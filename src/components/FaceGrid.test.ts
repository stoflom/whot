// Section-heading blur rule (#93, gui-design §4.24): a blur that lands
// inside the same heading is not a context change — the heading's inputs
// wait for Enter/apply; focus leaving (or going nowhere) commits.
// Run: npm test (vitest run)
import { describe, expect, it } from "vitest";
import { focusLeftHeading } from "./FaceGrid";

const nameInput = {} as Node;
const groupInput = {} as Node;
const applyButton = {} as Node;
const card = {} as Node;

function heading(members: Node[]): Pick<HTMLElement, "contains"> {
  return { contains: (n: Node | null) => n != null && members.includes(n) };
}

describe("focusLeftHeading", () => {
  it("stays inside: name → group → apply within one heading does not commit (#93)", () => {
    const head = heading([nameInput, groupInput, applyButton]);
    expect(focusLeftHeading(groupInput, head)).toBe(false);
    expect(focusLeftHeading(nameInput, head)).toBe(false);
    expect(focusLeftHeading(applyButton, head)).toBe(false);
  });

  it("leaves: another card or another heading commits — context moves on", () => {
    expect(focusLeftHeading(card, heading([groupInput]))).toBe(true);
  });

  it("no focus target (click-away on a card/page area) commits", () => {
    expect(focusLeftHeading(null, heading([groupInput]))).toBe(true);
    expect(focusLeftHeading(null, null)).toBe(true);
    expect(focusLeftHeading(card, null)).toBe(true);
  });
});
