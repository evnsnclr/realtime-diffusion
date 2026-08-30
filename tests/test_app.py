import importlib
import os
from pathlib import Path

from fastapi.testclient import TestClient


os.environ["SURFACESHIFT_BACKEND"] = "preview"
app_module = importlib.import_module("app")
client = TestClient(app_module.app)


def test_health_reports_preview_mode(monkeypatch):
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("SURFACESHIFT_ACCESS_CODE", raising=False)
    monkeypatch.delenv("CLAY_SCREEN_ACCESS_CODE", raising=False)
    response = client.get("/api/health")
    assert response.status_code == 200
    payload = response.json()
    assert payload["ok"] is True
    assert payload["default_runtime"] == "preview"
    assert payload["runtimes"]["cloud"]["available"] is False
    assert payload["runtimes"]["local"]["available"] is False
    assert payload["runtimes"]["preview"]["available"] is True
    assert response.headers["cache-control"] == "no-store"


def test_home_and_static_files_are_served():
    assert client.get("/").status_code == 200
    assert client.get("/static/app.js").status_code == 200
    assert client.get("/static/flux-config.js").status_code == 200
    assert client.get("/static/overlay.js").status_code == 200
    assert client.get("/static/overlay-timer-worker.js").status_code == 200
    assert client.get("/static/styles.css").status_code == 200


def test_session_configuration_is_validated():
    good = client.post(
        "/api/session",
        json={
            "session_id": "4f5dbad8-20d9-4ae9-90dd-73f35e614e32",
            "prompt": "handmade clay",
            "strength": 0.75,
        },
    )
    assert good.status_code == 200

    bad = client.post(
        "/api/session",
        json={"session_id": "../bad", "prompt": "x", "strength": 2.0},
    )
    assert bad.status_code == 422


def test_preview_refuses_uploaded_frames():
    response = client.post("/api/frame", content=b"not-an-image")
    assert response.status_code == 409


def test_preview_refuses_transform_requests():
    response = client.post("/api/transform", content=b"not-an-image")
    assert response.status_code == 409


def test_fal_token_endpoint_fails_closed_without_secrets(monkeypatch):
    monkeypatch.delenv("FAL_KEY", raising=False)
    monkeypatch.delenv("SURFACESHIFT_ACCESS_CODE", raising=False)
    monkeypatch.delenv("CLAY_SCREEN_ACCESS_CODE", raising=False)
    response = client.post(
        "/api/fal/realtime-token",
        json={
            "app": "fal-ai/flux-2/klein/realtime",
            "accessCode": "demo-code",
        },
    )
    assert response.status_code == 503
    assert "FAL_KEY" not in response.text
    assert response.headers["cache-control"] == "no-store"


def test_fal_token_endpoint_disables_caching_for_method_and_validation_errors():
    wrong_method = client.get("/api/fal/realtime-token")
    malformed = client.post("/api/fal/realtime-token", json={"app": "x"})

    assert wrong_method.status_code == 405
    assert malformed.status_code == 422
    assert wrong_method.headers["cache-control"] == "no-store"
    assert malformed.headers["cache-control"] == "no-store"


def test_fal_token_endpoint_scopes_the_upstream_request(monkeypatch):
    calls = []

    class FakeResponse:
        is_success = True
        status_code = 200

        @staticmethod
        def json():
            return {"token": "short-lived-token"}

    class FakeClient:
        def __init__(self, **kwargs):
            calls.append({"client": kwargs})

        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, url, **kwargs):
            calls.append({"url": url, **kwargs})
            return FakeResponse()

    monkeypatch.setenv("FAL_KEY", "server-only-key")
    monkeypatch.setenv("SURFACESHIFT_ACCESS_CODE", "demo-code")
    monkeypatch.setattr(app_module.httpx, "AsyncClient", FakeClient)

    response = client.post(
        "/api/fal/realtime-token",
        json={
            "app": "fal-ai/flux-2/klein/realtime",
            "accessCode": "demo-code",
        },
    )

    assert response.status_code == 200
    assert response.json() == {"token": "short-lived-token", "expiresIn": 120}
    assert response.headers["cache-control"] == "no-store"
    upstream = calls[-1]
    assert upstream["url"] == "https://rest.fal.ai/tokens/realtime"
    assert upstream["headers"]["Authorization"] == "Key server-only-key"
    assert upstream["json"] == {
        "app": "fal-ai/flux-2/klein/realtime",
        "allowed_apps": ["fal-ai/flux-2/klein/realtime"],
        "duration": 120,
    }
    assert "server-only-key" not in response.text


