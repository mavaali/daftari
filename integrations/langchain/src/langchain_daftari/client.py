"""DaftariClient — transport primitive over the daftari MCP stdio server.

This is intentionally LangChain-free. The client manages the subprocess, the MCP
``ClientSession``, and a background event loop so that synchronous callers (and
multiple concurrent ones) can share one daftari connection without each call
having to spin up its own session and pay the subprocess-start cost.

Phase 1 ships a LangChain tool wrapper layer on top (``tools.py``). Phase 2 will
add a ``DaftariStore(BaseStore)`` for LangGraph long-term memory. Both reuse
this client unchanged.
"""

from __future__ import annotations

import asyncio
import shutil
import threading
from concurrent.futures import TimeoutError as FutureTimeoutError
from contextlib import AsyncExitStack
from typing import Any, Optional

from mcp.client.session import ClientSession
from mcp.client.stdio import StdioServerParameters, stdio_client

from .response import DaftariResponse


class DaftariError(Exception):
    """Base class for daftari client errors."""


class DaftariNotFoundError(DaftariError):
    """Raised when the configured daftari command can't be resolved on PATH."""


class DaftariConnectionError(DaftariError):
    """Raised when the daftari subprocess dies or the transport breaks."""


class DaftariTimeoutError(DaftariError):
    """Raised when a single tool call exceeds the configured per-call deadline."""


_DEFAULT_COMMAND: list[str] = ["npx", "daftari"]
_DEFAULT_TIMEOUT_S: float = 30.0
_CLOSE_GRACE_S: float = 5.0


