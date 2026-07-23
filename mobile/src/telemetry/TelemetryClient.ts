import type { SensorSample } from '../native/TapPayNative';

export type DeviceRole = 'A' | 'B';

export interface BumpTag {
  grip?: string;
  orientation?: string;
  contactPoint?: string;
}

export interface TelemetryClientOptions {
  url: string;
  sessionId: string;
  deviceRole: DeviceRole;
  deviceId: string;
}

const RECONNECT_DELAY_MS = 1500;

function toWireTag(tag: BumpTag) {
  return { grip: tag.grip ?? null, orientation: tag.orientation ?? null, contact_point: tag.contactPoint ?? null };
}

/**
 * Thin WebSocket client to the telemetry harness's /ws/ingest endpoint. Queues
 * outgoing messages while disconnected and flushes on reconnect -- a dropped
 * connection during a bump session shouldn't silently lose samples.
 */
export class TelemetryClient {
  private ws: WebSocket | null = null;
  private queue: string[] = [];
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(private readonly options: TelemetryClientOptions) {
    this.connect();
  }

  private connect(): void {
    if (this.closed) return;
    const ws = new WebSocket(this.options.url);
    this.ws = ws;
    ws.onopen = () => this.flushQueue();
    ws.onclose = () => this.scheduleReconnect();
    ws.onerror = () => ws.close();
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_DELAY_MS);
  }

  private send(payload: Record<string, unknown>): void {
    const message = JSON.stringify(payload);
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    } else {
      this.queue.push(message);
    }
  }

  private flushQueue(): void {
    while (this.queue.length > 0 && this.ws?.readyState === WebSocket.OPEN) {
      const next = this.queue.shift();
      if (next) this.ws.send(next);
    }
  }

  sendSensorBatch(samples: SensorSample[], tag: BumpTag = {}): void {
    this.send({
      type: 'sensor_batch',
      session_id: this.options.sessionId,
      device_role: this.options.deviceRole,
      device_id: this.options.deviceId,
      tag: toWireTag(tag),
      samples,
    });
  }

  sendRssiSample(sample: { t_device_ns: number; dbm: number; peerAddr: string | null }): void {
    this.send({
      type: 'rssi_sample',
      session_id: this.options.sessionId,
      device_role: this.options.deviceRole,
      device_id: this.options.deviceId,
      t_device_ns: sample.t_device_ns,
      dbm: sample.dbm,
      peer_addr: sample.peerAddr,
    });
  }

  /**
   * A coarse hint for slicing the session offline -- NOT the alignment mechanism.
   * See telemetry/analysis/compute_correlation.py: alignment is anchored on the
   * accel-magnitude peak, not on this human-timed tap or on device clocks.
   */
  sendBumpMarker(tag: BumpTag = {}): void {
    this.send({
      type: 'bump_marker',
      session_id: this.options.sessionId,
      device_role: this.options.deviceRole,
      device_id: this.options.deviceId,
      t_device_ns: Date.now() * 1_000_000,
      tag: toWireTag(tag),
    });
  }

  close(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
  }
}
