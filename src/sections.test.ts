// §4.44 (gui-design v3.94) — the centre-pane section derivations are
// pure; this suite pins the grouping rules the grid runs on:
//   §4.24  the image detail / focus film roll (by person, Show-filtered)
//   §4.30  the review grouping (importer person, UnknownN first)
//   §4.9   the person view in both cluster-group modes
//   §4.35  the rejected section + the system person's empty rule default
//   #155   the staged (§4.24) description drives the Description regroup
import { describe, expect, it } from "vitest";
import { buildSections, sectionsForImage } from "./sections";
import type { SectionInputs } from "./sections";
import type { AppearanceGroup, Face, ImageRow, Person, Snapshot } from "./api";
import type { Stage } from "./stage";

let nextId = 100;

function face(o: {
  id?: number;
  image?: number;
  person?: number | null;
  status?: string;
  desc?: string | null;
  state?: string;
}): Face {
  const id = o.id ?? nextId++;
  const f: Face = {
    id,
    image_id: o.image ?? 9,
    person_id: o.person ?? 1,
    x: 0, y: 0, w: 1, h: 1,
    name: "ignored",
    seq: 0,
    description: o.desc ?? null,
    confidence: 0,
    link_status: o.status ?? "provisional",
    state: o.state ?? "live",
    rotation: 0,
    import_id: null,
    created_at: "",
  };
  return { ...f, person_id: o.person === undefined ? 1 : o.person };
}

function person(
  id: number,
  name: string,
  counts: { total: number; provisional?: number; confirmed?: number; rejected?: number },
  groups: string[] = [],
): Person {
  return {
    id,
    name,
    state: "active",
    note: null,
    primary_face_id: null,
    primary_pinned: 0,
    created_at: "",
    groups,
    counts: {
      total: counts.total,
      provisional: counts.provisional ?? 0,
      confirmed: counts.confirmed ?? 0,
      rejected: counts.rejected ?? 0,
    },
  };
}

const EMPTY_IMAGE: ImageRow = {
  id: 9, primary_path: "/roll/a.jpg", width: 10, height: 10,
  orientation: null, rotation: 0, rtype: null, state: "imported",
  first_import_id: null, last_import_id: null,
};

function snap(persons: Person[], faces: Face[]): Snapshot {
  return {
    persons,
    faces,
    images: [EMPTY_IMAGE],
    imports: [],
    settings: {
      cluster_threshold: 0.4,
      refcrop_n: 5,
      face_filter: "all",
      cluster_group: "accuracy",
      merge_name_distance: 1,
      merge_suffix_aliases: [],
    },
  };
}

// fixtures the default input reads — reset per test
let personsFixture: Person[] = [];
let facesFixture: Face[] = [];
let personsByIdFixture = new Map<number, Person>();

function resetFixtures(persons: Person[], faces: Face[]) {
  personsFixture = persons;
  facesFixture = faces;
  personsByIdFixture = new Map(persons.map((p) => [p.id, p]));
}

/** buildSections over the fixture snapshot, with the given overrides */
function build(over: Partial<SectionInputs> = {}) {
  return buildSections({
    mode: "review",
    imageId: null,
    personId: null,
    selectedPerson: null,
    clusters: null,
    faceFilter: "all",
    clusterGroup: "accuracy",
    pending: [] as Stage[],
    snap: snap(personsFixture, facesFixture),
    facesById: new Map(facesFixture.map((f) => [f.id, f])),
    // the §4.24 branch only matters inside this suite when imageId is set;
    // App's wrapper is identity-stable, the tests only need correctness
    sectionsForImage: (imgId) =>
      sectionsForImage(
        snap(personsFixture, facesFixture),
        personsByIdFixture,
        imgId,
        over.faceFilter ?? "all",
      ),
    ...over,
  });
}

// ---------------------------------------------------------------- §4.24

