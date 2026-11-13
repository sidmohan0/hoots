import React from "react";

// One glyph, four states (tokens: component.presence).
// 40×22 box, two r9 pupils at x=10 and x=30. Only gone-quiet alarms.
// Reduced motion: no blink, no breathe — half-lids + clock only.

export type PresenceState = "awake" | "thinking" | "sleeping" | "quiet";

function Eye({ state }: { state: PresenceState }) {
  if (state === "sleeping") {
    return <path d="M -6 1 A 6 6 0 0 0 6 1" fill="none" stroke="var(--c-text-muted)" strokeWidth={1.5} strokeLinecap="round" />;
  }
  if (state === "quiet") {
    return <circle r={9} fill="none" stroke="var(--c-quiet)" strokeWidth={1.5} strokeDasharray="3 3" />;
  }
  const thinking = state === "thinking";
  return (
    <>
      <circle r={9} fill="var(--c-bg-sunken)" stroke="var(--c-line-strong)" strokeWidth={1} />
      {thinking && <rect className="lid" x={-9} y={-9} width={18} height={9} fill="var(--c-text)" />}
      <circle className="pupil" r={3.2} fill="var(--c-accent)" />
    </>
  );
}

export function Glyph({ state, size = 40 }: { state: PresenceState; size?: number }) {
  const w = size;
  const h = Math.round((size * 22) / 40);
  return (
    <svg width={w} height={h} viewBox="0 0 40 22" className={`glyph glyph-${state}`} data-state={state} role="img" aria-label={state}>
      <g transform="translate(10 11)">
        <Eye state={state} />
      </g>
      <g transform="translate(30 11)">
        <Eye state={state} />
      </g>
    </svg>
  );
}
