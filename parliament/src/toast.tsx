import React, { useEffect, useSyncExternalStore } from "react";

// One quiet toast surface, bottom-left (tokens: color.*.surface +
// border quiet colour). Auto-dismisses after 6s; reduced motion just skips
// the slide. Never used for status chatter — only for things that failed.

export type ToastAction = { label: string; run: () => void };
type Toast = { id: number; text: string; action?: ToastAction };

const DISMISS_MS = 6000;

let seq = 0;
let list: Toast[] = [];
const subs = new Set<() => void>();

function emit() {
  for (const s of subs) s();
}

export function dismissToast(id: number) {
  const next = list.filter((t) => t.id !== id);
  if (next.length === list.length) return;
  list = next;
  emit();
}

export function toast(text: string, action?: ToastAction): number {
  const id = ++seq;
  // one live toast per message — a retry prompt never stacks on itself
  const dup = list.find((t) => t.text === text);
  list = [...(dup ? list.filter((t) => t !== dup) : list), { id, text, action }];
  emit();
  if (typeof window !== "undefined") window.setTimeout(() => dismissToast(id), DISMISS_MS);
  return id;
}

function subscribe(fn: () => void) {
  subs.add(fn);
  return () => {
    subs.delete(fn);
  };
}

const snapshot = () => list;

export function Toaster() {
  const toasts = useSyncExternalStore(subscribe, snapshot, snapshot);
  useEffect(() => () => void (list = []), []);
  if (!toasts.length) return null;
  return (
    <div className="toasts" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div className="toast" key={t.id} role="status">
          <span className="toast-text">{t.text}</span>
          {t.action && (
            <button
              className="toast-action"
              onClick={() => {
                dismissToast(t.id);
                t.action!.run();
              }}
            >
              {t.action.label}
            </button>
          )}
          <button className="toast-close" aria-label="Dismiss" onClick={() => dismissToast(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
