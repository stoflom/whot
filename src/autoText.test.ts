// Group-dialog open modes (#92, gui-design §4.18).
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { groupInputMode } from "./autoText";

describe("groupInputMode", () => {
  it("appends after a '|'-terminated parent prefill (right-click → Add group…)", () => {
    expect(groupInputMode("family|")).toBe("append");
    expect(groupInputMode("family|lombards|")).toBe("append");
  });

  it("replaces a whole structural path (rename/move a branch, move persons)", () => {
    expect(groupInputMode("family|lombards")).toBe("replace");
    expect(groupInputMode("Unknown")).toBe("replace");
  });

  it("treats the empty top-level prefill as replace (select-all is a no-op)", () => {
    expect(groupInputMode("")).toBe("replace");
    expect(groupInputMode("  ")).toBe("replace");
  });
});
