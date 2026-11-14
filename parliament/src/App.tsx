import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type Automation, type Fact, type Item, type Presence } from "./api";
import { dayKey, dayLabel, timeOf, useElapsed, useStream } from "./hooks";
import { Glyph, type PresenceState } from "./Glyph";
import { Markdown } from "./markdown";
import { Toaster, toast } from "./toast";
import { looksLikePromise, proposePromise, PromiseCard, type Proposal } from "./PromiseCard";
import { DaySpine } from "./DaySpine";
import { startRecording, toWav16k } from "./voice";
import { Command } from "./Command";
import { EmptyBough, NewHoot } from "./Onboarding";
import { Settings } from "./Settings";
import { applyStoredTheme, COMPOSE_EVENT, goHoot, navigate, readRoute, useRoute } from "./nav";
import { useTabBusy } from "./favicon";
import "./nav.css";

// Parliament v0.2 — boards 03 (IA), 04B (v1 base), 07 (interaction notes).
// One view (the hoot), two drawers, machine footer. URL is the router (nav.ts).

// A locally-held user item that the server hasn't echoed yet.
type Pending = { tid: string; text: string; at: number; status: "sending" | "failed"; turnId?: string };

// tokens: motion.timing.awayDividerFade (mirrored in app.css for the transition)
const AWAY_FADE_MS = 1500;
// tokens: component.item / “scrolled up” threshold for the reply pill
const NEAR_BOTTOM_PX = 400;

const reducedMotion = () =>
  typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// One browser notification per reply, and only while the tab is hidden.
// Permission is asked from the send gesture (never on load); `tag` is the turn
// id so a replayed SSE event collapses onto the same notification.
const canNotify = () => typeof Notification !== "undefined" && Notification.permission === "granted";

const askNotifyPermission = () => {
  if (typeof Notification === "undefined" || Notification.permission !== "default") return;
  Notification.requestPermission().catch(() => {});
};

