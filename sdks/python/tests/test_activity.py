"""ActivityBuilder unit tests. Mirror the TypeScript SDK coverage:
defaults, validation parity, all action types, redaction wiring.
"""

import pytest

from bond_sdk import (
    ACTIVITY_TYPES,
    ActivityInput,
    ActivityPolicyContext,
    BondApiError,
    build_activity,
)


def base_kwargs(**overrides):
    kwargs = {
        "agent_id": "agent-1",
        "action_type": "tool-call",
        "action": "pay-vendor",
        "policy_context": ActivityPolicyContext(policy_version="bond-policy-v1"),
    }
    kwargs.update(overrides)
    return kwargs


def test_defaults_generated():
    first = build_activity(**base_kwargs())
    second = build_activity(**base_kwargs())
    assert first["activityId"]
    assert first["activityId"] != second["activityId"]
    from datetime import datetime

    # Parses as a real timestamp (ISO-8601).
    datetime.fromisoformat(first["occurredAt"])
    assert first["agentId"] == "agent-1"


def test_caller_supplied_ids_and_timestamps():
    payload = build_activity(
        **base_kwargs(activity_id="act-9", occurred_at="2026-01-01T00:00:00.000Z")
    )
    assert payload["activityId"] == "act-9"
    assert payload["occurredAt"] == "2026-01-01T00:00:00.000Z"


def test_all_action_types_accepted():
    assert len(ACTIVITY_TYPES) == 7
    for action_type in ACTIVITY_TYPES:
        payload = build_activity(**base_kwargs(action_type=action_type))
        assert payload["actionType"] == action_type


def test_unknown_action_type_rejected():
    with pytest.raises(BondApiError) as exc_info:
        build_activity(**base_kwargs(action_type="nonsense"))
    assert exc_info.value.code == "INVALID_ACTIVITY_INPUT"


def test_empty_fields_rejected():
    with pytest.raises(BondApiError, match="agentId"):
        build_activity(**base_kwargs(agent_id=""))
    with pytest.raises(BondApiError, match="action"):
        build_activity(**base_kwargs(action="  "))
    with pytest.raises(BondApiError, match="policyVersion"):
        build_activity(
            **base_kwargs(
                policy_context=ActivityPolicyContext(policy_version="")
            )
        )
    with pytest.raises(BondApiError, match="occurredAt"):
        build_activity(**base_kwargs(occurred_at="yesterday"))


def test_optional_fields_and_redaction():
    payload = build_activity(
        **base_kwargs(
            tool="transfers",
            amount_minor_units="100",
            external_destination=True,
            bytes_out=42,
            text_snippet="s" * 600,
            metadata={"model": "m", "apiKey": "sk-secret"},
            reporter_severity="high",
        )
    )
    assert payload["tool"] == "transfers"
    assert payload["amountMinorUnits"] == "100"
    assert payload["externalDestination"] is True
    assert payload["bytesOut"] == 42
    assert payload["textSnippet"] == "s" * 500
    assert payload["metadata"] == {"model": "m"}
    assert payload["reporterSeverity"] == "high"


def test_absent_optionals_omitted_from_wire_payload():
    payload = build_activity(**base_kwargs())
    for key in (
        "tool",
        "amountMinorUnits",
        "externalDestination",
        "bytesOut",
        "textSnippet",
        "metadata",
        "reporterSeverity",
    ):
        assert key not in payload
    assert set(payload.keys()) == {
        "activityId",
        "agentId",
        "occurredAt",
        "actionType",
        "action",
        "policyContext",
    }


def test_dataclass_serialization_exact_keys():
    payload = ActivityInput(
        agent_id="agent-7",
        action_type="message",
        action="hello",
        policy_context=ActivityPolicyContext(
            policy_version="bond-policy-v1",
            allowed_actions=("a",),
            spend_limit_minor_units="5",
        ),
    ).to_dict()
    assert payload["policyContext"] == {
        "policyVersion": "bond-policy-v1",
        "allowedActions": ["a"],
        "spendLimitMinorUnits": "5",
    }
