package expo.modules.tappay.sensors

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.SystemClock

private const val SAMPLE_PERIOD_US = 10_000 // requested 100 Hz; Android delivery is best-effort
private const val BATCH_SIZE = 10

/**
 * Streams accel/gyro/mag at a requested 100 Hz. Batches are ticked off the
 * accelerometer callback (the axis the qualification gate and R_AB care about
 * most); gyro/mag values attached are each sensor's most recent reading, not
 * necessarily sampled at the exact same instant -- SensorManager doesn't
 * guarantee cross-sensor sync. That's an accepted M0 limitation; the offline
 * correlation analysis (telemetry/analysis/compute_correlation.py) is designed
 * around per-device, not cross-sensor, timing anyway.
 */
class SensorStreamer(context: Context) {
  private val sensorManager = context.getSystemService(Context.SENSOR_SERVICE) as SensorManager
  private var listener: SensorEventListener? = null

  private var latestAccel = doubleArrayOf(0.0, 0.0, 0.0)
  private var latestGyro = doubleArrayOf(0.0, 0.0, 0.0)
  private var latestMag = doubleArrayOf(0.0, 0.0, 0.0)
  private val batch = mutableListOf<Map<String, Any?>>()

  fun start(onBatch: (List<Map<String, Any?>>) -> Unit) {
    stop()

    val accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    val gyro = sensorManager.getDefaultSensor(Sensor.TYPE_GYROSCOPE)
    val mag = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD)

    val newListener = object : SensorEventListener {
      override fun onSensorChanged(event: SensorEvent) {
        when (event.sensor.type) {
          Sensor.TYPE_ACCELEROMETER -> {
            latestAccel = doubleArrayOf(event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
            batch.add(
              mapOf(
                "t_device_ns" to SystemClock.elapsedRealtimeNanos(),
                "accel" to latestAccel.toList(),
                "gyro" to latestGyro.toList(),
                "mag" to latestMag.toList()
              )
            )
            if (batch.size >= BATCH_SIZE) {
              onBatch(batch.toList())
              batch.clear()
            }
          }
          Sensor.TYPE_GYROSCOPE ->
            latestGyro = doubleArrayOf(event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
          Sensor.TYPE_MAGNETIC_FIELD ->
            latestMag = doubleArrayOf(event.values[0].toDouble(), event.values[1].toDouble(), event.values[2].toDouble())
        }
      }

      override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) {}
    }

    listener = newListener
    accel?.let { sensorManager.registerListener(newListener, it, SAMPLE_PERIOD_US) }
    gyro?.let { sensorManager.registerListener(newListener, it, SAMPLE_PERIOD_US) }
    mag?.let { sensorManager.registerListener(newListener, it, SAMPLE_PERIOD_US) }
  }

  fun stop() {
    listener?.let { sensorManager.unregisterListener(it) }
    listener = null
    batch.clear()
  }
}
