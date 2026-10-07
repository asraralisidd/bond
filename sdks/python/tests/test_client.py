"""BondClient unit tests. Mocked transport only — no network, no wallet,
no live API. Mirrors the @bond/sdk client test coverage.
"""

import json

import httpx
import pytest

from bond_sdk import BondApiError, BondClient, new_idempotency_key


def make_client(handler, **kwargs):
    """Build a client over an httpx.MockTransport, capturing requests."""
    seen = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(mock_handler)
    http = httpx.Client(
        transport=transport, base_url=kwargs.pop("base_url", "https://api.example")
    )
    client = BondClient(
        base_url="https://api.example", http_client=http, **kwargs
    )
    return client, seen


def json_response(status, payload, headers=None):
    all_headers = {"x-request-id": "req-test-1"}
    all_headers.update(headers or {})
    return httpx.Response(status, json=payload, headers=all_headers)


def test_construction_requires_base_url():
    with pytest.raises(BondApiError):
        BondClient(base_url="")


def test_base_url_normalization_and_auth_header():
    client, seen = make_client(
        lambda req: json_response(200, {"data": {"agentId": "a-1"}}),
        token="tok-123",
    )
    agent = client.get_agent("a-1")
    assert agent == {"agentId": "a-1"}
    assert len(seen) == 1
    assert str(seen[0].url) == "https://api.example/api/v1/agents/a-1"
    assert seen[0].headers["Authorization"] == "Bearer tok-123"
    assert seen[0].headers["Content-Type"] == "application/json"


def test_token_provider_and_empty_token():
    client, seen = make_client(
        lambda req: json_response(200, {"data": []}),
        token=lambda: "tok-async",
    )
    client.list_agents()
    assert seen[0].headers["Authorization"] == "Bearer tok-async"

    client2, seen2 = make_client(
        lambda req: json_response(200, {"data": []}), token=lambda: ""
    )
    client2.list_agents()
    assert "Authorization" not in seen2[0].headers

    client3, seen3 = make_client(
        lambda req: json_response(200, {"data": []}), token=None
    )
    client3.list_agents()
    assert "Authorization" not in seen3[0].headers


def test_request_id_tracking_and_envelope_unwrap():
    client, _ = make_client(
        lambda req: json_response(
            200, {"data": {"agentId": "a-2"}}, {"x-request-id": "req-7"}
        )
    )
    agent = client.get_agent("a-2")
    assert agent == {"agentId": "a-2"}
    assert client.last_request_id == "req-7"


def test_idempotency_key_only_on_idempotent_mutations():
    client, seen = make_client(
        lambda req: json_response(201, {"data": {}}),
    )
    client.register_agent(
        platform="p",
        agent_type="custom",
        capabilities=[],
        external_ref="e",
    )
    key = seen[0].headers.get("Idempotency-Key")
    assert isinstance(key, str) and len(key) > 0
    # UUID4 format.
    import uuid

    assert str(uuid.UUID(key, version=4)) == key

    seen.clear()
    client.get_agent("a-1")
    assert "Idempotency-Key" not in seen[0].headers


def test_caller_supplied_idempotency_key_used_verbatim():
    client, seen = make_client(
        lambda req: json_response(201, {"data": {"transactionId": "t-1"}}),
    )
    client.create_transaction(
        purpose="FUND_BOND", agent_id="a-1", idempotency_key="caller-key-9"
    )
    sent = json.loads(seen[0].content.decode())
    assert sent["idempotencyKey"] == "caller-key-9"


def test_new_idempotency_key_unique_uuid4():
    import uuid

    keys = {new_idempotency_key() for _ in range(50)}
    assert len(keys) == 50
    for key in keys:
        assert str(uuid.UUID(key, version=4)) == key


@pytest.mark.parametrize(
    "status,code",
    [(401, "UNAUTHORIZED"), (403, "FORBIDDEN"), (404, "NOT_FOUND"), (409, "IDEMPOTENCY_CONFLICT")],
)
def test_error_status_codes(status, code):
    client, _ = make_client(
        lambda req: json_response(
            status, {"code": code, "message": "m"}, {"x-request-id": "r"}
        )
    )
    with pytest.raises(BondApiError) as exc_info:
        client.list_agents()
    err = exc_info.value
    assert err.code == code
    assert err.status == status
    assert err.request_id == "r"
    assert err.retry_after is None
    assert client.last_request_id == "r"


def test_429_retry_after_no_retry():
    calls = []

    def handler(request):
        calls.append(request)
        return json_response(
            429,
            {"code": "RATE_LIMITED", "message": "slow"},
            {"retry-after": "45"},
        )

    client, _ = make_client(handler)
    with pytest.raises(BondApiError) as exc_info:
        client.list_agents()
    assert exc_info.value.retry_after == 45
    assert len(calls) == 1  # single attempt, no retry storm

    client2, _ = make_client(
        lambda req: json_response(429, {"code": "RATE_LIMITED", "message": "slow"})
    )
    with pytest.raises(BondApiError) as exc_info2:
        client2.list_agents()
    assert exc_info2.value.retry_after is None


