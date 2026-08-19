// @ts-check
// Plain CommonJS so tailwind.config.js (run under plain Node, no TS/babel
// transform) can require() it directly. src/design/tokens.ts re-exports this
// as the single source of truth for the app-side TypeScript code.
//
// Argent -- see tokens.ts's header docblock and CLAUDE.md section 4/8 for
// the full story. Two prior "obsidian & metal" decisions are reversed here
// (the primary button's fill, and the background's motion) -- both
// reversals are recorded in CLAUDE.md, not just applied silently.
const colors = {
  // Ink -- near-black ground and its opaque steps.
  ground: "#0B0D10",
  surface: "#131519", // opaque fallback / ViewShot-safe cards (see Card.tsx's `solid` prop)
  elevated: "#191C21", // fields, avatar wells, inset boxes
  sunken: "#0D0F12", // darkest chrome: camera/scan wraps

  // Glass -- translucent white tiers stacked on ink, the backing for every
  // BlurView-based panel (Card, GlassButton, TextField, SegmentedControl).
  glassLow: "rgba(255,255,255,0.05)",
  glass: "rgba(255,255,255,0.07)",
  glassHigh: "rgba(255,255,255,0.09)",
  glassActive: "rgba(255,255,255,0.13)",
  glassBorder: "rgba(255,255,255,0.11)",
  glassBorderStrong: "rgba(255,255,255,0.16)",
  glassHighlight: "rgba(255,255,255,0.32)", // the 1px inset-top-edge highlight
  glassDrop: "rgba(0,0,0,0.26)", // the outer drop shadow
  hairline: "rgba(255,255,255,0.08)", // list separators / dividers

  // Text -- one base rgb(238,241,244), five opacity stops instead of
  // distinct named hexes. `bone` is kept as a name deliberately: ~60 call
  // sites already read colors.bone for "brightest text."
  bone: "#EEF1F4",
  textPrimary: "rgba(238,241,244,0.92)",
  textSecondary: "rgba(238,241,244,0.62)",
  textTertiary: "rgba(238,241,244,0.45)",
  textQuiet: "rgba(238,241,244,0.36)", // section labels, meta, inactive tabs

  // Platinum -- the only accent. A neutral metal, not a hue. Reserved for
  // GlassButton's variant="primary" fill -- at most one per screen.
  platinumLight: "#F1F5F9",
  platinumMid: "#C6CFD9", // the 52% gradient stop
  platinumDeep: "#9AA5B2",
  ink: "#1B1E23", // text/icons ON platinum

  // Direction (credit/debit) -- de-hued from the old green/bone pair. See
  // CLAUDE.md section 8 for why: sign glyph + a brightness delta + a chip
  // tint borrowed from the teal blob, never a green/red semantic pair.
  creditText: "#DFE6EE",
  creditTint: "rgba(120,196,196,0.16)",
  debitTint: "rgba(255,255,255,0.06)",

  // Failure signalling -- functional, not decorative, exempt from the
  // "no accent hue" rule.
  danger: "#C15C4F",
  dangerTint: "rgba(193,92,79,0.14)",

  // Background blobs (ScreenBackground.tsx) -- never used as UI element
  // colors, only as the animated radial-gradient field behind glass.
  blobBlue: "rgba(126,163,214,0.42)",
  blobViolet: "rgba(178,150,205,0.30)",
  blobTeal: "rgba(120,196,196,0.24)",
  blobSand: "rgba(226,206,178,0.22)",

  scrim: "rgba(6,8,10,0.66)",
};

const radius = {
  sm: 10,
  md: 16,
  lg: 24,
  xl: 28, // Argent's rounder panels -- Home balance card, receipt card
  pill: 999,
};

module.exports = { colors, radius };
