// #156 (gui-design §4.16 multi-group placement). Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import type { Person } from "./api";
import { orderedVisiblePersonIds } from "./components/PersonTree";

function person(
  id: number,
  name: string,
  groups: string[],
  total = 1
): Person {
  return {
    id,
    name,
    state: "imported",
    note: null,
    primary_face_id: null,
    primary_pinned: 0,
    created_at: "",
    groups,
    counts: { total, provisional: 0, confirmed: 0, rejected: 0 },
  } as Person;
}

describe("orderedVisiblePersonIds — multi-group placement (#156, v3.56)", () => {
  const persons = [
    person(1, "Burgit Oosthuizen", ["Friends", "Friends|PHS"], 19),
    person(2, "Esther Buchanan", ["Friends", "Friends|PHS"], 30),
    person(3, "Mary", ["Family|Lombard-PaMa|Friends"], 2),
    person(4, "Solo", [], 1),
  ];

  it("a multi-group person is stepped once, not once per placement", () => {
    const ids = orderedVisiblePersonIds(persons, "");
    expect(ids.filter((id) => id === 1).length).toBe(1);
    expect(ids.filter((id) => id === 2).length).toBe(1);
    expect(ids.filter((id) => id === 3).length).toBe(1);
  });

  it("every person is still reachable in the step list", () => {
    expect(orderedVisiblePersonIds(persons, "").sort()).toEqual([1, 2, 3, 4]);
  });

  it("the filter keeps working across all placements of a person", () => {
    // name filter
    expect(orderedVisiblePersonIds(persons, "burgit")).toEqual([1]);
    // group-path filter matches persons whose ANY row matches ('PHS')
    expect(orderedVisiblePersonIds(persons, "PHS").sort()).toEqual([1, 2]);
    // single-group person unaffected
    expect(orderedVisiblePersonIds(persons, "Lombard-PaMa")).toEqual([3]);
  });
});
