import { createHash } from "node:crypto";
import type { FastifyRequest } from "fastify";

/** Ship List v2 Wave 2 Phase 4 -- login-anomaly signal. Prefers a
 * client-supplied `X-Device-Id` header (a random UUID `mobile/src/auth/
 * deviceId.ts` generates once and persists in expo-secure-store, sent only
 * on POST /auth/login) since it's stable across a customer's IP changing
 * (roaming, carrier NAT reassignment) and distinguishes two customers
 * behind the same NAT/VPN egress IP, neither of which a bare IP can do.
 * Falls back to the request IP for any caller that doesn't send the
 * header (a future non-mobile client, or a direct API call) -- a real but
 * coarser signal, not a hard requirement. Never stores the raw value:
 * only a SHA-256 hash lands in known_devices, so a leaked table row can't
 * be replayed as a literal device-id header value against this endpoint
 * or correlated with the mobile client's own persisted copy. */
export function deriveLoginFingerprint(request: FastifyRequest): { hash: Buffer; source: "device_id" | "ip" } {
  const header = request.headers["x-device-id"];
  const deviceId = typeof header === "string" ? header : Array.isArray(header) ? header[0] : undefined;
  if (deviceId && deviceId.length > 0 && deviceId.length <= 200) {
    return { hash: createHash("sha256").update(deviceId).digest(), source: "device_id" };
  }
  return { hash: createHash("sha256").update(request.ip).digest(), source: "ip" };
}
