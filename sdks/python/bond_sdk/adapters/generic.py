"""Generic framework adapter boundary (Phase 24).

For custom/in-house agent frameworks with no dedicated BOND adapter:
callers describe their event explicitly (action type, action, optional
tool/text/metadata/usage) and receive a validated ``ActivityInput``.
No guessing, no schema sniffing — the caller asserts the mapping, and
BOND validates it like any hand-built activity.

Use a dedicated adapter (LangGraph, CrewAI, AutoGen) when one fits;
use this boundary otherwise. Either way the output is the same
normalized protocol representation.
"""

from __future__ import annotations

from typing import Any, Literal

from ..activity import ActivityInput, ActivityPolicyContext
from ..errors import BondApiError

GenericActionType = Literal[
    "tool-call",
    "transfer",
    "message",
    "policy-decision",
    "auth",
    "config-change",
    "external-report",
]


def _invalid(message: str) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


class GenericFrameworkAdapter:
    """Explicit caller-described mapping to BOND activities.

    Holds only mapping configuration (agent identity + policy
    context). Never holds a client, token, or credential; never
    performs I/O.
    """

    def __init__(
        self,
        agent_id: str,
        policy_context: ActivityPolicyContext,
    ) -> None:
        if not isinstance(agent_id, str) or not agent_id.strip():
            raise _invalid("Invalid adapter: agent_id must be non-empty")
        self._agent_id = agent_id
        self._policy_context = policy_context

    def describe_event(
        self,
        *,
        action_type: GenericActionType,
        action: str,
        tool: str | None = None,
        text_snippet: str | None = None,
        metadata: dict[str, object] | None = None,
        usage: Any = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
    ) -> ActivityInput:
        """Build an activity from an explicitly described framework event.

        ``usage`` is a ``providers.NormalizedModelUsage`` (or any
        object with the same attribute names); only its counters and
        identifiers are read — never prompts or completions.
        """
        if not isinstance(action, str) or not action.strip():
            raise _invalid(
                "Invalid framework event: action must be a non-empty string"
            )
        kwargs: dict[str, Any] = {}
        if tool is not None:
            kwargs["tool"] = tool
        if text_snippet is not None:
            kwargs["text_snippet"] = text_snippet
        if metadata is not None:
            kwargs["metadata"] = metadata
        if usage is not None:
            provider = getattr(usage, "provider", None)
            if provider is not None:
                kwargs["provider"] = provider
            for field in (
                "model",
                "input_tokens",
                "output_tokens",
                "total_tokens",
                "estimated_cost_minor_units",
            ):
                value = getattr(usage, field, None)
                if value is not None:
                    kwargs[field] = value
        return ActivityInput(
            agent_id=self._agent_id,
            action_type=action_type,
            action=action,
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            **kwargs,  # type: ignore[arg-type]
        )
