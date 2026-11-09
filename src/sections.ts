// Centre-pane section derivations (gui-design §4.44, v3.94) — PURE data
// mappings over the snapshot: §4.24 the image detail (Rolls + focus
// film roll), §4.9 the person view in both cluster-group modes,
// §4.35 the rejected section, §4.30 the review grouping. App composes
// them but owns none of these rules — every behavioural correction to
// the grouping is implemented and regression-tested HERE (nothing
// touches state, DOM or IPC).
//
// The #98 identity rule is untouched: the returned Section[] is memoised
// per render in App and handed to the grid through sectionsRef; the
// latest-value refs stay App-owned.

import type { AppearanceGroup, Face, Person, Snapshot } from "./api";
import { groupByDescription, matchesStatusFilter, type ClusterGroup, type FaceFilter } from "./viewFilters";
import type { StagedEntry } from "./stage";
import { renameGroupFor } from "./groupList";
import { isRejectedBin } from "./personNames";
import type { Section } from "./components/FaceGrid";

/** the App view state that selects the section source. Declared here
    so the pure inputs stay structural — App keeps its own alias. */
export type Mode = "review" | "rolls" | "person";

/** everything the derivations read from the render-time screen state —
    App owns each field's identity (one useMemo per snapshot etc.) */
export interface SectionInputs {
  snap: Snapshot | null;
  mode: Mode;
  /** the Rolls image detail (§4.24); null outside an open image */
  imageId: number | null;
  /** the anchored person (§4.9) */
  personId: number | null;
  /** personsById.get(personId) ?? null — App's `selectedPerson` */
  selectedPerson: Person | null;
  /** §4.9 accuracy-mode similarity clusters (App's IPC state) */
  clusters: AppearanceGroup[] | null;
  facesById: Map<number, Face>;
  faceFilter: FaceFilter;
  clusterGroup: ClusterGroup;
  /** §4.24/#155: the staged set drives the Description-mode grouping
      too — indexed per face (#224); App passes it only where the
      grouping reads it (null elsewhere — the identity is irrelevant) */
  stagedIdx: Map<number, StagedEntry> | null;
  /** the §4.24 grouping (same module, below) as a callback so the
      branches share one identity (App memoises it per snapshot) */
  sectionsForImage: (imgId: number) => Section[];
}

/** #222 (F-H3): the person anchor the section derivations actually read.
    personId drives only the person view (§4.9) — the review grouping
    (§4.30) and the image detail (§4.24) never touch it. App keys the
    sections memo on THIS value instead of the raw personId, so a verdict
    advance / tree select inside Review changes no section object: the
    O(total faces) regroup and the memo(FaceCard) churn both stay away
    from a Review verdict. In person modes the key passes through, so the
    memo regroups exactly when the anchored person moves. */
export function sectionsPersonKey(
  mode: Mode,
  personId: number | null,
): number | null {
  return mode === "person" ? personId : null;
}

/** one section per person over an image's faces — the §4.24 Rolls image
    detail and the §4.19 focus-mode film roll share it. DIRECT grouping:
    the Show filter (§4.10) picks the faces, order = filter pass order. */
export function sectionsForImage(
  snap: Snapshot | null,
  personsById: Map<number, Person>,
  imgId: number,
  faceFilter: FaceFilter,
): Section[] {
  if (!snap) return [];
  const byPerson = new Map<number | null, Face[]>();
  for (const f of snap.faces.filter(
    (x) => x.image_id === imgId && matchesStatusFilter(x.link_status, faceFilter)
  )) {
    const arr = byPerson.get(f.person_id) ?? [];
    arr.push(f);
    byPerson.set(f.person_id, arr);
  }
  return [...byPerson.entries()].map(([pid, fl]) => {
    const p = pid != null ? personsById.get(pid) : undefined;
    return {
      key: `img-${pid}`,
      title: p?.name ?? "unassigned",
      faceIds: fl.map((f) => f.id),
      ruleDefaultName: p?.name,
      // #153: the rename keeps the person's current group path
      ruleDefaultGroup: renameGroupFor(p),
    };
  });
}

/** the centre pane's sections for the CURRENT view — one call per
    render-time memo in App; every branch is deterministic over the
    snapshot and the screen state. */
