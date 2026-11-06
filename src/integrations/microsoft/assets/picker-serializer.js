// The unit-testable core of the picker UI (Task U20, Requirement R9): turns a
// raw File Picker v8 `pick` command result into the ONLY payload that may
// cross to Daftari's `/enrollments/preview` and `/enrollments` routes.
//
// The picker driver (glue.js) acquires a browser SharePoint access token via
// msal-browser to open the picker popup — that token lives only in the
// browser and MUST NEVER be forwarded to the server. This module is the
// single choke point that guarantees it: it enumerates a fixed allowlist of
// output fields (driveId/itemId/name/sharepointIds) and drops everything
// else, so a pick result carrying an `accessToken` (or any other credential
// field a future picker SDK version might add) can never leak through by
// omission — the allowlist has to name a field for it to survive.
//
// Plain ES module, no build step: served as-is to the browser from
// GET /integrations/microsoft/ui/assets/picker-serializer.js, and imported
// directly by the vitest suite (test/integrations/microsoft-ui.test.ts) to
// assert the no-token property against a fake pick result.

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function stringOrUndefined(value) {
  return typeof value === "string" ? value : undefined;
}

// One command item from a File Picker v8 `pick` command result — shaped per
// the SDK's `items[]`/`value.items[]` result contract. Only the fields named
// here are ever read; anything else on the raw item (including a token) is
// invisible to this function by construction.
function serializeItem(rawItem) {
  if (!isRecord(rawItem)) return null;
  const driveId =
    stringOrUndefined(rawItem.driveId) ??
    stringOrUndefined(
      rawItem.parentReference && isRecord(rawItem.parentReference)
        ? rawItem.parentReference.driveId
        : undefined,
    );
  const itemId = stringOrUndefined(rawItem.id) ?? stringOrUndefined(rawItem.itemId);
  if (driveId === undefined || itemId === undefined) return null;
  const name = stringOrUndefined(rawItem.name);
  const sharepointIds = isRecord(rawItem.sharepointIds) ? rawItem.sharepointIds : undefined;
  return {
    driveId,
    itemId,
    ...(name === undefined ? {} : { name }),
    ...(sharepointIds === undefined
      ? {}
      : {
          sharepointIds: {
            ...(stringOrUndefined(sharepointIds.listId) === undefined
              ? {}
              : { listId: sharepointIds.listId }),
            ...(stringOrUndefined(sharepointIds.listItemId) === undefined
              ? {}
              : { listItemId: sharepointIds.listItemId }),
            ...(stringOrUndefined(sharepointIds.siteId) === undefined
              ? {}
              : { siteId: sharepointIds.siteId }),
            ...(stringOrUndefined(sharepointIds.webId) === undefined
              ? {}
              : { webId: sharepointIds.webId }),
          },
        }),
  };
}

/**
 * Strip a File Picker v8 `pick` result down to item references only. The
 * browser's SharePoint access token (however the picker SDK happens to carry
 * it — `accessToken`, `token`, nested under `authentication`, etc.) is never
 * read here and therefore never appears in the returned payload.
 *
 * @param {unknown} pickResult
 * @returns {{ items: Array<{ driveId: string, itemId: string, name?: string, sharepointIds?: Record<string, string> }> }}
 */
export function serializePickerSelection(pickResult) {
  if (!isRecord(pickResult)) return { items: [] };
  const rawItems = Array.isArray(pickResult.items)
    ? pickResult.items
    : isRecord(pickResult.value) && Array.isArray(pickResult.value.items)
      ? pickResult.value.items
      : [];
  const items = [];
  for (const rawItem of rawItems) {
    const serialized = serializeItem(rawItem);
    if (serialized !== null) items.push(serialized);
  }
  return { items };
}
