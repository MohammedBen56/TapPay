package expo.modules.tappay.ble

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattServer
import android.bluetooth.BluetoothGattServerCallback
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.AdvertiseCallback
import android.bluetooth.le.AdvertiseData
import android.bluetooth.le.AdvertiseSettings
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.ParcelUuid
import android.util.Log
import androidx.core.content.ContextCompat
import java.util.UUID
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException
import kotlinx.coroutines.suspendCancellableCoroutine

// The real TapPay payment transport (M3 Milestone 1, plan "elegant-hopping-
// lark") -- unlike BleRssiExchange.kt's TELEMETRY_SERVICE_UUID (M0, non-
// connectable, RSSI only), this is a CONNECTABLE GATT service carrying the
// actual signed proposal/receipt bytes. Deliberately a separate class rather
// than extending BleRssiExchange: the two advertisers use different service
// UUIDs and a connectable payment advertisement must not fight the
// telemetry RSSI exchange's own (non-connectable) advertiser for the single
// hardware advertising slot most chipsets provide.
private val TRANSPORT_SERVICE_UUID: UUID = UUID.fromString("6f1d1c9e-6b1e-4f6d-9a1a-9d6f8b6e2c20")
private val TRANSPORT_CHARACTERISTIC_UUID: UUID = UUID.fromString("6f1d1c9e-6b1e-4f6d-9a1a-9d6f8b6e2c21")
private val CLIENT_CHARACTERISTIC_CONFIG_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

/** A separate, compact UUID used ONLY as the advertised service-data key --
 * never as the GATT service UUID (that stays TRANSPORT_SERVICE_UUID,
 * discovered post-connection via discoverServices(), which has no
 * over-the-air size budget). Legacy (non-extended) BLE advertising has a
 * hard 31-byte cap on the whole AD payload: a 128-bit "complete service UUID
 * list" field is 18 bytes and 128-bit-keyed service data carrying the
 * 16-byte device_id is 34 bytes on its own -- either already blows the
 * budget, and both together (as originally written here) measurably failed
 * on-device with AdvertiseCallback error 1 (ADVERTISE_FAILED_DATA_TOO_LARGE)
 * on a real Galaxy A51. This UUID matches the Bluetooth Base UUID pattern
 * (0000xxxx-0000-1000-8000-00805F9B34FB), which the platform's AD encoder
 * automatically compresses to a 2-byte on-air representation, shrinking the
 * service-data structure to 20 bytes (2-byte header + 2-byte UUID + 16-byte
 * device_id) -- comfortably under the cap with the mandatory flags field
 * included. It is NOT a Bluetooth SIG-assigned 16-bit UUID; using an
 * arbitrary value here is only safe because this is unpublished/private use
 * (the same convention many non-SIG BLE prototypes rely on) -- collision
 * risk is scoped to two unrelated advertisers both picking this exact value
 * near each other, not a concern for this MVP.
 */
private val ADVERTISE_MATCH_UUID: UUID = UUID.fromString("0000fcc1-0000-1000-8000-00805f9b34fb")

private const val TAG = "TapPayBleGattTransport"

/** Requested MTU on the central side -- 517 is the maximum ATT_MTU the
 * platform allows; the actual negotiated value (delivered via onMtuChanged)
 * is almost always smaller and is what chunking is actually sized against.
 * Not every peripheral chipset grants a large MTU, so chunking must never
 * assume this was fully honored. */
private const val REQUESTED_MTU = 517

/** Fallback chunk payload size if MTU negotiation is skipped/unavailable --
 * the guaranteed-safe ATT payload on unenhanced (23-byte) MTU: 23 - 3 byte
 * ATT header - 1 byte continuation flag = 19. */
private const val DEFAULT_CHUNK_PAYLOAD_SIZE = 19

private const val CONTINUATION_MORE: Byte = 1
private const val CONTINUATION_LAST: Byte = 0

/** Splits `message` into continuation-bit-framed chunks no larger than
 * `chunkPayloadSize` bytes of payload each (plus the 1-byte header). The
 * receiving side (see [FrameReassembler]) concatenates payloads until a
 * chunk with the terminal flag arrives, so chunk count and total length
 * never need to be negotiated up front -- simpler than length-prefixing and
 * robust to the two sides settling on different-looking MTUs. */
