import { describe, expect, it } from "vitest";
import { ConnectivityMode, evaluateConnectivity } from "../types.js";

describe("evaluateConnectivity (spec §5 mode-selection rule)", () => {
  it("picks Mode A whenever the receiver is online, regardless of sender", () => {
    expect(evaluateConnectivity(true, true)).toBe(ConnectivityMode.MODE_A);
    expect(evaluateConnectivity(true, false)).toBe(ConnectivityMode.MODE_A);
  });

  it("picks Mode B when the receiver is offline but the sender is online", () => {
    expect(evaluateConnectivity(false, true)).toBe(ConnectivityMode.MODE_B);
  });

  it("picks Mode C when both are offline", () => {
    expect(evaluateConnectivity(false, false)).toBe(ConnectivityMode.MODE_C);
  });
});
