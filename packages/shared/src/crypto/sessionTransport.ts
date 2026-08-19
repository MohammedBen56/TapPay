/**
 * The one piece `session.ts` deliberately leaves to "the transport layer"
 * (see its `sealSessionMessage`/`openSessionMessage` doc comments): a
 * per-session outgoing counter, and a replay/reorder window for incoming
 * counters. `sealSessionMessage`/`openSessionMessage` alone only prove a
 * given counter value is authentic for this session -- they say nothing
 * about whether that exact counter has already been delivered once before.
 * Without this, a captured-and-replayed sealed message (e.g. an attacker
 * with radio proximity re-transmitting a genuine past GATT write) would
 * decrypt and verify successfully every time.
 *
 * Transport-agnostic on purpose, same as session.ts itself: M3's BLE GATT
 * layer is the first real caller, but nothing here assumes a radio.
 */

/** Sliding-window size for replay detection, in counter positions behind the
 * highest counter seen so far -- a config-driven default, not a hardcoded
 * constant callers can't override (CLAUDE.md §5/§8's "config over constants"
 * rule, same pattern as session.ts's own DEFAULT_SESSION_HELLO_WINDOW_MS).
 * 64 is generous for a single BLE connection's worth of reordering (a few
 * in-flight writes at most) without letting the bitmask grow unbounded. */
export const DEFAULT_REPLAY_WINDOW_SIZE = 64;

export interface SessionCounterState {
  /** The next counter value this side will use for sealSessionMessage. */
  nextSend: bigint;
  /** Highest counter accepted from the peer so far. -1n means none yet. */
  highestReceived: bigint;
  /** Bit i set means (highestReceived - i) has already been accepted --
   * an IPsec/DTLS-style anti-replay sliding bitmask, sized to
   * DEFAULT_REPLAY_WINDOW_SIZE (or whatever windowSize acceptReceivedCounter
   * is called with) bits. Bit 0 always corresponds to highestReceived
   * itself. */
  receivedWindowBitmask: bigint;
}

export function createSessionCounterState(): SessionCounterState {
  return { nextSend: 0n, highestReceived: -1n, receivedWindowBitmask: 0n };
}

/** Returns the counter to use for the next `sealSessionMessage` call on this
 * session, and advances the state so the same value is never handed out
 * twice. Mutates `state` in place -- callers own one `SessionCounterState`
 * per session and thread it through every seal/open call. */
export function nextSendCounter(state: SessionCounterState): bigint {
  const counter = state.nextSend;
  state.nextSend += 1n;
  return counter;
}

/**
 * True (and advances `state`) if `counter` is a genuinely new message from
 * the peer -- in order, or reordered-but-within-window and not previously
 * seen. False (state unchanged) for anything already accepted before, or
 * so far behind the current window it can no longer be distinguished from a
 * replay. Callers must call this BEFORE trusting a message opened via
 * `openSessionMessage` -- a successful GCM open alone does not mean "new,"
 * only "authentic for this session."
 */
export function acceptReceivedCounter(
  state: SessionCounterState,
  counter: bigint,
  windowSize: number = DEFAULT_REPLAY_WINDOW_SIZE,
): boolean {
  if (counter < 0n) return false;

  if (state.highestReceived < 0n) {
    state.highestReceived = counter;
    state.receivedWindowBitmask = 1n;
    return true;
  }

  const diff = counter - state.highestReceived;
  const windowSizeBig = BigInt(windowSize);

  if (diff > 0n) {
    // A new highest counter -- slide the window forward and mark this bit.
    state.receivedWindowBitmask = diff >= windowSizeBig ? 1n : ((state.receivedWindowBitmask << diff) | 1n) & ((1n << windowSizeBig) - 1n);
    state.highestReceived = counter;
    return true;
  }

  // counter <= highestReceived: only acceptable if within the window and not
  // already marked.
  const positionsBehind = -diff;
  if (positionsBehind >= windowSizeBig) return false;
  const bit = 1n << positionsBehind;
  if ((state.receivedWindowBitmask & bit) !== 0n) return false;
  state.receivedWindowBitmask |= bit;
  return true;
}
