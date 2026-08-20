# Shared components

Ship List v2 Wave 2 Phase 2. No Storybook exists in this project — these
are the 8 shared components under `mobile/src/components/`, documented
directly against their real source rather than a separate playground, so
this doc can't drift out of sync with the code the way a Storybook config
maintained separately sometimes does. Every design decision named below is
recorded in more depth in `CLAUDE.md` §8 — this doc is the quick-reference
API surface, not a replacement for that reasoning.

All colors/type/radii referenced below come from `mobile/src/design/
tokens.ts` (re-exporting `palette.js`) — never hardcode a hex value or
font size in a new screen; pull from `colors`/`type`/`radius` the same way
every component here does.

## `GlassButton`

The one button component in the app — no raw `Pressable`-styled-as-a-
button exists anywhere else.

```tsx
<GlassButton label="Send money" onPress={...} />
<GlassButton label="Cancel" variant="ghost" onPress={...} />
<GlassButton label="Delete" variant="danger" onPress={...} />
<GlassButton label="Confirm" onPress={...} loading={submitting} disabled={!valid} style={{ marginTop: 12 }} />
```

- `variant="primary"` (default): a flat platinum gradient fill, `ink`
  (`#1B1E23`) text. **At most one platinum button per screen** — this is
  a hard rule, not a suggestion (CLAUDE.md §8): platinum is the single
  brightest object on a monochrome field, and more than one per screen
  degrades the whole direction into noise. Every secondary action uses
  `ghost` instead.
- `variant="ghost"`: `expo-blur` glass fill, flat 1px hairline border,
  `bone` text. The default choice for every non-primary action.
- `variant="danger"`: same glass treatment, `dangerTint`/danger-red
  border and text. Destructive actions only (sign out, revoke a session,
  delete a beneficiary).
- `loading`: swaps the label for an `ActivityIndicator` in the variant's
  text color; also disables the press.
- Haptic feedback (`Haptics.impactAsync(Medium)`) and a spring
  press-scale animation are built in — never add your own haptic call
  around a `GlassButton` press, it already fires one.

## `Card`

The Argent glass panel — the base surface almost every screen's content
sits on.

```tsx
<Card style={{ gap: 16 }}>...</Card>
<Card solid style={styles.receiptCard}>...</Card>
```

- Default: a `BlurView`-backed translucent panel with a 1px hairline
  border and a soft top highlight line.
- `solid`: skips the blur, flat `colors.surface` fill instead. **Required**
  for any `Card` captured inside a `ViewShot` (share-as-image flows) — a
  `BlurView` inside a `ViewShot` capture is a real risk of rendering
  black/transparent on Android's hardware-accelerated surface. Every
  existing receipt/QR-share screen already follows this; a new
  share-as-image feature must too.
- Pass layout props (`gap`, `padding`, `alignItems`, etc.) through `style`
  directly onto the card's content — the blur renders as an absolutely-
  positioned sibling behind `children`, never a wrapping content `View`,
  so this never silently breaks your layout.

## `SegmentedControl`

```tsx
<SegmentedControl
  options={[{ value: "checking", label: "Checking" }, { value: "savings", label: "Savings" }]}
  value={selected}
  onChange={setSelected}
/>
```

Generic over the option value type (`<T extends string>`). The active
segment is deliberately glass, not platinum — same "at most one platinum
button per screen" rule as `GlassButton`; a segmented control's active
state is a selection indicator, not a call-to-action.

## `TextField`

```tsx
<TextField label="Amount" value={amountInput} onChangeText={setAmountInput} keyboardType="decimal-pad" error={amountError} />
```

Wraps a raw `TextInput`, forwarding every native `TextInputProps` prop
through (`forwardRef`, so a parent can still call `.focus()` on it
directly). `label` renders as an uppercase section-label caption above
the input; `error`, when set, renders in `colors.danger` below it and
tints the input border red. This is the only text-input component in the
app — a new form field should use this, not a raw `TextInput`.

## `ConfirmDialog`

