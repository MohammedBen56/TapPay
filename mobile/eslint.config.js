// Ship List Phase 5. Flat config (ESLint 10) -- the mobile package's first
// real lint beyond `tsc --noEmit` (CLAUDE.md §10). Type-aware rules are
// deliberately left to tsc (already run separately, `pnpm --filter
// @tappay/mobile lint`) rather than duplicated here via typescript-eslint's
// type-checked configs -- that would mean parsing every file twice for the
// same class of error. This config's job is code-quality and accessibility,
// not type correctness.
const js = require("@eslint/js");
const tseslint = require("typescript-eslint");
const react = require("eslint-plugin-react");
const reactHooks = require("eslint-plugin-react-hooks");
const reactNativeA11y = require("eslint-plugin-react-native-a11y");
const globals = require("globals");

module.exports = tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".expo/**",
      "android/**",
      "dist/**",
      // Plain-CommonJS config files, same set tsconfig.json already excludes
      // from tsc (CLAUDE.md §8's "mirroring Expo's own exclusion" note) --
      // parsed as scripts, not app source, so the TS/React rules below don't
      // apply cleanly to them.
      "babel.config.js",
      "metro.config.js",
      "tailwind.config.js",
      "jest.config.js",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // The handful of plain-CommonJS files that AREN'T excluded outright
    // above (this config itself, the Expo config plugins under plugins/,
    // src/design/palette.js) -- real files worth linting, just not as
    // ESM/browser code. Node's require/module/__dirname globals, not
    // TS/React rules.
    files: ["**/*.js"],
    languageOptions: { globals: globals.node, sourceType: "commonjs" },
    rules: {
      // require() is the only option in a CommonJS file -- the TS
      // recommended config's ESM-oriented no-require-imports rule doesn't
      // apply here.
      "@typescript-eslint/no-require-imports": "off",
    },
  },
  {
    files: ["**/*.{ts,tsx}"],
    plugins: {
      react,
      "react-hooks": reactHooks,
      "react-native-a11y": reactNativeA11y,
    },
    languageOptions: {
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { __DEV__: "readonly" },
    },
    settings: { react: { version: "19.2" } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...reactHooks.configs.recommended.rules,
      // react-native-a11y's own "android" shareable config (this app's only
      // target platform, CLAUDE.md §1) -- its rule keys are already
      // "react-native-a11y/<rule>", so this drops straight into flat
      // config's rules object with no translation needed.
      ...reactNativeA11y.configs.android.rules,
      // New JSX transform (React 19, this app's version) needs neither of
      // these -- react/jsx-uses-react and react/react-in-jsx-scope both
      // assume the classic transform where `React` must be in scope.
      "react/react-in-jsx-scope": "off",
      "react/jsx-uses-react": "off",
      "react/prop-types": "off", // TypeScript already owns prop typing
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // src/parked/: the original P2P proximity surface (CLAUDE.md §4) --
    // real, tested, but dormant and unrouted. Writing a genuinely
    // meaningful accessibilityHint for every control across six dormant
    // demo/debug screens is effort with no current user behind it; the
    // rule stays ON everywhere it matters (the live app, now fully clean)
    // and off only here. Revisit if/when this surface is un-parked.
    files: ["src/parked/**/*.{ts,tsx}"],
    rules: {
      "react-native-a11y/has-accessibility-hint": "off",
    },
  },
);
