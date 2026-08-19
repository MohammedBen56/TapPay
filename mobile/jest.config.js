// Ship List Phase 5. The mobile package's first real test runner --
// CLAUDE.md §10 previously noted "no test runner, lint is tsc --noEmit
// only." jest-expo's preset alone (no manual transformIgnorePatterns
// override) handles the RN/Expo module transform and native-module mocks --
// found by direct reproduction that a hand-written transformIgnorePatterns
// here shadows the preset's own, which is tuned for exactly this RN/Expo
// version's package layout (e.g. RN 0.86's @react-native/js-polyfills)
// in a way a copied-from-memory pattern isn't.
module.exports = {
  preset: "jest-expo",
};
