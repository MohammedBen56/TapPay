FROM python:3.12-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY app ./app
COPY analysis ./analysis

# Runs as a non-root user -- root-in-container is a real escalation surface
# if the container's ever escaped (Trivy's DS-0002), and this harness has no
# reason to need root: it only reads/writes the mounted telemetry/data/ jsonl
# files and serves the FastAPI app. UID 1000, not some higher fixed value:
# docker-compose.yml bind-mounts telemetry/data (and app/analysis) straight
# from the host, so the in-container user needs to match the host dev user's
# UID to have write access to the host-owned directory -- 1000 is both the
# conventional first-user UID on a single-dev-machine Linux/WSL2 box (this
# project's actual setup, CLAUDE.md §7) and free in python:3.12-slim.
RUN useradd --create-home --uid 1000 telemetry && chown -R telemetry:telemetry /app
USER telemetry

EXPOSE 8080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--reload"]
