import { invoke } from "@tauri-apps/api/core";
import { decodeImageBatch } from "./imageBatch";
import { LruCache } from "./lruCache";

export interface PersonCounts {
  total: number;
  provisional: number;
  confirmed: number;
  rejected: number;
}
export interface Person {
  id: number;
  name: string;
  state: string;
  note: string | null;
  primary_face_id: number | null;
  primary_pinned: number;
  /** creation timestamp (UTC, #40) — provenance for the #88 triage view */
  created_at: string;
  groups: string[];
  counts: PersonCounts;
}
export interface Face {
  id: number;
  image_id: number;
  /** null never occurs since #165 — every writer homes its faces
      (§4.13 re-homes removed persons' faces into `RejectedN`
      cluster persons, §4.35/#266); kept nullable only for legacy rows */
  person_id: number | null;
  x: number;
  y: number;
  w: number;
  h: number;
  name: string;
  seq: number;
  description: string | null;
  confidence: number;
  link_status: string;
  state: string;
  /** #122: display rotation of the face crop, CW (0/90/180/270) */
  rotation: number;
  import_id: number | null;
  created_at: string;
}
export interface ImageRow {
  id: number;
  primary_path: string;
  width: number;
  height: number;
  orientation: string | null;
  /** #118/#122: EXIF display rotation, CW (0/90/180/270) */
  rotation: number;
  rtype: string | null;
  state: string;
  first_import_id: number | null;
  last_import_id: number | null;
}
export interface ImportRow {
  id: number;
  path: string;
  started_at: string;
}
export interface Settings {
  cluster_threshold: number;
  refcrop_n: number;
  /** #99 (§4.10): status filter for every view — replaces show_rejected */
  face_filter: "all" | "provisional" | "confirmed" | "rejected";
  /** #99 (§4.9): persons-view cluster grouping */
  cluster_group: "accuracy" | "description";
  /** Merge Similar Persons (#88): max Damerau-Levenshtein distance, 1..3 */
  merge_name_distance: number;
  /** #88: generational-suffix alias groups, e.g. [["J","Jr","Junior"]] */
  merge_suffix_aliases: string[][];
  /** #273: the *Open in system viewer* program; "" = system default */
  image_viewer: string;
  /** #273: the *Open roll path* program; "" = system default manager */
  directory_viewer: string;
}
export interface Snapshot {
  /** #208 — change stamp, read before the rows: equal on a probe ⇒
      nothing changed and the focus reload can skip */
  version: number;
  persons: Person[];
  faces: Face[];
  images: ImageRow[];
  imports: ImportRow[];
  settings: Settings;
}
/** #219 — the delta a mutation returns instead of a full snapshot: only
    the tables/rows the mutation touched, plus the new change stamp. */
export interface Delta {
  /** the new change stamp (matches `Snapshot.version`) */
  version: number;
  /** an external write interleaved (importer) — full-refresh instead of
      applying the delta */
  drifted: boolean;
  /** touched person rows (counts + groups included); null = none */
  persons?: Person[] | null;
  /** touched face rows; null = none */
  faces?: Face[] | null;
  /** touched image rows; null = none */
  images?: ImageRow[] | null;
  /** removed person ids (faces are never deleted — they are re-homed) */
  removed: number[];
}
export interface Refcrop {
  face_id: number;
  seq: number;
  description: string;
  pinned: boolean;
  filename: string;
}
export interface ClusterFace {
  face_id: number;
  sim: number;
}
export interface AppearanceGroup {
  /** appearance (distinct description); "" = none */
  description: string;
  clusters: ClusterFace[][];
}

// ---------------------------------------------------------------- commands

export const getSnapshot = () => invoke<Snapshot>("get_snapshot");
/** #208 — the cheap change stamp for the focus/visibility reload skip */
export const getDataVersion = () => invoke<number>("get_data_version");
export const assignPerson = (faceIds: number[], name: string, group: string) =>
  invoke<Delta>("assign_person", { faceIds, name, group });
export const acceptFaces = (faceIds: number[]) =>
  invoke<Delta>("accept_faces", { faceIds });
export const rejectFaces = (faceIds: number[]) =>
  invoke<Delta>("reject_faces", { faceIds });
/** #122: rotate the full image ±90° (server state) */
export const rotateImage = (imageId: number, delta: number) =>
  invoke<Delta>("rotate_image", { imageId, delta });
/** #209: batch twin of rotateImage — one call per user action */
export const rotateImages = (imageIds: number[], delta: number) =>
  invoke<Delta>("rotate_images", { imageIds, delta });
/** #122: rotate the face crop ±90° (server state) */
export const rotateFace = (faceId: number, delta: number) =>
  invoke<Delta>("rotate_face", { faceId, delta });
export const setFaceDescription = (faceId: number, description: string) =>
  invoke<Delta>("set_face_description", { faceId, description });
/** #209: batch twin of setFaceDescription — one call per staged batch;
    the sequential per-face seq re-assignment (§4.4) happens inside its
    transaction, in call order */
export const setFaceDescriptions = (faceIds: number[], description: string) =>
  invoke<Delta>("set_face_descriptions", { faceIds, description });
