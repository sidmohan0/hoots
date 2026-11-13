// URL is the router. No full reloads: pushState + a DOM event the app listens
// for (DECISIONS #3: one view, two drawers, ⌘K lands in the bough).
// Params: ?hoot=<id>&day=<YYYY-MM-DD>&d=memory|promises&fact=<id>

import { useEffect, useState } from "react";

export type Drawer = "memory" | "promises" | null;

export type Route = {
  hoot: string;
  day: string | null;
  drawer: Drawer;
  fact: string | null;
};

export const NAV_EVENT = "hoots:navigate";
export const COMPOSE_EVENT = "hoots:compose";

export type RoutePatch = {
  hoot?: string | null;
  day?: string | null;
  d?: string | null;
  fact?: string | null;
};

const PARAMS = ["hoot", "day", "d", "fact"] as const;

export function readRoute(search = location.search): Route {
  const q = new URLSearchParams(search);
  const d = q.get("d");
  return {
    hoot: q.get("hoot") ?? "",
    day: q.get("day"),
    drawer: d === "memory" || d === "promises" ? d : null,
    fact: q.get("fact"),
  };
}

export function hrefFor(patch: RoutePatch): string {
  const q = new URLSearchParams(location.search);
  for (const k of PARAMS) {
    if (!(k in patch)) continue;
    const v = patch[k];
    if (v == null || v === "") q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  return `${location.pathname}${s ? `?${s}` : ""}`;
}

function commit(patch: RoutePatch, replace: boolean): void {
  const url = hrefFor(patch);
  if (replace) history.replaceState({ ...history.state, hoots: true }, "", url);
  else history.pushState({ ...history.state, hoots: true }, "", url);
  dispatchEvent(new Event(NAV_EVENT));
}

export function navigate(patch: RoutePatch): void {
  commit(patch, false);
}

export function goHoot(hoot: string): void {
  localStorage.setItem("hootId", hoot);
  commit({ hoot, day: null, fact: null }, false);
}

export function goDay(hoot: string, day: string | null): void {
  commit({ hoot, day }, false);
}

export function openFact(hoot: string, fact: string): void {
  commit({ hoot, fact, d: "memory" }, false);
}

export function setDrawer(d: Drawer): void {
  commit({ d }, true);
}

/** Fill the composer with a prompt (empty-state chips). */
export function compose(text: string): void {
  dispatchEvent(new CustomEvent<string>(COMPOSE_EVENT, { detail: text }));
}

// --- theme (dark default; tokens define both sets) ---------------------------
export type Theme = "dark" | "light";

export function storedTheme(): Theme {
  return localStorage.getItem("theme") === "light" ? "light" : "dark";
}

export function applyTheme(t: Theme): void {
  document.documentElement.dataset.theme = t;
  localStorage.setItem("theme", t);
}

export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = storedTheme();
}

/** Live route; re-renders on our own navigations and on browser back/forward. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => readRoute());
  useEffect(() => {
    const sync = () => setRoute(readRoute());
    addEventListener(NAV_EVENT, sync);
    addEventListener("popstate", sync);
    return () => {
      removeEventListener(NAV_EVENT, sync);
      removeEventListener("popstate", sync);
    };
  }, []);
  return route;
}