def test_fal_token_endpoint_accepts_raw_string_response(monkeypatch):
    class FakeResponse:
        is_success = True
        status_code = 201

        @staticmethod
        def json():
            return "short-lived-string-token"

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setenv("FAL_KEY", "server-only-key")
    monkeypatch.setenv("SURFACESHIFT_ACCESS_CODE", "demo-code")
    monkeypatch.setattr(app_module.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    response = client.post(
        "/api/fal/realtime-token",
        json={
            "app": "fal-ai/flux-2/klein/realtime",
            "accessCode": "demo-code",
        },
    )

    assert response.status_code == 200
    assert response.json() == {
        "token": "short-lived-string-token",
        "expiresIn": 120,
    }
    assert response.headers["cache-control"] == "no-store"


def test_fal_token_endpoint_rejects_wrong_code_and_model(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "server-only-key")
    monkeypatch.setenv("SURFACESHIFT_ACCESS_CODE", "demo-code")

    wrong_code = client.post(
        "/api/fal/realtime-token",
        json={"app": "fal-ai/flux-2/klein/realtime", "accessCode": "wrong"},
    )
    wrong_model = client.post(
        "/api/fal/realtime-token",
        json={"app": "fal-ai/other/realtime", "accessCode": "demo-code"},
    )

    assert wrong_code.status_code == 401
    assert wrong_model.status_code == 403


def test_ui_contract_is_present():
    root = Path(__file__).resolve().parents[1]
    html = (root / "index.html").read_text(encoding="utf-8")
    javascript = (root / "static" / "app.js").read_text(encoding="utf-8")
    overlay_js = (root / "static" / "overlay.js").read_text(encoding="utf-8")

    for expected in (
        'data-source="screen"',
        'data-source="camera"',
        'data-source="video"',
        'data-source="demo"',
        'data-style="clay"',
        'id="recordButton"',
        'id="recordingMode"',
        '<option value="output">Create · clean output</option>',
        '<option value="live" selected>Compare · live source + output</option>',
        '<option value="audit">Lab · exact native pairs</option>',
        'id="sessionBudget"',
        'value="45000" selected',
        'id="showcaseButton"',
        'id="floatButton"',
        'id="liveSourceCanvas"',
        'id="matchedSourceCanvas"',
        'id="matchedOutputCanvas"',
        "sends sampled frames to fal.ai",
        'id="accessCode"',
    ):
        assert expected in html

    assert "getDisplayMedia" in javascript
    assert "CaptureController" in javascript
    assert "CloudFramePump" in javascript
    assert "createOverlayController" in javascript
    assert "resilientTimers.setInterval" in javascript
    assert "documentPictureInPicture" in overlay_js
    assert "SourceMotionTracker" in javascript
    assert "motionCompensatedFrames" in javascript
    assert "MODEL + WARP" in javascript
    assert "MediaRecorder" in javascript
    assert 'drawSourceToLiveRecording()' in javascript
    assert 'drawCompareCard(liveSource' in javascript
    assert 'drawCompareCard(\n    outputCanvas' in javascript
    assert 'drawCompareCard(matchedOutputCanvas' in javascript
    assert "fal-ai/flux-2/klein/realtime" not in html
    assert "FAL_MODEL" in javascript
    assert "CLAY_SCREEN" not in javascript
    assert "FAL_KEY" not in javascript


def test_fal_token_endpoint_explains_account_rejection_without_leaking_secrets(monkeypatch):
    class FakeResponse:
        is_success = False
        status_code = 403

        @staticmethod
        def json():
            return {"detail": "billing detail"}

    class FakeClient:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *_args):
            return None

        async def post(self, *_args, **_kwargs):
            return FakeResponse()

    monkeypatch.setenv("FAL_KEY", "server-only-key")
    monkeypatch.setenv("SURFACESHIFT_ACCESS_CODE", "demo-code")
    monkeypatch.setattr(app_module.httpx, "AsyncClient", lambda **_kwargs: FakeClient())

    response = client.post(
        "/api/fal/realtime-token",
        json={
            "app": "fal-ai/flux-2/klein/realtime",
            "accessCode": "demo-code",
        },
    )

    assert response.status_code == 502
    assert response.json() == {
        "error": "FAL rejected the token request. Check the key and account balance."
    }
    assert "server-only-key" not in response.text


def test_legacy_clay_screen_env_names_still_work(monkeypatch):
    monkeypatch.setenv("FAL_KEY", "server-only-key")
    monkeypatch.delenv("SURFACESHIFT_ACCESS_CODE", raising=False)
    monkeypatch.setenv("CLAY_SCREEN_ACCESS_CODE", "legacy-code")

    health = client.get("/api/health")
    assert health.json()["runtimes"]["cloud"]["available"] is True

    wrong = client.post(
        "/api/fal/realtime-token",
        json={"app": "fal-ai/flux-2/klein/realtime", "accessCode": "wrong"},
    )
    assert wrong.status_code == 401


def test_new_env_name_wins_over_legacy(monkeypatch):
    monkeypatch.setenv("SURFACESHIFT_ACCESS_CODE", "new-code")
    monkeypatch.setenv("CLAY_SCREEN_ACCESS_CODE", "legacy-code")
    assert app_module.env_setting("ACCESS_CODE") == "new-code"