export function App() {
  const route = useRoute();
  const [hoots, setHoots] = useState<any[]>([]);
  const [items, setItems] = useState<Item[]>([]);
  const [presence, setPresence] = useState<Presence | null>(null);
  const [thinking, setThinking] = useState<{ turnId: string; startedAt: number } | null>(null);
  const [queued, setQueued] = useState<{ text: string; at: number }[]>([]);
  const [outbound, setOutbound] = useState<{ count: number; bytes: number } | null>(null);
  const [facts, setFacts] = useState<Fact[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const drawer = route.drawer;
  const setDrawer = (d: "memory" | "promises" | null) => navigate({ d });
  const [newHoot, setNewHoot] = useState(false);
  const [settings, setSettings] = useState(false);
  const [away, setAway] = useState<{ count: number; since: number } | null>(null);
  const [webRead, setWebRead] = useState<number>(() => Date.now() - 7 * 86_400_000);
  const boughRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLInputElement>(null);
  const [boughId, setBoughId] = useState<string | null>(null);
  const [pending, setPending] = useState<Pending[]>([]);
  const [replies, setReplies] = useState(0);
  const notifiedTurns = useRef<Set<string>>(new Set());
  const atBottom = useRef(true);
  const itemsRef = useRef<Item[]>([]);
  itemsRef.current = items;
  const [loaded, setLoaded] = useState(false);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [proposing, setProposing] = useState(false);
  const [proposalText, setProposalText] = useState("");
  const [runs, setRuns] = useState<any[]>([]);
  const [rec, setRec] = useState<{ stop: () => Promise<{ blob: Blob; ms: number }> } | null>(null);
  const [voiceBusy, setVoiceBusy] = useState<"idle" | "recording" | "hearing">("idle");
  // hunts are never pages: their turns render inline in the bough under a
  // header row, keyed by thread. Hunt goals come from the thread list.
  const [hunts, setHunts] = useState<Record<string, { id: string; goal: string | null }>>({});
  const huntThreads = useRef<{ id: string; goal: string | null }[]>([]);
  const [globalFacts, setGlobalFacts] = useState<Fact[]>([]);

  useEffect(() => {
    applyStoredTheme();
  }, []);

  // tab icon + title follow the turn; back to normal the moment the tab is seen
  // (moved below `state`, which the icon needs)

  // A past day is folded history — the hero shrinks to give the bough its band.
  const hasPastDay = useMemo(
    () => items.some((i) => dayKey(i.created_at) !== dayKey(Date.now())),
    [items]
  );

  // --- load hoots + pick active ---
  useEffect(() => {
    (async () => {
      const hs = await api.hoots();
      setHoots(hs);
      const stored = localStorage.getItem("hootId");
      const active = hs.find((h) => h.id === route.hoot) ?? hs.find((h) => h.id === stored) ?? hs[0];
      setItems([]);
      setAway(null);
      setBoughId(null);
      setLoaded(false);
      if (active) {
        localStorage.setItem("hootId", active.id);
        const threads = await api.threads(active.id);
        const bough = threads.find((t) => t.kind === "bough");
        const mine = threads.filter((t) => t.kind === "hunt").map((t) => ({ id: t.id, goal: t.goal ?? null }));
        huntThreads.current = mine;
        setHunts(Object.fromEntries(mine.map((h) => [h.id, h])));
        setBoughId(bough?.id ?? null);
      }
    })().catch(() => {});
  }, [route.hoot]);

  // --- load bough items (plus every hunt's items — hunts render in the bough) ---
  useEffect(() => {
    if (!boughId) return;
    (async () => {
      const sets = await Promise.all([
        api.items(boughId),
        ...huntThreads.current.map((h) => api.items(h.id).catch(() => [] as Item[])),
      ]);
      const rows: Item[] = ([] as Item[]).concat(...sets).sort((a, b) => a.created_at - b.created_at);
      setItems(rows);
      setLoaded(true);
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
    api.globalFacts().then(setGlobalFacts).catch(() => {});
    api.automations(hootId()).then(setAutomations).catch(() => {});
  };
  useEffect(loadFacts, [hootId()]);
  const loadRuns = () => {
    if (!hootId()) return;
    api.promiseRuns(hootId(), dayKey(Date.now())).then(setRuns).catch(() => {});
  };
  useEffect(loadRuns, [hootId()]);

  // --- keyboard map: / composer · M memory · P promises · [ ] days · 1–9 hoots
  const dayKeys = useMemo(() => [...new Set(items.map((i) => dayKey(i.created_at)))].sort(), [items]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      if (k === "/") {
        e.preventDefault();
        composerRef.current?.focus();
        return;
      }
      if (k === "m") {
        setDrawer(drawer === "memory" ? null : "memory");
        return;
      }
      if (k === "p") {
        setDrawer(drawer === "promises" ? null : "promises");
        return;
      }
      if (k === "[" || k === "]") {
        if (!dayKeys.length) return;
        const at = route.day ? dayKeys.indexOf(route.day) : dayKeys.length - 1;
        const from = at < 0 ? dayKeys.length - 1 : at;
        const next = dayKeys[Math.min(dayKeys.length - 1, Math.max(0, from + (k === "[" ? -1 : 1)))];
        if (next) navigate({ day: next });
        return;
      }
      if (/^[1-9]$/.test(k)) {
        const target = hoots[Number(k) - 1];
        if (target) goHoot(target.id);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [dayKeys, drawer, hoots, route.day]);

  // --- SSE ---
  const stream = useStream((ev) => {
    if (ev.event === "item.append") {
      const item = ev.data.item as Item;
      const text = textOf(item);
      setItems((prev) => (prev.some((p) => p.id === item.id) ? prev : [...prev, item]));
      if (item.role === "user") {
        // the server echo retires the optimistic bubble: turn id first, else the
        // earliest unassigned bubble with the same text (identical sends match once)
        setPending((p) => {
          const key = text.trim();
          let done = false;
          return p.filter((x) => {
            if (x.turnId) return x.turnId !== item.turn_id;
            if (!done && key && x.text.trim() === key) {
              done = true;
              return false;
            }
            return true;
          });
        });
        setQueued((q) => q.filter((x) => x.text.trim() !== text.trim()));
      }
      if (item.role === "hoot") {
        markRead();
        notifyReply(item, text);
        // never yank a reader who has scrolled up — show the pill instead
        if (atBottom.current) scrollToBottom();
        else setReplies((n) => n + 1);
      } else if (atBottom.current) scrollToBottom();
    }
    if (ev.event === "turn.status") {
      const { turn_id, status } = ev.data;
      if (status === "in_progress") setThinking((t) => (t?.turnId === turn_id ? t : { turnId: turn_id, startedAt: Date.now() }));
      if (status === "completed" || status === "interrupted") {
        setThinking((t) => (t?.turnId === turn_id ? null : t));
        // no ghost bubbles if a turn ends without its echo
        setPending((p) => p.filter((x) => x.turnId !== turn_id));
        if (status === "interrupted") {
          loadFacts();
          const last = [...itemsRef.current].reverse().find((i) => i.turn_id === turn_id && i.role === "user");
          const retryText = last ? textOf(last) : "";
          if (retryText) toast("That didn't go through · try again", { label: "retry", run: () => send(retryText) });
        }
      }
    }
    if (ev.event === "fact.changed") loadFacts();
    if (ev.event === "thread.created") {
      // A hunt was spawned mid-session: name it up front so its turns can carry
      // the header row (items themselves arrive as normal item.append events).
      const d = ev.data as any;
      if (d.kind === "hunt" && d.thread_id) {
        const entry = { id: String(d.thread_id), goal: (d.goal as string) ?? null };
        huntThreads.current = [...huntThreads.current, entry];
        setHunts((h) => ({ ...h, [entry.id]: entry }));
      }
    }
    if (ev.event === "automation.fired") {
      api.automations(hootId()).then(setAutomations).catch(() => {});
      loadRuns();
    }
  });

  const scrollToBottom = () => {
    const el = boughRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: reducedMotion() ? "auto" : "smooth" });
    atBottom.current = true;
    setReplies(0);
  };

  const onBoughScroll = () => {
    const el = boughRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
    atBottom.current = near;
    if (near && replies) setReplies(0);
  };

  // POST one turn for a pending bubble; the bubble itself is the optimistic item.
  const postTurn = async (tid: string, text: string) => {
    if (!boughId) return;
    setPending((p) => p.map((x) => (x.tid === tid ? { ...x, status: "sending" } : x)));
    try {
      const res = await api.send(boughId, text, "web");
      setPending((p) => p.map((x) => (x.tid === tid ? { ...x, turnId: res.turn_id } : x)));
      setQueued((q) => [...q, { text, at: Date.now() }]);
    } catch {
      setPending((p) => p.map((x) => (x.tid === tid ? { ...x, status: "failed" } : x)));
      toast("That didn't go through · try again", { label: "retry", run: () => postTurn(tid, text) });
    }
  };

  // Only the reply the user is waiting on is worth a notification; at most one
  // per turn, so SSE replay and multi-item turns can't stack.
  const notifyReply = (item: Item, text: string) => {
    if (!document.hidden || !canNotify() || !text.trim()) return;
    if (notifiedTurns.current.has(item.turn_id)) return;
    notifiedTurns.current.add(item.turn_id);
    const n = new Notification("Juniper", { body: text.slice(0, 120), tag: item.turn_id });
    n.onclick = () => {
      window.focus();
      n.close();
    };
  };

  const send = (text: string) => {
    if (!boughId) return;
    askNotifyPermission();
    // A cadence reads as a promise: propose first, schedule on confirm
    // (board 05 — nothing is scheduled until "I promise").
    if (!proposal && looksLikePromise(text)) {
      setProposalText(text);
      setProposing(true);
      proposePromise(hootId(), text)
        .then((p) => setProposal(p))
        .catch(() => {
          toast("Couldn't draft that promise · sending as a message");
          sendNow(text);
        })
        .finally(() => setProposing(false));
      return;
    }
    sendNow(text);
  };

  const sendNow = (text: string) => {
    if (!boughId) return;
    const tid = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPending((p) => [...p, { tid, text, at: Date.now(), status: "sending" }]);
    atBottom.current = true;
    setReplies(0);
    postTurn(tid, text);
  };

  const confirmPromise = (editedPrompt: string) => {
    if (!proposal) return;
    api
      .createAutomation(hootId(), {
        title: proposal.title,
        prompt: editedPrompt,
        rrule: proposal.rrule,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        thread_kind: "bough",
        deliver: 1,
      })
      .then(() => {
        loadFacts();
        toast("Promise kept");
      })
      .catch(() => toast("That didn't go through · try again"));
  };

  const dismissProposal = () => {
    const text = proposalText;
    setProposal(null);
    if (text) sendNow(text);
  };

  const retry = (p: Pending) => postTurn(p.tid, p.text);

  // Push-to-talk: click to start, click to send (mic permission is the gesture).
  const toggleVoice = async () => {
    if (voiceBusy === "hearing") return;
    if (!rec) {
      try {
        setRec(await startRecording());
        setVoiceBusy("recording");
      } catch {
        toast("No microphone — check permissions");
      }
      return;
    }
    const active = rec;
    setRec(null);
    setVoiceBusy("hearing");
    try {
      const { blob, ms } = await active.stop();
      if (ms < 400) {
        setVoiceBusy("idle");
        return; // a tap, not speech
      }
      const wav = await toWav16k(blob);
      const res = await api.voiceTurn(hootId(), wav);
      if ("needsModel" in res) {
        setVoiceBusy("idle");
        toast("Voice needs a one-time model (671 MB)", {
          label: "download",
          run: async () => {
            await api.voicePull();
            toast("Downloading the voice model — try the mic in a minute");
          },
        });
        return;
      }
      setVoiceBusy("idle");
      setReplies(0);
      atBottom.current = true;
    } catch (err: any) {
      setVoiceBusy("idle");
      toast(String(err?.message ?? "Didn't catch that · try again"));
    }
  };

  // Every drawer write goes through here so a failure is one toast with a retry.
  const factAction = (run: () => Promise<unknown>) => {
    run()
      .then(loadFacts)
      .catch(() => toast("That didn't go through · try again", { label: "retry", run: () => factAction(run) }));
  };

  const jumpToItem = (itemId: string) => {
    const existing = items.find((i) => i.id === itemId);
    const focus = () => {
      const el = document.getElementById(`item-${itemId}`);
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
      el?.classList.add("hl");
      setTimeout(() => el?.classList.remove("hl"), 1600);
    };
    if (existing) return focus();
    api
      .item(itemId)
      .then((it) => {
        setItems((prev) => (prev.some((p) => p.id === it.id) ? prev : [...prev, it].sort((a, b) => a.created_at - b.created_at)));
        setTimeout(focus, 60);
      })
      .catch(() => toast("Couldn't find the source of that fact"));
  };

  const hootName = hoots.find((h) => h.id === hootId())?.name ?? "Hoot";
  // Topic filter (⌘K TOPICS): client-side over the loaded bough, never a page.
  const topic = route.topic;
  const shownItems = useMemo(
    () => (topic ? items.filter((it) => topicMatch(it, topic)) : items),
    [items, topic]
  );
  const state: PresenceState =
    thinking ? "thinking" : stream.status === "quiet" ? "quiet" : (presence?.status as PresenceState) ?? "awake";

  useTabBusy(!!thinking, state);

  return (
    <div className={`shell${drawer ? " has-drawer" : ""}`}>
      <a
        className="skip-link"
        href="#composer-input"
        onClick={(e) => {
          e.preventDefault();
          composerRef.current?.focus();
        }}
      >
        skip to composer
      </a>
      <nav className="rail" aria-label="Parliament">
        {hoots.map((h) => (
          <button
            key={h.id}
            className={"rail-hoot" + (h.id === hootId() ? " active" : "")}
            title={h.name}
            onClick={() => goHoot(h.id)}
          >
            <span className="monogram">{h.name.slice(0, 1)}</span>
          </button>
        ))}
        <button className="rail-new" title="New hoot" onClick={() => setNewHoot(true)}>
          +
        </button>
      </nav>

      <main className="bough" ref={boughRef} onScroll={onBoughScroll}>
        <PresenceHeader
          name={hootName}
          state={state}
          presence={presence}
          thinking={thinking}
          runs={runs}
          compact={hasPastDay}
        />
        {loaded && !items.length && !thinking && <EmptyBough onConnectTelegram={() => setSettings(true)} />}
        <DaySpine
          todayKey={dayKey(Date.now())}
          dayKeys={[...new Set(items.map((i) => dayKey(i.created_at)))]}
          onJump={(k) => {
            if (k === dayKey(Date.now())) boughRef.current?.scrollTo({ top: boughRef.current.scrollHeight, behavior: "smooth" });
            else navigate({ day: k });
          }}
        />
        {topic && (
          <div className="topic-chip">
            <span className="topic-chip-label">topic · {topic}</span>
            <button onClick={() => navigate({ topic: null })} aria-label="Clear topic filter">
              ×
            </button>
          </div>
        )}
        <Items
          items={shownItems}
          hunts={hunts}
          topic={topic}
          thinking={thinking}
          queued={queued}
          pending={pending}
          onRetry={retry}
          away={away}
          webRead={webRead}
          boughRef={boughRef}
          focusDay={route.day}
        />
        {proposing && !proposal && <p className="proposal-line pending">drafting the promise…</p>}
        {proposal && (
          <PromiseCard
            proposal={proposal}
            busy={false}
            onConfirm={confirmPromise}
            onDismiss={dismissProposal}
            onEdit={() => {
              setProposal(null);
              composerRef.current?.focus();
              window.dispatchEvent(new CustomEvent(COMPOSE_EVENT, { detail: proposalText }));
            }}
          />
        )}
        <Composer
          onSend={send}
          busy={!!thinking}
          inputRef={composerRef}
          voice={voiceBusy}
          onVoice={toggleVoice}
        />
      </main>

      {replies > 0 && (
        <button className="reply-pill" onClick={scrollToBottom}>
          {hootName} replied{replies > 1 ? ` ${replies} times` : ""} ▽
        </button>
      )}

      <Drawer side="right" persistOnWide open={drawer === "memory"} onClose={() => setDrawer(null)} label="Memory">
        <Memory
          facts={facts}
          globalFacts={globalFacts}
          hootName={hootName}
          highlight={route.fact}
          onJump={jumpToItem}
          onConfirm={(id) => factAction(() => api.confirmFact(id))}
          onForget={(id) => factAction(() => api.forgetFact(id))}
          onEdit={(id, text) => factAction(() => api.editFact(id, text))}
          onScope={(id, scope) => factAction(() => api.patchFactScope(id, scope))}
        />
      </Drawer>
      <Drawer side="right" open={drawer === "promises"} onClose={() => setDrawer(null)} label="Promises">
        <Promises automations={automations} hootId={hootId()} runs={runs} onToggle={(id, enabled) => factAction(() => api.patchAutomation(id, { enabled }))} />
      </Drawer>

      <footer className="machine">
        <button className={"mem-toggle" + (drawer === "memory" ? " on" : "")} onClick={() => setDrawer(drawer === "memory" ? null : "memory")}>
          memory
        </button>
        <button className={drawer === "promises" ? "on" : ""} onClick={() => setDrawer(drawer === "promises" ? null : "promises")}>
          promises
        </button>
        <button className={settings ? "on" : ""} onClick={() => setSettings(true)}>
          settings
        </button>
        <span className="spacer" />
        <span className={`conn-dot ${stream.status}`} aria-hidden />
        {stream.status === "quiet" ? (
          <span className="conn quiet">can't reach the daemon{stream.since ? ` · since ${timeOf(stream.since)}` : ""}</span>
        ) : stream.status === "reconnecting" ? (
          <span className="conn">reconnecting…</span>
        ) : (
          <>
            <span>sids-mbp</span>
            <span>127.0.0.1:7420</span>
            <span>~/.hoots</span>
          </>
        )}
        <span>
          {outbound ? `${outbound.count} sent out today` : "—"} →
        </span>
      </footer>
      <Toaster />

      <Command hoots={hoots} onClose={() => {}} />
      <NewHoot
        open={newHoot}
        onClose={() => setNewHoot(false)}
        onCreated={(h) => {
          setNewHoot(false);
          setHoots((prev) => [...prev, h]);
          goHoot(h.id);
        }}
      />
      <Settings
        open={settings}
        hoot={hoots.find((h) => h.id === hootId()) ?? null}
        onClose={() => setSettings(false)}
        onSaved={(next) => setHoots((prev) => prev.map((h) => (h.id === next.id ? { ...h, ...next } : h)))}
      />
    </div>
  );
}

// Failure surfaces for drawer writes; retry re-runs the same mutation.
function textOf(item: Item): string {
  try {
    return String(JSON.parse(item.content)?.text ?? "");
  } catch {
    return "";
  }
}

function hootId(): string {
  return readRoute().hoot || localStorage.getItem("hootId") || "";
}

/** Client-side topic filter over already-loaded items (?topic=). */
function topicMatch(item: Item, topic: string): boolean {
  const needle = topic.toLowerCase();
  let text = "";
  try {
    text = String(JSON.parse(item.content)?.text ?? "");
  } catch {
    text = String(item.content ?? "");
  }
  return text.toLowerCase().includes(needle);
}

/**
 * Wrap case-insensitive matches of `q` in <mark> inside every text node of
 * `root`. Re-runnable: clears its own marks (and re-normalises) first.
 */
function highlightIn(root: HTMLElement, q: string | null) {
  root.querySelectorAll("mark.hl").forEach((m) => m.replaceWith(document.createTextNode(m.textContent ?? "")));
  root.normalize();
  const needle = (q ?? "").toLowerCase();
  if (!needle) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const lower = text.toLowerCase();
    if (!lower.includes(needle)) continue;
    const frag = document.createDocumentFragment();
    let from = 0;
    let at = lower.indexOf(needle);
    while (at >= 0) {
      frag.append(text.slice(from, at));
      const mark = document.createElement("mark");
      mark.className = "hl";
      mark.textContent = text.slice(at, at + needle.length);
      frag.append(mark);
      from = at + needle.length;
      at = lower.indexOf(needle, from);
    }
    frag.append(text.slice(from));
    node.replaceWith(frag);
  }
}

// --- presence header (board 04B, voice rule: chrome is third person) ---------
function PresenceHeader({ name, state, presence, thinking, runs, compact }: any) {
  const sent = runs.filter((r: any) => r.outcome === "sent").length;
  const missed = runs.filter((r: any) => r.outcome === "missed").length;
  const elapsed = useElapsed(thinking?.startedAt ?? null);
  const next = presence?.nextPromise
    ? new Date(presence.nextPromise).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
    : null;
  const hero = state === "thinking" ? `${name} is thinking.` : state === "sleeping" ? `${name} is sleeping.` : state === "quiet" ? `${name} has gone quiet.` : `${name} is awake.`;
  const lastHeard = presence?.lastHeard
    ? `last heard from you ${timeOf(presence.lastHeard.at)} · ${presence.lastHeard.surface}`
    : null;
  return (
    <header className={`presence${compact ? " compact" : ""}`}>
      <Glyph state={state} size={compact ? 24 : 40} />
      <div className="presence-lines">
        <h1 className="hero">{hero}</h1>
        <p className="chrome-line">
          {lastHeard ?? "no messages yet"}
          {thinking ? ` · thinking ${elapsed}` : next ? ` · next check-in ${next}` : ""}
          {runs.length > 0 && <span className="kept-counter"> · {sent} sent · {missed} missed</span>}
        </p>
      </div>
    </header>
  );
}

// --- items + day folding (board 04A) -----------------------------------------

function Items({
  items,
  hunts,
  topic,
  thinking,
  queued,
  pending,
  onRetry,
  away,
  webRead,
  boughRef,
  focusDay,
}: {
  items: Item[];
  hunts: Record<string, { id: string; goal: string | null }>;
  topic: string | null;
  thinking: { turnId: string; startedAt: number } | null;
  queued: { text: string; at: number }[];
  pending: Pending[];
  onRetry: (p: Pending) => void;
  away: { count: number; since: number } | null;
  webRead: number;
  boughRef: React.RefObject<HTMLDivElement | null>;
  focusDay: string | null;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [digests, setDigests] = useState<Record<string, string | null>>({});

  // arriving via ⌘K with ?day= — open it and put it in view
  useEffect(() => {
    if (!focusDay) return;
    setExpanded((e) => ({ ...e, [focusDay]: true }));
    const t = setTimeout(() => {
      document.querySelector(`[data-date="${focusDay}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    }, 40);
    return () => clearTimeout(t);
  }, [focusDay, items.length]);

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
    <div className="days" role="log" aria-live="polite" aria-relevant="additions">
      {days.map(([k, dayItems]) => {
        const isToday = k === todayKey;
        const open = isToday || !!expanded[k];
        const digest = digests[k];
        return (
          <section className="day" key={k} data-date={k}>
            <header className="day-head-row" onClick={() => !isToday && expandDay(k)}>
              <h2 className="day-head">{dayLabel(dayItems[0].created_at)}</h2>
              {!isToday && !open && (
                digest === undefined ? <p className="day-digest">· · ·</p>
                : digest === "" ? <p className="day-digest muted">quiet day</p>
                : digest === null ? <p className="day-digest muted">digest unavailable · <button className="linky" onClick={(e) => { e.stopPropagation(); setDigests((g) => { const n = { ...g }; delete n[k]; return n; }); }}>retry</button></p>
                : <p className="day-digest">{digest}</p>
              )}
            </header>
            {(open || isToday) && (
              <div className="day-items">
                {away && !awayShown && k === todayKey && ((awayShown = true), null)}
                {dayItems.map((it, i) => (
                  <React.Fragment key={it.id}>
                    {away && !awayShown && it.surface === "telegram" && it.created_at > webRead && ((awayShown = true),
                    (
                      <AwayDivider away={away} boughRef={boughRef} key={`away-${it.id}`} />
                    ))}
                    {hunts[it.thread_id] && dayItems[i - 1]?.thread_id !== it.thread_id && (
                      <p className="hunt-head">
                        ⌁ hunt · {hunts[it.thread_id].goal ?? "untitled"}
                      </p>
                    )}
                    <ItemRow item={it} topic={topic} />
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
      {pending.map((p) => (
        <PendingRow key={p.tid} p={p} onRetry={() => onRetry(p)} />
      ))}
      {queued.map((q) => (
        <div className="queued-chip" key={q.at}>
          queued next · “{q.text.length > 40 ? q.text.slice(0, 40) + "…" : q.text}”
        </div>
      ))}
    </div>
  );
}

// The divider is a reading aid, not furniture: it scrolls itself near the top
// on load, then fades out for good on first user scroll or once it leaves the
// viewport (tokens: component.awayDivider.read, motion.timing.awayDividerFade).
function AwayDivider({
  away,
  boughRef,
}: {
  away: { count: number; since: number };
  boughRef: React.RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"shown" | "fading" | "gone">("shown");
  const faded = useRef(false);

  const fade = () => {
    if (faded.current) return;
    faded.current = true;
    setPhase("fading");
    setTimeout(() => setPhase("gone"), AWAY_FADE_MS);
  };

  // park the divider near the top rather than the bottom of the bough
  useEffect(() => {
    const bough = boughRef.current;
    const el = ref.current;
    if (!bough || !el) return;
    const delta = el.getBoundingClientRect().top - bough.getBoundingClientRect().top;
    bough.scrollTop = Math.max(0, bough.scrollTop + delta - 96);
  }, []);

  // first *user* scroll (our own placement fires scroll too, so arm late)
  useEffect(() => {
    const bough = boughRef.current;
    if (!bough) return;
    let armed = false;
    const arm = setTimeout(() => (armed = true), 350);
    const onScroll = () => {
      if (armed) fade();
    };
    bough.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      clearTimeout(arm);
      bough.removeEventListener("scroll", onScroll);
    };
  }, []);

  // …or as soon as it scrolls out of view
  useEffect(() => {
    const el = ref.current;
    const root = boughRef.current;
    if (!el || !root || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => !e.isIntersecting && fade(), { root });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  if (phase === "gone") return null;
  return (
    <div ref={ref} className={`away-divider${phase === "fading" ? " fading" : ""}`}>
      WHILE YOU WERE AWAY · {away.count} ON TELEGRAM · since {timeOf(away.since)}
    </div>
  );
}

// Optimistic user bubble. Optimistic is dashed-adjacent: 0.7 opacity while
// sending, quiet meta + click-to-retry when the POST failed.
function PendingRow({ p, onRetry }: { p: Pending; onRetry: () => void }) {
  const failed = p.status === "failed";
  return (
    <div className="item mine pending">
      <div
        className={`bubble${failed ? " clickable" : ""}`}
        onClick={failed ? onRetry : undefined}
        role={failed ? "button" : undefined}
        tabIndex={failed ? 0 : undefined}
        onKeyDown={
          failed
            ? (e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onRetry();
                }
              }
            : undefined
        }
      >
        <p className="plain">{p.text}</p>
      </div>
      <p className={`meta${failed ? " failed" : ""}`}>{failed ? "didn't send · retry" : "sending…"}</p>
    </div>
  );
}

function ItemRow({ item, topic }: { item: Item; topic: string | null }) {
  const bubbleRef = useRef<HTMLDivElement>(null);
  let c: any = {};
  try {
    c = JSON.parse(item.content);
  } catch {
    c = { text: item.content };
  }
  // Highlighting mutates the rendered text nodes in place, so it must run after
  // React commits — and clear its own marks before re-marking.
  useEffect(() => {
    if (bubbleRef.current) highlightIn(bubbleRef.current, topic);
  }, [topic, item.content]);
  if (item.kind === "note") {
    return (
      <div className="noted-chip">
        <span className="noted-label">NOTED</span>
        <span ref={bubbleRef}>
          {c.fact}
        </span>
      </div>
    );
  }
  if (item.kind !== "message") return null;
  const mine = item.role === "user";
  return (
    <div className={`item ${mine ? "mine" : "theirs"}`} id={`item-${item.id}`}>
      <div className="bubble" ref={bubbleRef}>
        {mine ? <p className="plain">{String(c.text ?? "")}</p> : <Markdown text={String(c.text ?? "")} />}
      </div>
      <p className="meta">
        {timeOf(item.created_at)}
        {item.surface === "telegram" && <span className="surface"> · via Telegram</span>}
        {/* `sent` only once the server item exists — nothing optimistic gets here */}
        {mine && <span className="sent-mark"> · sent</span>}
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

function Composer({
  onSend,
  busy,
  inputRef,
  voice,
  onVoice,
}: {
  onSend: (text: string) => void;
  busy: boolean;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  voice?: "idle" | "recording" | "hearing";
  onVoice?: () => void;
}) {
  const [text, setText] = useState("");
  // empty-state chips fill the composer instead of sending
  useEffect(() => {
    const fill = (e: Event) => {
      setText((e as CustomEvent<string>).detail);
      inputRef?.current?.focus();
    };
    addEventListener(COMPOSE_EVENT, fill);
    return () => removeEventListener(COMPOSE_EVENT, fill);
  }, [inputRef]);
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    setText("");
    onSend(t);
  };
  return (
    <form className="composer" onSubmit={submit}>
      <button
        type="button"
        className={`mic ${voice ?? "idle"}`}
        onClick={onVoice}
        aria-label={voice === "recording" ? "Stop and send" : "Speak"}
        title={voice === "recording" ? "Stop and send" : voice === "hearing" ? "Hearing…" : "Hold to talk"}
      >
        {voice === "hearing" ? "…" : "🎙"}
      </button>
      <input
        id="composer-input"
        ref={inputRef}
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
function Drawer({ side, open, persistOnWide, onClose, label, children }: any) {
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!open) return;
    const el = ref.current;
    el?.querySelector<HTMLElement>("button, [href], input, textarea, select")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      if (e.key !== "Tab" || !el) return;
      const f = [...el.querySelectorAll<HTMLElement>("button, [href], input, textarea, select")].filter((n) => !n.hasAttribute("disabled"));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);
  if (!open && !persistOnWide) return null;
  const hidden = persistOnWide && !open ? " drawer-collapsed" : "";
  return (
    <>
      {open && <div className="drawer-scrim" aria-hidden="true" onClick={onClose} />}
      <aside ref={ref} className={`drawer drawer-${side}${hidden}`} role="dialog" aria-modal={open || undefined} aria-label={label}>
        <header className="drawer-head">
          <h3>{label}</h3>
          <button className="ghost" onClick={onClose}>
            close
          </button>
        </header>
        <div className="drawer-body">{children}</div>
      </aside>
    </>
  );
}

function Memory({
  facts,
  globalFacts,
  hootName,
  highlight,
  onJump,
  onConfirm,
  onForget,
  onEdit,
  onScope,
}: {
  facts: Fact[];
  globalFacts: Fact[];
  hootName: string;
  highlight: string | null;
  onJump: (itemId: string) => void;
  onConfirm: (id: string) => void;
  onForget: (id: string) => void;
  onEdit: (id: string, text: string) => void;
  onScope: (id: string, scope: "global" | "hoot") => void;
}) {
  const [summary, setSummary] = useState("");
  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`fact-${highlight}`)?.scrollIntoView({ block: "center" });
  }, [highlight, facts.length]);
  useEffect(() => {
    const h = localStorage.getItem("hootId") ?? "";
    api.pellet(h).then((p) => setSummary(p.summary ?? "")).catch(() => {});
  }, [facts.length]);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const groups: { label: string; rows: Fact[] }[] = useMemo(() => {
    const week: Fact[] = [];
    const people: Fact[] = [];
    const ongoing: Fact[] = [];
    const weekAgo = Date.now() - 7 * 86_400_000;
    // Globals live in their own section below, not in this hoot's groups.
    for (const f of facts) {
      if (f.scope === "global") continue;
      if (f.category === "person") people.push(f);
      else if (f.created_at >= weekAgo) week.push(f);
      else ongoing.push(f);
    }
    return [
      { label: "THIS WEEK", rows: week },
      { label: "PEOPLE", rows: people },
      { label: "ONGOING", rows: ongoing },
    ].filter((g) => g.rows.length);
  }, [facts]);
  return (
    <div>
      {summary && (
        <section className="pellet-summary">
          <p className="label">SUMMARY</p>
          <p className="small">{summary}</p>
        </section>
      )}
      <p className="label">FACTS · {facts.length}</p>
      {groups.map((g) => (
      <section key={g.label}>
      <p className="label">{g.label}</p>
      <ul className="facts">
        {g.rows.map((f) => (
          <li id={`fact-${f.id}`} key={f.id} className={`fact ${f.confidence === "extracted" ? "guess" : ""}${highlight === f.id ? " hl" : ""}`}>
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
              <p
                className="fact-text"
                title={f.source_item_id ? "jump to source" : undefined}
                onClick={() => f.source_item_id && onJump(f.source_item_id)}
                style={f.source_item_id ? { cursor: "pointer" } : undefined}
              >
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
              {f.scope !== "global" && (
                <button
                  className="fact-everywhere"
                  title="share with all hoots"
                  onClick={() => onScope(f.id, "global")}
                >
                  everywhere
                </button>
              )}
              <button onClick={() => onForget(f.id)}>forget</button>
            </div>
          </li>
        ))}
      </ul>
      </section>
      ))}
      {!facts.length && <p className="small muted">Nothing yet. Everything {hootName} learns shows up here.</p>}
      <section className="shared-facts">
        <p className="label">SHARED WITH ALL HOOTS</p>
        <p className="caption muted">“everywhere” puts a fact in every hoot's context — only you promote one.</p>
        <ul className="facts">
          {globalFacts.map((f) => (
            <li id={`fact-${f.id}`} key={f.id} className={`fact global${highlight === f.id ? " hl" : ""}`}>
              <p className="fact-text">{f.text}</p>
              <p className="fact-meta">
                {f.hoot_name ? `from ${f.hoot_name} · ` : ""}
                {new Date(f.created_at).toLocaleDateString([], { day: "numeric", month: "short" })}
              </p>
              <div className="fact-actions">
                <button onClick={() => onScope(f.id, "hoot")}>this hoot only</button>
              </div>
            </li>
          ))}
          {!globalFacts.length && <li className="small muted">Nothing shared yet.</li>}
        </ul>
      </section>
    </div>
  );
}

function Promises({
  automations,
  runs,
  onToggle,
}: {
  automations: Automation[];
  hootId: string;
  runs: any[];
  onToggle: (id: string, enabled: boolean) => void;
}) {
  const today = dayKey(Date.now());
  const fmt = (ms: number) => timeOf(ms);
  const upcoming = automations
    .filter((a) => a.enabled && a.next_fire_at)
    .sort((a, b) => (a.next_fire_at ?? 0) - (b.next_fire_at ?? 0));
  return (
    <div>
      <p className="label">TODAY</p>
      <ul className="runs">
        {runs.map((r) => (
          <li key={r.id} className="run-row">
            <span className={`run-dot ${r.outcome}`} aria-hidden />
            <span className="run-time">{timeOf(r.scheduled_at)}</span>
            <span>{r.title}</span>
            <span className="muted">· {r.outcome}</span>
          </li>
        ))}
        {upcoming[0]?.next_fire_at && (
          <li className="run-row">
            <span className="run-dot next" aria-hidden />
            <span className="run-time">{fmt(upcoming[0].next_fire_at)}</span>
            <span>next</span>
          </li>
        )}
        {!runs.length && !upcoming.length && <li className="run-row muted">nothing scheduled today</li>}
      </ul>
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
