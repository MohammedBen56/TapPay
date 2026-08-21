/** The QR payload encoded on the Profile screen and decoded by Send's
 * "Scan QR" / "Import a photo" recipient-input methods. Mobile-only
 * convention -- never crosses the wire as a typed shape (the server only
 * ever sees a bare RIB string, via /transfers or /lookup/rib), so this
 * doesn't belong in packages/shared's api.ts. */
export interface ProfileQrPayload {
  rib: string;
  display_name: string;
}

export function encodeProfileQr(payload: ProfileQrPayload): string {
  return JSON.stringify(payload);
}

export function decodeProfileQr(raw: string): ProfileQrPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "rib" in parsed &&
      typeof (parsed as Record<string, unknown>).rib === "string"
    ) {
      const displayName = (parsed as Record<string, unknown>).display_name;
      return { rib: (parsed as Record<string, unknown>).rib as string, display_name: typeof displayName === "string" ? displayName : "" };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Ship List v2 Wave 2 Phase 7: a discriminated variant alongside
 * ProfileQrPayload (not a replacement) -- encoded on
 * app/requests/index.tsx for a pending outgoing request, decoded by
 * Send's same scan/import/NFC methods to prefill recipient + amount +
 * reference. `request_id` is what Send uses to call
 * `POST /money-requests/:id/fulfill` instead of a bare `POST /transfers`
 * once the payer confirms, so the request itself gets marked fulfilled
 * as part of the same settlement rather than as a separate step. Never
 * crosses the wire as a typed shape either -- same reasoning as
 * ProfileQrPayload above. */
export interface RequestQrPayload {
  type: "request";
  request_id: string;
  rib: string;
  display_name: string;
  /** Minor-units decimal string, matching every other money field on the wire. */
  amount: string;
  reference: string;
}

export function encodeRequestQr(payload: RequestQrPayload): string {
  return JSON.stringify(payload);
}

export function decodeRequestQr(raw: string): RequestQrPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      (parsed as Record<string, unknown>).type === "request" &&
      typeof (parsed as Record<string, unknown>).request_id === "string" &&
      typeof (parsed as Record<string, unknown>).rib === "string" &&
      typeof (parsed as Record<string, unknown>).amount === "string" &&
      typeof (parsed as Record<string, unknown>).reference === "string"
    ) {
      const p = parsed as Record<string, unknown>;
      const displayName = p.display_name;
      return {
        type: "request",
        request_id: p.request_id as string,
        rib: p.rib as string,
        display_name: typeof displayName === "string" ? displayName : "",
        amount: p.amount as string,
        reference: p.reference as string,
      };
    }
  } catch {
    // fall through
  }
  return null;
}
