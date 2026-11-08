// #262 (§4.21) — the description type-ahead vocabulary: distinct tags of
// the snapshot's face descriptions, most-used first, ties by name, count
// as the hint.
import { describe, expect, it } from "vitest";
import type { Face } from "./api";
import { descTagOptions } from "./descTags";

const face = (description: string | null): Face =>
  ({ description } as Face);

describe("descTagOptions (#262, §4.21)", () => {
  it("collects distinct tags, most-used first, ties by name, count as hint", () => {
    const faces = [
      face("beard|glasses"),
      face("beard"),
      face("glasses | hat"),
      face("beard"),
      face(null),
      face(""),
    ];
    expect(descTagOptions(faces)).toEqual([
      { value: "beard", hint: "3" },
      { value: "glasses", hint: "2" },
      { value: "hat", hint: "1" },
    ]);
  });

  it("trims tokens and drops empties", () => {
    expect(descTagOptions([face("  beard |  |glasses ")])).toEqual([
      { value: "beard", hint: "1" },
      { value: "glasses", hint: "1" },
    ]);
  });

  it("no faces → no options", () => {
    expect(descTagOptions([])).toEqual([]);
  });
});