export const setPrimaryFace = (personId: number, faceId: number) =>
  invoke<Delta>("set_primary_face", { personId, faceId });
export const setPersonName = (personId: number, name: string) =>
  invoke<Delta>("set_person_name", { personId, name });
export const setPersonGroup = (personId: number, group: string) =>
  invoke<Delta>("set_person_group", { personId, group });
export const setPersonNote = (personId: number, note: string) =>
  invoke<Delta>("set_person_note", { personId, note });
/** §4.16 (#50) — group membership: replace each person's group path
    (empty ⇒ Ungrouped); faces/statuses untouched */
export const movePersonsToGroup = (personIds: number[], group: string) =>
  invoke<Delta>("move_persons_to_group", { personIds, group });
/** §4.16 (#157, v3.59) — tree D&D: re-home ONE membership per person
    (remove the dragged-from row when they have it, file into the target
    branch, INSERT OR IGNORE dedupes); other memberships are kept */
export const movePersonsBetweenGroups = (
  personIds: number[],
  fromGroup: string,
  toGroup: string
) => invoke<Delta>("move_persons_between_groups", { personIds, fromGroup, toGroup });
/** §4.16 (#50) — rename/move a branch: rewrite the path prefix of every
    person inside it (sub-branches follow); empty new ⇒ subtree to Ungrouped */
export const renameGroup = (oldPath: string, newPath: string) =>
  invoke<Delta>("rename_group", { oldPath, newPath });
/** §4.16 (#50) — delete a branch: members (incl. sub-branches) fall to their status seats (#165, §4.35) */
export const deleteGroup = (path: string) => invoke<Delta>("delete_group", { path });
/** §4.13/#35/#165/#266 — reject + re-home faces into their `RejectedN`
    cluster persons, delete the person(s); no undo */
export const removePersons = (personIds: number[]) =>
  invoke<Delta>("remove_persons", { personIds });
export const addRefcrop = (personId: number, faceId: number) =>
  invoke<Delta>("add_refcrop", { personId, faceId });
export const removeRefcrop = (personId: number, faceId: number) =>
  invoke<Delta>("remove_refcrop", { personId, faceId });
export const getRefcrops = (personId: number) =>
  invoke<Refcrop[]>("get_refcrops", { personId });
/** #268: open the image's original (first recorded location that
    exists) in the system viewer — the system viewer's title shows the
    REAL path, never a `/tmp` copy. Returns "" on success; a non-empty
    string is the fallback status (original not found → temp copy
    opened) for the caller's info toast. (#33 legacy: temp copy only) */
export const openImage = (imageId: number) => invoke<string>("open_image", { imageId });
/** #272 (gui-design v11.1) — 'Open roll path': the directory CONTAINING
    the image file (parent of primary_path — a recursive roll import may
    place it below the roll root) in the system file manager (a stale
    directory is a rejection for the error toast, #144) */
export const openRoll = (imageId: number) => invoke<void>("open_roll", { imageId });
export const personFaceClusters = (personId: number, threshold: number) =>
  invoke<AppearanceGroup[]>("person_face_clusters", { personId, threshold });
export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) => invoke("set_settings", { settings });

// ------------------------------------------------------- import runner (#167)

/** per-roll CLI options, mapped 1:1 onto import_roll.py's flags (§4.36) */
export interface ImportOptions {
  rollDir: string;
  dryRun: boolean;
  all: boolean;
  gpu: boolean;
  threshold: number;
  recursive: boolean;
  createDb: boolean;
}
export interface ImportStatus {
  running: boolean;
  killed: boolean;
  exitCode: number | null;
  /** seconds since the current/last run started */
  elapsed: number | null;
  /** cursor for the next poll */
  nextSince: number;
  lines: string[];
}
/** fs probe: does the path hold ≥ 1 image at ANY depth (#169,
    recursive + early-exit)? `true` + no snapshot match =
    "not yet imported" (§4.36) */
export const scanImportDir = (path: string) =>
  invoke<boolean>("scan_import_dir", { path });
/** spawn scripts/import_roll.py as an independent child process;
    refused while one is already running */
export const startImport = (options: ImportOptions) =>
  invoke<ImportStatus>("start_import", { options });
/** kill the running import child (if any) → whether one was killed */
export const stopImport = () => invoke<boolean>("stop_import");
/** the pane's stdout poll: lines [since..] + process state + elapsed */
export const getImportStatus = (since: number) =>
  invoke<ImportStatus>("get_import_status", { since });
/** the resolved DB path for the pane's read-only header */
export const getImportInfo = () =>
  invoke<{ dbPath: string; dbExists: boolean }>("get_import_info");

// ---------------------------------------------------------------- image delivery
//
// #212 — images cross the IPC as RAW BYTES (tauri::ipc::Response →
// ArrayBuffer) and render from Blob URLs: no base64 (~33% smaller
// transfers, no giant JS strings) and same-origin loads, so the #122
// canvas rotation never taints. Requests COALESCE — a mount wave (the
// grid, a thumb row, the refcrop strip) flushes ONE get_image_batch
// call per kind. BLOBs never change once written, so cached URLs stay
// valid for the session; the per-kind LRU caps bound the retained Blob
// URLs and revoke evicted ones (a revoked URL never breaks an
// already-loaded <img> — verified on WebKitGTK).