internal fun frameMessage(message: ByteArray, chunkPayloadSize: Int = DEFAULT_CHUNK_PAYLOAD_SIZE): List<ByteArray> {
  if (message.isEmpty()) return listOf(byteArrayOf(CONTINUATION_LAST))
  val chunks = mutableListOf<ByteArray>()
  var offset = 0
  while (offset < message.size) {
    val end = minOf(offset + chunkPayloadSize, message.size)
    val isLast = end == message.size
    val chunk = ByteArray(1 + (end - offset))
    chunk[0] = if (isLast) CONTINUATION_LAST else CONTINUATION_MORE
    System.arraycopy(message, offset, chunk, 1, end - offset)
    chunks.add(chunk)
    offset = end
  }
  return chunks
}

/** Reassembles chunks produced by [frameMessage] back into whole messages.
 * Stateful per logical stream -- a transport with both a central and a
 * peripheral role active needs one instance per direction, never shared. */
internal class FrameReassembler {
  private val buffer = mutableListOf<Byte>()

  /** Feeds one received chunk. Returns the complete reassembled message once
   * a terminal (CONTINUATION_LAST) chunk arrives, null otherwise (still
   * waiting on more chunks). */
  fun accept(chunk: ByteArray): ByteArray? {
    if (chunk.isEmpty()) return null
    val flag = chunk[0]
    if (chunk.size > 1) buffer.addAll(chunk.drop(1))
    if (flag == CONTINUATION_LAST) {
      val complete = buffer.toByteArray()
      buffer.clear()
      return complete
    }
    return null
  }
}

class BleConnectionException(message: String) : Exception(message)
class BleUnsupportedException(message: String) : Exception(message)

/**
 * The real payment GATT transport: peripheral (advertiser + GATT server) and
 * central (scanner + GATT client) roles, both exposed as plain callable
 * functions -- role selection (who advertises vs who scans for a given
 * payment) is a UI/product decision made above this class, NOT decided here
 * (Milestone 2, `PayScreen.tsx`/`paymentFlow.ts` wiring, not yet done).
 *
 * Deliberately raw `android.bluetooth.*`, no BLE library dependency, matching
 * `BleRssiExchange.kt`'s existing style. `connectToPeer`/`send` are
 * `suspend` functions bridging Android's callback-based GATT APIs via
 * `suspendCancellableCoroutine`, the same pattern `KeyStoreManager.sign`
 * uses for the callback-based BiometricPrompt API.
 *
 * Framing/replay: this class only moves opaque bytes -- it does not seal or
 * open session messages (`packages/shared/src/crypto/session.ts`) itself,
 * nor track the send counter / replay window
 * (`packages/shared/src/crypto/sessionTransport.ts`). Those stay in shared
 * TS, transport-agnostic, per session.ts's own module doc; this class's only
 * job is "get bytes from one phone to the other reliably," the same
 * separation QR already had (qr.ts carries bytes, `@tappay/shared` carries
 * wire format and crypto).
 */
class BleGattTransport(private val context: Context) {
  private val bluetoothManager = context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
  private val adapter: BluetoothAdapter? get() = bluetoothManager.adapter

  private var onData: ((ByteArray) -> Unit)? = null
  private var onConnectionState: ((String) -> Unit)? = null

  // --- Peripheral role state ---
  private var gattServer: BluetoothGattServer? = null
  private var advertiseCallback: AdvertiseCallback? = null
  private var serverCharacteristic: BluetoothGattCharacteristic? = null
  private var connectedCentral: BluetoothDevice? = null
  private var centralNotificationsEnabled = false
  private val serverReassembler = FrameReassembler()

  // --- Central role state ---
  private var scanCallback: ScanCallback? = null
  private var clientGatt: BluetoothGatt? = null
  private var clientCharacteristic: BluetoothGattCharacteristic? = null
  private var negotiatedChunkSize = DEFAULT_CHUNK_PAYLOAD_SIZE
  private val clientReassembler = FrameReassembler()

  private fun hasPermission(permission: String): Boolean =
    ContextCompat.checkSelfPermission(context, permission) == PackageManager.PERMISSION_GRANTED

  private val canAdvertise: Boolean
    get() = adapter?.isMultipleAdvertisementSupported == true && adapter?.bluetoothLeAdvertiser != null

  // ============================== Peripheral ==============================

