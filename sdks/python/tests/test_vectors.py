"""Protocol vector runner (Phase 16.3).

Loads the CANONICAL fixtures from sdks/protocol/vectors/ — the same
files the TypeScript suite reads. No copies, no forks. Builds payloads
with the Python SDK, drives mocked transports, and deep-compares
against ``expected``. No network access. Deterministic: all dynamic
fields are literal strings in the fixtures.
"""

import json
from pathlib import Path

import httpx
import pytest

from bond_sdk import BondApiError, BondClient, build_activity
from bond_sdk.activity import (
    ActivityInput,
    ActivityPolicyContext,
    build_model_activity,
)
from bond_sdk.providers import (
    NormalizedModelUsage,
    normalize_anthropic_usage,
    normalize_deepseek_usage,
    normalize_gemini_usage,
    normalize_local_usage,
    normalize_openai_usage,
)

VECTORS_DIR = (
    Path(__file__).resolve().parent.parent.parent / "protocol" / "vectors"
)

# Canonical camelCase -> ActivityInput snake_case. Explicit, reviewed
# test-only mapping (the fixtures stay language-neutral).
_FIELD_MAP = {
    "activityId": "activity_id",
    "agentId": "agent_id",
    "occurredAt": "occurred_at",
    "actionType": "action_type",
    "action": "action",
    "tool": "tool",
    "amountMinorUnits": "amount_minor_units",
    "externalDestination": "external_destination",
    "bytesOut": "bytes_out",
    "textSnippet": "text_snippet",
    "metadata": "metadata",
    "reporterSeverity": "reporter_severity",
    "policyContext": "policy_context",
}

_POLICY_MAP = {
    "policyVersion": "policy_version",
    "allowedActions": "allowed_actions",
    "declaredTools": "declared_tools",
    "denylistedActions": "denylisted_actions",
    "spendLimitMinorUnits": "spend_limit_minor_units",
    "exfilThresholdBytes": "exfil_threshold_bytes",
}


def load_vectors(name):
    with open(VECTORS_DIR / name, encoding="utf-8") as handle:
        return json.load(handle)


def to_activity_kwargs(vector_input):
    """Translate canonical input to ActivityInput kwargs (validated keys)."""
    unknown = set(vector_input) - set(_FIELD_MAP)
    assert not unknown, f"unmapped vector fields: {sorted(unknown)}"
    kwargs = {}
    for camel, snake in _FIELD_MAP.items():
        if camel in vector_input:
            kwargs[snake] = vector_input[camel]
    policy = dict(vector_input.get("policyContext", {}))
    unknown_policy = set(policy) - set(_POLICY_MAP)
    assert not unknown_policy, f"unmapped policy fields: {sorted(unknown_policy)}"
    kwargs["policy_context"] = ActivityPolicyContext(
        **{snk: policy[cam] for cam, snk in _POLICY_MAP.items() if cam in policy}
    )
    return kwargs


def mock_client(handler):
    seen = []

    def mock_handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    transport = httpx.MockTransport(mock_handler)
    http = httpx.Client(transport=transport, base_url="https://api.example")
    return BondClient(base_url="https://api.example", http_client=http), seen


def json_response(status, payload, headers=None):
    merged = dict(headers or {})
    if payload is None:
        return httpx.Response(status, content=b"not-json{{{", headers=merged)
    return httpx.Response(status, json=payload, headers=merged)


REGISTRATION = load_vectors("registration.json")
ACTIVITIES = load_vectors("activities.json")
ERRORS = load_vectors("errors.json")
ENVELOPES = load_vectors("envelopes.json")


def test_canonical_files_present():
    assert (VECTORS_DIR / "registration.json").exists()
    assert (VECTORS_DIR / "activities.json").exists()
    assert (VECTORS_DIR / "errors.json").exists()
    assert (VECTORS_DIR / "envelopes.json").exists()
    assert len(REGISTRATION["valid"]) > 0
    assert len(ACTIVITIES["valid"]) == 7


@pytest.mark.parametrize(
    "vector", REGISTRATION["valid"], ids=lambda v: v["name"]
)
def test_registration_serializes_byte_identically(vector):
    client, seen = mock_client(
        lambda req: json_response(201, {"data": {"agentId": "agent-vector-x"}})
    )
    client.register_agent(
        platform=vector["input"]["platform"],
        agent_type=vector["input"]["agentType"],
        capabilities=list(vector["input"]["capabilities"]),
        external_ref=vector["input"]["externalRef"],
    )
    assert len(seen) == 1
    sent = json.loads(seen[0].content.decode())
    assert sent == vector["expected"]
    assert sorted(sent.keys()) == sorted(vector["expected"].keys())


@pytest.mark.parametrize(
    "vector", REGISTRATION["invalid"], ids=lambda v: v["name"]
)
def test_registration_invalid_documented(vector):
    # Invalid registration cases are server-validated; the SDK must
    # transmit the payload unmodified (no silent fixing/dropping).
    assert vector["expectedServerCode"] == "INVALID_IDENTIFIER"
    assert vector["input"] is not None


def test_activity_covers_all_seven_types():
    names = sorted(v["name"] for v in ACTIVITIES["valid"])
    assert names == [
        "auth",
        "config-change",
        "external-report",
        "message",
        "policy-decision",
        "tool-call",
        "transfer",
    ]


