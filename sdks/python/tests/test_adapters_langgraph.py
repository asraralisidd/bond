"""LangGraph adapter unit tests. Offline, duck-typed fakes only —
LangGraph is NOT installed and must NOT be required. No network."""

import pytest

from bond_sdk.activity import ActivityPolicyContext
from bond_sdk.adapters import LangGraphActivityAdapter
from bond_sdk.errors import BondApiError


def make_adapter():
    return LangGraphActivityAdapter(
        "agent-lg-1",
        ActivityPolicyContext(policy_version="bond-policy-v1"),
    )


def test_adapter_imports_without_langgraph_installed():
    import importlib.util

    if importlib.util.find_spec("langgraph") is not None:
        pytest.skip("langgraph installed; absence path not exercisable")
    # This module already imported the adapter at top level, proving the
    # import works with no langgraph present. Pin the absence explicitly:
    # the adapter source must not import langgraph at module scope.
    import inspect

    import bond_sdk.adapters.langgraph as module

    source = inspect.getsource(module)
    assert "import langgraph" not in source
    assert "from langgraph" not in source


def test_message_mapping_string_content():
    adapter = make_adapter()
    activity = adapter.from_message(
        {"content": "hello operator"},
        activity_id="act-lg-1",
        occurred_at="2026-01-01T00:00:00.000Z",
    )
    payload = activity.to_dict()
    assert payload == {
        "activityId": "act-lg-1",
        "agentId": "agent-lg-1",
        "occurredAt": "2026-01-01T00:00:00.000Z",
        "actionType": "message",
        "action": "agent-message",
        "textSnippet": "hello operator",
        "policyContext": {"policyVersion": "bond-policy-v1"},
    }


def test_message_mapping_attribute_object_and_blocks():
    class FakeMessage:
        def __init__(self, content):
            self.content = content

    adapter = make_adapter()
    by_attr = adapter.from_message(
        FakeMessage("hi"),
        activity_id="a",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert by_attr["textSnippet"] == "hi"

    blocks = adapter.from_message(
        {
            "content": [
                {"type": "text", "text": "first"},
                {"type": "image_url", "image_url": "https://x/y.png"},
                {"type": "text", "text": "second"},
            ]
        },
        activity_id="b",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert blocks["textSnippet"] == "first\nsecond"


def test_message_rejects_malformed():
    adapter = make_adapter()
    for bad in ({}, {"content": ""}, {"content": []}, {"content": 42}, None):
        with pytest.raises(BondApiError) as exc_info:
            adapter.from_message(bad)
        assert exc_info.value.code == "INVALID_ACTIVITY_INPUT"


def test_tool_call_mapping():
    adapter = make_adapter()
    activity = adapter.from_tool_call(
        "transfers",
        {"vendor": "acme", "count": 2, "nested": {"x": 1}},
        result="paid",
        activity_id="act-lg-2",
        occurred_at="2026-01-01T00:00:00.000Z",
    )
    payload = activity.to_dict()
    assert payload["actionType"] == "tool-call"
    assert payload["action"] == "transfers"
    assert payload["tool"] == "transfers"
    assert payload["textSnippet"] == "paid"
    # Non-scalar args dropped; scalars kept.
    assert payload["metadata"] == {"vendor": "acme", "count": 2}


def test_tool_call_rejects_malformed():
    adapter = make_adapter()
    with pytest.raises(BondApiError):
        adapter.from_tool_call("")
    with pytest.raises(BondApiError):
        adapter.from_tool_call("ok", args=["not", "a", "mapping"])
    with pytest.raises(BondApiError):
        adapter.from_tool_call("ok", result={"blob": True})
    with pytest.raises(BondApiError):
        adapter.from_tool_call("ok", args={1: "non-string-key"})


def test_node_output_text_and_mapping():
    adapter = make_adapter()
    text = adapter.from_node_output(
        "planner",
        "plan complete",
        activity_id="a",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert text["actionType"] == "message"
    assert text["action"] == "langgraph:planner"
    assert text["textSnippet"] == "plan complete"

    decided = adapter.from_node_output(
        "reviewer",
        {"approved": True},
        action_type="policy-decision",
        activity_id="b",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert decided["actionType"] == "policy-decision"
    assert decided["metadata"] == {"approved": True}

    with pytest.raises(BondApiError):
        adapter.from_node_output("planner", "")
    with pytest.raises(BondApiError):
        adapter.from_node_output("planner", ["a", "list"])
    with pytest.raises(BondApiError):
        adapter.from_node_output("planner", 42)
    with pytest.raises(BondApiError):
        adapter.from_node_output("", "ok")
    with pytest.raises(BondApiError):
        adapter.from_node_output(
            "planner", "ok", action_type="transfer"  # type: ignore[arg-type]
        )


def test_adapter_holds_no_credentials_or_client():
    adapter = make_adapter()
    assert not hasattr(adapter, "token")
    assert not hasattr(adapter, "client")
    assert not hasattr(adapter, "secret")
    assert "token" not in repr(adapter.__dict__).lower()


def test_adapter_output_feeds_activity_builder_unchanged():
    adapter = make_adapter()
    built = adapter.from_message(
        {"content": "x" * 600},
        activity_id="a",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    # Builder truncation applies through the adapter path.
    assert built["textSnippet"] == "x" * 500
