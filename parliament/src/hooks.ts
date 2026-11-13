import { useEffect, useRef, useState } from "react";
import type { StreamEvt } from "./api";

// Connection health, per tokens motion.timing.reconnectShow / goneQuiet.
export type StreamHealth = { status: "live" | "reconnecting" | "quiet"; since: number | null };

// Subscribe to the perch's SSE stream. EventSource reconnects automatically
// and resends Last-Event-ID; the perch replays the gap (DECISIONS: SSE ids).
// The returned health drives the footer + gone-quiet presence only; nothing
// here may toast (a flapping stream would spam).
export function useStream(onEvent: (ev: StreamEvt) => void): StreamHealth {
  const handler = useRef(onEvent);
  handler.current = onEvent;
  const [down, setDown] = useState<number | null>(null);
  const [status, setStatus] = useState<StreamHealth["status"]>("live");

  useEffect(() => {
    const es = new EventSource("/v1/stream");
    const listener = (e: MessageEvent) => {
      try {
        handler.current({ id: Number(e.lastEventId), event: e.type, data: JSON.parse(e.data) });
      } catch {
        /* ignore malformed */
      }
    };
    for (const type of ["turn.status", "item.append", "hoot.updated", "automation.fired", "fact.changed", "promise.changed"]) {
      es.addEventListener(type, listener as EventListener);
    }
    es.onopen = () => setDown(null);
    // Any error (CONNECTING retry or CLOSED) counts as down; recovery is onopen.
    es.onerror = () => setDown((d) => d ?? Date.now());
    return () => es.close();
  }, []);

  useEffect(() => {
    if (down == null) {
      setStatus("live");
      return;
    }
    const check = () => {
      const age = Date.now() - down;
      setStatus(age >= 30_000 ? "quiet" : age >= 3_000 ? "reconnecting" : "live");
    };
    check();
    const t = setInterval(check, 1000);
    return () => clearInterval(t);
  }, [down]);

  return { status, since: down };
}

/** Ticking elapsed-seconds clock while `active` (board 07: thinking · 0:41). */
export function useElapsed(startedAt: number | null): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (startedAt == null) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt == null) return "";
  const s = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export function timeOf(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export function dayKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function dayLabel(ms: number): string {
  const d = new Date(ms);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (same(d, today)) return "Today";
  if (same(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}
