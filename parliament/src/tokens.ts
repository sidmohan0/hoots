// Parliament design tokens → CSS custom properties.
// Source of truth: ../docs/design-tokens.json (W3C draft format).
// Emits kebab-case custom properties for both themes. Composite type tokens
// (type.h3 = {fontSize, fontWeight, …}) emit one custom property per facet;
// cubic-bezier arrays become usable timing functions.

import tokens from "../../docs/design-tokens.json";

type Any = Record<string, any>;

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function emit(value: any): string | null {
  if (Array.isArray(value)) {
    // cubic-bezier / font stacks
    if (value.length === 4 && value.every((v) => typeof v === "number")) {
      return `cubic-bezier(${value.join(", ")})`;
    }
    return value.join(", ");
  }
  if (typeof value === "boolean") return String(value);
  if (value == null) return null;
  return String(value);
}

function flatten(obj: Any, prefix: string, out: Record<string, string>) {
  for (const [k, v] of Object.entries(obj)) {
    if (k.startsWith("$")) continue;
    const path = prefix ? `${prefix}-${kebab(k)}` : kebab(k);
    if (v && typeof v === "object" && "$value" in v) {
      const raw = v.$value;
      if (raw && typeof raw === "object" && !Array.isArray(raw)) {
        // composite token: one property per facet (fontSize, fontWeight, …)
        for (const [facet, fv] of Object.entries(raw)) {
          const s = emit(fv);
          if (s != null) out[`${path}-${kebab(facet)}`] = s;
        }
      } else {
        const s = emit(raw);
        if (s != null) out[path] = s;
      }
    } else if (v && typeof v === "object") {
      flatten(v, path, out);
    }
  }
}

const light: Record<string, string> = {};
flatten(tokens.color.light, "c", light);
const dark: Record<string, string> = {};
flatten(tokens.color.dark, "c", dark);

function resolve(value: string): string {
  return value.replace(/\{color\.\*\.(.+?)\}/g, (_m, name: string) => `var(--c-${kebab(name)})`);
}

function block(scope: Record<string, string>): string {
  return Object.entries(scope)
    .map(([k, v]) => `  --${k}: ${resolve(v)};`)
    .join("\n");
}

const staticTokens: Record<string, string> = {};
for (const group of ["font", "type", "space", "radius", "border", "shadow", "focus", "layout", "avatar", "motion", "component"]) {
  flatten((tokens as Any)[group], group, staticTokens);
}
const staticCss = Object.entries(staticTokens)
  .map(([k, v]) => `  --${k}: ${resolve(v)};`)
  .join("\n");

export const themeCss = `
:root {
${block(light)}
${staticCss}
}
:root[data-theme="dark"] {
${block(dark)}
}
`;
