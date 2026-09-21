"""One shared HTTP client with retries and a per-host rate limit.

The free endpoints this project leans on (DexScreener, GeckoTerminal) publish
modest per-minute limits and answer 429 rather than queueing. A token bucket per
host keeps a sweep across four chains from tripping them.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import defaultdict
from typing import Any

import httpx
from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential_jitter,
)

log = logging.getLogger(__name__)

# Requests per minute we allow ourselves per host. Deliberately below each
# provider's published ceiling.
HOST_LIMITS: dict[str, int] = {
    "api.dexscreener.com": 250,
    "api.geckoterminal.com": 25,
    "public-api.dextools.io": 50,
}
DEFAULT_LIMIT = 60


class _RateLimiter:
    """Minimum-interval limiter, one lock per host."""

    def __init__(self) -> None:
        self._last: dict[str, float] = defaultdict(float)
        self._locks: dict[str, threading.Lock] = defaultdict(threading.Lock)

    def wait(self, host: str) -> None:
        interval = 60.0 / HOST_LIMITS.get(host, DEFAULT_LIMIT)
        with self._locks[host]:
            elapsed = time.monotonic() - self._last[host]
            if elapsed < interval:
                time.sleep(interval - elapsed)
            self._last[host] = time.monotonic()


_limiter = _RateLimiter()


class TransientHTTPError(RuntimeError):
    """A failure worth retrying: 429, 5xx, or a dropped connection."""


class Fetcher:
    def __init__(self, timeout: float = 20.0, user_agent: str = "provenance/0.1") -> None:
        self._client = httpx.Client(
            timeout=timeout,
            follow_redirects=True,
            headers={"User-Agent": user_agent, "Accept": "application/json"},
        )

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> Fetcher:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    @retry(
        retry=retry_if_exception_type((TransientHTTPError, httpx.TransportError)),
        stop=stop_after_attempt(4),
        wait=wait_exponential_jitter(initial=1, max=20),
        reraise=True,
    )
    def _request(self, method: str, url: str, **kwargs: Any) -> httpx.Response:
        host = httpx.URL(url).host
        _limiter.wait(host)
        response = self._client.request(method, url, **kwargs)
        if response.status_code == 429 or response.status_code >= 500:
            raise TransientHTTPError(f"{response.status_code} from {host}")
        return response

    def get_json(self, url: str, **kwargs: Any) -> Any | None:
        """Return parsed JSON, or None for any non-retryable failure.

        Sources are best-effort by design: one dead endpoint should degrade the
        dossier, not abort the run.
        """
        try:
            response = self._request("GET", url, **kwargs)
        except Exception as exc:  # noqa: BLE001 - deliberate catch-all at the boundary
            log.warning("GET %s failed: %s", url, exc)
            return None
        if response.status_code >= 400:
            log.info("GET %s -> %s", url, response.status_code)
            return None
        try:
            return response.json()
        except ValueError:
            log.warning("GET %s returned non-JSON", url)
            return None

    def post_json(self, url: str, payload: Any, **kwargs: Any) -> Any | None:
        try:
            response = self._request("POST", url, json=payload, **kwargs)
        except Exception as exc:  # noqa: BLE001
            log.warning("POST %s failed: %s", url, exc)
            return None
        if response.status_code >= 400:
            log.info("POST %s -> %s (%s)", url, response.status_code, response.text[:200])
            return None
        try:
            return response.json()
        except ValueError:
            return None


# --------------------------------------------------------------------------
# Tolerant accessors. Upstream schemas drift and fields vanish; every read of a
# third-party payload goes through these so a shape change degrades one field
# rather than raising mid-sweep.
# --------------------------------------------------------------------------


def dig(obj: Any, *path: str | int, default: Any = None) -> Any:
    for key in path:
        if obj is None:
            return default
        try:
            if isinstance(key, int):
                obj = obj[key]
            else:
                obj = obj.get(key)
        except (AttributeError, KeyError, IndexError, TypeError):
            return default
    return obj if obj is not None else default


def as_float(value: Any) -> float | None:
    if value is None or isinstance(value, bool):
        return None
    try:
        out = float(value)
    except (TypeError, ValueError):
        return None
    return out if out == out and out not in (float("inf"), float("-inf")) else None


def as_int(value: Any) -> int | None:
    out = as_float(value)
    return int(out) if out is not None else None
