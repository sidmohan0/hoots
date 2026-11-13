import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type Automation, type Fact, type Item, type Presence } from "./api";
import { dayKey, dayLabel, timeOf, useElapsed, useStream } from "./hooks";
import { Glyph, type PresenceState } from "./Glyph";

// Parliament v0.2 — boards 03 (IA), 04B (v1 base), 07 (interaction notes).
// One view (the hoot), two drawers, machine footer. ⌘K palette lands next.

const urlHoot = new URLSearchParams(location.search).get("hoot") ?? "";

type Live = {
  items: Item[];
  turnState: Record<string, { status: string; startedAt: number }>;
  queued: { text: string; at: number }[];
};

export function App() {
  const [hoots, setHoots] = useState<any[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [thinking, setThinking] = useState<{ turnId: string; startedAt: number } | null>(null);
  const [queued, setQueued] = useState<{ text: string; at: number }[]>([]);
  const [outbound, setOutbound] = useState<{ count: number; bytes: number } | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [drawer, setDrawer] = useState<"memory" | "promises" | null>(() => {
    const d = new URLSearchParams(location.search).get("d");
    return d === "memory" || d === "promises" ? d : null;
  });
  const [away, setAway] = useState<{ count: number; since: number } | null>(null);
  const [webRead, setWebRead] = useState<number>(() => Date.now() - 7 * 86_400_000);
  const boughRef = useRef<HTMLDivElement>(null);
  const [boughId, setBoughId] = useState<string | null>(null);

  // --- load hoots + pick active ---
  useEffect(() => {
    (async () => {
      const hs = await api.hoots();
      setHoots(hs);
      const active = hs.find((h) => h.id === urlHoot) ?? hs[0];
      if (active) {
        localStorage.setItem("hootId", active.id);
        const threads = await api.threads(active.id);
        const bough = threads.find((t) => t.kind === "bough");
        setBoughId(bough?.id ?? null);
      }
    })().catch(() => {});
  }, []);

  // --- load bough items ---
  useEffect(() => {
    if (!boughId) return;
    (async () => {
      const rows = await api.items(boughId);
      setItems(rows);
      // away divider: unread-on-web telegram items (board 07)
      try {
        const rs = await api.readState(hootId());
        const web = rs.find((r) => r.surface === "web")?.last_read_at ?? 0;
        setWebRead(web);
        const unread = rows.filter((r) => r.created_at > web && (r as any).surface === "telegram");
        if (web && unread.length) setAway({ count: unread.length, since: web });
      } catch {}
      markRead();
    })();
  }, [boughId]);

  const markRead = () => {
    if (!hootId()) return;
    api.read(hootId(), "web").catch(() => {});
  };

  // --- presence + outbound pollers ---
  useEffect(() => {
    if (!hootId()) return;
    const pull = () => {
      api.presence(hootId()).then(setPresence).catch(() => {});
      api.outbound().then(setOutbound).catch(() => {});
    };
    pull();
    const t = setInterval(pull, 15_000);
    return () => clearInterval(t);
  }, [thinking]);

  // --- facts + automations ---
  const loadFacts = () => {
    if (!hootId()) return;
    api.facts(hootId()).then(setFacts).catch(() => {});
    api.automations(hootId()).then(setAutomations).catch(() => {});
  };
  useEffect(loadFacts, [hootId()]);

  // --- SSE ---
  useStream((ev) => {
    if (ev.event === "item.append") {
      const item = ev.data.item as Item;
      setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [...prev, item]));
      if (item.role === "user") {
        setQueued((q) => q.filter((x) => JSON.parse(item.content).text.trim() !== x.text.trim()));
        setThinking((t) => (t && item.turn_id === t.turnId ? t : t));
      }
      if (item.role === "hoot") markRead();
      // scroll if near bottom
      requestAnimationFrame(() => {
        const el = boughRef.current;
        if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 400) el.scrollTop = el.scrollHeight;
      });
    }
    if (ev.event === "turn.status") {
      const { turn_id, status } = ev.data;
      if (status === "in_progress") setThinking((t) => (t?.turnId === turn_id ? t : { turnId: turn_id, startedAt: Date.now() }));
      if (status === "completed" || status === "interrupted") {
        setThinking((t) => (t?.turnId === turn_id ? null : t));
        if (status === "interrupted") loadFacts();
      }
    }
    if (ev.event === "fact.changed") loadFacts();
    if (ev.event === "automation.fired") {
      api.automations(hootId()).then(setAutomations).catch(() => {});
    }
  });

  const send = async (text: string) => {
    if (!boughId) return;
    setQueued((q) => [...q, { text, at: Date.now() }]);
    try {
      await api.send(boughId, text, "web");
    } catch {
      setQueued((q) => q.filter((x) => x.text !== text));
    }
  };

  const hootName = hoots.find((h) => h.id === hootId())?.name ?? "Hoot";
  const state: PresenceState = thinking ? "thinking" : (presence?.status as PresenceState) ?? "awake";

  return (
    <div className="shell">
      <nav className="rail" aria-label="Parliament">
        {hoots.map((h) => (
          <button
            key={h.id}
            className={"rail-hoot" + (h.id === hootId() ? " active" : "")}
            title={h.name}
            onClick={() => {
              localStorage.setItem("hootId", h.id);
              location.href = `/?hoot=${h.id}`;
            }}
          >
            <span className="monogram">{h.name.slice(0, 1)}</span>
          </button>
        ))}
        <button className="rail-new" title="New hoot" onClick={() => alert("New hoot flow lands with the onboarding pass")}>
          +
        </button>
      </nav>

      <main className="bough" ref={boughRef}>
        <PresenceHeader name={hootName} state={state} presence={presence} thinking={thinking} />
        <Items
          items={items}
          thinking={thinking}
          queued={queued}
          away={away}
          webRead={webRead}
                  />
        <Composer onSend={send} busy={!!thinking} />
      </main>

      <Drawer side="right" open={drawer === "memory"} onClose={() => setDrawer(null)} label="Memory">
        <Memory facts={facts} hootName={hootName} onConfirm={(id) => api.confirmFact(id).then(loadFacts)} onForget={(id) => api.forgetFact(id).then(loadFacts)} onEdit={(id, text) => api.editFact(id, text).then(loadFacts)} />
      </Drawer>
      <Drawer side="right" open={drawer === "promises"} onClose={() => setDrawer(null)} label="Promises">
        <Promises automations={automations} hootId={hootId()} onToggle={(id, enabled) => api.patchAutomation(id, { enabled }).then(loadFacts)} />
      </Drawer>

      <footer className="machine">
        <button className={drawer === "memory" ? "on" : ""} onClick={() => setDrawer(drawer === "memory" ? null : "memory")}>
          memory
        </button>
        <button className={drawer === "promises" ? "on" : ""} onClick={() => setDrawer(drawer === "promises" ? null : "promises")}>
          promises
        </button>
        <span className="spacer" />
        <span>sids-mbp</span>
        <span>127.0.0.1:7420</span>
        <span>~/.hoots</span>
        <span>
          {outbound ? `${outbound.count} sent out today` : "—"} →
        </span>
      </footer>
    </div>
  );
}

