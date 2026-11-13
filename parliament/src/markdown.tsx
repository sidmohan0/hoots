import React, { useMemo } from "react";

// Dependency-free markdown for hoot replies.
//
// Sanitising strategy: nothing is ever handed to `dangerouslySetInnerHTML`.
// The source is parsed into React elements, so all text is escaped by React
// itself and no tag/attribute from the model can survive into the DOM. URLs
// are additionally allow-listed (`http:`, `https:`, `mailto:`, root-relative,
// fragment) before they reach `href`.
//
// Supported: bold, italic, inline code, fenced code, allow-listed links,
// ordered/unordered lists, blockquotes, ATX headings, paragraphs.
// User messages stay plain text (see .plain in app.css) — only hoots speak md.

type Block =
  | { t: "p"; text: string }
  | { t: "code"; lang: string; text: string }
  | { t: "list"; ordered: boolean; items: string[] }
  | { t: "quote"; blocks: Block[] }
  | { t: "h"; level: number; text: string };

const SAFE_URL = /^(?:https?:\/\/|mailto:|\/|#)/i;
const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HEADING = /^\s*(#{1,6})\s+(.*)$/;

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out: Block[] = [];
  let i = 0;
  let para: string[] = [];

  const flushPara = () => {
    if (para.length) {
      out.push({ t: "p", text: para.join("\n") });
      para = [];
    }
  };

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushPara();
      i++;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      flushPara();
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      out.push({ t: "code", lang: fence[1] ?? "", text: body.join("\n") });
      continue;
    }

    const head = HEADING.exec(line);
    if (head) {
      flushPara();
      out.push({ t: "h", level: head[1].length, text: head[2] });
      i++;
      continue;
    }

    if (QUOTE.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(QUOTE.exec(lines[i++])![1]);
      out.push({ t: "quote", blocks: parseBlocks(body.join("\n")) });
      continue;
    }

    const ordered = ORDERED.test(line);
    if (ordered || BULLET.test(line)) {
      flushPara();
      const items: string[] = [];
      while (i < lines.length) {
        const m = (ordered ? ORDERED : BULLET).exec(lines[i]);
        if (m) {
          items.push(m[1]);
          i++;
          // continuation lines of the same item
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !BULLET.test(lines[i]) && !ORDERED.test(lines[i])) {
            items[items.length - 1] += " " + lines[i].trim();
            i++;
          }
          continue;
        }
        if (!lines[i].trim()) {
          // a blank line ends the list unless another item follows
          let j = i + 1;
          while (j < lines.length && !lines[j].trim()) j++;
          const resumes = j < lines.length && (ordered ? ORDERED : BULLET).test(lines[j]);
          if (!resumes) break;
          i = j;
          continue;
        }
        break;
      }
      out.push({ t: "list", ordered, items });
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushPara();
  return out;
}

function inline(src: string, key: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  let buf = "";
  let i = 0;

  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = "";
    }
  };

  while (i < src.length) {
    const c = src[i];

    if (c === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flush();
        out.push(
          <code className="md-code" key={`${key}-c${i}`}>
            {src.slice(i + 1, end)}
          </code>
        );
        i = end + 1;
        continue;
      }
    }

    if (c === "[") {
      const m = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(src.slice(i));
      if (m && SAFE_URL.test(m[2])) {
        flush();
        out.push(
          <a key={`${key}-a${i}`} href={m[2]} target="_blank" rel="noreferrer noopener">
            {inline(m[1], `${key}-a${i}`)}
          </a>
        );
        i += m[0].length;
        continue;
      }
    }

    if (c === "*" || c === "_") {
      const strong = src.startsWith(c + c, i);
      // avoid snake_case becoming italic
      const openOk = c === "*" || i === 0 || !/\w/.test(src[i - 1]);
      const delim = strong ? c + c : c;
      const end = openOk ? src.indexOf(delim, i + delim.length) : -1;
      if (end > i + delim.length) {
        flush();
        const inner = src.slice(i + delim.length, end);
        out.push(
          strong ? (
            <strong key={`${key}-s${i}`}>{inline(inner, `${key}-s${i}`)}</strong>
          ) : (
            <em key={`${key}-e${i}`}>{inline(inner, `${key}-e${i}`)}</em>
          )
        );
        i = end + delim.length;
        continue;
      }
    }

    if (c === "\n") {
      flush();
      out.push(<br key={`${key}-br${i}`} />);
      i++;
      continue;
    }

    buf += c;
    i++;
  }
  flush();
  return out;
}

function block(b: Block, key: string): React.ReactNode {
  switch (b.t) {
    case "p":
      return <p key={key}>{inline(b.text, key)}</p>;
    case "code":
      return (
        <pre className="md-pre" key={key}>
          <code className="md-code" data-lang={b.lang || undefined}>
            {b.text}
          </code>
        </pre>
      );
    case "h":
      return React.createElement(`h${Math.min(b.level, 3)}`, { key, className: "md-h" }, inline(b.text, key));
    case "quote":
      return (
        <blockquote className="md-quote" key={key}>
          {b.blocks.map((inner, n) => block(inner, `${key}-${n}`))}
        </blockquote>
      );
    case "list": {
      const kids = b.items.map((text, n) => <li key={`${key}-i${n}`}>{inline(text, `${key}-i${n}`)}</li>);
      return b.ordered ? (
        <ol className="md-list" key={key}>
          {kids}
        </ol>
      ) : (
        <ul className="md-list" key={key}>
          {kids}
        </ul>
      );
    }
  }
}

export function Markdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseBlocks(text ?? ""), [text]);
  return <div className="md">{blocks.map((b, i) => block(b, `b${i}`))}</div>;
}