@pytest.mark.parametrize(
    "vector", ACTIVITIES["valid"], ids=lambda v: v["name"]
)
def test_activity_builds_exactly(vector):
    built = ActivityInput(**to_activity_kwargs(vector["input"])).to_dict()
    assert json.loads(json.dumps(built)) == vector["expected"]


@pytest.mark.parametrize(
    "vector", ACTIVITIES["invalid"], ids=lambda v: v["name"]
)
def test_activity_invalid_rejected(vector):
    with pytest.raises(BondApiError) as exc_info:
        ActivityInput(**to_activity_kwargs(vector["input"])).to_dict()
    assert exc_info.value.code == vector["expectedCode"]


def test_error_status_classes_covered():
    statuses = sorted(v["status"] for v in ERRORS["vectors"])
    assert statuses == [401, 403, 404, 409, 429, 429, 500, 502]


@pytest.mark.parametrize("vector", ERRORS["vectors"], ids=lambda v: v["name"])
def test_error_mapping(vector):
    def handler(request):
        return json_response(
            vector["status"], vector["body"], vector["headers"]
        )

    client, _ = mock_client(handler)
    with pytest.raises(BondApiError) as exc_info:
        client.list_agents()
    err = exc_info.value
    expected = vector["expected"]
    assert err.code == expected["code"]
    assert err.message == expected["message"]
    assert err.status == expected["status"]
    assert err.request_id == expected["requestId"]
    assert err.retry_after == expected["retryAfter"]


def test_envelope_categories_covered():
    names = sorted(v["name"] for v in ENVELOPES["vectors"])
    assert names == ["agent", "public-verification", "risk-analysis", "risk-flags"]


@pytest.mark.parametrize(
    "vector", ENVELOPES["vectors"], ids=lambda v: v["name"]
)
def test_envelope_unwrap(vector):
    def handler(request):
        assert str(request.url) == f"https://api.example{vector['path']}"
        assert request.method == vector["method"]
        return json_response(200, vector["body"])

    client, _ = mock_client(handler)
    if vector["name"] == "agent":
        data = client.get_agent("agent-vector-1")
    elif vector["name"] == "risk-analysis":
        data = client.analyze_activity("agent-vector-1", {"action": "probe"})
    elif vector["name"] == "risk-flags":
        data = client.list_flags("agent-vector-1")
    else:
        data = client.verify_agent("agent-vector-1")
    assert json.loads(json.dumps(data)) == vector["expected"]


USAGE = load_vectors("usage.json")

_USAGE_NORMALIZERS = {
    "openai": normalize_openai_usage,
    "anthropic": normalize_anthropic_usage,
    "gemini": normalize_gemini_usage,
    "deepseek": normalize_deepseek_usage,
    "local": normalize_local_usage,
}

_USAGE_FIELDS = (
    "provider",
    "model",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "estimated_cost_minor_units",
    "provider_request_id",
)

_CAMEL_USAGE_FIELDS = {
    "provider": "provider",
    "model": "model",
    "inputTokens": "input_tokens",
    "outputTokens": "output_tokens",
    "totalTokens": "total_tokens",
    "estimatedCostMinorUnits": "estimated_cost_minor_units",
    "providerRequestId": "provider_request_id",
}


def usage_to_expected(usage):
    """NormalizedModelUsage -> canonical camelCase dict (None kept)."""
    return {
        camel: getattr(usage, snake) for camel, snake in _CAMEL_USAGE_FIELDS.items()
    }


def test_usage_covers_all_five_providers():
    names = sorted(v["name"] for v in USAGE["valid"])
    assert names == ["anthropic", "deepseek", "gemini", "local", "openai"]


@pytest.mark.parametrize("vector", USAGE["valid"], ids=lambda v: v["name"])
def test_usage_normalizes_exactly(vector):
    normalizer = _USAGE_NORMALIZERS[vector["provider"]]
    usage = normalizer(vector["input"])
    assert json.loads(json.dumps(usage_to_expected(usage))) == vector["expected"]


@pytest.mark.parametrize("vector", USAGE["invalid"], ids=lambda v: v["name"])
def test_usage_invalid_rejected(vector):
    normalizer = _USAGE_NORMALIZERS[vector["provider"]]
    with pytest.raises(BondApiError) as exc_info:
        normalizer(vector["input"])
    assert exc_info.value.code == vector["expectedCode"]


@pytest.mark.parametrize(
    "vector", USAGE["modelActivities"], ids=lambda v: v["name"]
)
def test_model_activity_builds_exactly(vector):
    vector_input = vector["input"]
    usage_kwargs = {
        snake: vector_input["usage"][camel]
        for camel, snake in _CAMEL_USAGE_FIELDS.items()
    }
    payload = build_model_activity(
        vector_input["agentId"],
        NormalizedModelUsage(**usage_kwargs),
        ActivityPolicyContext(
            policy_version=vector_input["policyContext"]["policyVersion"]
        ),
        action=vector_input.get("action", "model-invocation"),
        activity_id=vector_input.get("activityId"),
        occurred_at=vector_input.get("occurredAt"),
    )
    assert json.loads(json.dumps(payload)) == vector["expected"]