function hootId(): string {
  return urlHoot || localStorage.getItem("hootId") || "";
}

// --- presence header (board 04B, voice rule: chrome is third person) ---------
function PresenceHeader({ name, state, presence, thinking }: any) {
  const elapsed = useElapsed(thinking?.startedAt ?? null);
  const next = presence?.nextPromise
    ? new Date(presence.nextPromise).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;
  const hero = state === "thinking" ? `${name} is thinking.` : state === "sleeping" ? `${name} is sleeping.` : state === "quiet" ? `${name} has gone quiet.` : `${name} is awake.`;
  const lastHeard = presence?.lastHeard
    ? `last heard from you ${timeOf(presence.lastHeard.at)} · ${presence.lastHeard.surface}`
    : null;
  return (
    <header className="presence">
      <Glyph state={state} />
      <div className="presence-lines">
        <h1 className="hero">{hero}</h1>
        <p className="chrome-line">
          {lastHeard ?? "no messages yet"}
          {next && !thinking ? ` · next check-in ${next}` : ""}
        </p>
      </div>
    </header>
  );
}

// --- items + day folding (board 04A) -----------------------------------------
type TempItem = { temp: true; text: string; at: number };

function Items({
  items,
  thinking,
  queued,
  away,
  webRead,
}: {
  items: Item[];
  thinking: { turnId: string; startedAt: number } | null;
  queued: { text: string; at: number }[];
  away: { count: number; since: number } | null;
  webRead: number;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [digests, setDigests] = useState<Record<string, string>>({});

  const days = useMemo(() => {
    const map = new Map<string, Item[]>();
    for (const it of items) {
      const k = dayKey(it.created_at);
      if (!map.has(k)) map.set(k, []);
      map.get(k)!.push(it);
    }
    return [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }, [items]);

  const todayKey = dayKey(Date.now());
  const expandDay = async (k: string) => {
    setExpanded((e) => ({ ...e, [k]: !e[k] }));
    if (!digests[k] && k !== todayKey) {
      const hoot = localStorage.getItem("hootId") ?? "";
      api.digest(hoot, k).then((d) => setDigests((g) => ({ ...g, [k]: d.digest ?? "" }))).catch(() => {});
    }
  };

  let awayShown = false;

  return (
    <div className="days">
      {days.map(([k, dayItems]) => {
        const isToday = k === todayKey;
        const open = isToday || !!expanded[k];
        const digest = digests[k];
        return (
          <section className="day" key={k} data-date={k}>
            <header className="day-head-row" onClick={() => !isToday && expandDay(k)}>
              <h2 className="day-head">{dayLabel(dayItems[0].created_at)}</h2>
              {!isToday && !open && <p className="day-digest">{digest ?? "· · ·"}</p>}
            </header>
            {(open || isToday) && (
              <div className="day-items">
                {away && !awayShown && k === todayKey && ((awayShown = true), null)}
                {dayItems.map((it, i) => (
                  <React.Fragment key={it.id}>
                    {away && !awayShown && it.surface === "telegram" && it.created_at > webRead && ((awayShown = true),
                    (
                      <div className="away-divider" key={`away-${it.id}`}>
                        WHILE YOU WERE AWAY · {away.count} ON TELEGRAM · since {timeOf(away.since)}
                      </div>
                    ))}
                    <ItemRow item={it} />
                    {i === dayItems.length - 1 && thinking && <ThinkingCard startedAt={thinking.startedAt} />}
                  </React.Fragment>
                ))}
                {isToday && thinking && dayItems.every((i2) => i2.turn_id !== thinking.turnId) && (
                  <ThinkingCard startedAt={thinking.startedAt} />
                )}
              </div>
            )}
          </section>
        );
      })}
      {queued.map((q) => (
        <div className="queued-chip" key={q.at}>
          queued next · “{q.text.length > 40 ? q.text.slice(0, 40) + "…" : q.text}”
        </div>
      ))}
    </div>
  );
}

function ItemRow({ item }: { item: Item }) {
  const c = JSON.parse(item.content);
  if (item.kind === "note") {
    return (
      <div className="noted-chip">
        <span className="noted-label">NOTED</span>
        <span>{c.fact}</span>
      </div>
    );
  }
  if (item.kind !== "message") return null;
  const mine = item.role === "user";
  return (
    <div className={`item ${mine ? "mine" : "theirs"}`}>
      <div className="bubble">
        <p>{c.text}</p>
      </div>
      <p className="meta">
        {timeOf(item.created_at)}
        {item.surface === "telegram" && <span className="surface"> · via Telegram</span>}
        {mine && <span> · sent</span>}
      </p>
    </div>
  );
}

function ThinkingCard({ startedAt }: { startedAt: number }) {
  const elapsed = useElapsed(startedAt);
  const [relaxed, setRelaxed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setRelaxed(true), 20_000);
    return () => clearTimeout(t);
  }, []);
  return (
    <div className="thinking-card">
      <Glyph state="thinking" size={24} />
      <span>
        thinking · {elapsed}
        {relaxed && " — usually ~1 min · fine to leave"}
      </span>
    </div>
  );
}

