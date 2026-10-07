"""Error model unit tests. Mirror the TypeScript SDK coverage."""

from bond_sdk import BondApiError, friendly_message, parse_retry_after


def test_error_fields():
    err = BondApiError("NOT_FOUND", "Agent not found", 404, "req-9")
    assert isinstance(err, Exception)
    assert type(err).__name__ == "BondApiError"
    assert err.code == "NOT_FOUND"
    assert err.status == 404
    assert err.request_id == "req-9"
    assert err.retry_after is None
    assert str(err) == "Agent not found"
    limited = BondApiError("RATE_LIMITED", "slow", 429, "r1", 30)
    assert limited.retry_after == 30


def test_repr_exposes_only_structured_fields():
    err = BondApiError("X", "secret-message-text", 500, None)
    assert "secret-message-text" not in repr(err)
    assert "X" in repr(err)


def test_parse_retry_after():
    assert parse_retry_after(None) is None
    assert parse_retry_after("30") == 30
    assert parse_retry_after("  5  ") == 5
    assert parse_retry_after("0") == 0
    assert parse_retry_after("") is None
    assert parse_retry_after("soon") is None
    assert parse_retry_after("1.5") is None
    assert parse_retry_after("-3") is None


def test_friendly_message():
    assert (
        friendly_message(BondApiError("RATE_LIMITED", "x", 429, "r1"))
        == "Too many requests — please wait a moment and try again."
    )
    assert (
        friendly_message(BondApiError("NOT_FOUND", "gone", 404, None))
        == "NOT_FOUND: gone"
    )
    assert friendly_message(ValueError("boom")) == "boom"
    assert friendly_message("plain") == "plain"
