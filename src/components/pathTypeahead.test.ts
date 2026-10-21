// #97 (§4.21) — group-path suggestion options.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { groupPathOptions } from "./PathTypeahead";

const persons = [
  { groups: ["family|lombards"] },
  { groups: ["family|lombards"] }, // duplicate collapses
  { groups: [] }, // ungrouped person — no path contributed
  { groups: ["travel"] },
  { groups: ["family"] }, // first segment also exists on its own
];

describe("groupPathOptions", () => {
  it("collects the distinct non-empty paths, sorted, plus 'ungrouped'", () => {
    expect(groupPathOptions(persons)).toEqual([
      { value: "family" },
      { value: "family|lombards" },
      { value: "travel" },
      { value: "", label: "ungrouped" },
    ]);
  });

  it("the ungrouped entry inserts '' — a literal 'Ungrouped' path is illegal", () => {
    const opts = groupPathOptions([]);
    const last = opts[opts.length - 1];
    expect(last.value).toBe("");
    expect(last.label).toBe("ungrouped");
  });
});