function Composer({ onSend, busy }: { onSend: (text: string) => void; busy: boolean }) {
  const [text, setText] = useState("");
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    onSend(t);
  };
  return (
    <form className="composer" onSubmit={submit}>
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={busy ? "Add while it thinks — queued next" : "Tell Juniper anything…"}
        aria-label="Message"
      />
      <button type="submit" className="btn-primary" disabled={!text.trim()}>
        Send
      </button>
    </form>
  );
}

// --- drawers ------------------------------------------------------------------
function Drawer({ side, open, onClose, label, children }: any) {
  if (!open) return null;
  return (
    <aside className={`drawer drawer-${side}`} role="dialog" aria-label={label}>
      <header className="drawer-head">
        <h3>{label}</h3>
        <button className="ghost" onClick={onClose}>
          close
        </button>
      </header>
      <div className="drawer-body">{children}</div>
    </aside>
  );
}

function Memory({
  facts,
  hootName,
  onConfirm,
  onForget,
  onEdit,
}: {
  facts: Fact[];
  hootName: string;
  onConfirm: (id: string) => void;
  onForget: (id: string) => void;
  onEdit: (id: string, text: string) => void;
}) {
  const [summary, setSummary] = useState("");
  useEffect(() => {
    const h = localStorage.getItem("hootId") ?? "";
    api.pellet(h).then((p) => setSummary(p.summary ?? "")).catch(() => {});
  }, [facts.length]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  return (
    <div>
      {summary && (
        <section className="pellet-summary">
          <p className="label">SUMMARY</p>
          <p className="small">{summary}</p>
        </section>
      )}
      <p className="label">FACTS · {facts.length}</p>
      <ul className="facts">
        {facts.map((f) => (
          <li key={f.id} className={`fact ${f.confidence === "extracted" ? "guess" : ""}`}>
            {editing === f.id ? (
              <input
                value={draft}
                autoFocus
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    onEdit(f.id, draft);
                    setEditing(null);
                  }
                  if (e.key === "Escape") setEditing(null);
                }}
              />
            ) : (
              <p className="fact-text">
                {f.text}
                {f.confidence === "extracted" && <span className="guess-tag">guess?</span>}
              </p>
            )}
            <p className="fact-meta">
              {new Date(f.created_at).toLocaleDateString([], { day: "numeric", month: "short" })} ·{" "}
              {f.confidence === "pinned" ? "pinned" : f.confidence}
              {f.category ? ` · ${f.category}` : ""}
            </p>
            <div className="fact-actions">
              {f.confidence === "extracted" && <button onClick={() => onConfirm(f.id)}>confirm</button>}
              <button onClick={() => { setEditing(f.id); setDraft(f.text); }}>correct</button>
              <button onClick={() => onForget(f.id)}>forget</button>
            </div>
          </li>
        ))}
        {!facts.length && <p className="small muted">Nothing yet. Everything {hootName} learns shows up here.</p>}
      </ul>
    </div>
  );
}

