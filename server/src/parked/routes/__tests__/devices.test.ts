import { randomUUID } from "node:crypto";
import { decodeDeviceCredential, verifyCoseSign1 } from "@tappay/shared";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../../app.js";
import { serverPublicKeyBytes } from "../../../crypto/serverSigner.js";
import { createEnrolledDevice } from "./testHelpers.js";

describe("GET /devices/:deviceId/credential", () => {
  const app = buildApp({ rateLimit: false, proximityRoutes: true });

  it("returns a server-signed credential binding the device's real identity_pubkey", async () => {
    const alice = await createEnrolledDevice(0n);

    const response = await app.inject({ method: "GET", url: `/devices/${alice.deviceId}/credential` });

    expect(response.statusCode).toBe(200);
    const { credential } = response.json() as { credential: string };
    const verified = verifyCoseSign1(Buffer.from(credential, "base64"), serverPublicKeyBytes);
    expect(verified).not.toBeNull();

    const decoded = decodeDeviceCredential(verified!.payload);
    expect(Buffer.from(decoded.device_id).toString("hex")).toBe(alice.deviceId.replace(/-/g, ""));
  });

  it("404s for a device that was never enrolled", async () => {
    const response = await app.inject({ method: "GET", url: `/devices/${randomUUID()}/credential` });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("UnknownDevice");
  });

  it("403s for an enrolled device whose attestation never verified -- no credential issued", async () => {
    const mallory = await createEnrolledDevice(0n, { attestationOk: false });

    const response = await app.inject({ method: "GET", url: `/devices/${mallory.deviceId}/credential` });

    expect(response.statusCode).toBe(403);
    expect(response.json().error).toBe("UnverifiedDevice");
  });
});
