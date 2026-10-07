"""Redaction unit tests. Mirror the TypeScript SDK coverage and the
backend secret-like key policy: matching keys dropped (names only),
values never retained, primitives truncated, non-primitives dropped.
"""

from bond_sdk import (
    is_secret_like_key,
    redact_metadata,
    truncate_snippet,
)


def test_secret_like_keys():
    for key in [
        "apiKey",
        "api_key",
        "api-key",
        "secret",
        "clientSecret",
        "password",
        "passwd",
        "token",
        "accessToken",
        "privateKey",
        "private_key",
        "seed",
        "mnemonic",
        "auth",
        "authorization",
        "credential",
        "bearer",
        "X-Attestor-Secret",
    ]:
        assert is_secret_like_key(key), key
    for key in ["tool", "action", "model", "temperature", "count"]:
        assert not is_secret_like_key(key), key


def test_drops_secrets_without_retaining_values():
    metadata, redacted = redact_metadata(
        {"model": "x", "apiKey": "sk-live-secret", "count": 3}
    )
    assert metadata == {"count": 3, "model": "x"}
    assert "apiKey" in redacted
    combined = str({"metadata": metadata, "redacted": redacted})
    assert "sk-live-secret" not in combined


def test_non_primitives_dropped_and_strings_truncated():
    metadata, redacted = redact_metadata(
        {"nested": {"deep": True}, "items": [1, 2], "long": "y" * 300}
    )
    assert metadata["long"] == "y" * 256
    assert "nested" in redacted
    assert "items" in redacted


def test_none_and_determinism():
    assert redact_metadata(None) == ({}, [])
    first = redact_metadata({"b": 1, "a": 2})
    second = redact_metadata({"a": 2, "b": 1})
    assert first == second


def test_truncate_snippet():
    assert truncate_snippet(None) is None
    assert truncate_snippet("short") == "short"
    assert truncate_snippet("z" * 600) == "z" * 500
