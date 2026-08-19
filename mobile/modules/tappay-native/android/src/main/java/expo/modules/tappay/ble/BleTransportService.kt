package expo.modules.tappay.ble

import android.app.Service
import android.content.Intent
import android.os.IBinder

/**
 * Minimal scaffold for the connection-holding foreground service Android 14+
 * requires for a `connectedDevice`-type foreground service (CLAUDE.md's
 * long-standing named gap, §5's "Invariants for code that does not exist
 * yet"). NOT started by anything yet: [BleGattTransport] never calls
 * `startForegroundService`, and this class never calls `startForeground()`
 * or creates a notification channel -- it exists only so the manifest's
 * `<service android:foregroundServiceType="connectedDevice">` declaration
 * (required for that attribute to be valid at all) has a real class to
 * reference. Wiring an actual running foreground service -- notification
 * content, a channel, start/stop tied to `BleGattTransport`'s
 * connect/disconnect lifecycle -- is Milestone 2's job, once BLE is wired
 * into a real payment flow that can hold a connection long enough to need
 * one. Compiles and is declared; functionally inert until then.
 */
class BleTransportService : Service() {
  override fun onBind(intent: Intent?): IBinder? = null
}