describe("sectionsForImage (image detail, §4.24)", () => {
  it("groups the image's visible faces by person; hides status-filtered ones", () => {
    const s = snap(
      [person(1, "Anna", { total: 2 }), person(2, "Bert", { total: 1 })],
      [
        face({ image: 9, person: 1, status: "provisional" }),
        face({ image: 9, person: 1, status: "confirmed" }),
        face({ image: 9, person: 2, status: "rejected" }),
      ],
    );
    // All: everything except rejected (§4.10) — Bert's only face is hidden
    const all = sectionsForImage(s, new Map(s.persons.map((p) => [p.id, p])), 9, "all");
    expect(all.map((x) => x.title)).toEqual(["Anna"]);
    expect(all[0]).toMatchObject({
      key: "img-1",
      faceIds: expect.any(Array),
      ruleDefaultName: "Anna",
    });
    expect(all[0].faceIds).toHaveLength(2);
    // Rejected: Bert's rejected face is the only visible one
    const rej = sectionsForImage(s, new Map(s.persons.map((p) => [p.id, p])), 9, "rejected");
    expect(rej.map((x) => x.title)).toEqual(["Bert"]);
    expect(rej[0].faceIds).toHaveLength(1);
  });

  it("orphan faces land in the 'unassigned' section", () => {
    const s = snap(
      [person(1, "Anna", { total: 1 })],
      [face({ image: 9, person: 1 }), face({ image: 9, person: null })],
    );
    const out = sectionsForImage(s, new Map(s.persons.map((p) => [p.id, p])), 9, "all");
    expect(out.map((x) => x.title)).toEqual(["Anna", "unassigned"]);
    expect(out[1].ruleDefaultName).toBeUndefined();
  });

  it("the group default keeps the person's path, never a status seat (#153/#178)", () => {
    const s = snap(
      [person(3, "Anna", { total: 1 }, ["Family|Rossouw|gen1"])],
      [face({ image: 9, person: 3 })],
    );
    const out = sectionsForImage(s, new Map(s.persons.map((p) => [p.id, p])), 9, "all");
    expect(out[0].ruleDefaultGroup).toBe("Family|Rossouw|gen1");
    // a New-seat person's seat is never prefiled into a group field
    const st = snap(
      [person(4, "Unknown9", { total: 1 }, ["New"])],
      [face({ image: 9, person: 4 })],
    );
    const out2 = sectionsForImage(st, new Map(st.persons.map((p) => [p.id, p])), 9, "all");
    expect(out2[0].ruleDefaultGroup).toBe("");
  });
});

// ---------------------------------------------------------------- §4.30

describe("review grouping (§4.30)", () => {
  it("groups the review-status faces by importer person, UnknownN first, then id", () => {
    resetFixtures(
      [
        person(3, "Anna", { total: 5 }),
        person(5, "Unknown1", { total: 1 }),
        person(7, "Unknown2", { total: 1 }),
      ],
      [
        face({ person: 3, status: "provisional" }),
        face({ person: 3, status: "provisional" }),
        face({ person: 5, status: "provisional" }),
        face({ person: 7, status: "provisional" }),
        face({ person: 3, status: "confirmed" }),
      ],
    );
    const out = build({ mode: "review" });
    expect(out.map((x) => x.key)).toEqual(["rev-5", "rev-7", "rev-3"]);
    // Unknown1: 1 section face == 1 total → no subtitle; Anna: 2 of 5 → subtitle
    expect(out[0].subtitle).toBeUndefined();
    expect(out[2].subtitle).toBe("5 faces total");
    expect(out[2].ruleDefaultName).toBe("Anna");
  });

  it("the Show filter picks the review status: accepted-only grouping", () => {
    resetFixtures(
      [person(3, "Anna", { total: 2 })],
      [
        face({ person: 3, status: "provisional" }),
        face({ person: 3, status: "confirmed" }),
      ],
    );
    const out = build({ mode: "review", faceFilter: "confirmed" });
    expect(out).toHaveLength(1);
    expect(out[0].faceIds).toHaveLength(1); // only the confirmed face
  });

  it("personless faces still render (legacy rows, 'unassigned' bucket is review-side too)", () => {
    resetFixtures(
      [],
      [face({ person: null, status: "provisional" })],
    );
    const out = build({ mode: "review" });
    // no person row can hold them — they render no section, nothing crashes
    expect(out).toEqual([]);
  });
});

