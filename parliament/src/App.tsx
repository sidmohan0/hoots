import React from "react";

// Shell per DECISIONS.md #3: one view (the hoot), two drawers, machine footer.
// Boards: 03 (IA) + 04B (v1 base) + 07 (interaction notes). v0.0.1 = structure.

export function App() {
  return (
    <div className="shell" data-theme="dark">
      <nav className="rail" aria-label="Parliament">
        {/* presence glyphs go here */}
      </nav>
      <main className="bough">
        <header className="presence">
          <div className="presence-glyph" />
          <div className="presence-lines">
            <h1 className="hero">Juniper is awake.</h1>
            <p className="chrome-line">last heard from you 12:31 · web · next check-in 15:00</p>
          </div>
        </header>
        <div className="day" data-date="today">
          <h2 className="day-head">Today · Fri 13 Nov</h2>
          <div className="items">{/* bough items */}</div>
        </div>
        <form className="composer" onSubmit={(e) => e.preventDefault()}>
          <input placeholder="Tell Juniper anything…" aria-label="Message Juniper" />
          <button type="submit" className="btn-primary">Send</button>
        </form>
      </main>
      <footer className="machine">
        <span>sids-mbp</span>
        <span>127.0.0.1:7420</span>
        <span>~/.hoots</span>
        <span>0 sent out today →</span>
      </footer>
    </div>
  );
}
