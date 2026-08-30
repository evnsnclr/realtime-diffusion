"""Idle-billing probe: does an idle-but-connected fal realtime session cost money?

The pricing page bills flux-2/klein/realtime per compute second of generation,
which implies an idle WebSocket costs ~$0 — but that is inferred, not
documented (docs/RESEARCH_AND_BUILD_PLAN.md follow-up research). This probe
settles it empirically: mint a token exactly the way the app server does,
open the realtime socket, send NOTHING for a fixed window, close, then check
the account's usage for that window.

Uses your FAL_KEY from ../../.env.local (or the environment). Sends no
frames, so the expected cost is $0; the probe never prints the key.
Run it yourself: it touches your fal account.
"""

from __future__ import annotations

import argparse
import asyncio
import datetime as dt
import json
import os
from pathlib import Path

FAL_TOKEN_ENDPOINT = "https://rest.fal.ai/tokens/realtime"
FAL_USAGE_ENDPOINT = "https://api.fal.ai/v1/models/usage"
FAL_APP = "fal-ai/flux-2/klein/realtime"
DEFAULT_IDLE_MINUTES = 10
USAGE_SETTLE_SECONDS = 90


def parse_env_file(text: str) -> dict[str, str]:
    """Parse dotenv lines without evaluating anything (mirrors run_demo.sh)."""
    values: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line or line.lstrip().startswith("#"):
            continue
        name, _, value = line.partition("=")
        name = name.strip()
        if name.isidentifier():
            values[name] = value
    return values


def token_request_payload(app: str = FAL_APP, duration_seconds: int = 900) -> dict:
    """Same shape as app.py's minting request, with a longer window."""
    return {"app": app, "allowed_apps": [app], "duration": duration_seconds}


def realtime_url(app: str, token: str, path: str = "/realtime") -> str:
    suffix = "" if app.endswith(path) else path
    return f"wss://fal.run/{app}{suffix}?fal_jwt_token={token}"


def usage_params(start: dt.datetime, end: dt.datetime) -> dict:
    if start.tzinfo is None or end.tzinfo is None:
        raise ValueError("usage_params needs timezone-aware datetimes")
    start_utc = start.astimezone(dt.timezone.utc)
    end_utc = end.astimezone(dt.timezone.utc)
    return {
        "start_time": start_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_time": end_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
    }


def load_fal_key() -> str:
    key = os.getenv("FAL_KEY", "").strip()
    if not key:
        env_path = Path(__file__).resolve().parents[2] / ".env.local"
        if env_path.exists():
            key = parse_env_file(env_path.read_text()).get("FAL_KEY", "").strip()
    if not key:
        raise SystemExit("No FAL_KEY in the environment or ../../.env.local")
    return key


async def hold_idle(url: str, minutes: float) -> dict:
    import websockets

    received: list[str] = []
    connected_at = dt.datetime.now(dt.timezone.utc)
    deadline = asyncio.get_running_loop().time() + minutes * 60
    dropped_early = None
    try:
        async with websockets.connect(url, max_size=2**22) as socket:
            print(f"Connected. Holding idle for {minutes:g} minutes — sending nothing.")
            while True:
                remaining = deadline - asyncio.get_running_loop().time()
                if remaining <= 0:
                    break
                try:
                    message = await asyncio.wait_for(socket.recv(), timeout=min(remaining, 30))
                    received.append(str(message)[:200])
                except asyncio.TimeoutError:
                    continue
                except websockets.exceptions.ConnectionClosed as error:
                    dropped_early = f"{type(error).__name__}: code={error.code}"
                    break
    except Exception as error:
        # Exception text is deliberately type-only: InvalidURI (and friends)
        # embed the full connect URL, which carries the JWT.
        dropped_early = f"{type(error).__name__} during connect/handshake"
    return {
        "connected_at": connected_at,
        "disconnected_at": dt.datetime.now(dt.timezone.utc),
        "server_messages": received,
        "dropped_early": dropped_early,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--minutes", type=float, default=DEFAULT_IDLE_MINUTES)
    args = parser.parse_args()

    import httpx

    key = load_fal_key()
    auth = {"Authorization": f"Key {key}"}

    window_start = dt.datetime.now(dt.timezone.utc)
    print(f"Window start (UTC): {window_start:%Y-%m-%d %H:%M:%S}")

    print("Minting a realtime token the same way app.py does ...")
    minted = httpx.post(
        FAL_TOKEN_ENDPOINT,
        headers={**auth, "Content-Type": "application/json"},
        json=token_request_payload(duration_seconds=int(args.minutes * 60) + 300),
        timeout=15,
    )
    if not minted.is_success:
        print(f"Token mint failed ({minted.status_code}): {minted.text[:300]}")
        return 1
    payload = minted.json()
    token = payload if isinstance(payload, str) else payload.get("token", "")
    if not token:
        print("Token endpoint returned no token.")
        return 1

    session = asyncio.run(hold_idle(realtime_url(FAL_APP, token), args.minutes))
    window_end = dt.datetime.now(dt.timezone.utc)
    held = (session["disconnected_at"] - session["connected_at"]).total_seconds()
    print(f"Held the socket for {held:.0f}s.")
    if session["dropped_early"]:
        print(f"Connection ended early: {session['dropped_early']}")
        print("An early drop at token expiry is itself a finding — note the time above.")
    if session["server_messages"]:
        print(f"Server sent {len(session['server_messages'])} message(s) while idle; first:")
        print(f"  {session['server_messages'][0]}")

    print(f"\nWaiting {USAGE_SETTLE_SECONDS}s for usage accounting to settle ...")
    import time as time_module
    time_module.sleep(USAGE_SETTLE_SECONDS)

    usage = httpx.get(
        FAL_USAGE_ENDPOINT,
        headers=auth,
        params=usage_params(window_start, dt.datetime.now(dt.timezone.utc)),
        timeout=15,
    )
    print(f"\nWindow end (UTC): {window_end:%Y-%m-%d %H:%M:%S}")
    if usage.is_success:
        print("Usage API response for the probe window:")
        try:
            print(json.dumps(usage.json(), indent=2)[:2000])
        except ValueError:
            print(usage.text[:2000])
        print(
            "\nVerdict: if cost_total for this window is 0 (or absent), an idle"
            " connection is free and the app's cost story holds."
        )
    else:
        print(f"Usage API returned {usage.status_code} — your key is likely not admin-scoped.")
        print("Check the dashboard instead: https://fal.ai/dashboard/usage")
        print(
            f"Look at the window {window_start:%H:%M}–{window_end:%H:%M} UTC: zero"
            f" billed compute seconds there means idle connections are free."
        )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
