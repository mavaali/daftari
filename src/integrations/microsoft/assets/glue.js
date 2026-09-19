// The Microsoft picker page's client-side driver (Task U20, Requirement R9).
// Runs in the browser only, loaded as `<script type="module" src=".../glue.js">`
// — no inline script, per the page's CSP (`script-src 'self'`).
//
// Flow:
//   1. Ack checkbox gates the Enroll button (§9/§12 UX) — never enabled until
//      the audience-disclosure checkbox is checked.
//   2. "Select files" acquires a SharePoint-resource token via msal-browser's
//      PKCE popup flow (`{pickerHost}/.default` — "the picker relies on
//      SharePoint tokens, not Graph", design §5.1), then opens File Picker v8
//      as a POPUP (not iframe) against `{pickerHost}/_layouts/15/FileBrowser.aspx`.
//   3. On the picker's `pick` command, the DOM-driving code here hands the raw
//      result to `serializePickerSelection` (picker-serializer.js) — the only
//      place allowed to decide what crosses to Daftari. The browser's
//      SharePoint access token is read by THIS module (to open the picker) but
//      is never passed into the serializer and never appears in the fetch
//      bodies below.
//   4. Preview POSTs the serialized selection to /enrollments/preview; Enroll
//      POSTs (with `acknowledged: true`) to /enrollments.

import { serializePickerSelection } from "./picker-serializer.js";
import { PublicClientApplication } from "./vendor/msal-browser/index.mjs";

const root = document.getElementById("microsoft-picker-root");
if (root === null) {
  throw new Error("microsoft picker page: missing #microsoft-picker-root");
}

const config = JSON.parse(root.getAttribute("data-config") ?? "{}");
const { clientId, authority, pickerHost, provider } = config;

const ackCheckbox = document.getElementById("audience-ack");
const enrollButton = document.getElementById("enroll-button");
const selectButton = document.getElementById("select-files-button");
const collectionSelect = document.getElementById("collection-select");
const statusEl = document.getElementById("picker-status");

let currentSelection = null; // the last serializePickerSelection() output

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

// §9/§12: Enroll stays disabled until BOTH the audience checkbox is checked
// AND a selection exists — never inferred from one alone.
function refreshEnrollGate() {
  if (enrollButton === null) return;
  const ready = ackCheckbox?.checked === true && currentSelection !== null;
  enrollButton.disabled = !ready;
}

ackCheckbox?.addEventListener("change", refreshEnrollGate);

