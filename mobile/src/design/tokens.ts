/**
 * Argent -- cool platinum/ink glass visual direction (approved via a Claude
 * Design canvas prototype, "Argent Android.dc.html"; see CLAUDE.md section 4
 * for the full writeup and section 8 for the two decisions it reverses).
 * Replaces the earlier "obsidian & metal" champagne-gold direction. The
 * single source of truth for color/type/spacing -- mirrored into
 * tailwind.config.js so both NativeWind classes and raw StyleSheet/Reanimated
 * values read the same numbers. Dark-only by deliberate choice, unchanged
 * from the obsidian era: this is one committed visual world (a near-black
 * ground with a drifting glass surface), not a themeable UI.
 *
 * Two prior recorded decisions are reversed here, deliberately, with new
 * owner input via the Argent canvas -- not silently violated:
 *  - The primary button was glass-with-a-gold-border because a flat GOLD
 *    gradient fill read as "too AI-generated." Argent's primary is a flat
 *    PLATINUM gradient fill -- a neutral metal, not a saturated brand hue,
 *    which is the distinction that makes this not the same mistake. See
 *    GlassButton.tsx and CLAUDE.md section 8.
 *  - The background was made deliberately non-animated after device testing
 *    found a drifting gold sheen over the balance card gimmicky. Argent's
 *    four background blobs are a different mechanism (large, low-opacity,
 *    behind glass, cheap UI-thread transforms) with an explicit A51
 *    performance gate. See ScreenBackground.tsx and CLAUDE.md section 8.
 */

// palette.js is plain CommonJS so tailwind.config.js (run under plain Node,
// no TS/babel transform) can require() it directly -- this import makes it
// the single source of truth for the app-side TypeScript code too.
import { colors as paletteColors, radius as paletteRadius } from "./palette.js";

/** This is a CAST, not an inferred type -- deleting or renaming a key in
 * palette.js does NOT produce a tsc error here; colors.thatKey just ships as
 * `undefined` at runtime. Whenever palette.js's key list changes, this list
 * must change in the same edit. See CLAUDE.md section 8. */
export const colors = paletteColors as {
  ground: string;
  surface: string;
  elevated: string;
  sunken: string;
  glassLow: string;
  glass: string;
  glassHigh: string;
  glassActive: string;
  glassBorder: string;
  glassBorderStrong: string;
  glassHighlight: string;
  glassDrop: string;
  hairline: string;
  bone: string;
  textPrimary: string;
  textSecondary: string;
  textTertiary: string;
  textQuiet: string;
  platinumLight: string;
  platinumMid: string;
  platinumDeep: string;
  ink: string;
  creditText: string;
  creditTint: string;
  debitTint: string;
  danger: string;
  dangerTint: string;
  blobBlue: string;
  blobViolet: string;
  blobTeal: string;
  blobSand: string;
  scrim: string;
};

/** Type scale: which face/weight/size owns which role, applied uniformly
 * across every screen (owner feedback from the original mockup round:
 * Fraunces was spot-applied to hero elements only and read as inconsistent
 * -- this table is the fix, not a per-screen judgment call; still true under
 * Argent). Newsreader (light display serif) owns hero figures and screen
 * identity; Schibsted Grotesk (grotesk, tabular figures) owns everything
 * else -- INCLUDING amount, which deliberately moved off the display serif:
 * right-aligned scrolling amount columns need tabular digit alignment a
 * 200-weight serif can't give. */
export const type = {
  hero: { family: "Newsreader_200ExtraLight", size: 44, lineHeight: 50, letterSpacing: -0.5 },
  screenTitle: { family: "Newsreader_300Light", size: 24, lineHeight: 30 },
  sectionLabel: { family: "SchibstedGrotesk_600SemiBold", size: 11, lineHeight: 15, letterSpacing: 1.4 },
  body: { family: "SchibstedGrotesk_400Regular", size: 16, lineHeight: 22 },
  bodyStrong: { family: "SchibstedGrotesk_600SemiBold", size: 16, lineHeight: 22 },
  caption: { family: "SchibstedGrotesk_400Regular", size: 13, lineHeight: 18 },
  amount: { family: "SchibstedGrotesk_500Medium", size: 15, lineHeight: 20, fontVariant: ["tabular-nums"] as const },
} as const;

export const radius = paletteRadius as { sm: number; md: number; lg: number; xl: number; pill: number };

export const spacing = {
  xs: 4,
  sm: 8,
  md: 16,
  lg: 24,
  xl: 32,
  xxl: 48,
} as const;
