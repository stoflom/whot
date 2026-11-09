// #262/#270 (§4.21) — the description type-ahead: the vocabulary
// (distinct tags of the snapshot's face descriptions, most-used first,
// ties by name, count as the hint) and the current-token value rules.
import { describe, expect, it } from "vitest";
import type { Face } from "./api";
import { descApplyPick, descCurrentToken, descTagOptions } from "./descTags";

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

describe("descCurrentToken (#270, §4.21)", () => {
  it("no | → the whole trimmed value is the token", () => {
    expect(descCurrentToken("beard")).toBe("beard");
    expect(descCurrentToken("  side ")).toBe("side");
    expect(descCurrentToken("")).toBe("");
  });

  it("a compound → the text after the LAST |", () => {
    expect(descCurrentToken("beard|s")).toBe("s");
    expect(descCurrentToken("beard|glasses|h")).toBe("h");
  });

  it("the | add-mode prefix is just a leading last-|", () => {
    expect(descCurrentToken("|b")).toBe("b");
    expect(descCurrentToken("|beard|s")).toBe("s");
  });

  it("a bare trailing | → empty token (nothing to match)", () => {
    expect(descCurrentToken("beard|")).toBe("");
  });
});

describe("descApplyPick (#270, §4.21)", () => {
  it("no | → the pick replaces the whole value", () => {
    expect(descApplyPick("b", "beard")).toBe("beard");
  });

  it("a compound → only the current token is replaced", () => {
    expect(descApplyPick("beard|s", "side")).toBe("beard|side");
    expect(descApplyPick("beard|glasses|h", "hat")).toBe("beard|glasses|hat");
  });

  it("the | add-mode prefix survives the pick", () => {
    expect(descApplyPick("|b", "beard")).toBe("|beard");
    expect(descApplyPick("|beard|s", "side")).toBe("|beard|side");
  });

  it("the user's exact flow: b → beard, then |s → side → beard|side", () => {
    let v = descApplyPick("b", "beard"); // type b, pick beard
    expect(v).toBe("beard");
    v = descApplyPick(`${v}|s`, "side"); // type |s, pick side
    expect(v).toBe("beard|side");
  });
});