class DaftariClient:
    """Holds a single daftari subprocess and shares it across sync / async callers.

    The class is a context manager. ``with DaftariClient(...) as c:`` opens the
    subprocess, runs the MCP handshake, and tears everything down on exit.

    Concurrency:
        ``ClientSession`` multiplexes JSON-RPC request IDs internally, so it is
        safe to issue ``call_tool`` from multiple threads concurrently — every
        call is dispatched onto the same background event loop.

    Args:
        vault_path: Absolute or relative path to the daftari vault directory.
        user: Identity the daftari server runs as. Defaults to ``"guest"``.
        role: RBAC role from ``.daftari/config.yaml``. Defaults to ``"guest"``.
        command: List form of the launcher, default ``["npx", "daftari"]``. The
            first element is the binary; everything after is prepended to the
            generated ``--vault/--user/--role`` arguments. Override for global
            installs (``["daftari"]``), local clones (``["node", "/path/cli.js"]``),
            or pinned versions (``["npx", "-y", "daftari@1.12.6"]``).
        env: Extra environment variables for the subprocess. ``None`` (default)
            inherits the parent environment.
        timeout: Per-call deadline in seconds. Default 30.
    """

    def __init__(
        self,
        *,
        vault_path: str,
        user: str = "guest",
        role: str = "guest",
        command: Optional[list[str]] = None,
        env: Optional[dict[str, str]] = None,
        timeout: float = _DEFAULT_TIMEOUT_S,
    ) -> None:
        self.vault_path = vault_path
        self.user = user
        self.role = role
        self.command = list(command) if command is not None else list(_DEFAULT_COMMAND)
        self.env = env
        self.timeout = timeout

        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._loop_thread: Optional[threading.Thread] = None
        self._session: Optional[ClientSession] = None
        self._stack: Optional[AsyncExitStack] = None
        self._open = False
        self._closed = False

    @property
    def session(self) -> Optional[ClientSession]:
        """The underlying MCP ``ClientSession`` once connected, else ``None``.

        Exposed for advanced callers that want to bypass the wrapper layer.
        Note that ``ClientSession`` methods are async and bound to the
        background loop — use ``acall_tool`` / ``call_tool`` for safe access.
        """
        return self._session

    def __enter__(self) -> "DaftariClient":
        self._ensure_command_available()
        self._start_loop_thread()
        self._run_on_loop(self._connect(), timeout=self.timeout)
        self._open = True
        return self

    def __exit__(self, *exc_info: Any) -> bool:
        self.close()
        return False

    def close(self) -> None:
        """Tear down the subprocess and stop the background loop. Idempotent."""
        if self._closed:
            return
        self._closed = True
        if self._loop is not None and self._loop.is_running():
            try:
                self._run_on_loop(self._disconnect(), timeout=_CLOSE_GRACE_S)
            except Exception:
                pass
            self._loop.call_soon_threadsafe(self._loop.stop)
        if self._loop_thread is not None:
            self._loop_thread.join(timeout=_CLOSE_GRACE_S)
        self._open = False

    def call_tool(self, name: str, arguments: Optional[dict[str, Any]] = None) -> DaftariResponse:
        """Synchronously call an MCP tool by name. Safe to call from any thread."""
        self._check_open()
        try:
            return self._run_on_loop(
                self._call_tool(name, arguments or {}),
                timeout=self.timeout,
            )
        except FutureTimeoutError as e:
            raise DaftariTimeoutError(
                f"daftari tool {name!r} did not respond within {self.timeout}s"
            ) from e

    async def acall_tool(
        self, name: str, arguments: Optional[dict[str, Any]] = None
    ) -> DaftariResponse:
        """Async variant of ``call_tool``. Safe to await from any event loop.

        If the caller is on the daftari client's own background loop the call is
        awaited directly; otherwise it is dispatched cross-loop via
        ``run_coroutine_threadsafe``.
        """
        self._check_open()
        running = _running_loop_or_none()
        if running is None or running is self._loop:
            return await self._call_tool(name, arguments or {})
        assert self._loop is not None
        fut = asyncio.run_coroutine_threadsafe(
            self._call_tool(name, arguments or {}), self._loop
        )
        return await asyncio.wrap_future(fut)

    def list_tools(self) -> list[Any]:
        """Return the full list of MCP tool definitions exposed by daftari.

        Each entry is an ``mcp.types.Tool`` with ``name``, ``description``,
        ``inputSchema``, and optional ``annotations``.
        """
        self._check_open()
        return self._run_on_loop(self._list_tools(), timeout=self.timeout)

    async def alist_tools(self) -> list[Any]:
        """Async variant of ``list_tools``."""
        self._check_open()
        running = _running_loop_or_none()
        if running is None or running is self._loop:
            return await self._list_tools()
        assert self._loop is not None
        fut = asyncio.run_coroutine_threadsafe(self._list_tools(), self._loop)
        return await asyncio.wrap_future(fut)

    def _ensure_command_available(self) -> None:
        binary = self.command[0]
        if shutil.which(binary) is None:
            raise DaftariNotFoundError(
                f"daftari command not found: {binary!r} is not on PATH. "
                "Install with `npm install -g daftari`, or pass `command=['node', '/path/to/cli.js']` "
                "to point at a local clone, or `command=['npx', '-y', 'daftari@<version>']` "
                "to pin a version."
            )

    def _start_loop_thread(self) -> None:
        ready = threading.Event()
        def _run() -> None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            self._loop = loop
            ready.set()
            try:
                loop.run_forever()
            finally:
                try:
                    loop.close()
                except Exception:
                    pass

        self._loop_thread = threading.Thread(
            target=_run, name="daftari-loop", daemon=True
        )
        self._loop_thread.start()
        ready.wait()

    def _run_on_loop(self, coro: Any, *, timeout: float) -> Any:
        assert self._loop is not None, "loop not started"
        fut = asyncio.run_coroutine_threadsafe(coro, self._loop)
        try:
            return fut.result(timeout=timeout)
        except FutureTimeoutError:
            fut.cancel()
            raise

    async def _connect(self) -> None:
        self._stack = AsyncExitStack()
        params = StdioServerParameters(
            command=self.command[0],
            args=[
                *self.command[1:],
                "--vault",
                self.vault_path,
                "--user",
                self.user,
                "--role",
                self.role,
            ],
            env=self.env,
        )
        try:
            read, write = await self._stack.enter_async_context(stdio_client(params))
            self._session = await self._stack.enter_async_context(
                ClientSession(read, write)
            )
            await asyncio.wait_for(self._session.initialize(), timeout=self.timeout)
        except asyncio.TimeoutError as e:
            await self._safe_close_stack()
            raise DaftariConnectionError(
                f"daftari did not complete MCP initialize within {self.timeout}s"
            ) from e
        except Exception as e:
            await self._safe_close_stack()
            raise DaftariConnectionError(f"failed to start daftari: {e}") from e

    async def _disconnect(self) -> None:
        await self._safe_close_stack()
        self._session = None

    async def _safe_close_stack(self) -> None:
        if self._stack is not None:
            try:
                await self._stack.aclose()
            except Exception:
                pass
            self._stack = None

    async def _call_tool(self, name: str, arguments: dict[str, Any]) -> DaftariResponse:
        if self._session is None:
            raise DaftariConnectionError("daftari client is not connected")
        try:
            result = await asyncio.wait_for(
                self._session.call_tool(name, arguments),
                timeout=self.timeout,
            )
        except asyncio.TimeoutError as e:
            raise DaftariTimeoutError(
                f"daftari tool {name!r} did not respond within {self.timeout}s"
            ) from e
        except Exception as e:
            raise DaftariConnectionError(
                f"daftari tool {name!r} failed at the transport layer: {e}"
            ) from e
        return DaftariResponse.from_mcp_result(result)

    async def _list_tools(self) -> list[Any]:
        if self._session is None:
            raise DaftariConnectionError("daftari client is not connected")
        try:
            current_cursor: Optional[str] = None
            collected: list[Any] = []
            while True:
                page = await asyncio.wait_for(
                    self._session.list_tools(cursor=current_cursor),
                    timeout=self.timeout,
                )
                if page.tools:
                    collected.extend(page.tools)
                if not getattr(page, "nextCursor", None):
                    break
                current_cursor = page.nextCursor
            return collected
        except asyncio.TimeoutError as e:
            raise DaftariTimeoutError(
                f"daftari tools/list did not respond within {self.timeout}s"
            ) from e
        except Exception as e:
            raise DaftariConnectionError(
                f"daftari tools/list failed: {e}"
            ) from e

    def _check_open(self) -> None:
        if not self._open or self._closed:
            raise DaftariConnectionError("DaftariClient is not open; use it as a context manager")


def _running_loop_or_none() -> Optional[asyncio.AbstractEventLoop]:
    try:
        return asyncio.get_running_loop()
    except RuntimeError:
        return None
