"""Client-side metadata redaction (defense in depth only).

Reproduces the risk-engine secret-like key policy: matching keys are
dropped before sending, never logged, never stored. The backend remains
authoritative — client redaction never replaces server validation.
"""

from __future__ import annotations

import re

_SECRET_KEY_PATTERN = re.compile(
    r"api[_-]?key|secret|passwd|password|token|private[_-]?key|"
    r"seed|mnemonic|auth|credential|bearer",
    re.IGNORECASE,
)

_MAX_STRING_FIELD = 256
_MAX_TEXT_SNIPPET = 500

MetadataValue = str | int | float | bool | None


def is_secret_like_key(key: str) -> bool:
    """Returns True when a metadata key looks secret-like."""
    return _SECRET_KEY_PATTERN.search(key) is not None


def redact_metadata(
    raw: dict[str, object] | None,
) -> tuple[dict[str, MetadataValue], list[str]]:
    """Drop secret-like and non-primitive metadata values.

    Returns ``(metadata, redacted_fields)`` where ``metadata`` holds
    safe primitives (sorted keys, truncated strings) and
    ``redacted_fields`` holds dropped key *names* only — original
    secret values never appear in the output. Pure and deterministic.
    """
    metadata: dict[str, MetadataValue] = {}
    redacted_fields: list[str] = []
    if raw is None:
        return metadata, redacted_fields
    for key in sorted(raw.keys()):
        value = raw[key]
        if is_secret_like_key(key):
            redacted_fields.append(key)
            continue
        if (
            isinstance(value, str)
            or isinstance(value, bool)
            or isinstance(value, (int, float))
            or value is None
        ):
            metadata[key] = (
                value[:_MAX_STRING_FIELD]
                if isinstance(value, str)
                else value  # type: ignore[assignment]
            )
        else:
            redacted_fields.append(key)
    redacted_fields.sort()
    return metadata, redacted_fields


def truncate_snippet(text: str | None) -> str | None:
    """Truncate free text to the server-accepted snippet budget.

    Defense in depth: the server truncates again authoritatively.
    """
    if text is None:
        return None
    return text[:_MAX_TEXT_SNIPPET]