// ---------------------------------------------------------------- §4.35

describe("the system person's rule defaults (§4.35)", () => {
  it("Show → Rejected keeps rejected faces grouped, Rejected's default name is never prefilled", () => {
    resetFixtures(
      [
        person(99, "Rejected", { total: 2 }),
        person(3, "Anna", { total: 1 }),
      ],
      [
        face({ person: 99, status: "rejected" }),
        face({ person: 99, status: "rejected" }),
        face({ person: 3, status: "rejected" }),
      ],
    );
    const out = build({ mode: "review", faceFilter: "rejected" });
    // order: neither name starts Unknown → both by id
    expect(out.map((x) => x.key)).toEqual(["rev-3", "rev-99"]);
    expect(out[1].ruleDefaultName).toBe(""); // a claim needs a typed name
    expect(out[0].ruleDefaultName).toBe("Anna");
  });
});

// ---------------------------------------------------------------- §4.9

describe("person view — accuracy mode (§4.9)", () => {
  const twoAps: AppearanceGroup[] = [
    { description: "hat", clusters: [[{ face_id: 11, sim: 0.9 }, { face_id: 12, sim: 0.5 }] ] },
    { description: "", clusters: [[{ face_id: 13, sim: 0.84 }]] },
  ];

  it("clusters become sections: appearance prefix over 1, min-sim subtitle, 'closest to primary' first", () => {
    resetFixtures(
      [person(1, "Anna", { total: 3 })],
      [
        face({ id: 11, person: 1, status: "confirmed" }),
        face({ id: 12, person: 1, status: "confirmed" }),
        face({ id: 13, person: 1, status: "confirmed" }),
      ],
    );
    const out = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusters: twoAps,
    });
    expect(out.map((x) => [x.key, x.title])).toEqual([
      ["cl-0-0", "hat — Group 1 — closest to primary"],
      ["cl-1-0", "Group 2"],
    ]);
    expect(out[0].subtitle).toBe("≥ 50% similar to primary");
    expect(out[0].description).toBe("hat");
    expect(out[1].description).toBeUndefined();
  });

  it("the filter may empty a cluster — dropped; section numbering restarts over survivors", () => {
    resetFixtures(
      [person(1, "Anna", { total: 3 })],
      [
        face({ id: 11, person: 1, status: "rejected" }),
        face({ id: 12, person: 1, status: "confirmed" }),
        face({ id: 13, person: 1, status: "confirmed" }),
      ],
    );
    const single: AppearanceGroup[] = [
      { description: "", clusters: [
        [{ face_id: 11, sim: 0.9 }],                       // all-rejected → drops
        [{ face_id: 12, sim: 0.7 }, { face_id: 13, sim: 0.8 }],
      ] },
    ];
    const out = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusters: single,
    });
    // §4.9: the emptied cluster leaves, and the survivor is renumbered "Group 1"
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Group 1 — closest to primary");
    expect(out[0].faceIds).toEqual([12, 13]);
    expect(out[0].subtitle).toBe("≥ 70% similar to primary");
  });

  it("the rejected section appears only while the filter shows rejected (§4.10)", () => {
    resetFixtures(
      [person(1, "Anna", { total: 2 })],
      [
        face({ id: 11, person: 1, status: "confirmed" }),
        face({ id: 14, person: 1, status: "rejected" }),
      ],
    );
    const clusters: AppearanceGroup[] = [
      { description: "", clusters: [[{ face_id: 11, sim: 0.9 }]] },
    ];
    // All — everything except rejected (§4.10): the rejected section is absent
    const all = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusters,
    });
    expect(all.map((x) => x.key)).toEqual(["cl-0-0"]);
    // Show → Rejected: rejected faces join — the section is appended last
    const rej = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusters,
      faceFilter: "rejected",
    });
    expect(rej.map((x) => x.key)).toEqual(["rejected"]);
    expect(rej[0].faceIds).toEqual([14]);
    const prov = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusters,
      faceFilter: "provisional",
    });
    expect(prov.map((x) => x.key)).toEqual([]);
  });

  it("a person without clusters state gets no similarity sections (IPC still loading)", () => {
    resetFixtures(
      [person(1, "Anna", { total: 1 })],
      [face({ person: 1, status: "confirmed" })],
    );
    const out = build({ mode: "person", personId: 1, selectedPerson: personsByIdFixture.get(1)! });
    expect(out).toEqual([]);
  });
});

