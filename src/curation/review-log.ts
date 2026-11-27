// Review journal — instrumentation for measuring human review burden (bead
// 9mpe). One append-only, content-free JSONL file under .daftari/ that records
// three things:
//
//   - shown:        the FIRST time an item was surfaced to a reviewer of a
//                   given kind (board list, court docket). One line per
//                   (item, viewer_kind), so the file stays small.
//   - decision:     a review decision — staged-action ratify/reject/expire,
//                   board disposition, tension resolve, direct promote — with
//                   who decided (decided_by_kind) and whether it changed the
//                   vault (changed_anything).
//   - tension_open: a tension was logged, so backlog over time is computable
//                   from this file without diffing tensions.md.
//
// Ids, kinds and timestamps only — never titles, claims, rationales or paths.
// Staged-action and tension ids are opaque counters; board findings use their
// content-addressed identity_key; a document is hashed (docReviewItem).
//
// decided_by_kind is derived ONLY from the authenticated principal
// (AccessContext.user — set by the operator via --user or server.auth) and
// the vault config. A caller-supplied claim (vault_ratify's `principal`,
// `--by`, an `agent` argument) never feeds it. See principalKind.
//
// Same mechanics as the read log: git-ignored, best-effort (a failed append
// never fails the decision it describes), corrupt lines skipped on read.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import type { Finding } from "../board/types.js";
import type { DaftariConfig } from "../utils/config.js";
import { loadConfig } from "../utils/config.js";
import { sha256Hex } from "../utils/hash.js";

export const DECIDED_BY_KINDS = ["human", "agent", "unknown"] as const;
export type DecidedByKind = (typeof DECIDED_BY_KINDS)[number];

export interface ShownEvent {
  ev: "shown";
  surface: string; // "board" | "docket"
  item: string;
  viewer_kind: DecidedByKind;
  at: string; // ISO 8601
}

export interface DecisionEvent {
  ev: "decision";
  surface: string; // "staged" | "board" | "tension" | "promote"
  item: string;
  action: string; // ratified | rejected | expired | accept | dismiss | <resolution kind> | promote
  decided_by_kind: DecidedByKind;
  changed_anything: boolean;
  at: string; // ISO 8601 — the decision instant
}

export interface TensionOpenEvent {
  ev: "tension_open";
  item: string;
  at: string;
}

export type ReviewEvent = ShownEvent | DecisionEvent | TensionOpenEvent;

export function reviewLogPath(vaultRoot: string): string {
  return join(vaultRoot, ".daftari", "review-log.jsonl");
}

// --- decided_by_kind -------------------------------------------------------

function isKind(v: unknown): v is DecidedByKind {
  return typeof v === "string" && (DECIDED_BY_KINDS as readonly string[]).includes(v);
}

// Resolution order:
//   1. principal_kinds[principal] in config — the operator's explicit word.
//   2. server.auth.session.maps_to.user → human: the identity a browser
//      password login receives (bearer tokens are for programs).
//   3. an `agent:` or `system:` prefix → agent (Daftari's own actor naming).
//   4. otherwise unknown.
// Human is never inferred from a name alone: under-counting humans is the
// safe error for a review-burden metric; over-counting them is not.
export function principalKind(
  config: DaftariConfig | null,
  principal: string | null | undefined,
): DecidedByKind {
  if (typeof principal !== "string") return "unknown";
  const name = principal.trim();
  if (name.length === 0) return "unknown";
  const mapped = config?.principalKinds;
  if (mapped && Object.hasOwn(mapped, name)) return mapped[name] as DecidedByKind;
  if (config?.server.session?.mapsTo.user === name) return "human";
  if (name.startsWith("agent:") || name.startsWith("system:")) return "agent";
  return "unknown";
}

// principalKind against the vault's config. A missing or malformed config
// degrades to the prefix rules — instrumentation never blocks a decision.
export function principalKindForVault(
  vaultRoot: string,
  principal: string | null | undefined,
): DecidedByKind {
  let config: DaftariConfig | null = null;
  try {
    const loaded = loadConfig(vaultRoot);
    if (loaded.ok) config = loaded.value;
  } catch {
    config = null;
  }
  return principalKind(config, principal);
}

