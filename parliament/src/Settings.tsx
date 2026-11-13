import React, { useEffect, useState } from "react";
import { api } from "./api";
import { applyTheme, storedTheme, type Theme } from "./nav";
import "./nav.css";

// Settings sheet for one hoot: name, persona, timezone (display), Telegram,
// pause, theme. PATCH /v1/hoots/:id (status is the pause flag).

function useBotUsername(): string | null {
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    const token = document.querySelector('meta[name="hoot-token"]')?.getAttribute("content") ?? "";
    fetch("/v1/config", { headers: { authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((cfg) => {
        const u = cfg?.telegram_bot_username ?? cfg?.bot_username ?? null;
        if (typeof u === "string" && u) setUsername(u);
      })
      .catch(() => {});
  }, []);
  return username;
}

export function Settings({
  open,
  hoot,
  onClose,
  onSaved,
}: {
  open: boolean;
  hoot: any | null;
  onClose: () => void;
  onSaved: (hoot: any) => void;
}) {
  const [name, setName] = useState("");
  const [persona, setPersona] = useState("");
  const [paused, setPaused] = useState(false);
  const [theme, setTheme] = useState<Theme>(() => storedTheme());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const bot = useBotUsername();

  useEffect(() => {
    if (!open || !hoot) return;
    setName(hoot.name ?? "");
    setPersona(hoot.system_prompt ?? "");
    setPaused(hoot.status === "paused");
    setTheme(storedTheme());
    setError("");
    setSaved(false);
    setBusy(false);
  }, [open, hoot]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open || !hoot) return null;

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

  const patch = async (body: any) => {
    setBusy(true);
    setError("");
    try {
      const next = await api.patchHoot(hoot.id, body);
      onSaved(next);
      setSaved(true);
      return true;
    } catch (err: any) {
      setError(String(err?.message ?? err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    const ok = await patch({ name: name.trim(), system_prompt: persona });
    if (ok) setTimeout(() => setSaved(false), 1500);
  };

  const togglePause = async (next: boolean) => {
    setPaused(next);
    const ok = await patch({ status: next ? "paused" : "active" });
    if (!ok) setPaused(!next);
    else onSaved({ ...hoot, status: next ? "paused" : "active" });
  };

  const chooseTheme = (t: Theme) => {
    setTheme(t);
    applyTheme(t);
  };

  return (
    <div className="sheet-scrim" onMouseDown={onClose}>
      <form
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={`Settings for ${hoot.name}`}
        onSubmit={submit}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <h2 className="sheet-title">Settings · {hoot.name}</h2>
          <button type="button" className="ghost" onClick={onClose}>
            close
          </button>
        </header>

        <label className="field">
          <span className="label">NAME</span>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Juniper" />
        </label>

        <label className="field">
          <span className="label">PERSONA</span>
          <textarea value={persona} rows={4} onChange={(e) => setPersona(e.target.value)} placeholder="Warm, brief, asks before assuming" />
          <span className="caption muted">Sent as the hoot's system prompt.</span>
        </label>

        <div className="field">
          <span className="label">TIMEZONE</span>
          <p className="readout">{timezone}</p>
          <span className="caption muted">Read from this browser. Promises fire on this clock.</span>
        </div>

        <div className="field">
          <span className="label">TELEGRAM</span>
          {bot ? (
            <a className="readout link" href={`https://t.me/${bot}`} target="_blank" rel="noreferrer">
              t.me/{bot}
            </a>
          ) : (
            <p className="caption muted">
              Open Telegram, find the bot whose token is in the perch's <code>.env</code>, and send it anything — it
              binds this hoot to that chat.
            </p>
          )}
        </div>

        <div className="field row">
          <div>
            <span className="label">PAUSE</span>
            <p className="caption muted">Stops turns; memory stays.</p>
          </div>
          <label className="switch">
            <input type="checkbox" checked={paused} onChange={(e) => togglePause(e.target.checked)} />
            <span />
          </label>
        </div>

        <div className="field">
          <span className="label">THEME</span>
          <div className="segmented" role="radiogroup" aria-label="Theme">
            {(["dark", "light"] as Theme[]).map((t) => (
              <button
                key={t}
                type="button"
                role="radio"
                aria-checked={theme === t}
                className={"segment" + (theme === t ? " on" : "")}
                onClick={() => chooseTheme(t)}
              >
                {t}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="form-error">{error}</p>}

        <footer className="sheet-foot">
          <button type="submit" className="btn-primary" disabled={!name.trim() || busy}>
            {busy ? "Saving…" : saved ? "Saved" : "Save"}
          </button>
          <span className="caption muted">PATCH /v1/hoots/{hortOrId(hoot)}</span>
        </footer>
      </form>
    </div>
  );
}

function hortOrId(hoot: any): string {
  return String(hoot.id ?? "").slice(0, 8);
}
