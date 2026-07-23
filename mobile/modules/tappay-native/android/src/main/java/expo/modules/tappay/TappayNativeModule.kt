package expo.modules.tappay

import android.Manifest
import androidx.fragment.app.FragmentActivity
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.tappay.ble.BleRssiExchange
import expo.modules.tappay.security.KeyStoreManager
import expo.modules.tappay.sensors.SensorStreamer

private val BLE_PERMISSIONS = arrayOf(
  Manifest.permission.BLUETOOTH_SCAN,
  Manifest.permission.BLUETOOTH_ADVERTISE,
  Manifest.permission.BLUETOOTH_CONNECT
)

private class NoCurrentActivityException :
  CodedException("ERR_NO_ACTIVITY", "no current FragmentActivity to host the biometric prompt", null)

class TappayNativeModule : Module() {
  private val sensorStreamer by lazy { SensorStreamer(appContext.reactContext!!) }
  private val bleRssiExchange by lazy { BleRssiExchange(appContext.reactContext!!) }
  private val keyStoreManager by lazy { KeyStoreManager() }

  override fun definition() = ModuleDefinition {
    Name("TappayNative")

    Events("onSensorBatch", "onRssiSample")

    AsyncFunction("requestPermissions") { promise: expo.modules.kotlin.Promise ->
      Permissions.askForPermissionsWithPermissionsManager(appContext.permissions, promise, *BLE_PERMISSIONS)
    }

    AsyncFunction("startStreaming") {
      sensorStreamer.start { samples -> sendEvent("onSensorBatch", mapOf("samples" to samples)) }
      bleRssiExchange.start { sample -> sendEvent("onRssiSample", sample) }
    }

    AsyncFunction("stopStreaming") {
      sensorStreamer.stop()
      bleRssiExchange.stop()
    }

    AsyncFunction("generateIdentityKey") { deviceId: String, challenge: ByteArray ->
      keyStoreManager.generateIdentityKey(deviceId, challenge)
    }

    AsyncFunction("getIdentityPublicKey") { deviceId: String ->
      mapOf(
        "publicKey" to keyStoreManager.getCompressedPublicKey(deviceId),
        "attestationChain" to keyStoreManager.getAttestationCertChain(deviceId)
      )
    }

    // The plain `AsyncFunction("name") { ... }` DSL resolves to a non-suspend
    // lambda overload -- it cannot await another suspend function. sign() needs
    // to (it suspends across the BiometricPrompt callback), so this one uses the
    // `Coroutine` infix form instead, the DSL's actual suspend-body entry point.
    AsyncFunction("signWithIdentityKey") Coroutine { deviceId: String, bytesToSign: ByteArray ->
      val activity = appContext.currentActivity as? FragmentActivity ?: throw NoCurrentActivityException()
      keyStoreManager.sign(deviceId, activity, bytesToSign)
    }

    OnDestroy {
      sensorStreamer.stop()
      bleRssiExchange.stop()
    }
  }
}
