import React, { useEffect, useMemo, useRef, useState } from "react";
import { api, type Fact, type Item } from "./api";
import { dayKey, dayLabel } from "./hooks";
import { goDay, goHoot, goTopic, openFact } from "./nav";
import "./nav.css";

// ⌘K — one overlay: hoots, days, facts, topics (DECISIONS #3).
// Enter always lands in the bough, never on a results page.

type Row = {
  key: string;
  kind: "hoot" | "day" | "fact" | "topic";
  hoot: string;
  label: string;
  sub?: string;
  date?: string;
  category?: string | null;
};

type Section = { name: "HOOTS" | "DAYS" | "FACTS" | "TOPICS"; rows: Row[] };

const THIRTY_DAYS = 30 * 86_400_000;

function score(q: string, text: string): number {
  if (!q) return 1;
  const needle = q.toLowerCase();
  const hay = text.toLowerCase();
  let i = 0;
  let run = 0;
  let total = 0;
  for (const ch of hay) {
    if (ch === needle[i]) {
      run += 1;
      total += 1 + run * 0.5;
      i += 1;
      if (i === needle.length) return total + 1;
    } else {
      run = 0;
    }
  }
  return 0;
}

export function Command({
  hoots,
  onClose,
}: {
  hoots: any[];
  onClose: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const [days, setDays] = useState<Row[]>([]);
  const [facts, setFacts] = useState<Row[]>([]);
  const [topicRows, setTopicRows] = useState<Row[]>([]);
  const dialogRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const restoreTo = useRef<HTMLElement | null>(null);

  // ⌘K / Ctrl+K from anywhere (the palette owns its own trigger).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Load the index fresh every time the palette opens.
  useEffect(() => {
    if (!open) return;
    restoreTo.current = document.activeElement as HTMLElement | null;
    setQ("");
    setSel(0);
    let cancelled = false;
    (async () => {
      const cutoff = Date.now() - THIRTY_DAYS;
      const dayRows: Row[] = [];
      const factRows: Row[] = [];
      await Promise.all(
        hoots.map(async (h) => {
          try {
            const threads = await api.threads(h.id);
            const bough = threads.find((t: any) => t.kind === "bough");
            if (bough) {
              const items: Item[] = await api.items(bough.id);
              const seen = new Set<string>();
              for (const it of items) {
                if (it.created_at < cutoff) continue;
                const k = dayKey(it.created_at);
                if (seen.has(k)) continue;
                seen.add(k);
                dayRows.push({ key: `d:${h.id}:${k}`, kind: "day", hoot: h.id, label: dayLabel(it.created_at), sub: h.name, date: k });
              }
            }
            const fs: Fact[] = await api.facts(h.id);
            for (const f of fs.slice(0, 80)) {
              factRows.push({ key: `f:${f.id}`, kind: "fact", hoot: h.id, label: f.text, sub: h.name, category: f.category });
            }
          } catch {
            /* one dead hoot shouldn't sink the palette */
          }
        })
      );
      if (cancelled) return;
      dayRows.sort((a, b) => ((a.date ?? "") < (b.date ?? "") ? -1 : 1));
      setDays(dayRows);
      setFacts(factRows);
    })().catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 0);
    return () => {
      cancelled = true;
    };
  }, [open, hoots]);

  // Topics are searched on the perch, not derived from the fact list: three
  // characters in, ask each hoot what it keeps talking about.
  useEffect(() => {
    if (!open) return;
    const needle = q.trim();
    if (needle.length < 3) {
      setTopicRows([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      Promise.all(
        hoots.map(async (h) => {
          try {
            const ts = await api.topics(h.id, needle);
            return ts.map<Row>((x) => ({
              key: `t:${h.id}:${x.topic}`,
              kind: "topic",
              hoot: h.id,
              label: x.topic,
              sub: `${h.name} · ${x.count}`,
            }));
          } catch {
            return [] as Row[];
          }
        })
      )
        .then((all) => {
          if (!cancelled) setTopicRows(([] as Row[]).concat(...all));
        })
        .catch(() => {});
    }, 150);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, open, hoots]);

  // Restore focus on close.
  useEffect(() => {
    if (!open) {
      restoreTo.current?.focus?.();
      onClose();
    }
  }, [open, onClose]);

  const sections = useMemo<Section[]>(() => {
    const hootRows: Row[] = hoots.map((h) => ({
      key: `h:${h.id}`,
      kind: "hoot",
      hoot: h.id,
      label: h.name,
      sub: h.status === "paused" ? "paused" : h.model_name ?? undefined,
    }));
    const topicRowsOut =
      q.trim().length >= 3 ? filter(topicRows, q) : topicsOf(facts);
    const sectionsOut: Section[] = [
      { name: "HOOTS", rows: filter(hootRows, q) },
      { name: "DAYS", rows: filter(days, q) },
      { name: "FACTS", rows: filter(facts, q) },
      { name: "TOPICS", rows: topicRowsOut },
    ];
    return sectionsOut.filter((s) => s.rows.length > 0);
  }, [hoots, days, facts, q, topicRows]);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);

  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, flat.length - 1)));
  }, [flat.length]);

  if (!open) return null;

  const close = () => setOpen(false);

  const run = (row: Row | undefined) => {
    if (!row) return;
    if (row.kind === "hoot") goHoot(row.hoot);
    else if (row.kind === "day") goDay(row.hoot, row.date ?? null);
    else if (row.kind === "fact") openFact(row.hoot, row.key.slice(2));
    else if (row.kind === "topic") goTopic(row.hoot, row.label);
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s + 1) % flat.length : 0));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => (flat.length ? (s - 1 + flat.length) % flat.length : 0));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      run(flat[sel]);
      return;
    }
    if (e.key === "Tab") {
      // Focus trap: the input and the close affordance only.
      const nodes = dialogRef.current?.querySelectorAll<HTMLElement>("[data-trap]");
      if (!nodes || nodes.length < 2) return;
      const list = [...nodes];
      const at = list.indexOf(document.activeElement as HTMLElement);
      e.preventDefault();
      list[(at + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus();
    }
  };

  let index = -1;

  return (
    <div className="cmdk-scrim" onMouseDown={close}>
      <div
        className="cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        ref={dialogRef}
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <input
          ref={inputRef}
          data-trap
          className="cmdk-input"
          value={q}
          placeholder="Jump to a hoot, a day, a fact…"
          aria-label="Filter"
          aria-controls="cmdk-list"
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => {
            setQ(e.target.value);
            setSel(0);
          }}
        />
        <div className="cmdk-list" id="cmdk-list" role="listbox" aria-label="Results">
          {!flat.length && q.trim() && <p className="cmdk-empty">Nothing matches “{q}”.</p>}
          {sections.map((s) => (
            <section key={s.name} className="cmdk-section">
              <p className="cmdk-label">{s.name}</p>
              {s.rows.map((row) => {
                index += 1;
                const here = index;
                return (
                  <button
                    key={row.key}
                    role="option"
                    aria-selected={here === sel}
                    className={"cmdk-row" + (here === sel ? " on" : "")}
                    onMouseMove={() => setSel(here)}
                    onClick={() => run(row)}
                  >
                    {row.kind === "hoot" && <span className="cmdk-monogram">{row.label.slice(0, 1)}</span>}
                    <span className="cmdk-text">
                      <span className="cmdk-title">{row.label}</span>
                      {row.sub && <span className="cmdk-sub">{row.sub}</span>}
                    </span>
                    {row.kind === "day" && <span className="cmdk-kind">day</span>}
                    {row.kind === "fact" && <span className="cmdk-kind">fact</span>}
                    {row.kind === "topic" && <span className="cmdk-kind">topic</span>}
                  </button>
                );
              })}
            </section>
          ))}
        </div>
        <footer className="cmdk-foot">
          <span>↑↓ move · ↵ open · esc close</span>
          <button data-trap className="ghost" onClick={close}>
            close
          </button>
        </footer>
      </div>
    </div>
  );
}

function filter(rows: Row[], q: string): Row[] {
  if (!q.trim()) return rows;
  return rows
    .map((r) => ({ r, s: Math.max(score(q, r.label), r.sub ? score(q, r.sub) * 0.5 : 0) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.r);
}

/** Topic suggestions before three characters: fact categories are the stand-in. */
function topicsOf(facts: Row[]): Row[] {
  const seen = new Map<string, Row>();
  for (const f of facts) {
    const tag = f.category;
    if (!tag || seen.has(tag)) continue;
    seen.set(tag, { key: `t:${tag}`, kind: "topic", hoot: f.hoot, label: tag, sub: "topic" });
  }
  return [...seen.values()];
}
