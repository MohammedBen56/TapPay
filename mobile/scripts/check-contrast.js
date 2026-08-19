#!/usr/bin/env node
// @ts-check
// Ship List Phase 5: WCAG 2.2 AA contrast audit over src/design/palette.js's
// token pairs -- palette.js is already the single source of truth for
// every color pair in the app (CLAUDE.md §8), so this is the one place a
// check like this needs to live. Plain CommonJS, run directly with `node`
// (no ts-node/tsx) -- same reason palette.js itself is CommonJS: nothing
// here needs a TS/babel transform.
//
// Curated real pairs, not every possible combination -- most color-pair
// combinations in palette.js are never actually composited together (e.g.
// a background blob against a danger tint means nothing). Each pair's
// required ratio follows WCAG 2.2 AA: 4.5:1 for regular text, 3:1 only for
// text that is unambiguously "large" (>=24px, or >=18.66px AND bold/600+)
// -- GlassButton's 16px SemiBold label does NOT qualify, so it's held to
// 4.5:1 like everything else here.
const { colors } = require("../src/design/palette.js");

/** @param {string} hexOrRgba */
function parseColor(hexOrRgba) {
  if (hexOrRgba.startsWith("#")) {
    const hex = hexOrRgba.slice(1);
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return { r, g, b, a: 1 };
  }
  const match = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(hexOrRgba);
  if (!match) throw new Error(`unrecognized color format: ${hexOrRgba}`);
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
}

/** Alpha-composites `fg` over an opaque `bg`, both from parseColor(). */
function compositeOver(fg, bg) {
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function relativeLuminance({ r, g, b }) {
  const channel = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrastRatio(colorA, colorB) {
  const lA = relativeLuminance(colorA);
  const lB = relativeLuminance(colorB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// [foreground token, background token, required ratio, what actually uses this pair]
const PAIRS = [
  ["bone", "ground", 4.5, "the brightest text tier -- wordmarks, hero numbers"],
  ["textPrimary", "ground", 4.5, "default body text"],
  ["textSecondary", "ground", 4.5, "secondary body text, taglines"],
  ["textTertiary", "ground", 4.5, "de-emphasized text"],
  ["textQuiet", "ground", 4.5, "section labels, meta, inactive tabs"],
  ["danger", "ground", 4.5, "error banners/text"],
  ["creditText", "ground", 4.5, "credit-direction amount text"],
  // GlassButton's variant="primary" label -- 16px SemiBold, does not
  // qualify as WCAG "large text" (needs >=18.66px bold), held to 4.5:1.
  ["ink", "platinumLight", 4.5, "GlassButton primary label vs. the gradient's lightest stop"],
  ["ink", "platinumMid", 4.5, "GlassButton primary label vs. the gradient's middle stop"],
  ["ink", "platinumDeep", 4.5, "GlassButton primary label vs. the gradient's deepest stop"],
];

let anyFailed = false;
console.log("WCAG 2.2 AA contrast audit -- src/design/palette.js\n");
for (const [fgName, bgName, required, usage] of PAIRS) {
  const fg = parseColor(colors[fgName]);
  const bg = parseColor(colors[bgName]);
  const effectiveFg = compositeOver(fg, bg); // bg itself is always opaque in this palette
  const ratio = contrastRatio(effectiveFg, bg);
  const ok = ratio >= required;
  if (!ok) anyFailed = true;
  const status = ok ? "PASS" : "FAIL";
  console.log(`[${status}] ${fgName} on ${bgName}: ${ratio.toFixed(2)}:1 (needs ${required}:1) -- ${usage}`);
}

if (anyFailed) {
  console.error("\nOne or more color pairs fail WCAG 2.2 AA. Fix the token in palette.js, not the threshold here.");
  process.exit(1);
}
console.log("\nAll checked pairs meet WCAG 2.2 AA.");
