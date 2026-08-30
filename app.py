"""SurfaceShift: live FLUX.2 restyling with an optional Apple Silicon fallback."""

from __future__ import annotations

import json
import os
from pathlib import Path
import re
import secrets
import tempfile

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field


BASE_DIR = Path(__file__).resolve().parent
STATIC_DIR = BASE_DIR / "static"


def env_setting(name: str, default: str = "") -> str:
    """Read a SURFACESHIFT_* setting, honoring the legacy CLAY_SCREEN_* name.

    The legacy names keep existing .env.local files working for one release.
    """
    value = os.getenv(f"SURFACESHIFT_{name}")
    if value is None:
        value = os.getenv(f"CLAY_SCREEN_{name}")
    return default if value is None else value


BACKEND = env_setting("BACKEND", "preview").strip().lower()
MAC_ENABLED = BACKEND in {"mac", "mps"}
MAX_FRAME_BYTES = 2_500_000
SESSION_ID_PATTERN = re.compile(r"^[0-9a-f-]{36}$")
RUNTIME_DIR = Path(tempfile.gettempdir()) / "surfaceshift"
RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
FAL_REALTIME_APP = "fal-ai/flux-2/klein/realtime"
FAL_TOKEN_ENDPOINT = "https://rest.fal.ai/tokens/realtime"
FAL_TOKEN_SECONDS = 120


class SessionConfig(BaseModel):
    session_id: str = Field(min_length=36, max_length=36)
    prompt: str = Field(min_length=1, max_length=600)
    strength: float = Field(ge=0.55, le=1.0)


class FalTokenRequest(BaseModel):
    app: str = Field(min_length=1, max_length=100)
    accessCode: str = Field(min_length=1, max_length=300)


def _validated_session_id(value: str) -> str:
    normalized = (value or "").strip().lower()
    if not SESSION_ID_PATTERN.fullmatch(normalized):
        raise ValueError("Invalid session id")
    return normalized


def _config_path(session_id: str) -> Path:
    return RUNTIME_DIR / f"{_validated_session_id(session_id)}.json"


def _write_atomic(path: Path, text: str) -> None:
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(text, encoding="utf-8")
    os.replace(temporary, path)


def _read_config(session_id: str) -> SessionConfig:
    data = json.loads(_config_path(session_id).read_text(encoding="utf-8"))
    return SessionConfig(**data)


def _cloud_available() -> bool:
    return bool(
        os.getenv("FAL_KEY", "").strip()
        and env_setting("ACCESS_CODE").strip()
    )


