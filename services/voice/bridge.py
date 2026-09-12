from __future__ import annotations

import asyncio
import json
import os
import urllib.error
import urllib.request
from collections.abc import AsyncIterator


class ProviderError(Exception):
    def __init__(self, message="", code="GATEWAY_UNREACHABLE"):
        super().__init__(message)
        self.code = code


def _text(payload):
    if isinstance(payload, str):
        return payload
    if isinstance(payload, dict):
        for key in ("delta", "text", "content"):
            value = payload.get(key)
            if isinstance(value, str) and value:
                return value
    return ""


class GatewayBridge:
    def __init__(self, base_url=None, session_id="voice-1"):
        self.base_url = base_url or os.environ.get("JARVIS_GATEWAY", "http://127.0.0.1:8787")
        self.session_id = session_id

    async def run_turn(self, text: str, traceId: str) -> AsyncIterator[str]:
        body = json.dumps({"id": traceId, "sessionId": self.session_id, "source": "voice", "content": text}).encode()

        def _post():
            req = urllib.request.Request(
                self.base_url.rstrip("/") + "/v1/input",
                data=body,
                headers={"content-type": "application/json"},
                method="POST",
            )
            try:
                with urllib.request.urlopen(req, timeout=120) as res:
                    return res.read().decode("utf-8", "replace")
            except urllib.error.URLError as exc:
                raise ProviderError(str(exc), code="GATEWAY_UNREACHABLE")
            except (OSError, TimeoutError) as exc:
                raise ProviderError(str(exc), code="GATEWAY_UNREACHABLE")

        try:
            raw = await asyncio.to_thread(_post)
        except ProviderError:
            raise
        except Exception as exc:
            raise ProviderError(str(exc), code="GATEWAY_UNREACHABLE")
        seen = False
        for line in raw.splitlines():
            line = line.strip()
            if not line.startswith("data:"):
                continue
            try:
                event = json.loads(line[5:].strip())
            except ValueError:
                continue
            kind = event.get("type", "") if isinstance(event, dict) else ""
            if kind == "agent.delta":
                piece = _text(event.get("payload"))
                if piece:
                    seen = True
                    yield piece
            elif kind == "agent.completed" and not seen:
                piece = _text(event.get("payload"))
                if piece:
                    seen = True
                    yield piece
