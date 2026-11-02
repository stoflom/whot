// Person-data signature (#213) — the cheap identity the App's refcrop
// and cluster effects key on instead of the whole snapshot object.
// PURE (the §4.44 convention): covers exactly the snapshot rows that can
// change `get_refcrops` / `person_face_clusters` output for one person —
// the membership and content of their faces, their name/primary, and the
// settings those two commands read. Anything else (another person's
// verdict, a group move, a rotation, a Show-filter change) keeps the
// signature, so the effects skip. Pin changes (add/remove_refcrop) live
// outside the snapshot entirely — App bumps a small epoch for those.

import type { Face, Person, Settings } from "./api";

/** Stable string for one person's cluster/refcrop-relevant state.
    Empty when there is no anchored person (or no settings yet). */
export function personDataSig(
  person: Person | null,
  faces: Face[],
  settings: Settings | null,
): string {
  if (person == null || settings == null) return "";
  const out: string[] = [
    `p${person.id}:${person.name}:${person.primary_face_id ?? ""}:${person.primary_pinned}`,
  ];
  const rows: [number, string][] = [];
  for (const f of faces) {
    if (f.person_id !== person.id) continue;
    rows.push([
      f.id,
      `${f.id}:${f.link_status}:${f.state}:${f.name}:${f.seq}:${f.confidence}:${f.description ?? ""}`,
    ]);
  }
  // input-order independent (the snapshot is id-ordered, but the
  // signature must not depend on that)
  rows.sort((a, b) => a[0] - b[0]);
  for (const [, row] of rows) out.push(row);
  out.push(`s:${settings.refcrop_n}:${settings.cluster_threshold}:${settings.cluster_group}`);
  return out.join("|");
}
