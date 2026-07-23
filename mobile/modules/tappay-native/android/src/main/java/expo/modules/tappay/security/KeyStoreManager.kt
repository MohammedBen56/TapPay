package expo.modules.tappay.security

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import java.security.KeyPairGenerator
import java.security.KeyStore
import java.security.PrivateKey
import java.security.Signature
import java.security.interfaces.ECPublicKey
import java.security.spec.ECGenParameterSpec
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

private const val KEYSTORE_PROVIDER = "AndroidKeyStore"

// Per-device alias, not a single fixed name: enrolling a second dev identity on
// the same phone (M1 Step 9's one-phone QR test path, before phone B's usbipd
// link is fixed) would otherwise silently overwrite the first identity's key.
private fun aliasFor(deviceId: String) = "tappay_identity_$deviceId"

class IdentityKeyNotFoundException(deviceId: String) :
  IllegalStateException("no identity key for device $deviceId -- call generateIdentityKey first")

class SigningAuthenticationException(message: String) : Exception(message)

/**
 * Hardware-backed P-256 identity key management (spec §3.2): StrongBox with TEE
 * fallback, biometric-gated (setUserAuthenticationRequired(true) +
 * AUTH_BIOMETRIC_STRONG), attestation-challenged at generation. The private key
 * never leaves the KeyStore -- signing happens inside it via the JCA Signature
 * API, gated by a system BiometricPrompt.
 */
class KeyStoreManager {
  private val keyStore = KeyStore.getInstance(KEYSTORE_PROVIDER).apply { load(null) }

  /** Returns true if StrongBox backing was achieved, false if it fell back to TEE
   * (an accepted degradation per spec §3.2, not a failure -- not every chipset
   * has StrongBox). `attestationChallenge` should be a fresh nonce issued by the
   * server for this enrollment (mobile/src/crypto/identity.ts orchestrates the
   * fetch), never a locally-generated value -- the whole point is that the
   * server can later confirm the attestation cert chain was produced for THIS
   * enrollment request, not replayed from an earlier one. */
  fun generateIdentityKey(deviceId: String, attestationChallenge: ByteArray): Boolean {
    val alias = aliasFor(deviceId)
    val purposes = KeyProperties.PURPOSE_SIGN or KeyProperties.PURPOSE_VERIFY

    fun buildSpec(strongBox: Boolean) =
      KeyGenParameterSpec.Builder(alias, purposes)
        .setAlgorithmParameterSpec(ECGenParameterSpec("secp256r1"))
        .setDigests(KeyProperties.DIGEST_SHA256)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        .setAttestationChallenge(attestationChallenge)
        .setIsStrongBoxBacked(strongBox)
        .build()

    val kpg = KeyPairGenerator.getInstance(KeyProperties.KEY_ALGORITHM_EC, KEYSTORE_PROVIDER)
    return try {
      kpg.initialize(buildSpec(strongBox = true))
      kpg.generateKeyPair()
      true
    } catch (e: StrongBoxUnavailableException) {
      kpg.initialize(buildSpec(strongBox = false))
      kpg.generateKeyPair()
      false
    }
  }

  /** Raw 33-byte SEC1-compressed P-256 public key, matching this project's
   * identity_pubkey wire format (spec §2.2) -- not Java's default X.509/SPKI form. */
  fun getCompressedPublicKey(deviceId: String): ByteArray {
    val cert = keyStore.getCertificate(aliasFor(deviceId)) ?: throw IdentityKeyNotFoundException(deviceId)
    val point = (cert.publicKey as ECPublicKey).w
    val x = fixedWidthUnsigned(point.affineX.toByteArray(), 32)
    val yIsOdd = point.affineY.testBit(0)
    return byteArrayOf(if (yIsOdd) 0x03 else 0x02) + x
  }

  /** Raw DER-encoded certificates, leaf first -- verified server-side at
   * enrollment against Google roots (M1 Step 7). Never trusted locally. */
  fun getAttestationCertChain(deviceId: String): List<ByteArray> =
    keyStore.getCertificateChain(aliasFor(deviceId))?.map { it.encoded }
      ?: throw IdentityKeyNotFoundException(deviceId)

  /**
   * Biometric-gated ECDSA-SHA256 sign over `bytesToSign`. Returns Java's
   * DER-encoded signature -- conversion to COSE's raw r||s happens in shared TS
   * (packages/shared/src/crypto/ecdsaDer.ts), tested once centrally against
   * known vector pairs rather than reimplemented in Kotlin.
   *
   * Because the key requires biometric auth, `Signature.initSign()` alone
   * leaves the Signature unusable until unlocked via a BiometricPrompt bound to
   * a CryptoObject wrapping it -- the actual signing happens inside
   * `onAuthenticationSucceeded`, bridged into this suspend function via
   * suspendCancellableCoroutine so callers just await a normal coroutine.
   */
  suspend fun sign(deviceId: String, activity: FragmentActivity, bytesToSign: ByteArray): ByteArray {
    val privateKey = keyStore.getKey(aliasFor(deviceId), null) as? PrivateKey
      ?: throw IdentityKeyNotFoundException(deviceId)
    val signature = Signature.getInstance("SHA256withECDSA").apply { initSign(privateKey) }
    return authenticateAndSign(activity, signature, bytesToSign)
  }

  private suspend fun authenticateAndSign(
    activity: FragmentActivity,
    signature: Signature,
    bytesToSign: ByteArray,
  ): ByteArray = suspendCancellableCoroutine { continuation ->
    val callback = object : BiometricPrompt.AuthenticationCallback() {
      override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
        try {
          val authedSignature = result.cryptoObject?.signature ?: signature
          authedSignature.update(bytesToSign)
          continuation.resume(authedSignature.sign())
        } catch (e: Exception) {
          continuation.resumeWithException(e)
        }
      }

      override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
        continuation.resumeWithException(SigningAuthenticationException("biometric auth error $errorCode: $errString"))
      }

      override fun onAuthenticationFailed() {
        // A single failed attempt (e.g. one non-matching fingerprint read) --
        // BiometricPrompt keeps the dialog open for retry on its own. Only
        // onAuthenticationError (final failure, cancel, lockout) rejects.
      }
    }

    activity.runOnUiThread {
      val prompt = BiometricPrompt(activity, ContextCompat.getMainExecutor(activity), callback)
      val promptInfo = BiometricPrompt.PromptInfo.Builder()
        .setTitle("Confirm payment")
        .setSubtitle("Authenticate to sign this transaction")
        .setNegativeButtonText("Cancel")
        .build()
      prompt.authenticate(promptInfo, BiometricPrompt.CryptoObject(signature))
    }

    continuation.invokeOnCancellation {
      // No explicit BiometricPrompt.cancelAuthentication() handle is captured
      // here since it's constructed inside runOnUiThread; the dialog dismissing
      // itself on activity teardown is an accepted gap for M1's dev-flow scope.
    }
  }

  private fun fixedWidthUnsigned(bytes: ByteArray, width: Int): ByteArray = when {
    bytes.size == width -> bytes
    // BigInteger.toByteArray() prepends a 0x00 sign byte whenever the high bit
    // of the value is set, to keep it non-negative -- strip it back off.
    bytes.size == width + 1 && bytes[0] == 0.toByte() -> bytes.copyOfRange(1, bytes.size)
    bytes.size < width -> ByteArray(width - bytes.size) + bytes // left-pad
    else -> throw IllegalStateException("unexpected EC coordinate length: ${bytes.size}")
  }
}
