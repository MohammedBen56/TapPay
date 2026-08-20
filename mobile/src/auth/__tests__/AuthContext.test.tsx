/**
 * Ship List Phase 5's first real component test -- specifically written to
 * verify the inactivity-lock state machine (AuthContext.tsx) without a
 * physical device, since that's exactly the kind of pure-JS logic that
 * doesn't need one (CLAUDE.md §4's device-verification gate is for the
 * native-boundary pieces, not this).
 *
 * AppState.addEventListener is spied on (not the whole "react-native"
 * module replaced) so this file owns a fully controlled listener registry
 * to fire a specific "background" then "active" sequence. Elapsed time
 * between them is controlled via AuthContext.tsx's own injectable clock
 * (setClockForTesting) rather than jest fake timers or a global Date.now
 * mock -- both were tried and abandoned: fake timers fight testing-
 * library's own real-timer-based `waitFor` polling, and mocking Date.now
 * globally desyncs against React's internal scheduler, which also reads it.
 * emitAppState awaits an async act() (not sync) -- found by direct
 * reproduction that a sync act() here left the resulting setStatus("locked")
 * update unflushed by the time the test's next assertion ran, even though
 * the state update itself demonstrably happened (confirmed via a temporary
 * debug log inside AuthContext.tsx during development of this test).
 *
 * Assertions query by visible text (getByText), not a testID + an extended
 * matcher library -- @testing-library/react-native@14 doesn't bundle
 * jest-native's DOM-style matchers (toHaveTextContent) by default, and
 * querying by what's actually on screen is the more accessibility-honest
 * check anyway (CLAUDE.md's Ship List Phase 5 accessibility rationale:
 * "query only through the accessibility tree").
 */
import { act, render, screen, waitFor } from "@testing-library/react-native";
import { afterEach, beforeEach, describe, expect, it, jest } from "@jest/globals";
import type { LoginResponse, MeResponse } from "@tappay/shared";
import { AppState, Text } from "react-native";
import { AuthProvider, setClockForTesting, useAuth } from "../AuthContext";
import { INACTIVITY_LOCK_THRESHOLD_MS } from "../../config/inactivityLock";

// Spies on the REAL AppState.addEventListener rather than replacing the
// whole "react-native" module -- found by direct reproduction that
// jest.requireActual("react-native") inside a jest.mock factory re-triggers
// Expo's own module-install side effects (its fetch polyfill setup) in a
// context where they crash. Spying leaves every other react-native export
// (Text, etc.) untouched and real.
type AppStateListener = (state: "active" | "background" | "inactive") => void;
const mockListeners = new Set<AppStateListener>();

async function emitAppState(state: "active" | "background" | "inactive"): Promise<void> {
  await act(async () => {
    for (const listener of mockListeners) listener(state);
    await Promise.resolve();
  });
}

jest.mock("../secureStore", () => ({
  getSavedCustomerId: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  getSavedDisplayName: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  isBiometricEnabled: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  saveCustomerId: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  saveDisplayName: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  saveRefreshTokenForBiometric: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
  getRefreshTokenViaBiometric: jest.fn<() => Promise<string | null>>().mockResolvedValue(null),
  clearBiometricRefreshToken: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
}));

jest.mock("expo-local-authentication", () => ({
  hasHardwareAsync: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
  isEnrolledAsync: jest.fn<() => Promise<boolean>>().mockResolvedValue(false),
}));

jest.mock("../../api/endpoints", () => ({
  api: {
    login: jest.fn(),
    me: jest.fn(),
    logout: jest.fn(),
  },
}));

// Babel-jest hoists jest.mock(...) calls above imports regardless of source
// order, so this import receives the mocked module even though it's written
// after the jest.mock call above. Cast to jest.Mocked so .mockResolvedValue
// etc. typecheck against the real module's shape.
import { api as realApi } from "../../api/endpoints";
const api = realApi as jest.Mocked<typeof realApi>;

const FAKE_ME: MeResponse = {
  customer_id: "10000001",
  display_name: "Test User",
  account_id: "acct-1",
  account_type: "checking",
  rib: "999780000000000000100113",
  iban: "MA37999780000000000000100113",
  currency: "MAD",
};

const FAKE_LOGIN: LoginResponse = {
  access_token: "at",
  refresh_token: "rt",
  expires_in: 900,
  user: { customer_id: FAKE_ME.customer_id, account_id: FAKE_ME.account_id },
};

function Probe(): React.JSX.Element {
  const { status } = useAuth();
  return <Text>{status}</Text>;
}

/** Renders a Probe, signs in via loginWithPassword, and returns once the
 * status has settled to "signedIn" -- the common setup every test below
 * needs before it can exercise background/foreground transitions. */
async function renderAndSignIn(): Promise<void> {
  api.login.mockResolvedValue(FAKE_LOGIN);
  api.me.mockResolvedValue(FAKE_ME);

  let auth!: ReturnType<typeof useAuth>;
  function Capture(): React.JSX.Element {
    // Standard RTL pattern for reaching a hook's return value from outside
    // the render tree in a test -- the compiler's purity rule doesn't know
    // this file is test-only, where capturing a ref to call
    // loginWithPassword() directly (see below) is the point, not a bug.
    // eslint-disable-next-line react-hooks/globals
    auth = useAuth();
    return <Probe />;
  }

  await act(async () => {
    render(
      <AuthProvider>
        <Capture />
      </AuthProvider>,
    );
  });
  await waitFor(() => expect(screen.getByText("signedOut")).toBeTruthy());

  await act(async () => {
    await auth.loginWithPassword("10000001", "Demo#2026");
  });
  expect(screen.getByText("signedIn")).toBeTruthy();
}

describe("AuthContext inactivity lock", () => {
  beforeEach(() => {
    mockListeners.clear();
    jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener: AppStateListener) => {
      mockListeners.add(listener);
      return { remove: () => mockListeners.delete(listener) };
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
    setClockForTesting(() => Date.now());
  });

  // AuthContext.tsx's own injectable clock (setClockForTesting), not a
  // global Date.now mock -- real timers/Date stay untouched throughout,
  // which keeps testing-library's own waitFor polling (used by
  // renderAndSignIn's setup) and React's internal scheduler (which reads
  // Date.now for its own purposes) working normally instead of fighting
  // this test over who owns the clock.
  function mockElapsedMs(ms: number): void {
    const base = Date.now();
    let call = 0;
    setClockForTesting(() => (call++ === 0 ? base : base + ms));
  }

  it("locks a signed-in session that returns to the foreground after the threshold", async () => {
    await renderAndSignIn();

    mockElapsedMs(INACTIVITY_LOCK_THRESHOLD_MS + 1_000);
    await emitAppState("background");
    await emitAppState("active");

    expect(screen.getByText("locked")).toBeTruthy();
  });

  it("does NOT lock a signed-in session that returns before the threshold", async () => {
    await renderAndSignIn();

    mockElapsedMs(1_000); // well under the threshold
    await emitAppState("background");
    await emitAppState("active");

    expect(screen.getByText("signedIn")).toBeTruthy();
  });

  it("never locks a session that was never signed in (background/foreground while signed out)", async () => {
    await act(async () => {
      render(
        <AuthProvider>
          <Probe />
        </AuthProvider>,
      );
    });
    await waitFor(() => expect(screen.getByText("signedOut")).toBeTruthy());

    mockElapsedMs(INACTIVITY_LOCK_THRESHOLD_MS + 1_000);
    await emitAppState("background");
    await emitAppState("active");

    expect(screen.getByText("signedOut")).toBeTruthy();
  });
});