export function buildSections(inp: SectionInputs): Section[] {
  const { snap, mode, imageId, personId, selectedPerson, clusters,
          facesById, faceFilter, clusterGroup, stagedIdx,
          sectionsForImage } = inp;
  if (!snap) return [];
  if (imageId != null) {
    // §4.24: an open image owns the pane — its filter-pass faces grouped
    // by person, whatever mode opened it (the detail is its own context)
    return sectionsForImage(imageId);
  }
  if (mode === "person" && personId != null) {
    const out: Section[] = [];
    const pname = selectedPerson?.name ?? "";
    const rg = renameGroupFor(selectedPerson ?? undefined);
    if (clusterGroup === "description") {
      // #99 Description mode: one section per distinct description over
      // the visible faces — no similarity split, no clusters IPC.
      // #155: the §4.24 staged preview drives the grouping too — a face
      // with a staged description is grouped under the description it
      // will land in on Accept (Apply = screen preview), instead of
      // showing the staged label under the old committed section (#224:
      // the staged desc is an O(1) index read now)
      const visible = snap.faces.filter(
        (f) =>
          f.person_id === personId &&
          f.state !== "discarded" &&
          f.link_status !== "rejected" &&
          matchesStatusFilter(f.link_status, faceFilter)
      );
      groupByDescription(
        visible.map((f) => ({
          id: f.id,
          // F2 keeps rejected-touching ops out of the pending set, and
          // rejected faces never reach this branch
          description:
            stagedIdx?.get(f.id)?.desc ??
            f.description ??
            ""
        }))
      ).forEach((g) => {
        out.push({
          key: `pd-${personId}-${g.description}`,
          title: g.description || "(no description)",
          description: g.description || undefined,
          faceIds: g.faceIds,
          ruleDefaultName: pname,
          // #153: the rename keeps the person's current group path
          ruleDefaultGroup: rg,
        });
      });
    } else {
      const groups = clusters ?? [];
      const multi = groups.length > 1;
      let n = 0;
      groups.forEach((g, gi) => {
        g.clusters.forEach((cl, ci) => {
          // #99: the filter may empty a cluster — drop it and recompute
          // the similarity claim over the faces that survive
          const ids = cl
            .map((c) => c.face_id)
            .filter((id) => {
              const f = facesById.get(id);
              return f != null && matchesStatusFilter(f.link_status, faceFilter);
            });
          if (ids.length === 0) return;
          n += 1;
          const kept = new Set(ids);
          const minSim = Math.min(
            ...cl.filter((c) => kept.has(c.face_id)).map((c) => c.sim)
          );
          // appearance prefix only when the person has more than one (§4.9)
          const prefix = multi && g.description ? `${g.description} — ` : "";
          out.push({
            key: `cl-${gi}-${ci}`,
            title:
              n === 1
                ? `${prefix}Group 1 — closest to primary`
                : `${prefix}Group ${n}`,
            subtitle: `≥ ${Math.round(minSim * 100)}% similar to primary`,
            faceIds: ids,
            ruleDefaultName: pname,
            // #101: the heading's description label shows the
            // appearance (display only — the title stays cluster-derived,
            // F6)
            description: g.description || undefined,
            // #153: the rename keeps the person's current group path
            ruleDefaultGroup: rg,
          });
        });
      });
    }
    if (matchesStatusFilter("rejected", faceFilter)) {
      const rej = snap.faces.filter(
        (f) => f.person_id === personId && f.link_status === "rejected"
      );
      if (rej.length > 0)
        out.push({ key: "rejected", title: "Rejected", faceIds: rej.map((f) => f.id) });
    }
    return out;
  }
  // review (and any other non-person, non-image view): the pending set
  // under All/Provisional (#99), or the status picked in the filter —
  // grouped by importer person, UnknownN first
  const reviewStatus =
    faceFilter === "confirmed" || faceFilter === "rejected" ? faceFilter : "provisional";
  const byPerson = new Map<number | null, Face[]>();
  for (const f of snap.faces.filter((x) => x.link_status === reviewStatus)) {
    const arr = byPerson.get(f.person_id) ?? [];
    arr.push(f);
    byPerson.set(f.person_id, arr);
  }
  const order = [...snap.persons].sort((a, b) => {
    const au = a.name.startsWith("Unknown");
    const bu = b.name.startsWith("Unknown");
    if (au !== bu) return au ? -1 : 1;
    return a.id - b.id;
  });
  return order
    .filter((p) => byPerson.has(p.id))
    .map((p) => ({
      key: `rev-${p.id}`,
      title: p.name,
      subtitle: p.counts.total > byPerson.get(p.id)!.length ? `${p.counts.total} faces total` : undefined,
      faceIds: byPerson.get(p.id)!.map((f) => f.id),
      // #165/§4.35/#266: the reject-bin persons' reserved names never
      // prefill — committing a claim needs a typed name
      ruleDefaultName: isRejectedBin(p.name) ? "" : p.name,
      // #153: the rename keeps the person's current group path
      ruleDefaultGroup: renameGroupFor(p),
    }));
}