describe("person view — description mode (§4.9, #155)", () => {
  it("one section per distinct description; faces group under the STAGED description when one is live", () => {
    resetFixtures(
      [person(1, "Anna", { total: 3 }, ["Friends"])],
      [
        face({ id: 11, person: 1, status: "confirmed", desc: "hat" }),
        face({ id: 12, person: 1, status: "provisional", desc: null }),
        face({ id: 13, person: 1, status: "provisional", desc: "beard|glasses" }),
        face({ id: 14, person: 1, status: "provisional", desc: null, state: "discarded" }),
      ],
    );
    // a live stage moves face 12 into "hat" (Apply = screen preview, §4.24)
    const out = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusterGroup: "description",
      pending: [{ faceIds: [12], desc: "hat" }],
    });
    expect(out.map((x) => [x.title, x.faceIds])).toEqual([
      ["hat", [11, 12]],
      ["beard|glasses", [13]],
    ]);
    // rule defaults carry the person + their real group path (#153)
    expect(out[0].ruleDefaultName).toBe("Anna");
    expect(out[0].ruleDefaultGroup).toBe("Friends");
    // no pending stage: 12 is its own "(no description)" section
    const bare = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusterGroup: "description",
    });
    expect(bare.map((x) => x.title)).toEqual(["hat", "beard|glasses", "(no description)"]);
  });

  it("rejected and discarded faces never reach the Description grouping", () => {
    resetFixtures(
      [person(1, "Anna", { total: 3 })],
      [
        face({ id: 11, person: 1, status: "rejected", desc: "x" }),
        face({ id: 12, person: 1, status: "provisional", desc: null }),
        face({ id: 13, person: 1, status: "confirmed", desc: null }),
      ],
    );
    const out = build({
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      clusterGroup: "description",
    });
    // both survivor faces are description-less → ONE "(no description)"
    // section holds them (groupByDescription buckets by description)
    expect(out.map((x) => [x.title, x.faceIds])).toEqual([["(no description)", [12, 13]]]);
  });
});

// ------------------------------------------------------- branch priority

describe("view branch priority", () => {
  it("an open image owns the pane even in person mode (§4.24)", () => {
    const s = snap(
      [person(1, "Anna", { total: 1 })],
      [
        face({ image: 9, person: 1 }),
        face({ image: 20, person: 1, id: 300 }),
      ],
    );
    resetFixtures(s.persons, s.faces);
    let imgCalls: number[] = [];
    const out = build({
      snap: s,
      mode: "person",
      personId: 1,
      selectedPerson: personsByIdFixture.get(1)!,
      imageId: 9,
      sectionsForImage: (imgId) => {
        imgCalls.push(imgId);
        return [{ key: "img-1", title: "Anna", faceIds: [11] }];
      },
    });
    expect(out).toEqual([{ key: "img-1", title: "Anna", faceIds: [11] }]);
    expect(imgCalls).toEqual([9]);
  });

  it("no snapshot → no sections (the loading guard)", () => {
    resetFixtures([], []);
    expect(build({ snap: null, mode: "review" })).toEqual([]);
  });
});
