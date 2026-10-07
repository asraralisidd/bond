"""Phase 24 framework adapter tests (Python).

Covers CrewAI, AutoGen, and generic adapters plus LangGraph usage
support. Offline duck-typed fakes only — no frameworks installed.
"""

import pytest

from bond_sdk.activity import ActivityPolicyContext
from bond_sdk.adapters import (
    AutoGenActivityAdapter,
    CrewAIActivityAdapter,
    GenericFrameworkAdapter,
    LangGraphActivityAdapter,
)
from bond_sdk.errors import BondApiError
from bond_sdk.providers import normalize_openai_usage


def make_policy():
    return ActivityPolicyContext(policy_version="bond-policy-v1")


def test_crewai_task_output():
    adapter = CrewAIActivityAdapter("agent-c-1", make_policy())
    payload = adapter.from_task_output(
        {"description": "research", "agent": "researcher", "raw": "done it"},
        activity_id="act-c-1",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert payload["action"] == "research"
    assert payload["actionType"] == "message"
    assert payload["textSnippet"] == "done it"


def test_crewai_task_output_fallbacks():
    adapter = CrewAIActivityAdapter("agent-c-1", make_policy())
    payload = adapter.from_task_output(
        {"output": "finished"},
        activity_id="act-c-2",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert payload["action"] == "crew-task"
    with pytest.raises(BondApiError):
        adapter.from_task_output(
            {"unrelated": 1},
            activity_id="act-c-3",
            occurred_at="2026-01-01T00:00:00.000Z",
        )


def test_crewai_tool_use():
    adapter = CrewAIActivityAdapter("agent-c-1", make_policy())
    payload = adapter.from_tool_use(
        "search",
        {"q": "x", "nested": {"a": 1}},
        activity_id="act-c-4",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert payload["tool"] == "search"
    assert payload["metadata"] == {"q": "x"}


def test_autogen_message_and_function_call():
    adapter = AutoGenActivityAdapter("agent-g-1", make_policy())
    message = adapter.from_message(
        {"role": "assistant", "name": "coder", "content": "hi"},
        activity_id="act-g-1",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert message["action"] == "coder"
    call = adapter.from_function_call(
        {"name": "search", "arguments": {"q": "x"}},
        activity_id="act-g-2",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert call["actionType"] == "tool-call"
    assert call["tool"] == "search"
    assert call["metadata"] == {"q": "x"}
    with pytest.raises(BondApiError):
        adapter.from_message(
            {"role": "assistant", "content": "   "},
            activity_id="act-g-3",
            occurred_at="2026-01-01T00:00:00.000Z",
        )


def test_generic_adapter_with_usage():
    adapter = GenericFrameworkAdapter("agent-x-1", make_policy())
    usage = normalize_openai_usage(
        {"usage": {"prompt_tokens": 2, "completion_tokens": 3}}
    )
    payload = adapter.describe_event(
        action_type="tool-call",
        action="custom-tool",
        tool="custom-tool",
        usage=usage,
        activity_id="act-x-1",
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert payload["provider"] == "openai"
    assert payload["totalTokens"] == 5
    with pytest.raises(BondApiError):
        adapter.describe_event(
            action_type="teleport",
            action="x",
            activity_id="act-x-2",
            occurred_at="2026-01-01T00:00:00.000Z",
        ).to_dict()


def test_langgraph_llm_call_with_usage():
    adapter = LangGraphActivityAdapter("agent-lg-9", make_policy())
    usage = normalize_openai_usage(
        {
            "model": "gpt-4o",
            "id": "chatcmpl-9",
            "usage": {"prompt_tokens": 4, "completion_tokens": 5,
                      "total_tokens": 9},
        }
    )
    payload = adapter.from_llm_call(
        {"content": "summarize this"},
        usage,
        occurred_at="2026-01-01T00:00:00.000Z",
    ).to_dict()
    assert payload["action"] == "model-invocation"
    assert payload["activityId"] == "chatcmpl-9"
    assert payload["provider"] == "openai"
    assert payload["totalTokens"] == 9
    assert "tool" not in payload
