// Parliament design tokens → CSS custom properties.
// Source of truth: ../docs/design-tokens.json (W3C draft format).
// This module is generated once and kept in sync by hand until a build step
// compiles the JSON directly; the light/dark sets are emitted for both themes.

import tokens from "../../docs/design-tokens.json";

type Any = Record<string, any>;

function flatten(obj: Any, prefix: string, out: Record<string, string>) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    const path = prefix ? `${prefix}-${k}` : k;
    if (v && typeof v === "object" && "$value" in v) {
      out[path] = String(v.$value);
    } else if (v && typeof v === "object") {
      flatten(v, path, out);
    }
  }
}

const light: Record<string, string> = {};
flatten(tokens.color.light, "c", light);
const dark: Record<string, string> = {};
flatten(tokens.color.dark, "c", dark);

function resolve(value: string, scope: Record<string, string>): string {
  // {color.*.accent} style references → var(--c-accent)
  return value.replace(/\{color\.\*\.(.+?)\}/g, (_m, name: string) =>
    `var(--c-${name.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase())})`
  );
}

function cssBlock(scope: Record<string, string>, refScope: Record<string, string>): string {
  const lines = Object.entries(scope).map(([k, v]) => `  --${k}: ${resolve(v, refScope)};`);
  return lines.join("\n");
}

const staticTokens: Record<string, string> = {};
for (const group of ["font", "type", "space", "radius", "border", "shadow", "focus", "layout", "avatar", "motion", "component"]) {
  flatten((tokens as Any)[group], group, staticTokens);
}
// component tokens reference color.* vars; resolve against light scope for
// the default sheet — themed components resolve their colour vars at runtime.
const staticCss = Object.entries(staticTokens)
  .map(([k, v]) => `  --${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}: ${resolve(v, light)};`)
  .join("\n");

export const themeCss = `
:root {
${cssBlock(light, light)}
${staticCss}
}
:root[data-theme="dark"] {
${cssBlock(dark, dark)}
}
`;

export const fonts = {
  display: (tokens.font.family.display as unknown as string[])[0],
  body: (tokens.font.family.body as unknown as string[])[0],
  mono: (tokens.font.family.mono as unknown as string[])[0],
};
