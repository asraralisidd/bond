"""Provider-agnostic activity builder.

Constructs the exact RawActivityInput contract the backend validates —
no OpenAI, Claude, Gemini, LangChain, CrewAI, or other provider shapes
anywhere. Serialized JSON keys match the BOND API contract exactly
(camelCase); Python attribute names follow Python conventions.

Defaults: activity_id (UUID4) and occurred_at (current UTC ISO
timestamp). Validation mirrors server rules so malformed payloads fail
fast client-side; the server remains authoritative.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal
from uuid import uuid4

from .errors import BondApiError
from .redact import redact_metadata, truncate_snippet

ActivityType = Literal[
    "tool-call",
    "transfer",
    "message",
    "policy-decision",
    "auth",
    "config-change",
    "external-report",
]

ACTIVITY_TYPES: tuple[ActivityType, ...] = (
    "tool-call",
    "transfer",
    "message",
    "policy-decision",
    "auth",
    "config-change",
    "external-report",
)

ReporterSeverity = Literal["low", "medium", "high", "critical"]

_ISO_TIMESTAMP_PATTERN = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$"
)


def _invalid(message: str) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


def _require_text(value: object, field_name: str, max_length: int = 256) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            f"Invalid activity: {field_name} must be a non-empty string"
        )
    trimmed = value.strip()
    if len(trimmed) > max_length:
        raise _invalid(
            f"Invalid activity: {field_name} exceeds {max_length} characters"
        )
    return trimmed


def _require_tokens(value: object, field_name: str) -> int:
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > 2**53 - 1
    ):
        raise _invalid(
            f"Invalid activity: {field_name} must be a non-negative integer"
        )
    return value


@dataclass(frozen=True)
class ActivityPolicyContext:
    """Versioned policy supplied by the caller (not engine config)."""

    policy_version: str
    allowed_actions: tuple[str, ...] | None = None
    declared_tools: tuple[str, ...] | None = None
    denylisted_actions: tuple[str, ...] | None = None
    spend_limit_minor_units: str | None = None
    exfil_threshold_bytes: int | None = None

    def to_dict(self) -> dict[str, object]:
        result: dict[str, object] = {
            "policyVersion": _require_text(
                self.policy_version, "policyContext.policyVersion"
            )
        }
        if self.allowed_actions is not None:
            result["allowedActions"] = list(self.allowed_actions)
        if self.declared_tools is not None:
            result["declaredTools"] = list(self.declared_tools)
        if self.denylisted_actions is not None:
            result["denylistedActions"] = list(self.denylisted_actions)
        if self.spend_limit_minor_units is not None:
            result["spendLimitMinorUnits"] = self.spend_limit_minor_units
        if self.exfil_threshold_bytes is not None:
            result["exfilThresholdBytes"] = self.exfil_threshold_bytes
        return result


@dataclass(frozen=True)
class ActivityInput:
    """Caller-supplied activity fields. Serializes to RawActivityInput."""

    agent_id: str
    action_type: ActivityType
    action: str
    policy_context: ActivityPolicyContext
    activity_id: str | None = None
    occurred_at: str | None = None
    tool: str | None = None
    amount_minor_units: str | None = None
    external_destination: bool | None = None
    bytes_out: int | None = None
    text_snippet: str | None = None
    metadata: dict[str, object] | None = None
    reporter_severity: ReporterSeverity | None = None
    provider: str | None = None
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    estimated_cost_minor_units: str | None = None

    def to_dict(self) -> dict[str, object]:
        """Build validated payload with exact BOND JSON keys."""
        activity_id = (
            str(uuid4())
            if self.activity_id is None
            else _require_text(self.activity_id, "activityId")
        )
        agent_id = _require_text(self.agent_id, "agentId", 128)
        occurred_at = (
            datetime.now(timezone.utc).isoformat()
            if self.occurred_at is None
            else _require_text(self.occurred_at, "occurredAt")
        )
        if not _ISO_TIMESTAMP_PATTERN.match(occurred_at):
            raise _invalid(
                "Invalid activity: occurredAt must be an ISO timestamp"
            )
        if self.action_type not in ACTIVITY_TYPES:
            raise _invalid(
                "Invalid activity: actionType must be one of "
                + ", ".join(ACTIVITY_TYPES)
            )
        action = _require_text(self.action, "action")
        payload: dict[str, object] = {
            "activityId": activity_id,
            "agentId": agent_id,
            "occurredAt": occurred_at,
            "actionType": self.action_type,
            "action": action,
            "policyContext": self.policy_context.to_dict(),
        }
        if self.tool is not None:
            payload["tool"] = _require_text(self.tool, "tool")
        if self.amount_minor_units is not None:
            payload["amountMinorUnits"] = _require_text(
                self.amount_minor_units, "amountMinorUnits"
            )
        if self.external_destination is not None:
            payload["externalDestination"] = self.external_destination
        if self.bytes_out is not None:
            payload["bytesOut"] = self.bytes_out
        if self.text_snippet is not None:
            payload["textSnippet"] = truncate_snippet(self.text_snippet)
        if self.metadata is not None:
            safe_metadata, _dropped = redact_metadata(self.metadata)
            payload["metadata"] = safe_metadata
        if self.reporter_severity is not None:
            payload["reporterSeverity"] = self.reporter_severity
        if self.provider is not None:
            payload["provider"] = _require_text(self.provider, "provider")
        if self.model is not None:
            payload["model"] = _require_text(self.model, "model")
        if self.input_tokens is not None:
            payload["inputTokens"] = _require_tokens(
                self.input_tokens, "inputTokens"
            )
        if self.output_tokens is not None:
            payload["outputTokens"] = _require_tokens(
                self.output_tokens, "outputTokens"
            )
        if self.total_tokens is not None:
            payload["totalTokens"] = _require_tokens(
                self.total_tokens, "totalTokens"
            )
        if self.estimated_cost_minor_units is not None:
            payload["estimatedCostMinorUnits"] = _require_text(
                self.estimated_cost_minor_units, "estimatedCostMinorUnits"
            )
        return payload


def build_activity(
    agent_id: str,
    action_type: ActivityType,
    action: str,
    policy_context: ActivityPolicyContext,
    **kwargs: object,
) -> dict[str, object]:
    """Convenience constructor returning the validated JSON-ready payload."""
    return ActivityInput(
        agent_id=agent_id,
        action_type=action_type,
        action=action,
        policy_context=policy_context,
        **kwargs,  # type: ignore[arg-type]
    ).to_dict()


def build_model_activity(
    agent_id: str,
    usage: Any,
    policy_context: ActivityPolicyContext,
    *,
    action: str = "model-invocation",
    activity_id: str | None = None,
    occurred_at: str | None = None,
) -> dict[str, object]:
    """Build a model-call activity from normalized provider usage.

    Accepts a :class:`providers.NormalizedModelUsage` (or any object
    with the same attribute names). The call is represented as a
    ``tool-call`` with fixed action ``model-invocation`` and no tool:
    provider/model attribution (not tool identity) drives Phase 22
    model/provider policy checks, so tool allowlists are unaffected.
    The provider request id becomes the activity id only when the
    caller does not supply one explicitly.
    """
    provider = getattr(usage, "provider", None)
    if not isinstance(provider, str) or not provider.strip():
        raise _invalid("Invalid model usage: provider must be provided")
    resolved_activity_id = activity_id
    if resolved_activity_id is None:
        request_id = getattr(usage, "provider_request_id", None)
        if isinstance(request_id, str) and request_id.strip():
            resolved_activity_id = request_id.strip()
    return ActivityInput(
        agent_id=agent_id,
        action_type="tool-call",
        action=action,
        policy_context=policy_context,
        activity_id=resolved_activity_id,
        occurred_at=occurred_at,
        provider=provider.strip(),
        model=getattr(usage, "model", None),
        input_tokens=getattr(usage, "input_tokens", None),
        output_tokens=getattr(usage, "output_tokens", None),
        total_tokens=getattr(usage, "total_tokens", None),
        estimated_cost_minor_units=getattr(
            usage, "estimated_cost_minor_units", None
        ),
    ).to_dict()