type ImageKind = "face" | "thumb" | "preview";

const revokeUrl = (_id: number, p: Promise<string | null>) =>
  void p.then((url) => {
    if (url) URL.revokeObjectURL(url);
  });

const imageCaches: Record<ImageKind, LruCache<number, Promise<string | null>>> = {
  face: new LruCache(5000, revokeUrl),
  thumb: new LruCache(1000, revokeUrl),
  preview: new LruCache(500, revokeUrl),
};

function cached<K>(
  cache: LruCache<K, Promise<string | null>>,
  key: K,
  load: () => Promise<string | null>,
): Promise<string | null> {
  let p = cache.get(key);
  if (!p) {
    p = load().catch((e) => {
      cache.delete(key);
      console.error(e);
      return null;
    });
    cache.set(key, p);
  }
  return p;
}

interface Waiter {
  resolve: (url: string | null) => void;
  reject: (e: unknown) => void;
}

// one in-flight batch per kind — every hook of a render commit queues
// into the same map and the flush below covers them all in one IPC
const queued = new Map<ImageKind, Map<number, Waiter>>();
let flushQueued = false;

function scheduleFlush(): void {
  if (flushQueued) return;
  flushQueued = true;
  queueMicrotask(() => {
    flushQueued = false;
    void flushImages();
  });
}

function loadImage(kind: ImageKind, id: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let waiters = queued.get(kind);
    if (!waiters) queued.set(kind, (waiters = new Map()));
    waiters.set(id, { resolve, reject });
    scheduleFlush();
  });
}

/**
 * #227 — which of a batch's requested ids did the response serve, and
 * what must happen to the rest?
 *
 * The backend never exceeds a per-response byte cap (`IMAGE_BATCH_MAX_BYTES`,
 * db.rs): a single oversized image is always served alone, the rest of
 * the batch is deferred. The wire format carries no truncation flag, so
 * truncation is distinguished from a genuine miss by construction:
 * - a cap hit always serves ≥ 1 entry (truncation ⇒ served > 0), and
 * - a single-id request can never be truncated by the cap, so its miss
 *   is genuinely "no blob".
 *
 * Returns the ids to resolve with `null` (genuine misses — the callers
 * cache them) and the ids to re-request (deferred by the cap). The
 * deferred set strictly shrinks per round (a deferred multi-id re-request
 * serves ≥ 1 entry), so the loop below terminates.
 */
export function splitImageBatch(
  requested: number[],
  served: number[],
): { missing: number[]; deferred: number[] } {
  const asked = new Set(requested);
  const got = new Set(served);
  const missing = [...asked].filter((id) => !got.has(id));
  const truncatable = served.length > 0 && requested.length > 1;
  return truncatable ? { missing: [], deferred: missing } : { missing, deferred: [] };
}

async function flushImages(): Promise<void> {
  for (const [kind, waiters] of queued) {
    if (waiters.size === 0) continue;
    const batch = [...waiters];
    waiters.clear();
    try {
      const buf = await invoke<ArrayBuffer>("get_image_batch", {
        kind,
        ids: batch.map(([id]) => id),
      });
      const got = decodeImageBatch(buf);
      const served = [...got.entries()].filter(([, b]) => b.length > 0).map(([id]) => id);
      // deferred first: the same waiter objects go back into the queue
      // (a later flush call may have queued a concurrent request — keep it)
      const { missing, deferred } = splitImageBatch(
        batch.map(([id]) => id),
        served,
      );
      if (deferred.length > 0) {
        let again = queued.get(kind);
        if (!again) queued.set(kind, (again = new Map()));
        for (const id of deferred) {
          const waiter = batch.find(([wid]) => wid === id)![1];
          if (!again.has(id)) again.set(id, waiter);
        }
        scheduleFlush();
      }
      const missingSet = new Set(missing);
      for (const [id, waiter] of batch) {
        if (deferred.includes(id)) continue; // stays queued for the next round
        if (missingSet.has(id)) {
          waiter.resolve(null); // no such image — cache the miss
          continue;
        }
        const bytes = got.get(id);
        if (!bytes || bytes.length === 0) {
          waiter.resolve(null); // no such image — cache the miss
          continue;
        }
        waiter.resolve(
          // slice(): a fresh ArrayBuffer-backed copy (the decoded views
          // share the IPC buffer, which BlobPart typing will not take)
          URL.createObjectURL(new Blob([bytes.slice()], { type: "image/jpeg" })),
        );
      }
    } catch (e) {
      // cached() drops the failed entry and reports null — a later mount retries
      for (const [, waiter] of batch) waiter.reject(e);
    }
  }
}

export const facePreview = (id: number) =>
  cached(imageCaches.face, id, () => loadImage("face", id));
export const imageThumb = (id: number) =>
  cached(imageCaches.thumb, id, () => loadImage("thumb", id));
export const imagePreview = (id: number) =>
  cached(imageCaches.preview, id, () => loadImage("preview", id));
