// #262 (§4.21) — the Edit dialog's Description field has type-ahead over
// the existing description tags: substring match, pick inserts the tag,
// and in `|` add mode the leading `|` is stripped for matching and a
// pick keeps it (`|b` → pick `beard` → `|beard`).
// Run: npm test (vitest run; jsdom pragma — a mounted component)
// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import EditDialog from "./EditDialog";
import type { SuggestOption } from "./SuggestInput";

afterEach(cleanup);

const DESC = "e.g. beard|glasses";

const renderDialog = (descOptions: SuggestOption[]) =>
  render(
    <EditDialog
      defaultScope="selection"
      counts={{ card: 0, group: 0, selection: 2 }}
      rejected={{ card: false, group: false, selection: false }}
      prefills={{ card: {}, group: {}, selection: {} }}
      persons={[]}
      pathOptions={[]}
      descOptions={descOptions}
      onDone={() => {}}
      onReject={() => {}}
      onCancel={() => {}}
    />
  );

const descInput = () => screen.getByPlaceholderText(DESC) as HTMLInputElement;

describe("Edit dialog description type-ahead (#262, §4.21)", () => {
  const options: SuggestOption[] = [
    { value: "beard", hint: "3" },
    { value: "glasses", hint: "2" },
  ];

  it("typing suggests existing tags", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "be" } });
    expect(screen.getByRole("option", { name: /beard/ })).toBeTruthy();
  });

  it("a pick inserts the tag for the typed text", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "be" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /beard/ }));
    expect(descInput().value).toBe("beard");
  });

  it("in | add mode the prefix is stripped for matching…", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "|be" } });
    expect(screen.getByRole("option", { name: /beard/ })).toBeTruthy();
  });

  it("…and a pick keeps the | prefix", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "|be" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /beard/ }));
    expect(descInput().value).toBe("|beard");
  });

  it("an exact typed tag shows no dropdown (the widget's contract)", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "beard" } });
    expect(screen.queryByRole("option")).toBeNull();
  });

  // #270: compounds build incrementally — the match is the CURRENT
  // token (after the last |), a pick replaces only that token
  it("typing a second token matches over that token only", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "beard|g" } });
    expect(screen.getByRole("option", { name: /glasses/ })).toBeTruthy();
    // the first token's tag is not re-offered for the second token
    expect(screen.queryByRole("option", { name: /beard/ })).toBeNull();
  });

  it("a pick replaces only the current token (prefix kept)", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "beard|g" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /glasses/ }));
    expect(descInput().value).toBe("beard|glasses");
  });

  it("the full flow: b → beard, then |g → glasses → beard|glasses", () => {
    renderDialog(options);
    fireEvent.change(descInput(), { target: { value: "b" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /beard/ }));
    expect(descInput().value).toBe("beard");
    fireEvent.change(descInput(), { target: { value: "beard|g" } });
    fireEvent.mouseDown(screen.getByRole("option", { name: /glasses/ }));
    expect(descInput().value).toBe("beard|glasses");
  });
});