  /** Starts a connectable advertisement carrying `ownDeviceId` (16 bytes) as
   * service data -- this is what a scanning central matches against to find
   * this SPECIFIC phone among possibly several nearby ones advertising the
   * same service UUID (the pairing-payload decision from the plan: the
   * existing `TxRequest.recipient_device_id`, already scanned from a QR, is
   * reused directly as the scan-filter target -- no separate pairing QR
   * type). Opens a GATT server hosting one write+notify characteristic.
   * `onData` fires once per complete reassembled message (never partial
   * chunks); `onConnectionState` fires "connected"/"disconnected". */
  fun startAdvertising(ownDeviceId: ByteArray, onData: (ByteArray) -> Unit, onConnectionState: (String) -> Unit) {
    require(ownDeviceId.size == 16) { "ownDeviceId must be 16 bytes, got ${ownDeviceId.size}" }
    stopAdvertising()
    this.onData = onData
    this.onConnectionState = onConnectionState

    if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
      Log.w(TAG, "BLUETOOTH_CONNECT not granted; cannot open a GATT server")
      return
    }
    val server = bluetoothManager.openGattServer(context, gattServerCallback)
    if (server == null) {
      Log.w(TAG, "openGattServer returned null; GATT server unavailable")
      return
    }
    gattServer = server

    val characteristic = BluetoothGattCharacteristic(
      TRANSPORT_CHARACTERISTIC_UUID,
      BluetoothGattCharacteristic.PROPERTY_WRITE or BluetoothGattCharacteristic.PROPERTY_NOTIFY,
      BluetoothGattCharacteristic.PERMISSION_WRITE,
    )
    characteristic.addDescriptor(
      BluetoothGattDescriptor(
        CLIENT_CHARACTERISTIC_CONFIG_UUID,
        BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE,
      ),
    )
    serverCharacteristic = characteristic

    val service = BluetoothGattService(TRANSPORT_SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
    service.addCharacteristic(characteristic)
    server.addService(service)

    startPeripheralAdvertising(ownDeviceId)
  }

  private fun startPeripheralAdvertising(ownDeviceId: ByteArray) {
    if (!hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) {
      Log.w(TAG, "BLUETOOTH_ADVERTISE not granted; skipping advertising")
      return
    }
    if (!canAdvertise) {
      Log.w(TAG, "BLE peripheral-mode advertising unsupported on this device")
      return
    }
    val advertiser = adapter?.bluetoothLeAdvertiser ?: return

    val settings = AdvertiseSettings.Builder()
      .setAdvertiseMode(AdvertiseSettings.ADVERTISE_MODE_LOW_LATENCY)
      .setTxPowerLevel(AdvertiseSettings.ADVERTISE_TX_POWER_HIGH)
      .setConnectable(true)
      .build()

    // Deliberately NOT addServiceUuid(TRANSPORT_SERVICE_UUID) -- see
    // ADVERTISE_MATCH_UUID's doc comment. The scanning central discovers the
    // real GATT service post-connection; advertising only needs a compact
    // matchable key.
    val data = AdvertiseData.Builder()
      .addServiceData(ParcelUuid(ADVERTISE_MATCH_UUID), ownDeviceId)
      .setIncludeDeviceName(false)
      .build()

    val callback = object : AdvertiseCallback() {
      override fun onStartFailure(errorCode: Int) {
        Log.w(TAG, "Transport advertise failed to start, error=$errorCode")
      }
    }
    advertiseCallback = callback
    advertiser.startAdvertising(settings, data, callback)
  }

  fun stopAdvertising() {
    val bleAdapter = adapter
    if (bleAdapter != null && hasPermission(Manifest.permission.BLUETOOTH_ADVERTISE)) {
      advertiseCallback?.let { runCatching { bleAdapter.bluetoothLeAdvertiser?.stopAdvertising(it) } }
    }
    advertiseCallback = null
    if (hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
      runCatching { gattServer?.close() }
    }
    gattServer = null
    serverCharacteristic = null
    connectedCentral = null
    centralNotificationsEnabled = false
  }

  private val gattServerCallback = object : BluetoothGattServerCallback() {
    override fun onConnectionStateChange(device: BluetoothDevice, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        connectedCentral = device
        onConnectionState?.invoke("connected")
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        connectedCentral = null
        centralNotificationsEnabled = false
        onConnectionState?.invoke("disconnected")
      }
    }

