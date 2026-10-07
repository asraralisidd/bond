"""Phase 24 provider normalization tests (Python).

Covers all five providers, totals rules, strict validation, cost
honesty, request-id handling, and build_model_activity. Offline —
no provider packages installed or required.
"""

import json

import pytest

from bond_sdk.activity import ActivityPolicyContext, build_model_activity
from bond_sdk.errors import BondApiError
from bond_sdk.providers import (
    normalize_anthropic_usage,
    normalize_deepseek_usage,
    normalize_gemini_usage,
    normalize_local_usage,
    normalize_openai_usage,
    normalize_usage,
)


def code_of(fn):
    try:
        fn()
    except BondApiError as exc:
        return exc.code
    return None


def test_openai_shape():
    usage = normalize_openai_usage(
        {
            "model": "gpt-4o",
            "id": "chatcmpl-abc",
            "usage": {
                "prompt_tokens": 10,
                "completion_tokens": 20,
                "total_tokens": 30,
            },
        }
    )
    assert usage.provider == "openai"
    assert usage.model == "gpt-4o"
    assert (usage.input_tokens, usage.output_tokens, usage.total_tokens) == (
        10,
        20,
        30,
    )
    assert usage.estimated_cost_minor_units is None
    assert usage.provider_request_id == "chatcmpl-abc"


def test_anthropic_derives_total():
    usage = normalize_anthropic_usage(
        {"model": "claude-x", "usage": {"input_tokens": 5, "output_tokens": 7}}
    )
    assert usage.total_tokens == 12
    assert usage.provider_request_id is None


def test_gemini_metadata_with_explicit_model():
    usage = normalize_gemini_usage(
        {
            "usageMetadata": {
                "promptTokenCount": 3,
                "candidatesTokenCount": 4,
                "totalTokenCount": 7,
            }
        },
        model="gemini-2.0-flash",
    )
    assert usage.provider == "gemini"
    assert usage.model == "gemini-2.0-flash"
    assert (usage.input_tokens, usage.output_tokens) == (3, 4)


def test_deepseek_and_local_shapes():
    assert (
        normalize_deepseek_usage(
            {"usage": {"prompt_tokens": 1, "completion_tokens": 2,
                       "total_tokens": 3}}
        ).provider
        == "deepseek"
    )
    local = normalize_local_usage(
        {
            "provider": "ollama",
            "model": "llama3",
            "input_tokens": 8,
            "output_tokens": 9,
            "cost_minor_units": "42",
        }
    )
    assert local.provider == "ollama"
    assert local.total_tokens == 17
    assert local.estimated_cost_minor_units == "42"


def test_explicit_total_kept_derived_when_absent():
    kept = normalize_openai_usage(
        {"usage": {"prompt_tokens": 10, "completion_tokens": 20,
                   "total_tokens": 99}}
    )
    assert kept.total_tokens == 99
    derived = normalize_local_usage({"input_tokens": 4, "output_tokens": 6})
    assert derived.total_tokens == 10
    absent = normalize_local_usage({})
    assert absent.total_tokens is None
    assert absent.input_tokens is None


@pytest.mark.parametrize(
    "usage",
    [
        {"prompt_tokens": -1},
        {"prompt_tokens": 1.5},
        {"prompt_tokens": True},
        {"prompt_tokens": "10"},
        {"prompt_tokens": 2**53},
    ],
)
def test_strict_token_validation(usage):
    assert (
        code_of(lambda: normalize_openai_usage({"usage": usage}))
        == "INVALID_ACTIVITY_INPUT"
    )


def test_response_required_and_costs_never_fabricated():
    assert code_of(lambda: normalize_openai_usage(None)) == \
        "INVALID_ACTIVITY_INPUT"
    usage = normalize_openai_usage(
        {"usage": {"prompt_tokens": 1, "completion_tokens": 1,
                   "total_tokens": 2}}
    )
    assert usage.estimated_cost_minor_units is None
    assert (
        code_of(lambda: normalize_local_usage({"cost_minor_units": "12.5"}))
        == "INVALID_ACTIVITY_INPUT"
    )


def test_model_override_and_attribute_objects():
    usage = normalize_gemini_usage(
        {"usageMetadata": {"promptTokenCount": 1}}, model="gemini-pro"
    )
    assert usage.model == "gemini-pro"
    assert usage.total_tokens == 1

    class Usage:
        prompt_tokens = 7
        completion_tokens = 8
        total_tokens = 15

    class Response:
        model = "gpt-x"
        usage = Usage()

    obj = normalize_usage(
        provider="openai",
        response=Response(),
        input_keys=("prompt_tokens",),
        output_keys=("completion_tokens",),
        total_keys=("total_tokens",),
    )
    assert (obj.model, obj.input_tokens, obj.total_tokens) == \
        ("gpt-x", 7, 15)


def test_build_model_activity():
    usage = normalize_openai_usage(
        {
            "model": "gpt-4o",
            "id": "chatcmpl-abc",
            "usage": {"prompt_tokens": 10, "completion_tokens": 20,
                      "total_tokens": 30},
        }
    )
    payload = build_model_activity(
        "agent-1",
        usage,
        ActivityPolicyContext(policy_version="bond-policy-v1"),
        activity_id="act-1",
        occurred_at="2026-01-01T00:00:00.000Z",
    )
    assert payload["action"] == "model-invocation"
    assert payload["actionType"] == "tool-call"
    assert payload["provider"] == "openai"
    assert payload["inputTokens"] == 10
    assert "tool" not in payload


def test_build_model_activity_request_id_default():
    class Usage:
        provider = "deepseek"
        model = None
        input_tokens = None
        output_tokens = None
        total_tokens = None
        estimated_cost_minor_units = None
        provider_request_id = "req-9"

    payload = build_model_activity(
        "agent-1",
        Usage(),
        ActivityPolicyContext(policy_version="bond-policy-v1"),
        occurred_at="2026-01-01T00:00:00.000Z",
    )
    assert payload["activityId"] == "req-9"


def test_build_model_activity_requires_provider():
    class Usage:
        provider = "  "
        model = None
        input_tokens = None
        output_tokens = None
        total_tokens = None
        estimated_cost_minor_units = None
        provider_request_id = None

    assert (
        code_of(
            lambda: build_model_activity(
                "agent-1",
                Usage(),
                ActivityPolicyContext(policy_version="bond-policy-v1"),
            )
        )
        == "INVALID_ACTIVITY_INPUT"
    )


def test_provider_secrets_prompts_completions_never_extracted():
    poisoned = {
        "model": "gpt-4o",
        "id": "chatcmpl-poison",
        "api_key": "sk-LIVE-KEY-DO-NOT-STORE",
        "authorization": "Bearer sk-LIVE-KEY-DO-NOT-STORE",
        "prompt": "super secret system prompt",
        "messages": [{"role": "user", "content": "hidden user content"}],
        "choices": [
            {"message": {"content": "hidden model completion"}}
        ],
        "usage": {"prompt_tokens": 3, "completion_tokens": 4,
                  "total_tokens": 7},
    }
    usage = normalize_openai_usage(poisoned)
    serialized = json.dumps(
        {
            "provider": usage.provider,
            "model": usage.model,
            "input_tokens": usage.input_tokens,
            "output_tokens": usage.output_tokens,
            "total_tokens": usage.total_tokens,
            "cost": usage.estimated_cost_minor_units,
            "request_id": usage.provider_request_id,
        }
    )
    for banned in (
        "sk-LIVE-KEY-DO-NOT-STORE",
        "super secret system prompt",
        "hidden user content",
        "hidden model completion",
        "authorization",
    ):
        assert banned not in serialized
