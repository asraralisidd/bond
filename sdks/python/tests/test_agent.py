"""BondAgentClient + credential management tests. Mocked transport
only — no network, no wallet, no live API.
"""

import httpx
import pytest

from bond_sdk import BondAgentClient, BondApiError, BondClient


def make_agent(handler):
    """Build an agent client over a MockTransport, capturing requests."""
    seen = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(mock_handler)
    http = httpx.Client(transport=transport, base_url="https://api.example")
    transport_client = BondClient(
        base_url="https://api.example",
        token="cred_test.secret",
        http_client=http,
    )
    return BondAgentClient(transport_client), seen


def json_response(status, payload, headers=None):
    all_headers = {"x-request-id": "req-test-1"}
    all_headers.update(headers or {})
    return httpx.Response(status, json=payload, headers=all_headers)


def test_credential_management_paths():
    from bond_sdk import BondClient as OperatorClient

    seen = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        path = request.url.path
        if request.method == "DELETE":
            credential_id = path.rstrip("/").split("/")[-1]
            return json_response(
                200, {"data": {"revoked": True, "credentialId": credential_id}}
            )
        if path.endswith("/rotate"):
            return json_response(
                201,
                {
                    "data": {
                        "metadata": {"credentialId": "cred_2"},
                        "secret": "new-secret",
                    }
                },
            )
        return json_response(
            201,
            {
                "data": {
                    "metadata": {"credentialId": "cred_1", "agentId": "a-1"},
                    "secret": "s3cret",
                }
                if request.method == "POST"
                else [{"credentialId": "cred_1", "agentId": "a-1"}],
            },
        )

    transport = httpx.MockTransport(mock_handler)
    http = httpx.Client(transport=transport, base_url="https://api.example")
    client = OperatorClient(
        base_url="https://api.example", token="sess_x", http_client=http
    )
    created = client.create_agent_credential("a-1")
    assert created["secret"] == "s3cret"
    assert "/api/v1/agents/a-1/credentials" in str(seen[0].url)
    listed = client.list_agent_credentials("a-1")
    assert "s3cret" not in str(listed)
    rotated = client.rotate_agent_credential("a-1", "cred_1")
    assert rotated["secret"] == "new-secret"
    assert str(seen[2].url).endswith("/credentials/cred_1/rotate")
    revoked = client.revoke_agent_credential("a-1", "cred_2")
    assert revoked == {"revoked": True, "credentialId": "cred_2"}
    assert seen[3].method == "DELETE"


def test_agent_client_exposes_only_four_capabilities():
    agent, _ = make_agent(
        lambda req: json_response(200, {"data": {"agentId": "a-1"}})
    )
    public = {name for name in dir(agent) if not name.startswith("_")}
    assert public >= {
        "analyze_activity",
        "list_flags",
        "get_flag",
        "list_events",
        "get_agent",
        "get_reputation",
        "get_policy",
        "verify_agent",
        "set_token",
        "last_request_id",
    }
    for forbidden in (
        "create_bond",
        "create_agent_credential",
        "rotate_agent_credential",
        "revoke_agent_credential",
        "submit_verdict",
        "enforce_attestation",
        "register_agent",
    ):
        assert not hasattr(agent, forbidden), forbidden


def test_agent_calls_carry_agent_credential():
    agent, seen = make_agent(
        lambda req: json_response(200, {"data": {"agentId": "a-1"}})
    )
    agent.get_agent("a-1")
    agent.list_flags("a-1")
    agent.get_flag("f-1")
    agent.verify_agent("a-1")
    assert len(seen) == 4
    for request in seen:
        assert request.headers["Authorization"] == "Bearer cred_test.secret"
    assert agent.last_request_id == "req-test-1"


def test_capability_denial_propagates_without_retry():
    agent, _ = make_agent(
        lambda req: json_response(
            403, {"code": "FORBIDDEN", "message": "Capability not granted"}
        )
    )
    with pytest.raises(BondApiError) as exc_info:
        agent.list_flags("a-1")
    assert exc_info.value.code == "FORBIDDEN"


def test_set_token_swaps_credential():
    agent, seen = make_agent(
        lambda req: json_response(200, {"data": {}})
    )
    agent.set_token("cred_other.newsecret")
    agent.get_agent("a-1")
    assert seen[0].headers["Authorization"] == "Bearer cred_other.newsecret"


def test_exports():
    import bond_sdk

    assert "BondAgentClient" in bond_sdk.__all__
