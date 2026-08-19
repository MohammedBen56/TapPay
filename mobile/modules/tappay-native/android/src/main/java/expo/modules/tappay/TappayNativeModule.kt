package expo.modules.tappay

import android.Manifest
import androidx.fragment.app.FragmentActivity
import expo.modules.interfaces.permissions.Permissions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.tappay.ble.BleGattTransport
import expo.modules.tappay.ble.BleRssiExchange
import expo.modules.tappay.nfc.NfcHceService
import expo.modules.tappay.security.KeyStoreManager
import expo.modules.tappay.sensors.SensorStreamer
import java.nio.charset.StandardCharsets

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
  private val bleGattTransport by lazy { BleGattTransport(appContext.reactContext!!) }
  private val keyStoreManager by lazy { KeyStoreManager() }

  override fun definition() = ModuleDefinition {
    Name("TappayNative")

    Events("onSensorBatch", "onRssiSample", "onBleTransportConnectionState", "onBleTransportData")

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

    // M3 Milestone 1 (plan "elegant-hopping-lark"): the real payment GATT
    // transport, distinct from bleRssiExchange above (M0 telemetry, RSSI
    // only, non-connectable). Role selection -- who advertises (peripheral)
    // vs who scans (central) for a given payment -- is a UI decision made
    // above this module (Milestone 2, not yet wired into PayScreen.tsx); both
    // roles are exposed here as plain callable functions.
    AsyncFunction("bleStartAdvertising") { ownDeviceId: ByteArray ->
      bleGattTransport.startAdvertising(
        ownDeviceId,
        onData = { data -> sendEvent("onBleTransportData", mapOf("data" to data)) },
        onConnectionState = { state -> sendEvent("onBleTransportConnectionState", mapOf("state" to state)) },
      )
    }

    AsyncFunction("bleStopAdvertising") {
      bleGattTransport.stopAdvertising()
    }

    // Coroutine form: connectToPeer suspends across scan -> connect ->
    // discoverServices -> requestMtu -> enable-notifications, all
    // callback-based Android GATT APIs, the same reason signWithIdentityKey
    // above needs Coroutine instead of a plain AsyncFunction body.
    AsyncFunction("bleConnectToPeer") Coroutine { targetDeviceId: ByteArray, timeoutMs: Int ->
      bleGattTransport.connectToPeer(
        targetDeviceId,
        onData = { data -> sendEvent("onBleTransportData", mapOf("data" to data)) },
        onConnectionState = { state -> sendEvent("onBleTransportConnectionState", mapOf("state" to state)) },
        timeoutMs = timeoutMs.toLong(),
      )
    }

    AsyncFunction("bleSend") Coroutine { bytes: ByteArray ->
      bleGattTransport.send(bytes)
    }

    AsyncFunction("bleDisconnect") {
      bleGattTransport.disconnect()
    }

    // NFC-2 (plan "milestones for NFC sharing"): the HCE emulator side of
    // "Share via NFC" (Profile screen). NfcHceService is instantiated by
    // the system whenever a reader selects our AID, not by this module, so
    // there's nothing to "start" in the sense bleStartAdvertising has --
    // this just hands the service the bytes to serve the next time it's
    // asked. Stopping clears it, so a stale share can't be read after the
    // user navigates away.
    AsyncFunction("nfcStartSharing") { payloadUtf8: String ->
      NfcHceService.payloadToShare = payloadUtf8.toByteArray(StandardCharsets.UTF_8)
    }

    AsyncFunction("nfcStopSharing") {
      NfcHceService.payloadToShare = null
    }

    OnDestroy {
      sensorStreamer.stop()
      bleRssiExchange.stop()
      bleGattTransport.disconnect()
      NfcHceService.payloadToShare = null
    }
  }
}
