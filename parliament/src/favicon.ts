// Tab identity: the presence glyph as a favicon data URI, plus a "● " title
// prefix while a turn is in flight (tokens: component.presence).
//
// Two live states only — awake and thinking. The gone-quiet state reuses the
// dashed eye shape, so it is generated from the same source rather than drawn
// twice. The icon is always a *static* frame (a tab icon can't cheaply blink),
// so reduced motion needs nothing suppressed; under reduced motion the
// thinking frame is the half-lid still, exactly like the glyph in the page.

import { useEffect } from "react";

export type TabState = "awake" | "thinking" | "sleeping" | "quiet";

// Literal token values: a data-URI SVG is a standalone document, so var()
// cannot resolve inside it. These mirror color.dark.* / component.presence.
const INK = "#9AA0AB"; // color.dark.textMuted — eye outline
const PUPIL = "#F2B544"; // color.*.accent — pupil
const LID = "#ECEDEF"; // color.dark.text — thinking lid
const QUIET = "#F28B6B"; // color.dark.quiet — gone-quiet dash

function eye(state: TabState, cx: number): string {
  if (state === "sleeping") {
    return `<path d="M${cx - 6} 12 A6 6 0 0 0 ${cx + 6} 12" fill="none" stroke="${INK}" stroke-width="1.5" stroke-linecap="round"/>`;
  }
  if (state === "quiet") {
    return `<circle cx="${cx}" cy="11" r="9" fill="none" stroke="${QUIET}" stroke-width="1.5" stroke-dasharray="3 3"/>`;
  }
  const lid = state === "thinking" ? `<rect x="${cx - 9}" y="2" width="18" height="9" fill="${LID}"/>` : "";
  return (
    `<circle cx="${cx}" cy="11" r="9" fill="none" stroke="${INK}" stroke-width="1"/>` +
    lid +
    `<circle cx="${cx}" cy="11" r="3.2" fill="${PUPIL}"/>`
  );
}

export function faviconUri(state: TabState): string {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -6 40 34" width="40" height="34">` +
    eye(state, 10) +
    eye(state, 30) +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let baseTitle: string | null = null;

function iconLink(): HTMLLinkElement {
  let el = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  if (!el) {
    el = document.createElement("link");
    el.rel = "icon";
    document.head.appendChild(el);
  }
  return el;
}

function paint(state: TabState): void {
  const link = iconLink();
  link.href = faviconUri(state);
  link.type = "image/svg+xml";
}

/**
 * Point the tab at a state. Busy wins and adds the "● " prefix; otherwise the
 * hoot's settled presence shows (awake by default, dashed for gone quiet).
 */
export function setTabState(busy: boolean, idle: TabState = "awake"): void {
  if (baseTitle == null) baseTitle = document.title;
  if (busy) {
    paint("thinking");
    document.title = `● ${baseTitle.replace(/^●\s*/, "")}`;
    return;
  }
  paint(idle);
  document.title = baseTitle;
}

/** Keep the tab in step with the turn and the hoot; clear the dot when seen. */
export function useTabBusy(busy: boolean, idle: TabState = "awake"): void {
  useEffect(() => {
    setTabState(busy, idle);
    const onVisible = () => {
      if (!document.hidden) setTabState(false, idle);
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      setTabState(false, idle);
    };
  }, [busy, idle]);
}
