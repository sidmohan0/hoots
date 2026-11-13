import React, { useEffect, useRef, useState } from "react";
import { api } from "./api";
import { compose } from "./nav";
import "./nav.css";

// New hoot + the brand-new-bough empty state (DECISIONS #11: the empty pellet
// slots are UI scaffolding with fixed labels, never invented memory).

export const MODELS = [
  "glm-5.3-uncensored",
  "glm-5.3-flash-uncensored",
  "kimi-k3.1-pro-uncensored",
  "deepseek-v4.1-flash-uncensored",
];

const QUESTIONS = [
  "What should I call you, and what are you in the middle of?",
  "When would a check-in be welcome — and when never?",
  "Want me on your phone too? (connect Telegram)",
];

const SLOTS = ["who you are", "what you're working on", "people who matter", "how you like to be nudged"];

export function EmptyBough({ onConnectTelegram }: { onConnectTelegram: () => void }) {
  return (
    <section className="empty" aria-label="Brand new hoot">
      <div className="empty-main">
        <p className="empty-hello">
          Hello. I'm brand new, so I don't know anything about you yet — I'll only ever know what you tell me, and you
          can see all of it in memory.
        </p>
        <div className="empty-q">
          {QUESTIONS.map((q) => (
            <button
              key={q}
              className="chip"
              onClick={() => (q.endsWith("(connect Telegram)") ? onConnectTelegram() : compose(q))}
            >
              {q}
            </button>
          ))}
        </div>
      </div>
      <div className="empty-slots" aria-hidden="true">
        {SLOTS.map((s) => (
          <div key={s} className="empty-slot">
            {s}
          </div>
        ))}
      </div>
    </section>
  );
}

export function NewHoot({
  open,
  onClose,
  onCreated,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (hoot: any) => void;
}) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName("");
    setPersona("");
    setModel(MODELS[0]);
    setBusy(false);
    setError("");
    setTimeout(() => nameRef.current?.focus(), 0);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const state = !name && !persona ? " pending" : name ? "" : " incomplete";

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const hoot = await api.createHoot({ name: name.trim(), system_prompt: persona.trim(), model_name: model });
      onCreated(hoot);
    } catch (err: any) {
      setError(String(err?.message ?? err));
      setBusy(false);
    }
  };

  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <form
        className={"sheet" + state}
        role="dialog"
        aria-modal="true"
        aria-label="New hoot"
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">New hoot</h2>
          <button type="button" className="ghost" onClick={onClose}>
            close
          </button>
        </header>
        <p className="sheet-lede">A name and a temperature. The rest it learns from you.</p>

        <label className="field">
          <span className="label">NAME</span>
          <input ref={nameRef} value={name} onChange={(e) => setName(e.target.value)} placeholder="Juniper" />
        </label>

        <label className="field">
          <span className="label">PERSONA</span>
          <textarea
            value={persona}
            rows={3}
            onChange={(e) => setPersona(e.target.value)}
            placeholder="Warm, brief, asks before assuming"
          />
          <span className="caption muted">Goes into the hoot's system prompt. Editable later in settings.</span>
        </label>

        <label className="field">
          <span className="label">MODEL</span>
          <select value={model} onChange={(e) => setModel(e.target.value)}>
            {MODELS.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        {error && <p className="form-error">{error}</p>}

        <footer className="sheet-foot">
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>
            {busy ? "Creating…" : "Create"}
          </button>
          <span className="caption muted">Starts with an empty bough and an empty pellet.</span>
        </footer>
      </form>
    </div>
  );
}
