import React, { useState } from "react";
import { api } from "./api";

// Board 05: promises are set in words, confirmed as a card.
// Nothing is scheduled until "I promise" — the only moment the word binds.
// The model proposes; this card restates in plain time chips, names its
// assumptions, and shows pellet conflicts. Confirm → created, dismissed →
// the text sends as an ordinary message.

export type Proposal = {
  title: string;
  prompt: string;
  rrule: string;
  times: string[];
  assumptions: string[];
  conflicts: { fact: string; time: string }[];
  nextFire: number;
};

const DOW = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function nextFive(proposal: Proposal): string[] {
  // Preview only: derive from the RRULE's hours/dow + nextFire.
  const out: string[] = [];
  const base = new Date(proposal.nextFire);
  const hours = [...proposal.times];
  const dowMatch = /BYDAY=([A-Z,]+)/.exec(proposal.rrule);
  const days = dowMatch ? dowMatch[1].split(",") : null;
  for (let i = 0; i < 5 && out.length < 5; i++) {
    const d = new Date(base.getTime() + i * 86_400_000);
    if (days && !days.some((dw) => DOW[(d.getDay() + 7) % 7].toUpperCase().startsWith(dw.slice(0, 2)))) continue;
    for (const h of hours) {
      const at = new Date(d);
      at.setHours(Number(h.slice(0, 2)), Number(h.slice(3, 5)), 0, 0);
      if (at.getTime() > Date.now() && out.length < 5) {
        out.push(`${DOW[at.getDay()]} ${h}`);
      }
    }
  }
  return out;
}

export function PromiseCard({
  proposal,
  onConfirm,
  onDismiss,
  onEdit,
  busy,
}: {
  proposal: Proposal;
  onConfirm: (editedPrompt: string) => void;
  onDismiss: () => void;
  onEdit: () => void;
  busy: boolean;
}) {
  const [prompt, setPrompt] = useState(proposal.prompt);
  const [outcome, setOutcome] = useState<"open" | "kept">("open");
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;

  if (outcome === "kept") {
    return (
      <div className="promise-card kept" role="status">
        <p className="promise-kept">
          Promised — {proposal.times.join(", ")} your time. It'll reach you on Telegram first, and here.
        </p>
      </div>
    );
  }

  return (
    <div className="promise-card" role="group" aria-label="Confirm promise">
      <p className="proposal-line">{proposal.title}</p>

      <div className="chips">
        {proposal.times.map((t) => {
          const conflict = proposal.conflicts.find((c) => c.time === t);
          return conflict ? (
            <span key={t} className="time-chip conflict" title={conflict.fact}>
              ⚠ {t}
            </span>
          ) : (
            <span key={t} className="time-chip">
              {t}
            </span>
          );
        })}
      </div>

      {proposal.conflicts.map((c) => (
        <p key={c.time} className="conflict-banner">
          ⚠ {c.time} clashes with something you told me: “{c.fact}”. Keep it anyway?
        </p>
      ))}

      {proposal.assumptions.length > 0 && (
        <p className="assumptions">{proposal.assumptions.join(" · ")}</p>
      )}

      <label className="card-field">
        <span className="label">WHAT I'LL DO</span>
        <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={3} />
      </label>

      <p className="card-row">
        <span className="label">WHERE</span> Telegram first; it'll also be here.
      </p>
      <p className="card-row">
        <span className="label">NEXT FIVE</span> {nextFive(proposal).join(" · ") || "—"}
      </p>
      <p className="card-row muted">
        <span className="label">CLOCK</span> Your local time, {tz} — follows daylight saving.
      </p>

      <div className="card-actions">
        <button className="btn-primary" disabled={busy} onClick={() => { onConfirm(prompt); setOutcome("kept"); }}>
          I promise
        </button>
        <button className="btn-secondary" onClick={onEdit}>
          Change something
        </button>
        <button className="btn-ghost" onClick={onDismiss}>
          Just once
        </button>
      </div>
    </div>
  );
}

/** Heuristic: does this read like a cadence, not a question? */
export function looksLikePromise(text: string): boolean {
  const t = text.toLowerCase();
  const cadence = /\b(daily|every day|every weekday|every (mon|tue|wed|thu|fri|sat|sun)|weekly|each (morning|evening|day)|on weekdays)\b/;
  const verb = /\b(check in|check-in|remind|nudge|ping me|ask me|follow up|prompt me)\b/;
  const timeish = /\b(at|around)\s*\d{1,2}(:\d{2})?\s*(am|pm)?\b|\b\d{1,2}(am|pm)\b/;
  return (cadence.test(t) && (verb.test(t) || timeish.test(t))) || (verb.test(t) && cadence.test(t));
}

export async function proposePromise(hootId: string, text: string): Promise<Proposal> {
  return api.propose(hootId, text);
}
