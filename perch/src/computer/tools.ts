// Tools the model uses to drive the machine. Guardrails live here: actions get
// audited with screenshots, and consequential ones go through the approval gate.
import { db, now, uuid } from "../db.js";
import type { ToolDef } from "../model.js";
import type { OcrBox } from "./driver.js";
import { boxCentre, looksConsequential, pickBox, recordStep, requestApproval, type Session } from "./session.js";

const describeWindows = async (session: Session) => {
  const wins = await session.driver.windows();
  session.lastWindows = wins.map((w) => w.app);
  return wins.slice(0, 20);
};

export function computerTools(getSession: (turnId: string) => Session | null): ToolDef[] {
  const withSession = <A>(fn: (s: Session, args: A, ctx: any) => Promise<unknown>) =>
    async (args: A, ctx: any) => {
      const session = getSession(ctx.turnId);
      if (!session) throw new Error("computer control is off for this hoot");
      if (session.mode === "off") throw new Error("computer control is off for this hoot");
      return fn(session, args, ctx);
    };

  return [
    {
      name: "screen",
      description:
        "Look at the screen. Returns window list plus OCR text with coordinates. Call this first and after every action that changes the screen. Optionally crop with a region.",
      parameters: {
        type: "object",
        properties: {
          x: { type: "number" },
          y: { type: "number" },
          w: { type: "number" },
          h: { type: "number" },
        },
      },
      execute: withSession(async (s: Session, args: any) => {
        const windows = await describeWindows(s);
        const front = windows.find((w) => w.focused && w.bounds.w > 120) ?? windows.find((w) => w.bounds.w > 200) ?? windows[0];
        // Only the frontmost window matters; the desktop behind is noise.
        const region = args.w != null
          ? { x: args.x ?? 0, y: args.y ?? 0, w: args.w, h: args.h }
          : front
            ? front.bounds
            : { x: 0, y: 0, w: 4000, h: 4000 };
        const boxes: OcrBox[] = await s.driver.ocr(region);
        const step = await recordStep(s, "look", region === front?.bounds ? front.app : "region");
        return {
          step: s.steps,
          shot: step.shotId,
          window: front ? { app: front.app, title: front.title.slice(0, 70), bounds: front.bounds } : null,
          other_windows: windows.filter((w) => w !== front).slice(0, 5).map((w) => w.app),
          focused: !!front?.focused,
          text: boxes
            .slice(0, 60)
            .map((b) => ({ text: b.text.slice(0, 55), x: b.x + Math.round(b.w / 2), y: b.y + Math.round(b.h / 2) })),
        };
      }),
    },
    {
      name: "activate_app",
      description: "Bring an application to the front by name (e.g. Safari, Notes, Finder).",
      parameters: { type: "object", properties: { app: { type: "string" } }, required: ["app"] },
      execute: withSession(async (s: Session, args: any) => {
        try {
          await s.driver.activate(args.app);
        } catch (err: any) {
          return { ok: false, error: `activate failed: ${err?.message ?? err}` };
        }
        await new Promise((r) => setTimeout(r, 700));
        const step = await recordStep(s, "activate", args.app);
        return { ok: true, summary: step.summary, shot: step.shotId };
      }),
    },
    {
      name: "open_url",
      description: "Open a URL in the default browser.",
      parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
      execute: withSession(async (s: Session, args: any) => {
        await s.driver.openUrl(args.url);
        await new Promise((r) => setTimeout(r, 1200));
        const step = await recordStep(s, "open", args.url);
        return { ok: true, summary: step.summary, shot: step.shotId };
      }),
    },
    {
      name: "click",
      description:
        "Click. Prefer `label` (matched against on-screen text) over raw coordinates; coordinates come from screen. Consequential clicks (Send/Submit/Pay/Delete…) pause for approval unless the hoot is in auto mode.",
      parameters: {
        type: "object",
        properties: {
          label: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          button: { type: "string", enum: ["left", "right", "middle"] },
          clicks: { type: "number" },
        },
      },
      execute: withSession(async (s: Session, args: any) => {
        let point: { x: number; y: number } | null =
          args.x != null && args.y != null ? { x: args.x, y: args.y } : null;
        let label: string | null = args.label ?? null;
        if (!point && label) {
          // Search the focused window first; only fall back to the full screen.
          const wins = await s.driver.windows();
          const front = wins.find((w) => w.focused && w.bounds.w > 120);
          const box =
            (front && pickBox(await s.driver.ocr(front.bounds), label)) ||
            pickBox(await s.driver.ocr({ x: 0, y: 0, w: 4000, h: 4000 }), label);
          if (!box) return { ok: false, reason: `no on-screen text matching "${label}"` };
          point = boxCentre(box);
          label = box.text;
        }
        if (!point) return { ok: false, reason: "need label or x/y" };
        const risky = looksConsequential(label);
        if (risky) {
          const decision = await requestApproval(s, `Click “${label}” at ${point.x},${point.y}`, "submit");
          if (decision !== "approved") return { ok: false, approved: false, decision };
        }
        try {
          await s.driver.click({ ...point, button: args.button ?? "left", clicks: Math.min(3, args.clicks ?? 1) });
        } catch (err: any) {
          return { ok: false, error: `click failed: ${err?.message ?? err}`, at: point };
        }
        await new Promise((r) => setTimeout(r, 450));
        const step = await recordStep(s, risky ? "submit" : "click", label ?? `${point.x},${point.y}`);
        return { ok: true, at: point, label, summary: step.summary, shot: step.shotId };
      }),
    },
    {
      name: "type_text",
      description: "Type text into whatever is focused.",
      parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      execute: withSession(async (s: Session, args: any) => {
        const text = String(args.text ?? "");
        await s.driver.type(text);
        const step = await recordStep(s, "type", text.length > 80 ? text.slice(0, 80) + "…" : text, { shot: false });
        return { ok: true, chars: text.length, summary: step.summary };
      }),
    },
    {
      name: "press_key",
      description:
        "Press a key or chord: `return`, `escape`, `tab`, `cmd+t`, `cmd+shift+tab`, `up`. Enter counts as consequential (it submits forms).",
      parameters: { type: "object", properties: { chord: { type: "string" } }, required: ["chord"] },
      execute: withSession(async (s: Session, args: any) => {
        const chord = String(args.chord ?? "");
        const risky = looksConsequential(null, chord);
        if (risky) {
          const decision = await requestApproval(s, `Press ${chord} (submits the focused field)`, "submit");
          if (decision !== "approved") return { ok: false, approved: false, decision };
        }
        await s.driver.key(chord);
        await new Promise((r) => setTimeout(r, 320));
        const step = await recordStep(s, risky ? "submit" : "key", chord, { shot: false });
        return { ok: true, summary: step.summary };
      }),
    },
    {
      name: "scroll",
      description: "Scroll the page or view. Positive dy scrolls down.",
      parameters: { type: "object", properties: { dy: { type: "number" } }, required: ["dy"] },
      execute: withSession(async (s: Session, args: any) => {
        await s.driver.scroll({ dy: Number(args.dy ?? 0) });
        await recordStep(s, "scroll", String(args.dy), { shot: false });
        return { ok: true };
      }),
    },
    {
      name: "drag",
      description: "Drag from one point to another (file moves, selections).",
      parameters: {
        type: "object",
        properties: {
          from_x: { type: "number" }, from_y: { type: "number" },
          to_x: { type: "number" }, to_y: { type: "number" },
        },
        required: ["from_x", "from_y", "to_x", "to_y"],
      },
      execute: withSession(async (s: Session, args: any) => {
        await s.driver.drag({
          from: { x: args.from_x, y: args.from_y },
          to: { x: args.to_x, y: args.to_y },
        });
        await recordStep(s, "drag", `${args.from_x},${args.from_y} → ${args.to_x},${args.to_y}`);
        return { ok: true };
      }),
    },
    {
      name: "clipboard",
      description: "Read or write the clipboard. `{op:'read'}` returns the text; `{op:'write', text}` sets it.",
      parameters: {
        type: "object",
        properties: { op: { type: "string", enum: ["read", "write"] }, text: { type: "string" } },
        required: ["op"],
      },
      execute: withSession(async (s: Session, args: any) => {
        if (args.op === "write") {
          await s.driver.clipboardWrite(String(args.text ?? ""));
          await recordStep(s, "clipboard", "write", { shot: false });
          return { ok: true };
        }
        const text = await s.driver.clipboardRead();
        await recordStep(s, "clipboard", "read", { shot: false });
        return { ok: true, text: text.slice(0, 4000) };
      }),
    },
    {
      name: "wait_for",
      description: "Wait until text appears on screen (or time out). Use after loads and submits.",
      parameters: {
        type: "object",
        properties: { text: { type: "string" }, timeout_ms: { type: "number" } },
        required: ["text"],
      },
      execute: withSession(async (s: Session, args: any) => {
        const found = await s.driver.waitForText(String(args.text ?? ""), Math.min(120_000, Number(args.timeout_ms ?? 15_000)));
        await recordStep(s, "wait", args.text, { shot: false });
        return { found };
      }),
    },
    {
      name: "ask_before",
      description:
        "Pause and ask the user to approve something before continuing. Use when the action is consequential in a way the label doesn't show (sending an email body, confirming a booking detail).",
      parameters: { type: "object", properties: { summary: { type: "string" } }, required: ["summary"] },
      execute: withSession(async (s: Session, args: any) => {
        const decision = await requestApproval(s, String(args.summary ?? "Continue?"), "submit");
        return { decision, ok: decision === "approved" };
      }),
    },
    {
      name: "remember_place",
      description: "Note where something is on screen (app + label) so you can return to it later in this turn.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, app: { type: "string" }, label: { type: "string" } },
        required: ["name"],
      },
      execute: (async (args: any, ctx: any) => {
        const session = getSession(ctx.turnId);
        if (!session) return { ok: false };
        db.prepare(
          `INSERT INTO computer_places (id, turn_id, name, app, label, created_at) VALUES (?, ?, ?, ?, ?, ?)`
        ).run(uuid(), session.turnId, String(args.name), args.app ?? null, args.label ?? null, now());
        return { ok: true };
      }) as any,
    },
  ];
}
