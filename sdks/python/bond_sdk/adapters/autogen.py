"""Minimal AutoGen event mapper (Phase 24).

Translates AutoGen-style conversation messages and function calls
into BOND ``ActivityInput`` objects. Duck-typed throughout: accepts
plain mappings and attribute-bearing objects, never imports
``autogen``/``pyautogen`` (not installed, not required). Unknown or
malformed shapes raise ``BondApiError`` (``INVALID_ACTIVITY_INPUT``)
— never fabricated.

[VERIFY-FRAMEWORK]: mappings below assume the stable AutoGen message
shape — ``{"role": ..., "content": str, "name": ...}`` — and
function calls as ``{"name": ..., "arguments": {...}}`` (with
``args``/``input`` accepted as aliases). If the installed AutoGen
version differs, only the extractors here need adjustment — never
the BOND protocol.

Security: no tokens, keys, wallet data, or logging. Message content
becomes the snippet; function arguments pass scalar-only filtering.
Raw results and arbitrary objects are never serialized.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any

from ..activity import (
    ActivityInput,
    ActivityPolicyContext,
    ReporterSeverity,
)
from ..errors import BondApiError


def _invalid(message: str) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


def _require_name(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            f"Invalid AutoGen event: {field_name} must be a non-empty string"
        )
    return value.strip()


def _read_field(source: Any, name: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(name)
    return getattr(source, name, None)


def _scalar_metadata(args: Any) -> dict[str, object]:
    if not isinstance(args, Mapping):
        raise _invalid(
            "Invalid AutoGen event: function arguments must be a mapping"
        )
    safe: dict[str, object] = {}
    for key, value in args.items():
        if not isinstance(key, str):
            raise _invalid(
                "Invalid AutoGen event: argument keys must be strings"
            )
        if (
            isinstance(value, str)
            or isinstance(value, bool)
            or isinstance(value, (int, float))
            or value is None
        ):
            safe[key] = value
    return safe


class AutoGenActivityAdapter:
    """Map AutoGen-style events to BOND activities.

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

    def from_message(
        self,
        message: Any,
        *,
        action: str | None = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
        reporter_severity: ReporterSeverity | None = None,
    ) -> ActivityInput:
        """Map a conversation message to a ``message`` activity."""
        content = _read_field(message, "content")
        if not isinstance(content, str) or not content.strip():
            raise _invalid(
                "Invalid AutoGen event: message content must be non-empty text"
            )
        role = _read_field(message, "role")
        name = _read_field(message, "name")
        resolved_action = action
        if resolved_action is None:
            if isinstance(name, str) and name.strip():
                resolved_action = name.strip()
            elif isinstance(role, str) and role.strip():
                resolved_action = f"autogen:{role.strip()}"
            else:
                resolved_action = "autogen-message"
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="message",
            action=_require_name(resolved_action, "action"),
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            text_snippet=content,
            reporter_severity=reporter_severity,
        )

    def from_function_call(
        self,
        call: Any,
        *,
        action: str | None = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
    ) -> ActivityInput:
        """Map a function call to a ``tool-call`` activity."""
        name = _read_field(call, "name")
        tool = _require_name(name, "function name")
        arguments: Any = None
        for key in ("arguments", "args", "input", "parameters"):
            candidate = _read_field(call, key)
            if candidate is not None:
                arguments = candidate
                break
        metadata = (
            _scalar_metadata(arguments) if arguments is not None else None
        )
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="tool-call",
            action=action if action is not None else tool,
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            tool=tool,
            metadata=metadata,
        )
