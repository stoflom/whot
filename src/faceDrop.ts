// #135/#136 (rule 34) — face drag & drop: the drag-payload rule and the
// face-level merge plan. Pure — unit-tested in faceDrop.test.ts.

/** the minimal face facts the plan needs */
export interface FaceRef {
  id: number;
  person_id: number | null;
}

/** the minimal person facts the plan needs */
export interface PersonRef {
  id: number;
  name: string;
}

/** the dragged payload: the whole selection when the dragged card is part
    of one (the #50 person-drag rule, mirrored); else just that card */
export function faceDragPayload(
  selected: ReadonlySet<number>,
  dragId: number,
): number[] {
  return selected.has(dragId) && selected.size > 1 ? [...selected] : [dragId];
}

/** the face-level merge plan for a drop onto a person row (#135) */
export interface FaceMergePlan {
  /** faces that actually move — the payload minus the target's own */
  movers: number[];
  /** mover faces grouped by source person id (unowned excluded) */
  bySource: Map<number, number[]>;
  /** mover faces with no person */
  unowned: number[];
  /** names of source persons that lose their LAST face to this merge */
  emptied: string[];
}

export function faceMergePlan(
  faceIds: number[],
  targetId: number,
  faces: readonly FaceRef[],
  persons: readonly PersonRef[],
): FaceMergePlan {
  const byId = new Map<number, FaceRef>(faces.map((f) => [f.id, f]));
  // current face count per person — for "loses their last face"
  const totalByPerson = new Map<number, number>();
  for (const f of faces) {
    if (f.person_id != null)
      totalByPerson.set(f.person_id, (totalByPerson.get(f.person_id) ?? 0) + 1);
  }
  const movers: number[] = [];
  const bySource = new Map<number, number[]>();
  const unowned: number[] = [];
  const lostByPerson = new Map<number, number>();
  for (const id of faceIds) {
    const f = byId.get(id);
    if (!f || f.person_id === targetId) continue; // already on the target
    movers.push(id);
    if (f.person_id == null) {
      unowned.push(id);
      continue;
    }
    const arr = bySource.get(f.person_id) ?? [];
    arr.push(id);
    bySource.set(f.person_id, arr);
    lostByPerson.set(f.person_id, (lostByPerson.get(f.person_id) ?? 0) + 1);
  }
  const nameById = new Map<number, string>(persons.map((p) => [p.id, p.name]));
  const emptied = [...bySource.keys()]
    .filter(
      (pid) =>
        (lostByPerson.get(pid) ?? 0) >= (totalByPerson.get(pid) ?? 0),
    )
    .map((pid) => nameById.get(pid) ?? `#${pid}`)
    .sort();
  return { movers, bySource, unowned, emptied };
}
