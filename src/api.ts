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
  groups: string[];
  counts: PersonCounts;
}
export interface Face {
  id: number;
  image_id: number;
  person_id: number;
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
  import_id: number | null;
  created_at: string;
}
export interface ImageRow {
  id: number;
  primary_path: string;
  width: number;
  height: number;
  orientation: string | null;
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
  show_rejected: boolean;
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
export const addRefcrop = (personId: number, faceId: number) =>
  invoke("add_refcrop", { personId, faceId });
export const removeRefcrop = (personId: number, faceId: number) =>
  invoke("remove_refcrop", { personId, faceId });
export const getRefcrops = (personId: number) =>
  invoke<Refcrop[]>("get_refcrops", { personId });
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
