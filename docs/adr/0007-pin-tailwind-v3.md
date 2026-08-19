# 0007 — Pin `tailwindcss` to v3, despite NativeWind's version number suggesting v4

## Context

`nativewind@4.2.6` reads as though it targets Tailwind CSS v4 (the version
numbers match), but `nativewind/dist/metro/tailwind/index.js` checks
`tailwindcss/package.json`'s actual version string at runtime and throws
`"NativeWind only supports Tailwind CSS v3"` for anything else. This is not
a configuration mismatch — it's unconditional in this installed NativeWind
version. Found live: the first native build this pivot ran compiled and
installed cleanly (Gradle has no opinion on the Tailwind version), but Metro
crashed on startup with exactly that error, because `tailwindcss@^4.3.3` was
installed initially, going by the version numbers alone rather than
checking NativeWind's actual runtime behavior.

## Decision

Pin `tailwindcss@^3.4.19` and use Tailwind v3's three-directive `global.css`
(`@tailwind base; @tailwind components; @tailwind utilities;`) instead of
v4's single `@import "tailwindcss";`. `tailwind.config.js` itself needed no
change — it was already written in v3-compatible CommonJS `module.exports`
form.

## Alternatives considered

- **Trust the version numbers and use Tailwind v4.** This is what actually
  happened first, and it broke — included here as the alternative that was
  tried and failed, not a hypothetical.
- **Wait for a NativeWind release that supports Tailwind v4 before adding
  either.** Rejected: NativeWind was already load-bearing for the design-
  token-driven styling approach chosen for this pivot; blocking the whole
  mobile foundation milestone on an upstream release with no committed
  timeline wasn't a reasonable trade against pinning a known-working version.

## Consequences

The team currently does not use NativeWind's `className` styling at all in
practice — every screen is `StyleSheet.create` reading `colors`/`type`
tokens directly (see CLAUDE.md §8's NativeWind/design-tokens note), so this
pin mostly matters for keeping Metro from crashing on startup rather than
for any `className` usage actively depending on v3-specific syntax.

## Revisit trigger

Do not "upgrade" `tailwindcss` back to v4 without first confirming, by
reading the actual installed NativeWind release's source (not its version
number), that the `"NativeWind only supports Tailwind CSS v3"` check has
been removed or relaxed.
