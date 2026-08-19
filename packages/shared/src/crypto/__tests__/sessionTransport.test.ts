import { describe, expect, it } from "vitest";
import { acceptReceivedCounter, createSessionCounterState, nextSendCounter, type SessionCounterState } from "../sessionTransport.js";

describe("nextSendCounter", () => {
  it("starts at 0 and increments monotonically", () => {
    const state = createSessionCounterState();
    expect(nextSendCounter(state)).toBe(0n);
    expect(nextSendCounter(state)).toBe(1n);
    expect(nextSendCounter(state)).toBe(2n);
  });

  it("never hands out the same counter twice, even across many calls", () => {
    const state = createSessionCounterState();
    const seen = new Set<bigint>();
    for (let i = 0; i < 200; i++) {
      const counter = nextSendCounter(state);
      expect(seen.has(counter)).toBe(false);
      seen.add(counter);
    }
  });
});

describe("acceptReceivedCounter", () => {
  it("accepts a strictly increasing in-order sequence", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 0n)).toBe(true);
    expect(acceptReceivedCounter(state, 1n)).toBe(true);
    expect(acceptReceivedCounter(state, 2n)).toBe(true);
  });

  it("accepts a reordered-but-within-window sequence (0, 2, 1)", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 0n)).toBe(true);
    expect(acceptReceivedCounter(state, 2n)).toBe(true); // advances highest to 2
    expect(acceptReceivedCounter(state, 1n)).toBe(true); // late arrival, still in window
  });

  it("rejects an exact replay of an already-accepted counter", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 5n)).toBe(true);
    expect(acceptReceivedCounter(state, 5n)).toBe(false);
  });

  it("rejects a replay of an earlier, already-accepted, reordered counter", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 0n)).toBe(true);
    expect(acceptReceivedCounter(state, 2n)).toBe(true);
    expect(acceptReceivedCounter(state, 1n)).toBe(true);
    expect(acceptReceivedCounter(state, 1n)).toBe(false); // replay of the reordered one
    expect(acceptReceivedCounter(state, 0n)).toBe(false); // replay of the original
  });

  it("rejects a counter too far outside the window as if it were a replay", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 100n, 8)).toBe(true);
    // 100 - 0 = 100, far past an 8-wide window -- indistinguishable from a
    // stale replay, must fail closed rather than accept.
    expect(acceptReceivedCounter(state, 0n, 8)).toBe(false);
  });

  it("accepts a counter right at the edge of the window and rejects one just past it", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, 10n, 8)).toBe(true);
    expect(acceptReceivedCounter(state, 3n, 8)).toBe(true); // 10-3=7, within an 8-wide window
    expect(acceptReceivedCounter(state, 1n, 8)).toBe(false); // 10-1=9, outside
  });

  it("rejects a negative counter outright", () => {
    const state = createSessionCounterState();
    expect(acceptReceivedCounter(state, -1n)).toBe(false);
  });

  it("keeps two directions' state fully independent (separate SessionCounterState per direction)", () => {
    const inbound: SessionCounterState = createSessionCounterState();
    const outboundPeerView: SessionCounterState = createSessionCounterState();

    expect(acceptReceivedCounter(inbound, 0n)).toBe(true);
    expect(acceptReceivedCounter(inbound, 1n)).toBe(true);

    // A completely separate state object for the other direction starts
    // fresh and is unaffected by the first.
    expect(acceptReceivedCounter(outboundPeerView, 0n)).toBe(true);
    expect(inbound.highestReceived).toBe(1n);
    expect(outboundPeerView.highestReceived).toBe(0n);
  });

  it("handles a long realistic run of mild reordering without false rejections or false acceptances", () => {
    const state = createSessionCounterState();
    // Simulate counters 0..49 delivered with each pair occasionally swapped.
    const order: bigint[] = [];
    for (let i = 0; i < 50; i += 2) {
      order.push(BigInt(i + 1), BigInt(i));
    }
    for (const counter of order) {
      expect(acceptReceivedCounter(state, counter)).toBe(true);
    }
    // Every one of those counters must now be rejected as a replay.
    for (const counter of order) {
      expect(acceptReceivedCounter(state, counter)).toBe(false);
    }
  });
});
