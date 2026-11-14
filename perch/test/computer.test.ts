
import { describe, it, expect } from "vitest";
import { looksConsequential, pickBox, modeOf } from "../src/computer/session.js";

describe("computer policy", () => {
  it("gates labelled submissions", () => {
    for (const l of ["Send", "Place order", "Delete", "Publish", "Pay now", "Save changes"])
      expect(looksConsequential(l)).toBe(true);
  });

  it("lets navigation through", () => {
    for (const l of ["File", "Edit", "Back", "Next", "Search", "Inbox", "Help"])
      expect(looksConsequential(l)).toBe(false);
  });

  it("gates cmd+return but not bare return", () => {
    expect(looksConsequential(null, "cmd+return")).toBe(true);
    expect(looksConsequential(null, "return")).toBe(false);
  });

  it("prefers exact and tight label matches", () => {
    const boxes = [
      { text: "Send a message", x: 0, y: 0, w: 400, h: 20 },
      { text: "Send", x: 10, y: 40, w: 60, h: 22 },
    ];
    expect(pickBox(boxes, "send")?.text).toBe("Send");
  });

  it("honours the hoot mode, defaulting to confirm when enabled", () => {
    expect(modeOf({ computer_mode: "off" })).toBe("off");
    expect(modeOf({ computer_mode: "auto" })).toBe("auto");
    expect(["confirm", "off"]).toContain(modeOf({ computer_mode: null }));
  });
});
