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