function Promises({ automations, onToggle }: { automations: Automation[]; hootId: string; onToggle: (id: string, enabled: boolean) => void }) {
  const today = dayKey(Date.now());
  const fmt = (ms: number) => timeOf(ms);
  return (
    <div>
      <p className="label">STANDING PROMISES</p>
      <ul className="promises">
        {automations.map((a) => {
          const next = a.next_fire_at ? new Date(a.next_fire_at) : null;
          return (
            <li key={a.id} className={"promise" + (a.enabled ? "" : " paused")}>
              <div className="promise-row">
                <strong>{a.title}</strong>
                <label className="switch">
                  <input type="checkbox" checked={!!a.enabled} onChange={(e) => onToggle(a.id, e.target.checked)} />
                  <span />
                </label>
              </div>
              <p className="small">
                {a.enabled && next
                  ? `next ${fmt(a.next_fire_at!)} · ${next.toLocaleDateString([], { weekday: "short" })}`
                  : "paused"}
              </p>
              <p className="caption muted">{a.prompt.slice(0, 120)}{a.prompt.length > 120 ? "…" : ""}</p>
            </li>
          );
        })}
        {!automations.length && <p className="small muted">No promises yet. Ask in the bough: “check in with me daily at 9.”</p>}
      </ul>
      <p className="caption muted">Today is {today}. A promise kept late (Mac asleep) is still kept — it says so itself.</p>
    </div>
  );
}
