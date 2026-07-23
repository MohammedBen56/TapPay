package expo.modules.tappay.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.ParcelUuid
import android.os.SystemClock
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID

// Fixed service UUID for the M0 telemetry RSSI exchange only -- not the real TapPay
// GATT service (that's M3). This just lets two phones find each other's
// advertisement and read RSSI without a full GATT connection.
private val TELEMETRY_SERVICE_UUID: UUID = UUID.fromString("6f1d1c9e-6b1e-4f6d-9a1a-9d6f8b6e2c10")
private const val TAG = "TapPayBleRssiExchange"

/**
 * Non-connectable advertise + filtered scan pair. No GATT connection is opened.
 * Not all chipsets support peripheral-mode advertising -- [canAdvertise] reports
 * that up front so the app can surface it rather than fail silently. M0 only needs
 * one phone advertising and one scanning to get RSSI data; M3 needs both to
 * advertise for the real qualification gate.
 */
class BleRssiExchange(private val context: Context) {
  private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter: BluetoothAdapter? get() = bluetoothManager.adapter

  private var advertiseCallback: AdvertiseCallback? = null
  private var scanCallback: ScanCallback? = null

  val canAdvertise: Boolean
    get() = adapter?.isMultipleAdvertisementSupported == true && adapter?.bluetoothLeAdvertiser != null

  fun start(onRssi: (Map<String, Any?>) -> Unit) {
    stop()
    startAdvertising()
    startScanning(onRssi)
  }

  fun stop() {
    val bleAdapter = adapter
    if (bleAdapter != null && hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) {
      advertiseCallback?.let { runCatching { bleAdapter.bluetoothLeAdvertiser?.stopAdvertising(it) } }
    }
    if (bleAdapter != null && hasPermission(Manifest.permission.BLUETOOTH_SCAN)) {
      scanCallback?.let { runCatching { bleAdapter.bluetoothLeScanner?.stopScan(it) } }
    }
    advertiseCallback = null
    scanCallback = null
  }

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private fun startAdvertising() {
    if (!hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) {
      Log.w(TAG, "BLUETOOTH_ADVERTISE not granted; skipping advertising")
      return
    }
    val advertiser = adapter?.bluetoothLeAdvertiser
    if (advertiser == null) {
      Log.w(TAG, "BLE peripheral-mode advertising unsupported on this device")
      return
    }

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(false)
      .build()

    val data = AdvertiseData.Builder()
      .addServiceUuid(ParcelUuid(TELEMETRY_SERVICE_UUID))
      .setIncludeDeviceName(false)
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        Log.w(TAG, "Advertise failed to start, error=$errorCode")
      }
    }
    advertiseCallback = callback
    advertiser.startAdvertising(settings, data, callback)
  }

  private fun startScanning(onRssi: (Map<String, Any?>) -> Unit) {
    if (!hasPermission(Manifest.permission.BLUETOOTH_SCAN)) {
      Log.w(TAG, "BLUETOOTH_SCAN not granted; skipping scan")
      return
    }
    val scanner = adapter?.bluetoothLeScanner
    if (scanner == null) {
      Log.w(TAG, "BLE scanning unavailable on this device")
      return
    }

    val filter = ScanFilter.Builder()
      .setServiceUuid(ParcelUuid(TELEMETRY_SERVICE_UUID))
      .build()

    val settings = ScanSettings.Builder()
      .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
      .build()

    val hasConnectPermission = hasPermission(Manifest.permission.BLUETOOTH_CONNECT)

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        val peerAddr = if (hasConnectPermission) runCatching { result.device?.address }.getOrNull() else null
        onRssi(
          mapOf(
            "t_device_ns" to SystemClock.elapsedRealtimeNanos(),
            "dbm" to result.rssi,
            "peerAddr" to peerAddr
          )
        )
      }

      override fun onScanFailed(errorCode: Int) {
        Log.w(TAG, "Scan failed to start, error=$errorCode")
      }
    }
    scanCallback = callback
    scanner.startScan(listOf(filter), settings, callback)
  }
}
