# 0004 — NativeWind/Tailwind v4 startup crash

**Class:** version-number-vs-actual-runtime-behavior mismatch at a build-tool boundary
**Found via:** the first native build of the Argent-era mobile foundation
**Status:** Fixed, and the reasoning is now a standing rule (ADR-0007)

## Impact

The mobile app's first native build after the design-token/NativeWind
foundation was added compiled and installed cleanly — Gradle has no opinion
on which Tailwind version is installed — but Metro crashed on startup with
`"NativeWind only supports Tailwind CSS v3"`, blocking all further mobile
work until diagnosed. Not a data-safety or security incident; included here
because it's a real example of a build-system-boundary failure that was
root-caused and converted into a permanent rule, the same shape every entry
in this log follows.

## Timeline

Surfaced immediately on the first `npx expo run:android` after adding
NativeWind and Tailwind as dependencies, with `tailwindcss@^4.3.3` installed
on the assumption that NativeWind 4.x meant Tailwind v4 compatibility.

## Root cause

`nativewind@4.2.6`'s version number does not track Tailwind CSS's version at
all — it's NativeWind's own semver. `nativewind/dist/metro/tailwind/
index.js` reads `tailwindcss/package.json`'s actual installed version at
Metro startup and unconditionally throws for anything other than v3. Nothing
about the two packages' version numbers being close together implied
compatibility; the assumption was never actually true, just untested until
the first real build.

## Fix

Pinned `tailwindcss@^3.4.19` and switched `global.css` to Tailwind v3's
three-directive form. See ADR-0007 for the full decision record, including
why "wait for a NativeWind release that supports v4" was rejected as the
alternative.

## Prevention

- ADR-0007 states the rule explicitly: never "upgrade" `tailwindcss` without
  first reading NativeWind's actual installed source, not its version
  number, to confirm the v3-only check has been relaxed.
- `expo-doctor` and `expo install --check` in mobile CI (Ship List, Phase 5)
  are planned specifically because they catch this exact class of
  SDK/dependency-version drift automatically — this incident is the reason
  those two checks are on the must-build list rather than a generic
  "add more linting" suggestion.
