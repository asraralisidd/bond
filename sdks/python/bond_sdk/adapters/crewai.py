"""Minimal CrewAI event mapper (Phase 24).

Translates CrewAI-style task/tool events into BOND ``ActivityInput``
objects. Duck-typed throughout: accepts plain mappings and
attribute-bearing objects, never imports ``crewai`` (not installed,
not required). Unknown or malformed shapes raise ``BondApiError``
(``INVALID_ACTIVITY_INPUT``) — never fabricated.

[VERIFY-FRAMEWORK]: mappings below assume CrewAI task outputs
exposing a text payload (``raw``/``output``/``result``/``content``)
plus optional ``description`` and ``agent`` role, and tool uses as
``name``/``input`` (or ``args``/``arguments``) pairs. CrewAI's API
surface varies by version; if the installed version differs, only
the extractors here need adjustment — never the BOND protocol.

Security: no tokens, keys, wallet data, or logging. Only scalar
metadata and caller-summarized text pass through; raw tool results
and arbitrary objects are never serialized.
"""

from __future__ import annotations

from collections.abc import Mapping
from typing import Any, Literal

from ..activity import (
    ActivityInput,
    ActivityPolicyContext,
    ReporterSeverity,
)
from ..errors import BondApiError

CrewActionType = Literal["message", "tool-call"]


def _invalid(message: str) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


def _require_name(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            f"Invalid CrewAI event: {field_name} must be a non-empty string"
        )
    return value.strip()


def _read_field(source: Any, name: str) -> Any:
    if isinstance(source, Mapping):
        return source.get(name)
    return getattr(source, name, None)


def _task_text(task: Any) -> str:
    """Extract the text payload from a CrewAI-style task output."""
    for key in ("raw", "output", "result", "content"):
        value = _read_field(task, key)
        if isinstance(value, str) and value.strip():
            return value
    raise _invalid(
        "Invalid CrewAI event: task output has no text payload "
        "(expected raw/output/result/content)"
    )


def _scalar_metadata(args: Any) -> dict[str, object]:
    if not isinstance(args, Mapping):
        raise _invalid(
            "Invalid CrewAI event: tool input must be a mapping or omitted"
        )
    safe: dict[str, object] = {}
    for key, value in args.items():
        if not isinstance(key, str):
            raise _invalid(
                "Invalid CrewAI event: tool input keys must be strings"
            )
        if (
            isinstance(value, str)
            or isinstance(value, bool)
            or isinstance(value, (int, float))
            or value is None
        ):
            safe[key] = value
    return safe


class CrewAIActivityAdapter:
    """Map CrewAI-style events to BOND activities.

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

    def from_task_output(
        self,
        task: Any,
        *,
        action: str | None = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
        reporter_severity: ReporterSeverity | None = None,
    ) -> ActivityInput:
        """Map a completed crew task to a ``message`` activity."""
        text = _task_text(task)
        description = _read_field(task, "description")
        resolved_action = action
        if resolved_action is None:
            resolved_action = (
                description.strip()
                if isinstance(description, str) and description.strip()
                else "crew-task"
            )
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="message",
            action=_require_name(resolved_action, "action"),
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            text_snippet=text,
            reporter_severity=reporter_severity,
        )

    def from_tool_use(
        self,
        name: str,
        tool_input: Mapping[str, object] | None = None,
        *,
        action: str | None = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
    ) -> ActivityInput:
        """Map a CrewAI tool invocation to a ``tool-call`` activity."""
        tool = _require_name(name, "tool name")
        raw_input = tool_input
        if raw_input is None:
            raw_input = {}
        metadata = _scalar_metadata(raw_input)
        # CrewAI uses several input key spellings; callers pass the
        # already-located mapping, so no guessing happens here.
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="tool-call",
            action=action if action is not None else tool,
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            tool=tool,
            metadata=metadata or None,
        )