app = FastAPI(title="SurfaceShift", docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.middleware("http")
async def disable_sensitive_response_caching(request: Request, call_next):
    response = await call_next(request)
    if request.url.path in {"/api/health", "/api/fal/realtime-token"}:
        response.headers["Cache-Control"] = "no-store"
    return response


if MAC_ENABLED:
    from mac_runtime import MacDiffusionEngine

    ENGINE = MacDiffusionEngine()
else:
    ENGINE = None


@app.get("/")
async def home():
    return FileResponse(BASE_DIR / "index.html")


@app.get("/api/health")
async def health():
    cloud_available = _cloud_available()
    local_available = ENGINE is not None
    local_status = ENGINE.status() if ENGINE is not None else {}
    if cloud_available:
        default_runtime = "cloud"
    elif local_available:
        default_runtime = "local"
    else:
        default_runtime = "preview"

    payload = {
        "ok": True,
        "default_runtime": default_runtime,
        "runtimes": {
            "cloud": {
                "available": cloud_available,
                "model": FAL_REALTIME_APP,
                "token_endpoint": "api/fal/realtime-token",
                "access_code_required": True,
            },
            "local": {
                "available": local_available,
                "backend": "streamdiffusion-mac" if local_available else None,
                **local_status,
            },
            "preview": {"available": True},
        },
    }
    return JSONResponse(payload, headers={"Cache-Control": "no-store"})


@app.post("/api/fal/realtime-token")
async def fal_realtime_token(token_request: FalTokenRequest):
    fal_key = os.getenv("FAL_KEY", "").strip()
    expected_code = env_setting("ACCESS_CODE")

    if not fal_key or not expected_code:
        return JSONResponse(
            {"error": "Cloud inference is not configured"},
            status_code=503,
            headers={"Cache-Control": "no-store"},
        )
    if token_request.app != FAL_REALTIME_APP:
        return JSONResponse(
            {"error": "Model is not allowed"},
            status_code=403,
            headers={"Cache-Control": "no-store"},
        )
    if not secrets.compare_digest(
        token_request.accessCode.encode("utf-8"),
        expected_code.encode("utf-8"),
    ):
        return JSONResponse(
            {"error": "Access denied"},
            status_code=401,
            headers={"Cache-Control": "no-store"},
        )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            upstream = await client.post(
                FAL_TOKEN_ENDPOINT,
                headers={
                    "Authorization": f"Key {fal_key}",
                    "Content-Type": "application/json",
                },
                json={
                    "app": FAL_REALTIME_APP,
                    "allowed_apps": [FAL_REALTIME_APP],
                    "duration": FAL_TOKEN_SECONDS,
                },
            )
    except httpx.HTTPError as error:
        return JSONResponse(
            {"error": "Could not create a realtime token"},
            status_code=502,
            headers={"Cache-Control": "no-store"},
        )

    try:
        payload = upstream.json()
    except ValueError as error:
        return JSONResponse(
            {"error": "Could not create a realtime token"},
            status_code=502,
            headers={"Cache-Control": "no-store"},
        )

    if upstream.status_code in {401, 403}:
        return JSONResponse(
            {"error": "FAL rejected the token request. Check the key and account balance."},
            status_code=502,
            headers={"Cache-Control": "no-store"},
        )

    token = None
    if isinstance(payload, str) and payload:
        token = payload
    elif isinstance(payload, dict) and isinstance(payload.get("token"), str):
        token = payload["token"]

    if not upstream.is_success or not token:
        return JSONResponse(
            {"error": "Could not create a realtime token"},
            status_code=502,
            headers={"Cache-Control": "no-store"},
        )

    return JSONResponse(
        {"token": token, "expiresIn": FAL_TOKEN_SECONDS},
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/session")
async def configure_session(config: SessionConfig):
    try:
        config.session_id = _validated_session_id(config.session_id)
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    _write_atomic(_config_path(config.session_id), config.model_dump_json())
    return {"ok": True, "session_id": config.session_id}


@app.post("/api/transform")
async def transform_frame(request: Request):
    if ENGINE is None:
        raise HTTPException(
            status_code=409,
            detail="The server is running browser preview mode. Start it with run_mac.sh.",
        )

    session_id = request.headers.get("x-session-id", "").strip().lower()
    try:
        config = _read_config(session_id)
    except (ValueError, FileNotFoundError, json.JSONDecodeError):
        raise HTTPException(status_code=409, detail="Session is missing or invalid")

    payload = await request.body()
    if not payload or len(payload) > MAX_FRAME_BYTES:
        raise HTTPException(status_code=413, detail="Invalid frame payload")

    try:
        jpeg, inference_ms = await run_in_threadpool(
            ENGINE.transform,
            payload,
            config.prompt,
            config.strength,
        )
    except RuntimeError as error:
        raise HTTPException(status_code=503, detail=str(error)) from error
    except ValueError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error

    return Response(
        jpeg,
        media_type="image/jpeg",
        headers={
            "Cache-Control": "no-store",
            "X-Inference-Ms": str(round(inference_ms)),
            "X-Backend": "mps",
        },
    )


@app.post("/api/frame")
async def legacy_frame_endpoint():
    raise HTTPException(
        status_code=409,
        detail="SurfaceShift now uses the local Mac transform endpoint",
    )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "7860"))
    uvicorn.run(app, host="127.0.0.1", port=port)