    override fun onCharacteristicWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      characteristic: BluetoothGattCharacteristic,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (characteristic.uuid == TRANSPORT_CHARACTERISTIC_UUID) {
        serverReassembler.accept(value)?.let { complete -> onData?.invoke(complete) }
      }
      if (responseNeeded && hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
        runCatching { gattServer?.sendResponse(device, requestId, 0, offset, null) }
      }
    }

    override fun onDescriptorWriteRequest(
      device: BluetoothDevice,
      requestId: Int,
      descriptor: BluetoothGattDescriptor,
      preparedWrite: Boolean,
      responseNeeded: Boolean,
      offset: Int,
      value: ByteArray,
    ) {
      if (descriptor.uuid == CLIENT_CHARACTERISTIC_CONFIG_UUID) {
        centralNotificationsEnabled = value.contentEquals(BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      }
      if (responseNeeded && hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
        runCatching { gattServer?.sendResponse(device, requestId, 0, offset, null) }
      }
    }
  }

  private suspend fun sendAsPeripheral(bytes: ByteArray) {
    val device = connectedCentral ?: throw BleConnectionException("no central connected")
    val server = gattServer ?: throw BleConnectionException("GATT server not started")
    val characteristic = serverCharacteristic ?: throw BleConnectionException("transport characteristic not set up")
    if (!centralNotificationsEnabled) throw BleConnectionException("central has not enabled notifications yet")
    if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) throw BleConnectionException("BLUETOOTH_CONNECT not granted")

    for (chunk in frameMessage(bytes, negotiatedChunkSize)) {
      notifyChunk(server, device, characteristic, chunk)
    }
  }

  // notifyCharacteristicChanged gained a (device, characteristic, confirm,
  // value) overload in API 33; minSdk is 24, so the deprecated
  // characteristic.value + no-value overload is still required below that.
  @Suppress("DEPRECATION")
  private fun notifyChunk(server: BluetoothGattServer, device: BluetoothDevice, characteristic: BluetoothGattCharacteristic, chunk: ByteArray) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      server.notifyCharacteristicChanged(device, characteristic, false, chunk)
    } else {
      characteristic.value = chunk
      server.notifyCharacteristicChanged(device, characteristic, false)
    }
  }

  // ================================ Central ================================

  /**
   * Scans for a peripheral advertising [TRANSPORT_SERVICE_UUID] with service
   * data matching `targetDeviceId`, connects, discovers services, negotiates
   * MTU, and enables notifications -- suspends until the transport is fully
   * ready to send/receive, or throws on timeout/failure. `targetDeviceId` is
   * the same `recipient_device_id` already carried by the scanned Request QR
   * (`TxRequest`) -- no separate BLE pairing QR.
   */
  suspend fun connectToPeer(
    targetDeviceId: ByteArray,
    onData: (ByteArray) -> Unit,
    onConnectionState: (String) -> Unit,
    timeoutMs: Long = 15_000,
  ): Unit = suspendCancellableCoroutine { continuation ->
    require(targetDeviceId.size == 16) { "targetDeviceId must be 16 bytes, got ${targetDeviceId.size}" }
    this.onData = onData
    this.onConnectionState = onConnectionState

    if (!hasPermission(Manifest.permission.BLUETOOTH_SCAN) || !hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
      continuation.resumeWithException(BleConnectionException("BLUETOOTH_SCAN/BLUETOOTH_CONNECT not granted"))
      return@suspendCancellableCoroutine
    }
    val scanner = adapter?.bluetoothLeScanner
    if (scanner == null) {
      continuation.resumeWithException(BleUnsupportedException("BLE scanning unavailable on this device"))
      return@suspendCancellableCoroutine
    }

    var resolved = false
    val timeoutRunnable = Runnable {
      if (!resolved) {
        resolved = true
        runCatching { scanner.stopScan(scanCallback) }
        continuation.resumeWithException(BleConnectionException("timed out finding/connecting to peer over BLE"))
      }
    }
    val timeoutHandler = android.os.Handler(android.os.Looper.getMainLooper())
    timeoutHandler.postDelayed(timeoutRunnable, timeoutMs)

    // Matches on ADVERTISE_MATCH_UUID's service data (what the peripheral
    // actually advertises), not TRANSPORT_SERVICE_UUID -- see that UUID's
    // doc comment for why they're deliberately different.
    val filter = ScanFilter.Builder().setServiceData(ParcelUuid(ADVERTISE_MATCH_UUID), targetDeviceId).build()
    val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()

    val callback = object : ScanCallback() {
      override fun onScanResult(callbackType: Int, result: ScanResult) {
        if (resolved) return
        // ScanFilter already enforces the exact match above; re-checking
        // here is cheap defense-in-depth against any platform-specific scan
        // filter looseness, not load-bearing.
        val serviceData = result.scanRecord?.getServiceData(ParcelUuid(ADVERTISE_MATCH_UUID)) ?: return
        if (!serviceData.contentEquals(targetDeviceId)) return

        resolved = true
        timeoutHandler.removeCallbacks(timeoutRunnable)
        runCatching { scanner.stopScan(this@BleGattTransport.scanCallback) }

        clientGatt = result.device.connectGatt(context, false, gattClientCallback)
        gattConnectContinuation = continuation
      }

      override fun onScanFailed(errorCode: Int) {
        if (resolved) return
        resolved = true
        timeoutHandler.removeCallbacks(timeoutRunnable)
        continuation.resumeWithException(BleConnectionException("scan failed to start, error=$errorCode"))
      }
    }
    scanCallback = callback
    scanner.startScan(listOf(filter), settings, callback)

    continuation.invokeOnCancellation {
      runCatching { scanner.stopScan(callback) }
      timeoutHandler.removeCallbacks(timeoutRunnable)
    }
  }

  // Held across the connect→discoverServices→requestMtu→enableNotifications
  // chain so the single suspendCancellableCoroutine in connectToPeer resumes
  // only once every step succeeds, or on the first failure. Cleared on
  // resume either way.
  private var gattConnectContinuation: kotlin.coroutines.Continuation<Unit>? = null

  private fun failConnect(message: String) {
    val continuation = gattConnectContinuation ?: return
    gattConnectContinuation = null
    continuation.resumeWithException(BleConnectionException(message))
  }

  private val gattClientCallback = object : BluetoothGattCallback() {
    override fun onConnectionStateChange(gatt: BluetoothGatt, status: Int, newState: Int) {
      if (newState == BluetoothProfile.STATE_CONNECTED) {
        onConnectionState?.invoke("connected")
        if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
          failConnect("BLUETOOTH_CONNECT not granted")
          return
        }
        if (!gatt.discoverServices()) failConnect("discoverServices() failed to start")
      } else if (newState == BluetoothProfile.STATE_DISCONNECTED) {
        onConnectionState?.invoke("disconnected")
        failConnect("disconnected before transport was ready")
      }
    }

    override fun onServicesDiscovered(gatt: BluetoothGatt, status: Int) {
      if (status != BluetoothGatt.GATT_SUCCESS) {
        failConnect("service discovery failed, status=$status")
        return
      }
      val characteristic = gatt.getService(TRANSPORT_SERVICE_UUID)?.getCharacteristic(TRANSPORT_CHARACTERISTIC_UUID)
      if (characteristic == null) {
        failConnect("peer does not expose the TapPay transport characteristic")
        return
      }
      clientCharacteristic = characteristic
      if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT) || !gatt.requestMtu(REQUESTED_MTU)) {
        // MTU negotiation isn't universally supported; fall back to the
        // default-MTU chunk size and proceed straight to enabling
        // notifications rather than failing the whole connection over it.
        negotiatedChunkSize = DEFAULT_CHUNK_PAYLOAD_SIZE
        enableNotifications(gatt, characteristic)
      }
    }

    override fun onMtuChanged(gatt: BluetoothGatt, mtu: Int, status: Int) {
      negotiatedChunkSize = if (status == BluetoothGatt.GATT_SUCCESS) (mtu - 4).coerceAtLeast(DEFAULT_CHUNK_PAYLOAD_SIZE) else DEFAULT_CHUNK_PAYLOAD_SIZE
      val characteristic = clientCharacteristic ?: return failConnect("MTU negotiated before characteristic was ready")
      enableNotifications(gatt, characteristic)
    }

    private fun enableNotifications(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) return failConnect("BLUETOOTH_CONNECT not granted")
      if (!gatt.setCharacteristicNotification(characteristic, true)) {
        return failConnect("setCharacteristicNotification failed")
      }
      val cccd = characteristic.getDescriptor(CLIENT_CHARACTERISTIC_CONFIG_UUID)
      if (cccd == null) {
        return failConnect("peer characteristic has no client-config descriptor")
      }
      val wrote = writeDescriptorCompat(gatt, cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE)
      if (!wrote) failConnect("failed to write client-config descriptor")
      // Success is completed in onDescriptorWrite below, not here -- writing
      // is itself asynchronous.
    }

    override fun onDescriptorWrite(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
      if (descriptor.uuid != CLIENT_CHARACTERISTIC_CONFIG_UUID) return
      if (status != BluetoothGatt.GATT_SUCCESS) {
        failConnect("client-config descriptor write failed, status=$status")
        return
      }
      val continuation = gattConnectContinuation ?: return
      gattConnectContinuation = null
      continuation.resume(Unit)
    }

    // The 3-arg overload (with `value` delivered directly) only exists from
    // API 33 -- on minSdk 24..32 devices the platform calls the deprecated
    // 2-arg overload instead and never invokes this one at all. Both must be
    // overridden, or notifications silently stop working below API 33 (the
    // Galaxy A51's Android version is not guaranteed to be 33+, unlike a
    // newer flagship). The 2-arg one reads `characteristic.value`, the last
    // legal way to get the payload pre-33.
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      handleCharacteristicChanged(characteristic, value)
    }

    @Suppress("DEPRECATION")
    override fun onCharacteristicChanged(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return // handled by the 3-arg overload above
      handleCharacteristicChanged(characteristic, characteristic.value ?: return)
    }

    private fun handleCharacteristicChanged(characteristic: BluetoothGattCharacteristic, value: ByteArray) {
      if (characteristic.uuid != TRANSPORT_CHARACTERISTIC_UUID) return
      clientReassembler.accept(value)?.let { complete -> onData?.invoke(complete) }
    }

    override fun onCharacteristicWrite(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
      val continuation = pendingWriteContinuation ?: return
      pendingWriteContinuation = null
      if (status == BluetoothGatt.GATT_SUCCESS) {
        continuation.resume(Unit)
      } else {
        continuation.resumeWithException(BleConnectionException("characteristic write failed, status=$status"))
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun writeDescriptorCompat(gatt: BluetoothGatt, descriptor: BluetoothGattDescriptor, value: ByteArray): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeDescriptor(descriptor, value) == BluetoothStatusSuccess
    } else {
      descriptor.value = value
      gatt.writeDescriptor(descriptor)
    }
  }

  // gatt.writeDescriptor(descriptor, value) (API 33+) returns a plain Int
  // status code, not a Boolean -- BluetoothStatusSuccess (0) is what a
  // successful call returns, matching BluetoothStatusCodes.SUCCESS without
  // requiring the API-33-only constant class at compile time for minSdk 24.
  private val BluetoothStatusSuccess = 0

  // Only one in-flight characteristic write is ever awaited at a time --
  // sendAsCentral below writes chunks sequentially, awaiting each one's
  // onCharacteristicWrite before sending the next, so chunks are never lost
  // to missing flow control.
  private var pendingWriteContinuation: kotlin.coroutines.Continuation<Unit>? = null

  private suspend fun writeChunk(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, chunk: ByteArray) {
    suspendCancellableCoroutine<Unit> { continuation ->
      if (!hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
        continuation.resumeWithException(BleConnectionException("BLUETOOTH_CONNECT not granted"))
        return@suspendCancellableCoroutine
      }
      pendingWriteContinuation = continuation
      val started = writeCharacteristicCompat(gatt, characteristic, chunk)
      if (!started) {
        pendingWriteContinuation = null
        continuation.resumeWithException(BleConnectionException("writeCharacteristic failed to start"))
      }
    }
  }

  @Suppress("DEPRECATION")
  private fun writeCharacteristicCompat(gatt: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray): Boolean {
    return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
      gatt.writeCharacteristic(characteristic, value, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusSuccess
    } else {
      characteristic.value = value
      characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
      gatt.writeCharacteristic(characteristic)
    }
  }

  private suspend fun sendAsCentral(bytes: ByteArray) {
    val gatt = clientGatt ?: throw BleConnectionException("not connected")
    val characteristic = clientCharacteristic ?: throw BleConnectionException("transport characteristic not discovered")
    for (chunk in frameMessage(bytes, negotiatedChunkSize)) {
      writeChunk(gatt, characteristic, chunk)
    }
  }

  // ================================ Shared ================================

  /** Sends `bytes` over whichever role (peripheral or central) is currently
   * active. Throws if neither role has an active connection. */
  suspend fun send(bytes: ByteArray) {
    if (clientGatt != null) {
      sendAsCentral(bytes)
    } else if (connectedCentral != null) {
      sendAsPeripheral(bytes)
    } else {
      throw BleConnectionException("no active BLE connection to send over")
    }
  }

  fun disconnect() {
    if (hasPermission(Manifest.permission.BLUETOOTH_CONNECT)) {
      runCatching { clientGatt?.disconnect() }
      runCatching { clientGatt?.close() }
    }
    clientGatt = null
    clientCharacteristic = null
    negotiatedChunkSize = DEFAULT_CHUNK_PAYLOAD_SIZE
    stopAdvertising()
    onData = null
    onConnectionState = null
  }
}
