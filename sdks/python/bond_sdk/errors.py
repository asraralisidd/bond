"""Framework-free error model.

Mirrors the backend safe envelope ({code, message, requestId}) plus the
Retry-After signal on 429s. Never carries credentials, tokens, or
request bodies.
"""

from __future__ import annotations


class BondApiError(Exception):
    """Structured API failure. See also :func:`friendly_message`."""

    def __init__(
        self,
        code: str,
        message: str,
        status: int,
        request_id: str | None,
        retry_after: int | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.request_id = request_id
        self.retry_after = retry_after

    def __str__(self) -> str:
        return self.message

    def __repr__(self) -> str:
        # Never include anything but the stable structured fields.
        return (
            f"BondApiError(code={self.code!r}, status={self.status!r}, "
            f"request_id={self.request_id!r}, retry_after={self.retry_after!r})"
        )


def parse_retry_after(value: str | None) -> int | None:
    """Parse a Retry-After header value (delta-seconds).

    Returns None when absent or unparsable — callers decide whether to
    retry; the SDK never retries automatically (no retry storms).
    """
    if value is None:
        return None
    trimmed = value.strip()
    if not trimmed.isdigit():
        return None
    return int(trimmed)


def friendly_message(error: object) -> str:
    """User-facing message for API failures."""
    if isinstance(error, BondApiError) and error.code == "RATE_LIMITED":
        return "Too many requests — please wait a moment and try again."
    if isinstance(error, BondApiError):
        return f"{error.code}: {error.message}"
    if isinstance(error, Exception):
        return str(error)
    return str(error)
