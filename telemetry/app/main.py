from __future__ import annotations

import json
import time
from pathlib import Path

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import ValidationError

from analysis.session_payload import build_payload, list_sessions

from .schemas import parse_ingest_message
from .templates import render_session_viewer, render_sessions_index

APP_DIR = Path(__file__).resolve().parent
DATA_DIR = APP_DIR.parent / "data"
DATA_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="TapPay Telemetry Harness")

dashboard_clients: set[WebSocket] = set()


def _session_file(session_id: str) -> Path:
    # session_id is attacker-controlled input from a phone on the LAN; keep it out of the path.
    safe_id = "".join(c for c in session_id if c.isalnum() or c in "-_") or "unknown"
    return DATA_DIR / f"{safe_id}.jsonl"


async def _broadcast_to_dashboards(payload: dict) -> None:
    dead: list[WebSocket] = []
    for client in dashboard_clients:
        try:
            await client.send_json(payload)
        except Exception:
            dead.append(client)
    for client in dead:
        dashboard_clients.discard(client)


@app.websocket("/ws/ingest")
async def ws_ingest(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        while True:
            raw = await websocket.receive_json()
            t_server_ns = time.time_ns()
            try:
                message = parse_ingest_message(raw)
            except (ValidationError, ValueError) as exc:
                await websocket.send_json({"error": str(exc)})
                continue

            record = message.model_dump()
            record["t_server_ns"] = t_server_ns

            with _session_file(message.session_id).open("a") as f:
                f.write(json.dumps(record) + "\n")

            await _broadcast_to_dashboards(record)
    except WebSocketDisconnect:
        pass


@app.websocket("/ws/dashboard")
async def ws_dashboard(websocket: WebSocket) -> None:
    await websocket.accept()
    dashboard_clients.add(websocket)
    try:
        while True:
            # Dashboard clients don't send anything meaningful; just block until closed.
            await websocket.receive_text()
    except WebSocketDisconnect:
        dashboard_clients.discard(websocket)


@app.get("/")
async def index() -> FileResponse:
    return FileResponse(APP_DIR / "static" / "index.html")


@app.get("/sessions")
async def sessions_index() -> HTMLResponse:
    return HTMLResponse(render_sessions_index(list_sessions(DATA_DIR)))


@app.get("/sessions/{session_id}")
async def session_viewer(session_id: str) -> HTMLResponse:
    path = _session_file(session_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"no session file for {session_id!r}")
    payload = build_payload(path)
    return HTMLResponse(render_session_viewer(payload))


app.mount("/static", StaticFiles(directory=APP_DIR / "static"), name="static")
