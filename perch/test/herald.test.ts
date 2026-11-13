import { describe, it, expect } from "vitest";
import { toTelegramHtml, chunk } from "../src/herald-telegram.js";

describe("telegram formatting", () => {
  it("renders the html subset and escapes code", () => {
    const md = "**Yes** and *also* `code`\n\n- one\n- two\n\n> quoted\n\n```js\nif (a < b) x();\n```\n\n[link](https://example.com)";
    const html = toTelegramHtml(md);
    expect(html).toContain("<b>Yes</b>");
    expect(html).toContain("<code>code</code>");
    expect(html).toContain("<pre>if (a &lt; b) x();\n</pre>");
    expect(html).toContain('<a href="https://example.com">link</a>');
  });

  it("chunks long replies without exceeding the limit or losing text", () => {
    const long = Array.from({ length: 400 }, (_, i) => `Line ${i} of a long reply.`).join("\n");
    const parts = chunk(long, 1000);
    expect(parts.every((p) => p.length <= 1000)).toBe(true);
    expect(parts.join("").replace(/\n/g, "").length).toBe(long.replace(/\n/g, "").length);
  });
});
