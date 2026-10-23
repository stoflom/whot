import { invoke } from "@tauri-apps/api/core";

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
  /** null for faces whose person was removed (§4.13) — rejected, unowned */
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
}
export interface Snapshot {
  persons: Person[];
  faces: Face[];
  images: ImageRow[];
  imports: ImportRow[];
  settings: Settings;
}
export interface Refcrop {
  face_id: number;
  seq: number;
  description: string;
  pinned: boolean;
  filename: string;
  image: string;
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
export const assignPerson = (faceIds: number[], name: string, group: string) =>
  invoke("assign_person", { faceIds, name, group });
export const acceptFaces = (faceIds: number[]) =>
  invoke("accept_faces", { faceIds });
export const rejectFaces = (faceIds: number[]) =>
  invoke("reject_faces", { faceIds });
/** #122: rotate the full image ±90° (server state) */
export const rotateImage = (imageId: number, delta: number) =>
  invoke("rotate_image", { imageId, delta });
/** #122: rotate the face crop ±90° (server state) */
export const rotateFace = (faceId: number, delta: number) =>
  invoke("rotate_face", { faceId, delta });
export const setFaceDescription = (faceId: number, description: string) =>
  invoke("set_face_description", { faceId, description });
export const setPrimaryFace = (personId: number, faceId: number) =>
  invoke("set_primary_face", { personId, faceId });
export const setPersonName = (personId: number, name: string) =>
  invoke("set_person_name", { personId, name });
export const setPersonGroup = (personId: number, group: string) =>
  invoke("set_person_group", { personId, group });
export const setPersonNote = (personId: number, note: string) =>
  invoke("set_person_note", { personId, note });
/** §4.16 (#50) — group membership: replace each person's group path
    (empty ⇒ Ungrouped); faces/statuses untouched */
export const movePersonsToGroup = (personIds: number[], group: string) =>
  invoke("move_persons_to_group", { personIds, group });
/** §4.16 (#50) — rename/move a branch: rewrite the path prefix of every
    person inside it (sub-branches follow); empty new ⇒ subtree to Ungrouped */
export const renameGroup = (oldPath: string, newPath: string) =>
  invoke("rename_group", { oldPath, newPath });
/** §4.16 (#50) — delete a branch: members (incl. sub-branches) become Ungrouped */
export const deleteGroup = (path: string) => invoke("delete_group", { path });
/** §4.13 (#35) — reject + detach faces, delete the person(s); no undo */
export const removePersons = (personIds: number[]) =>
  invoke("remove_persons", { personIds });
export const addRefcrop = (personId: number, faceId: number) =>
  invoke("add_refcrop", { personId, faceId });
export const removeRefcrop = (personId: number, faceId: number) =>
  invoke("remove_refcrop", { personId, faceId });
export const getRefcrops = (personId: number) =>
  invoke<Refcrop[]>("get_refcrops", { personId });
/** write the preview to a temp file and open it in the system viewer (#33) */
export const openImage = (imageId: number) => invoke("open_image", { imageId });
export const personFaceClusters = (personId: number, threshold: number) =>
  invoke<AppearanceGroup[]>("person_face_clusters", { personId, threshold });
export const getSettings = () => invoke<Settings>("get_settings");
export const setSettings = (settings: Settings) => invoke("set_settings", { settings });

// ---------------------------------------------------------------- image cache
//
// BLOBs never change once written, so a promise cache keyed by id is safe
// for the whole session.

const imgCache = new Map<string, Promise<string | null>>();

function cached(key: string, load: () => Promise<string | null>): Promise<string | null> {
  let p = imgCache.get(key);
  if (!p) {
    p = load().catch((e) => {
      imgCache.delete(key);
      console.error(e);
      return null;
    });
    imgCache.set(key, p);
  }
  return p;
}

export const facePreview = (id: number) =>
  cached(`face:${id}`, async () => invoke<string>("get_face_preview", { faceId: id }));
export const imageThumb = (id: number) =>
  cached(`thumb:${id}`, () => invoke<string | null>("get_image_thumb", { imageId: id }));
export const imagePreview = (id: number) =>
  cached(`preview:${id}`, () => invoke<string | null>("get_image_preview", { imageId: id }));
