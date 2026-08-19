package expo.modules.tappay.nfc

import android.nfc.cardemulation.HostApduService
import android.os.Bundle
import android.util.Log

/**
 * Host Card Emulation service for "Share via NFC" (Profile screen) --
 * lets this phone act as an NFC tag that another phone's `IsoDep` reader
 * (mobile/src/nfc/nfcReader.ts, react-native-nfc-manager) can tap and read.
 *
 * Android removed "Beam" (NDEF push) in Android 10+; HCE is the only
 * remaining way to do phone-to-phone NFC sharing, and it unavoidably needs
 * a system-registered service like this one -- no JS-only library exposes
 * it (checked directly against react-native-nfc-manager's source, which
 * only exposes the *reading* side). See CLAUDE.md's NFC section.
 *
 * Not a real payment applet: [AID] is a custom, unregistered identifier
 * under `category="other"` (res/xml/apduservice.xml), specifically so this
 * never competes for Android's "default payment app" role or shows the
 * system's default-payment-app picker -- this is account-info sharing, not
 * a transaction. Protocol is a single SELECT, not a standards-compliant
 * NDEF Type 4 Tag: only this app's own reader ever talks to it, so there's
 * no compatibility reason to implement the heavier spec.
 *
 * The payload rides on the SELECT response itself (ISO 7816-4 allows a
 * SELECT response to carry data, not just a status word) rather than
 * needing a separate READ command -- live two-phone testing found the
 * original SELECT-then-READ version failed intermittently because contact
 * broke between the two exchanges even when the SELECT itself had already
 * succeeded. One exchange means a share either fully succeeds or never
 * starts, with no window for a marginal tap to complete the first half and
 * lose the second. A legacy CLA_READ/INS_READ path stays for anything that
 * still probes it, but the reader (nfcReader.ts) no longer sends it.
 */
class NfcHceService : HostApduService() {
  companion object {
    private const val TAG = "NfcHceService"

    // Arbitrary, unregistered AID (5-16 bytes). Must match
    // res/xml/apduservice.xml's <aid-filter> exactly.
    val AID: ByteArray = byteArrayOf(
      0xF0.toByte(), 0x54, 0x41, 0x50, 0x50, 0x41, 0x59
    ) // F0 "TAPPAY"

    private const val CLA_SELECT = 0x00.toByte()
    private const val INS_SELECT = 0xA4.toByte()
    private const val CLA_READ = 0x80.toByte()
    private const val INS_READ = 0xCA.toByte()

    private val SW_OK = byteArrayOf(0x90.toByte(), 0x00)
    private val SW_INS_NOT_SUPPORTED = byteArrayOf(0x6D.toByte(), 0x00)
    private val SW_NO_PAYLOAD = byteArrayOf(0x6A.toByte(), 0x88.toByte()) // "referenced data not found"

    // Set by TappayNativeModule.nfcStartSharing/nfcStopSharing. HCE services
    // are instantiated by the system, not by our module directly, so the
    // payload to serve has to be handed over through shared state rather
    // than a constructor. processCommandApdu runs on a Binder thread, hence
    // @Volatile rather than a plain var.
    @Volatile
    var payloadToShare: ByteArray? = null
  }

  override fun processCommandApdu(commandApdu: ByteArray, extras: Bundle?): ByteArray {
    if (isSelectAid(commandApdu)) {
      val payload = payloadToShare
      if (payload == null) {
        Log.d(TAG, "SELECT matched but nothing is being shared right now")
        return SW_NO_PAYLOAD
      }
      Log.d(TAG, "SELECT matched -- returning ${payload.size} bytes on the SELECT response")
      return payload + SW_OK
    }

    // Legacy path, kept for anything that still probes it -- current
    // nfcReader.ts never sends this, everything now rides on SELECT above.
    if (commandApdu.size >= 2 && commandApdu[0] == CLA_READ && commandApdu[1] == INS_READ) {
      val payload = payloadToShare
      if (payload == null) {
        Log.d(TAG, "READ requested but nothing is being shared right now")
        return SW_NO_PAYLOAD
      }
      Log.d(TAG, "READ -- returning ${payload.size} bytes")
      return payload + SW_OK
    }

    Log.d(TAG, "Unrecognized APDU: ${commandApdu.joinToString(" ") { "%02X".format(it) }}")
    return SW_INS_NOT_SUPPORTED
  }

  override fun onDeactivated(reason: Int) {
    Log.d(TAG, "Deactivated, reason=$reason")
  }

  private fun isSelectAid(apdu: ByteArray): Boolean {
    // 00 A4 04 00 <Lc> <AID...>
    if (apdu.size < 5 + AID.size) return false
    if (apdu[0] != CLA_SELECT || apdu[1] != INS_SELECT) return false
    val lc = apdu[4].toInt() and 0xFF
    if (lc != AID.size) return false
    val aidInApdu = apdu.copyOfRange(5, 5 + AID.size)
    return aidInApdu.contentEquals(AID)
  }
}
