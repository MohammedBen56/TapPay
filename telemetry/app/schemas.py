from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field

Vec3 = tuple[float, float, float]


class SensorSample(BaseModel):
    t_device_ns: int
    accel: Vec3
    gyro: Vec3
    mag: Vec3


class BumpTag(BaseModel):
    grip: str | None = None
    orientation: str | None = None
    contact_point: str | None = None


class SensorBatchMessage(BaseModel):
    type: Literal["sensor_batch"] = "sensor_batch"
    session_id: str
    device_role: Literal["A", "B"]
    device_id: str
    tag: BumpTag = Field(default_factory=BumpTag)
    samples: list[SensorSample]


class RssiSampleMessage(BaseModel):
    type: Literal["rssi_sample"] = "rssi_sample"
    session_id: str
    device_role: Literal["A", "B"]
    device_id: str
    t_device_ns: int
    dbm: int
    peer_addr: str | None = None


class BumpMarkerMessage(BaseModel):
    type: Literal["bump_marker"] = "bump_marker"
    session_id: str
    device_role: Literal["A", "B"]
    device_id: str
    t_device_ns: int
    tag: BumpTag = Field(default_factory=BumpTag)


IngestMessage = SensorBatchMessage | RssiSampleMessage | BumpMarkerMessage

_MESSAGE_TYPES: dict[str, type[BaseModel]] = {
    "sensor_batch": SensorBatchMessage,
    "rssi_sample": RssiSampleMessage,
    "bump_marker": BumpMarkerMessage,
}


def parse_ingest_message(raw: dict) -> IngestMessage:
    msg_type = raw.get("type")
    model = _MESSAGE_TYPES.get(msg_type)
    if model is None:
        raise ValueError(f"unknown message type: {msg_type!r}")
    return model.model_validate(raw)