function csrfToken() {
  const match = document.cookie.match(/(?:^|;\s*)daftari_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function postJson(path, body) {
  const csrf = csrfToken();
  const response = await fetch(path, {
    method: "POST",
    credentials: "same-origin",
    headers: {
      "content-type": "application/json",
      ...(csrf.length > 0 ? { "x-csrf-token": csrf } : {}),
    },
    body: JSON.stringify(body),
  });
  return {
    ok: response.ok,
    status: response.status,
    body: await response.json().catch(() => null),
  };
}

// The exact File Picker v8 config from design §5.1: SDK 8.0, all sources
// enabled, multi-select up to 50 items.
function fileBrowserConfig(msgChannelId) {
  return {
    sdk: "8.0",
    entry: { oneDrive: { files: {} } },
    authentication: {},
    messaging: { origin: window.location.origin, channelId: msgChannelId },
    typesAndSources: {
      mode: "all",
      filters: [".docx", ".pptx", ".pdf", ".doc", ".ppt", "folder"],
      pivots: { oneDrive: true, recent: true, shared: true, sharedLibraries: true },
    },
    selection: { mode: "multiple", maximumCount: 50 },
  };
}

async function acquireSharePointToken(msalApp) {
  // "the picker relies on SharePoint tokens, not Graph" (§5.1) — the resource
  // scope is the picker host itself, never a Graph scope.
  const scopes = [`${pickerHost}/.default`];
  try {
    const silent = await msalApp.acquireTokenSilent({ scopes });
    return silent.accessToken;
  } catch {
    const popupResult = await msalApp.acquireTokenPopup({ scopes });
    return popupResult.accessToken;
  }
}

function openFilePickerPopup(token, msgChannelId) {
  return new Promise((resolvePick, rejectPick) => {
    const width = 1080;
    const height = 680;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      "about:blank",
      "ms-file-picker",
      `width=${width},height=${height},left=${left},top=${top},popup=1`,
    );
    if (popup === null) {
      rejectPick(new Error("picker popup was blocked"));
      return;
    }

    let port;
    // The trusted origin the popup must be showing to have its messages
    // accepted. `event.source === popup` alone is NOT enough: `source` is the
    // window handle, and it persists across navigations of that window — if
    // the popup were ever navigated away from pickerHost (an open redirect on
    // the SharePoint host, a third-party script injected into that origin,
    // etc.), messages from whatever now occupies that window would still pass
    // an `event.source`-only check and could forge the `authenticate` command
    // to solicit the SharePoint token, or forge a `pick` result. Requiring
    // `event.origin` to match pickerHost's origin closes that gap. Only the
    // window-message gate needs this: once handoff to the MessageChannel port
    // happens, that channel is scoped to the two endpoints that shared it and
    // inherits the trust established here.
    const trustedOrigin = new URL(pickerHost).origin;

    function onMessage(event) {
      if (event.source !== popup) return;
      if (event.origin !== trustedOrigin) return;
      const data = event.data;
      if (data?.type === "initialize" && data.channelId === msgChannelId) {
        port = event.ports[0];
        port.addEventListener("message", onPortMessage);
        port.start();
        port.postMessage({ type: "activate" });
        return;
      }
    }

    function onPortMessage(event) {
      const message = event.data;
      if (message?.type !== "command") return;
      const command = message.data;
      if (command?.command === "authenticate") {
        port.postMessage({ type: "result", id: message.id, data: { token } });
        return;
      }
      if (command?.command === "pick") {
        port.postMessage({ type: "result", id: message.id, data: {} });
        cleanup();
        resolvePick(command);
        return;
      }
      if (command?.command === "close") {
        cleanup();
        rejectPick(new Error("picker was closed"));
      }
    }

    let closedPollTimer;

    function cleanup() {
      window.removeEventListener("message", onMessage);
      if (closedPollTimer !== undefined) clearInterval(closedPollTimer);
      popup?.close();
    }

    window.addEventListener("message", onMessage);

    // Recovery for a manually-closed popup (OS window close, not the SDK's
    // own `close` command): without this, closing the popup by hand leaves
    // the Promise pending forever and the button stuck on "Opening file
    // picker…". Polling `popup.closed` is the only reliable cross-browser
    // signal for that — there's no event for it.
    closedPollTimer = setInterval(() => {
      if (popup.closed) {
        cleanup();
        rejectPick(new Error("picker popup was closed"));
      }
    }, 500);

    const form = new URLSearchParams();
    form.set("filePicker", JSON.stringify(fileBrowserConfig(msgChannelId)));
    form.set("locale", "en-us");
    const target = new URL(`${pickerHost}/_layouts/15/FileBrowser.aspx`);
    popup.location.href = `${target.toString()}?${form.toString()}`;
  });
}

selectButton?.addEventListener("click", () => {
  void (async () => {
    setStatus("Signing in…");
    try {
      const msalApp = new PublicClientApplication({
        auth: { clientId, authority },
      });
      await msalApp.initialize();
      const token = await acquireSharePointToken(msalApp);
      setStatus("Opening file picker…");
      const msgChannelId = crypto.randomUUID();
      const pickResult = await openFilePickerPopup(token, msgChannelId);
      // The only handoff point: the raw pick result (which may itself carry
      // no token, but is treated as untrusted regardless) goes through the
      // allowlisting serializer before it becomes state this page can POST.
      currentSelection = serializePickerSelection(pickResult);
      refreshEnrollGate();
      setStatus(`Selected ${currentSelection.items.length} item(s).`);
    } catch (error) {
      setStatus(`Selection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  })();
});

enrollButton?.addEventListener("click", () => {
  void (async () => {
    if (currentSelection === null || collectionSelect === null) return;
    const collection = collectionSelect.value;
    const preview = await postJson(`/integrations/${provider}/enrollments/preview`, {
      selection: currentSelection,
      collection,
    });
    if (!preview.ok) {
      setStatus(`Preview failed (${preview.status}).`);
      return;
    }
    const enroll = await postJson(`/integrations/${provider}/enrollments`, {
      selection: currentSelection,
      collection,
      acknowledged: true,
    });
    setStatus(enroll.ok ? "Enrolled." : `Enroll failed (${enroll.status}).`);
  })();
});
