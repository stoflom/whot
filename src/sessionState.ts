// #297 (gui-design rule 50, v15.0) — session persistence: the session-state
// set (§3/§4.39) survives an app restart via localStorage. This module is
// PURE — the versioned (de)serialiser and the snapshot validator. The
// restore effect + throttled saves live in useSessionState.ts; App keeps
// only setter bindings (rule 50: no App growth).
//
// The contract: ONE blob under ONE key; the schema stamp gates it, so a
// future shape change is ignored/migrated, never half-applied. Corrupt,
// absent or mismatched storage is silently ignored — session state is an
// affordance, never an error screen.

import type { Mode } from "./sections";

export const SESSION_STORAGE_KEY = "whot.session.v1";
export const SESSION_SCHEMA = 1;

/** the persisted set — the fields the rule 50 restore covers. Every
    field is optional; the safe readers fill only what the storage
    actually holds, the rest falls back to the live defaults. */
export interface SessionBlob {
  v: number;
  mode?: Mode;
  personId?: number | null;
  imageId?: number | null;
  splitImageId?: number | null;
  rollRoot?: string;
  rollBranch?: string;
  rollOpen?: string[];
  rollRecursive?: string[];
  importDir?: string | null;
  treeFilter?: string;
  treeCollapsed?: string[];
  /** §4.14 — the grid's mount pagination (restores WITH the scroll
      places: a place beyond the mounted prefix would clamp) */
  mountLimit?: number;
  /** §4.40 — the centre grid's scroll place, per mode */
  scroll?: Partial<Record<Mode, number>>;
  paneLeft?: number;
  paneRight?: number;
}

/** the safe, per-field-typed read of a blob — every field falls back to
    the live default when absent or of the wrong shape. This is what the
    first render seeds from (synchronous: localStorage needs no snapshot). */
export interface SessionInitial {
  mode: Mode;
  personId: number | null;
  imageId: number | null;
  splitImageId: number | null;
  rollRoot: string;
  rollBranch: string;
  rollOpen: string[];
  rollRecursive: string[];
  importDir: string | null;
  treeFilter: string;
  treeCollapsed: string[];
  mountLimit: number;
  scroll: Partial<Record<Mode, number>>;
  paneLeft: number;
  paneRight: number;
}

const MODES: readonly Mode[] = ["review", "rolls", "person"];
const MIN_PANE = 80;
const MIN_MOUNT_LIMIT = 12;

/** parse + gate the schema stamp. `null` for absent, corrupt, non-object
    or mismatched storage — the caller simply falls back to the defaults. */
export function parseSession(raw: string | null | undefined): SessionBlob | null {
  if (raw == null) return null;
  let b: unknown;
  try {
    b = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof b !== "object" || b === null || Array.isArray(b)) return null;
  const o = b as Record<string, unknown>;
  if (o.v !== SESSION_SCHEMA) return null;
  return o as unknown as SessionBlob;
}

/** the blob's serial form (one key, the schema stamp first). */
export function serializeSession(b: SessionBlob): string {
  return JSON.stringify(b);
}

const stringList = (x: unknown): string[] | null =>
  Array.isArray(x) ? x.filter((p): p is string => typeof p === "string") : null;
const posInt = (x: unknown): number | null =>
  typeof x === "number" && Number.isInteger(x) && x >= 0 ? x : null;

/** the safe per-field read (see SessionInitial). `null` blob → all
    defaults, exactly the pre-#297 boot. */
export function sessionInitial(blob: SessionBlob | null): SessionInitial {
  const b = blob;
  const scroll: Partial<Record<Mode, number>> = {};
  if (b?.scroll != null && typeof b.scroll === "object" && !Array.isArray(b.scroll)) {
    for (const m of MODES) {
      const n = posInt((b.scroll as Record<string, unknown>)[m]);
      if (n != null) scroll[m] = n;
    }
  }
  return {
    mode: b?.mode != null && (MODES as readonly string[]).includes(b.mode) ? b.mode : "review",
    personId: b?.personId != null && posInt(b.personId) != null ? b.personId : null,
    imageId: b?.imageId != null && posInt(b.imageId) != null ? b.imageId : null,
    splitImageId: b?.splitImageId != null && posInt(b.splitImageId) != null ? b.splitImageId : null,
    rollRoot: typeof b?.rollRoot === "string" && b.rollRoot !== "" ? b.rollRoot : "/",
    rollBranch:
      typeof b?.rollBranch === "string" && b.rollBranch !== "" ? b.rollBranch : "/",
    rollOpen: stringList(b?.rollOpen) ?? [],
    rollRecursive: stringList(b?.rollRecursive) ?? [],
    importDir: typeof b?.importDir === "string" ? b.importDir : null,
    treeFilter: typeof b?.treeFilter === "string" ? b.treeFilter : "",
    treeCollapsed: stringList(b?.treeCollapsed) ?? [],
    mountLimit:
      b?.mountLimit != null &&
      Number.isInteger(b.mountLimit) &&
      b.mountLimit >= MIN_MOUNT_LIMIT
        ? b.mountLimit
        : MIN_MOUNT_LIMIT,
    scroll,
    paneLeft:
      b?.paneLeft != null &&
      typeof b.paneLeft === "number" &&
      b.paneLeft >= MIN_PANE
        ? b.paneLeft
        : 250,
    paneRight:
      b?.paneRight != null &&
      typeof b.paneRight === "number" &&
      b.paneRight >= MIN_PANE
        ? b.paneRight
        : 290,
  };
}

/** the id validator: the anchor and the two open images checked against
    the FIRST snapshot that lands (re-run on every snapshot — an external
    deletion clears a dangling id the same way a live one would).
    `imageId` additionally requires its path under `rollBranch` — the
    rule 46 `–/m` miss is a LIVE state, not a boot state. */
export function validateIdsFor(
  snap: {
    persons: Array<{ id: number }>;
    images: Array<{ id: number; primary_path: string }>;
  },
  ids: {
    personId: number | null;
    imageId: number | null;
    splitImageId: number | null;
    rollBranch: string;
  }
): { personId: number | null; imageId: number | null; splitImageId: number | null } {
  const personIds = new Set(snap.persons.map((p) => p.id));
  const imageById = new Map(snap.images.map((i) => [i.id, i]));
  const personId =
    ids.personId != null && personIds.has(ids.personId) ? ids.personId : null;
  const image = ids.imageId != null ? imageById.get(ids.imageId) : undefined;
  const imageId =
    image != null &&
    (ids.rollBranch === "/" ||
      image.primary_path === ids.rollBranch ||
      image.primary_path.startsWith(`${ids.rollBranch}/`))
      ? image.id
      : null;
  const splitImageId =
    ids.splitImageId != null && imageById.has(ids.splitImageId)
      ? ids.splitImageId
      : null;
  return { personId, imageId, splitImageId };
}
