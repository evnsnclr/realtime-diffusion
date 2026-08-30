import datetime as dt
import importlib.util
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def _load(name: str, relative: str):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    sys.modules[name] = module
    spec.loader.exec_module(module)
    return module


coreml_probe = _load("coreml_probe", "benchmarks/coreml-probe/probe.py")
idle_probe = _load("idle_probe", "benchmarks/idle-billing-probe/probe.py")


def test_parse_input_schema_reads_real_metadata_shape():
    metadata = [{
        "inputSchema": [
            {"name": "sample", "dataType": "Float16", "shape": "[2, 4, 64, 64]"},
            {"name": "timestep", "dataType": "Float16", "shape": "[2]"},
        ]
    }]
    parsed = coreml_probe.parse_input_schema(metadata)
    assert parsed == [
        {"name": "sample", "dtype": "float16", "shape": [2, 4, 64, 64]},
        {"name": "timestep", "dtype": "float16", "shape": [2]},
    ]


def test_parse_input_schema_rejects_bad_metadata():
    import pytest

    with pytest.raises(ValueError):
        coreml_probe.parse_input_schema([{}])
    with pytest.raises(ValueError):
        coreml_probe.parse_input_schema(
            [{"inputSchema": [{"name": "x", "dataType": "Float64", "shape": "[1]"}]}]
        )
    with pytest.raises(ValueError):
        coreml_probe.parse_input_schema(
            [{"inputSchema": [{"name": "x", "dataType": "Float16", "shape": "[0]"}]}]
        )


def test_verdict_threshold_boundaries():
    go = coreml_probe.verdict(110.0)
    assert go["go"] is True and "GO" in go["message"]
    assert abs(go["projected_fps"] - 1000.0 / 110.0) < 1e-6

    no_go = coreml_probe.verdict(180.0)
    assert no_go["go"] is False and "NO-GO" in no_go["message"]

    assert coreml_probe.verdict(125.0)["go"] is True


def test_idle_probe_env_parser_never_evaluates():
    text = "# comment\nFAL_KEY=abc$(touch PWNED)def\nBAD LINE\n1BAD=x\nOK_NAME=v=w\n"
    values = idle_probe.parse_env_file(text)
    assert values["FAL_KEY"] == "abc$(touch PWNED)def"
    assert values["OK_NAME"] == "v=w"
    assert "1BAD" not in values


def test_idle_probe_request_builders():
    payload = idle_probe.token_request_payload(duration_seconds=900)
    assert payload["app"] == payload["allowed_apps"][0] == idle_probe.FAL_APP
    assert payload["duration"] == 900

    url = idle_probe.realtime_url("fal-ai/flux-2/klein/realtime", "tok123")
    assert url == "wss://fal.run/fal-ai/flux-2/klein/realtime?fal_jwt_token=tok123"
    plain = idle_probe.realtime_url("fal-ai/fast-lcm-diffusion", "tok123")
    assert plain == "wss://fal.run/fal-ai/fast-lcm-diffusion/realtime?fal_jwt_token=tok123"

    utc = dt.timezone.utc
    params = idle_probe.usage_params(
        dt.datetime(2026, 8, 30, 12, 0, 0, tzinfo=utc),
        dt.datetime(2026, 8, 30, 14, 10, 0, tzinfo=dt.timezone(dt.timedelta(hours=2))),
    )
    assert params == {
        "start_time": "2026-08-30T12:00:00Z",
        "end_time": "2026-08-30T12:10:00Z",
    }

    import pytest

    with pytest.raises(ValueError):
        idle_probe.usage_params(dt.datetime(2026, 8, 30), dt.datetime(2026, 8, 30, tzinfo=utc))
