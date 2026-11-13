import React, { useMemo, useState } from "react";

// Board 04A: a month spine for jumping. Dark = a day with entries; one meaning
// only (no heat shading). Days fold to digests in the bough itself.

export function DaySpine({
  dayKeys,
  onJump,
  todayKey,
}: {
  dayKeys: string[]; // YYYY-MM-DD of days that have entries
  onJump: (key: string) => void;
  todayKey: string;
}) {
  const [cursor, setCursor] = useState(() => {
    const [y, m] = todayKey.split("-").map(Number);
    return { y, m };
  });
  const has = useMemo(() => new Set(dayKeys), [dayKeys]);

  const first = new Date(cursor.y, cursor.m - 1, 1);
  const startPad = (first.getDay() + 6) % 7; // Monday-first
  const daysInMonth = new Date(cursor.y, cursor.m, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: startPad }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  const keyOf = (d: number) => `${cursor.y}-${String(cursor.m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const monthLabel = first.toLocaleDateString([], { month: "long", year: "numeric" });

  const shift = (delta: number) => {
    const d = new Date(cursor.y, cursor.m - 1 + delta, 1);
    setCursor({ y: d.getFullYear(), m: d.getMonth() + 1 });
  };

  return (
    <nav className="spine" aria-label="Days">
      <div className="spine-head">
        <button onClick={() => shift(-1)} aria-label="Previous month">‹</button>
        <span>{monthLabel}</span>
        <button onClick={() => shift(1)} aria-label="Next month">›</button>
      </div>
      <div className="spine-grid" role="grid">
        {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
          <span key={i} className="spine-dow" aria-hidden>{d}</span>
        ))}
        {cells.map((d, i) =>
          d === null ? (
            <span key={`p${i}`} />
          ) : (
            <button
              key={d}
              className={`spine-day${has.has(keyOf(d)) ? " has" : ""}${keyOf(d) === todayKey ? " today" : ""}`}
              onClick={() => onJump(keyOf(d))}
              aria-label={`${d} ${monthLabel}${has.has(keyOf(d)) ? " — has entries" : ""}`}
            >
              {d}
            </button>
          )
        )}
      </div>
      <button className="spine-today" onClick={() => onJump(todayKey)}>today</button>
      <p className="spine-note">Dark = a day with entries</p>
    </nav>
  );
}