// The principal a local CLI decision is attributed to. The CLI has no
// authentication — anyone (or any agent) with a shell as this OS user can run
// it — so this resolves to unknown unless the operator maps it in
// principal_kinds (e.g. `cli:alice: human`).
export function cliPrincipal(): string {
  let name = "unknown";
  try {
    name = userInfo().username;
  } catch {
    // no passwd entry — keep the placeholder
  }
  return `cli:${name}`;
}

// --- item keys -------------------------------------------------------------

// A document is recorded by hash, never by path.
export function docReviewItem(path: string): string {
  return `doc:${sha256Hex(path).slice(0, 16)}`;
}

// The journal key for a board finding. Staged and tension findings key by
// their native id so a board surfacing joins the vault_ratify /
// vault_tension_resolve decision on the same item.
export function boardReviewItem(finding: Pick<Finding, "target" | "identity_key">): string {
  const t = finding.target;
  if (t.kind === "staged") return t.stagedActionId;
  if (t.kind === "tension") return t.tensionId;
  return `finding:${finding.identity_key}`;
}

// --- append / read ---------------------------------------------------------

export function appendReviewEvents(vaultRoot: string, events: ReviewEvent[]): void {
  if (events.length === 0) return;
  try {
    mkdirSync(join(vaultRoot, ".daftari"), { recursive: true });
    appendFileSync(reviewLogPath(vaultRoot), events.map((e) => `${JSON.stringify(e)}\n`).join(""));
  } catch {
    // Best-effort: instrumentation never fails the action it measures.
  }
}

// Reads the journal, normalising older or partial lines: a missing kind reads
// as "unknown", a missing changed_anything as false.
export function readReviewEvents(vaultRoot: string): ReviewEvent[] {
  let raw: string;
  try {
    raw = readFileSync(reviewLogPath(vaultRoot), "utf-8");
  } catch {
    return [];
  }
  const out: ReviewEvent[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (typeof rec.item !== "string" || typeof rec.at !== "string") continue;
    const surface = typeof rec.surface === "string" ? rec.surface : "unknown";
    if (rec.ev === "shown") {
      out.push({
        ev: "shown",
        surface,
        item: rec.item,
        viewer_kind: isKind(rec.viewer_kind) ? rec.viewer_kind : "unknown",
        at: rec.at,
      });
    } else if (rec.ev === "decision") {
      out.push({
        ev: "decision",
        surface,
        item: rec.item,
        action: typeof rec.action === "string" ? rec.action : "unknown",
        decided_by_kind: isKind(rec.decided_by_kind) ? rec.decided_by_kind : "unknown",
        changed_anything: rec.changed_anything === true,
        at: rec.at,
      });
    } else if (rec.ev === "tension_open") {
      out.push({ ev: "tension_open", item: rec.item, at: rec.at });
    }
  }
  return out;
}

// Records the first surfacing of each item to a viewer of `viewerKind`.
// Already-recorded (item, kind) pairs are skipped, so repeated board loads
// cost one read of the journal and no writes.
export function recordShown(
  vaultRoot: string,
  surface: string,
  items: string[],
  viewerKind: DecidedByKind,
  at: string = new Date().toISOString(),
): void {
  if (items.length === 0) return;
  try {
    const seen = new Set<string>();
    for (const e of readReviewEvents(vaultRoot)) {
      if (e.ev === "shown") seen.add(`${e.viewer_kind}\u0000${e.item}`);
    }
    const fresh: ShownEvent[] = [];
    for (const item of items) {
      const key = `${viewerKind}\u0000${item}`;
      if (seen.has(key)) continue;
      seen.add(key);
      fresh.push({ ev: "shown", surface, item, viewer_kind: viewerKind, at });
    }
    appendReviewEvents(vaultRoot, fresh);
  } catch {
    // Best-effort, like every write here.
  }
}