def test_5xx_and_network_failure_no_credential_leak():
    client, _ = make_client(
        lambda req: json_response(500, {"code": "INTERNAL_ERROR", "message": "boom"})
    )
    with pytest.raises(BondApiError) as exc_info:
        client.list_agents()
    assert exc_info.value.code == "INTERNAL_ERROR"
    assert exc_info.value.status == 500

    def boom(request):
        raise httpx.ConnectError("down")

    client2, _ = make_client(boom, token="super-secret-token")
    with pytest.raises(BondApiError) as exc_info2:
        client2.list_agents()
    assert exc_info2.value.code == "NETWORK_ERROR"
    assert "super-secret-token" not in str(exc_info2.value)
    assert "super-secret-token" not in repr(exc_info2.value)


def test_unauthorized_hook_and_signout_skip():
    seen = []
    client, _ = make_client(
        lambda req: json_response(401, {"code": "UNAUTHORIZED", "message": "bad"}),
        on_unauthorized=seen.append,
    )
    with pytest.raises(BondApiError):
        client.list_agents()
    assert len(seen) == 1

    seen2 = []
    client2, _ = make_client(
        lambda req: json_response(401, {"code": "UNAUTHORIZED", "message": "bad"}),
        on_unauthorized=seen2.append,
    )
    with pytest.raises(BondApiError):
        client2.sign_out()
    assert seen2 == []


def test_set_token_replaces_credential():
    client, seen = make_client(
        lambda req: json_response(200, {"data": []}), token="old"
    )
    client.list_agents()
    assert seen[0].headers["Authorization"] == "Bearer old"
    client.set_token("new")
    client.list_agents()
    assert seen[1].headers["Authorization"] == "Bearer new"
    client.set_token(None)
    client.list_agents()
    assert "Authorization" not in seen[2].headers


def test_method_coverage_paths_and_methods():
    routes = []

    def handler(request):
        routes.append((request.method, str(request.url)))
        return json_response(200, {"data": {}})

    client, _ = make_client(handler)
    client.health()
    client.ready()
    client.create_session("k", "e")
    client.sign_out()
    client.request_wallet_challenge()
    client.verify_wallet_challenge("c", {"data": "d", "signature": "s", "verifyingKey": "v"})
    client.get_agent("a")
    client.register_agent(platform="p", agent_type="t", capabilities=[], external_ref="e")
    client.set_agent_status("a", "ACTIVE")
    client.create_bond(agent_id="a", commitment_minor_units="1")
    client.get_bond("b")
    client.set_bond_status("b", "ACTIVE")
    client.create_transaction(purpose="P", idempotency_key="k")
    client.get_transaction("t")
    client.advance_transaction("t", "PENDING")
    client.record_wallet_submission("t", "c")
    client.confirm_transaction("t")
    client.analyze_activity("a", {"action": "x"})
    client.list_flags("a")
    client.get_flag("f")
    client.register_attestor(organization="o", secret="s")
    client.request_attestation(flag_id="f", attestor_ids=["a"], expires_at="e")
    client.get_attestation("a")
    client.evaluate_attestation("a", 1)
    client.issue_decision("a", "dismiss")
    client.enforce_attestation("a", "1")
    client.create_eligibility_proof(
        agent_id="a",
        bond_id="b",
        required_minimum_minor_units="1",
        nonce="n",
        expires_at="e",
    )
    client.get_eligibility("e")
    client.consume_eligibility("e", "n")
    client.verify_agent("a")
    client.verify_eligibility("a", "v1")
    client.create_setup_grant(scopes=["agent:register"])
    client.list_setup_grants()
    client.revoke_setup_grant("grant_1")
    assert len(routes) == 34
    methods = {method for method, _ in routes}
    assert methods <= {"GET", "POST", "PATCH", "DELETE"}
    urls = [url for _, url in routes]
    assert "https://api.example/api/v1/agents/a" in urls
    assert "https://api.example/health" in urls
    for url in urls:
        assert url.startswith("https://api.example/")


def test_attestor_secret_header_only():
    client, seen = make_client(
        lambda req: json_response(201, {"data": {"status": "ok", "verdicts": 1}})
    )
    client.submit_verdict(
        "a", attestor_id="at", verdict="confirm", secret="shh-secret"
    )
    assert seen[0].headers["X-Attestor-Secret"] == "shh-secret"
    assert "shh-secret" not in seen[0].content.decode()
    assert "Authorization" not in seen[0].headers


def test_list_events_query_building():
    client, seen = make_client(
        lambda req: json_response(200, {"data": {"events": [], "nextCursor": None}})
    )
    page = client.list_events(limit=10, cursor="abc123", event_type="RISK_FLAG_RAISED")
    assert page == {"events": [], "nextCursor": None}
    assert (
        str(seen[0].url)
        == "https://api.example/api/v1/events?limit=10&cursor=abc123&type=RISK_FLAG_RAISED"
    )
    bare = client.list_events()
    assert bare == {"events": [], "nextCursor": None}
    assert str(seen[1].url) == "https://api.example/api/v1/events"
