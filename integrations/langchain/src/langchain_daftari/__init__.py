"""langchain-daftari — LangChain integration for the Daftari MCP vault."""

from .client import (
    DaftariClient,
    DaftariConnectionError,
    DaftariError,
    DaftariNotFoundError,
    DaftariTimeoutError,
)
from .response import DaftariResponse
from .tools import VAULT_SEARCH_DESCRIPTION_OVERRIDE, create_daftari_tools

__all__ = [
    "DaftariClient",
    "DaftariConnectionError",
    "DaftariError",
    "DaftariNotFoundError",
    "DaftariResponse",
    "DaftariTimeoutError",
    "VAULT_SEARCH_DESCRIPTION_OVERRIDE",
    "create_daftari_tools",
]

__version__ = "0.1.0"