```tsx
<ConfirmDialog
  visible={confirming}
  title="Sign out?"
  message="You'll need your password or biometrics to sign back in."
  confirmLabel="Sign out"
  confirmVariant="danger" /* default */
  onCancel={() => setConfirming(false)}
  onConfirm={handleConfirm}
/>
```

Replaces the OS-native `Alert.alert`, whose default styling reads as
inconsistent with the rest of the app (a real device-testing finding, not
a preference). Always renders a `Card` with a `Cancel` (ghost) button and
a confirm button (`confirmVariant`, defaults to `danger` — override to
`primary`/`ghost` for a non-destructive confirmation).

## `TransactionRow`

```tsx
<TransactionRow tx={transactionSummaryFromApi} />
```

One row in any transaction list (Home, Statements). Self-contained:
handles its own credit/debit color and sign, biller-category icon
substitution (`is_biller`/`biller_category` from the API response, via
`design/billerCategory.ts`), navigation to the receipt screen on press,
and date/amount formatting via `design/format.ts`'s `formatShortDate`/
`formatMAD` (never hand-roll a date or amount format inline — see the
"consolidate formatting" note in `docs/SHIP_LIST_V2.md`'s Wave 2 work).
Not meant to be restyled per-screen — if a screen needs a materially
different transaction-row layout, that's a new component, not a prop
added here.

## `ReviewRow`

```tsx
<ReviewRow label="Amount" value={`${formatMAD(amount)} MAD`} emphasize />
```

A label/value row inside a review-and-confirm `Card` — used by both
Send's review step and the bill-pay confirm step (and, going forward,
any new confirm-before-money-moves step should reuse this rather than
re-laying-out the same row shape). `emphasize` switches the value to
`type.amount`'s tabular-nums grotesk font instead of the default
`bodyStrong` — CLAUDE.md §8's type-hierarchy rule: a right-aligned money
value needs digit alignment a display serif can't give.

## `ScreenBackground`

```tsx
<ScreenBackground>{children}</ScreenBackground>
<ScreenBackground style={styles.center}>{children}</ScreenBackground>
```

The Argent ground every screen sits on — a flat near-black fill with four
large, low-opacity, slowly-drifting radial-gradient blobs behind a glass
layer. Every top-level screen wraps its content in this; it also applies
safe-area insets as padding, so screens don't need their own
`useSafeAreaInsets()` call for basic top/bottom spacing.

- Respects the OS reduce-motion accessibility setting live (not just
  checked once on mount) — Ship List v1's a11y Must-Build work. The
  `ANIMATE_BLOBS` module constant is a manual dev kill-switch layered on
  top of that, not instead of it; flip it off first if the animation
  isn't holding 60fps on a target device, then reduce `BLOBS`' length if
  that alone isn't enough. **Never ship a janky background** — this
  animation was unverified on the reference low-end device (Galaxy A51)
  as of the last device-testing pass; treat any claim about its
  performance as unverified until a real device confirms it.
- `BLOB_FIELD_OPACITY` is the contrast knob if body text over a blob
  center reads weak on a given screen.

## Conventions that apply across all of the above

- **Colors, type, radii**: always from `design/tokens.ts`, never a raw
  hex/number. If a color is missing, add it to `design/palette.js` (not
  directly to `tokens.ts` — see CLAUDE.md §8 for why the two files must
  stay in sync and what breaks if you only edit one).
- **One platinum button per screen** (`GlassButton`, `SegmentedControl`'s
  active segment stays glass, never platinum).
- **Solid, not blurred, inside any `ViewShot` capture** (`Card`'s `solid`
  prop) — every share-as-image flow already follows this.
- **No hand-rolled date/number formatting** — use `design/format.ts`'s
  `formatMAD`, `formatRibGrouped`, `formatDateTime`, `formatShortDate`,
  or `formatLongDate`. A new formatting need should add a new named
  function there, not an inline `toLocaleDateString`/`toLocaleString`
  call in a screen.
