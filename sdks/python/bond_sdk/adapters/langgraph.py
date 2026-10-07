"""Minimal LangGraph event mapper (Phase 16.5).

Translates LangGraph-style message/tool/node events into BOND
``ActivityInput`` objects. Duck-typed throughout: accepts plain
mappings and attribute-bearing objects, never imports ``langgraph``
(not installed, not required). Unknown or malformed shapes raise
``BondApiError`` (``INVALID_ACTIVITY_INPUT``) — never fabricated into
an unrelated activity type.

[VERIFY-LANGGRAPH]: field shapes below (``content`` as ``str`` or a
list of ``{"type": "text", "text": ...}`` blocks, tool ``name``/``args``
pairs, node state-update mappings) follow the stable langchain-core
message conventions. If the installed LangGraph version differs, only
the extractors here need adjustment — never the BOND protocol.

Security: no tokens, keys, wallet data, or logging. Tool arguments
and node state pass through scalar-only filtering plus the SDK's
existing redaction/truncation at build time. Raw tool results and
arbitrary objects are never serialized.
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

NodeActionType = Literal["message", "policy-decision"]


def _invalid(message: string) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


def _require_name(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            f"Invalid LangGraph event: {field_name} must be a non-empty string"
        )
    return value.strip()


def _read_field(source: Any, name: str) -> Any:
    """Read ``name`` from a mapping or an attribute-bearing object."""
    if isinstance(source, Mapping):
        return source.get(name)
    return getattr(source, name, None)


def _normalize_content(content: Any) -> str:
    """Normalize message content to plain text.

    Accepts ``str`` directly, or a list of content blocks from which
    only ``{"type": "text", "text": ...}`` string parts are joined.
    Anything else (binary blocks, arbitrary objects, ``repr()`` dumps)
    is rejected — never silently converted.
    """
    if isinstance(content, str):
        if not content.strip():
            raise _invalid("Invalid LangGraph event: message content is empty")
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for block in content:
            text: Any = None
            if isinstance(block, Mapping):
                if block.get("type") == "text":
                    text = block.get("text")
            else:
                text = getattr(block, "text", None)
                if getattr(block, "type", None) != "text":
                    continue
            if isinstance(text, str) and text.strip():
                parts.append(text)
        if not parts:
            raise _invalid(
                "Invalid LangGraph event: no usable text in message content"
            )
        return "\n".join(parts)
    raise _invalid(
        "Invalid LangGraph event: message content must be text or text blocks"
    )


def _scalar_metadata(args: Any) -> dict[str, object]:
    """Keep scalar mapping values only; reject anything else.

    Non-mapping args raise (malformed tool call). Non-string keys raise
    (JSON objects require string keys; silent coercion could collide).
    Non-scalar values are dropped — secret filtering happens downstream
    in the SDK redaction layer.
    """
    if not isinstance(args, Mapping):
        raise _invalid(
            "Invalid LangGraph event: tool args must be a mapping or omitted"
        )
    safe: dict[str, object] = {}
    for key, value in args.items():
        if not isinstance(key, str):
            raise _invalid(
                "Invalid LangGraph event: tool arg keys must be strings"
            )
        if (
            isinstance(value, str)
            or isinstance(value, bool)
            or isinstance(value, (int, float))
            or value is None
        ):
            safe[key] = value
    return safe


class LangGraphActivityAdapter:
    """Map LangGraph-style events to BOND activities.

    Holds only mapping configuration (agent identity + policy
    context). Never holds a client, token, or credential; never
    performs I/O. The caller submits the returned ``ActivityInput``
    via ``BondClient.analyze_activity``.
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
        action: str = "agent-message",
        activity_id: str | None = None,
        occurred_at: str | None = None,
        reporter_severity: ReporterSeverity | None = None,
    ) -> ActivityInput:
        """Map a chat-style message event to a ``message`` activity."""
        content = _read_field(message, "content")
        if content is None:
            raise _invalid(
                "Invalid LangGraph event: message has no content"
            )
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="message",
            action=_require_name(action, "action"),
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            text_snippet=_normalize_content(content),
            reporter_severity=reporter_severity,
        )

    def from_tool_call(
        self,
        name: str,
        args: Mapping[str, object] | None = None,
        *,
        result: str | None = None,
        action: str | None = None,
        activity_id: str | None = None,
        occurred_at: str | None = None,
    ) -> ActivityInput:
        """Map a tool invocation to a ``tool-call`` activity.

        ``result`` accepts text only — raw tool outputs must be
        summarized by the caller, never dumped wholesale.
        """
        tool = _require_name(name, "tool name")
        if result is not None and not isinstance(result, str):
            raise _invalid(
                "Invalid LangGraph event: tool result must be text or omitted"
            )
        return ActivityInput(
            agent_id=self._agent_id,
            action_type="tool-call",
            action=action if action is not None else tool,
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            tool=tool,
            text_snippet=result,
            metadata=_scalar_metadata(args) if args is not None else None,
        )

    def from_node_output(
        self,
        node_name: str,
        output: Any,
        *,
        action_type: NodeActionType = "message",
        activity_id: str | None = None,
        occurred_at: str | None = None,
    ) -> ActivityInput:
        """Map a LangGraph node result to a ``message``/``policy-decision``.

        Text outputs become the snippet; scalar-only mappings become
        metadata. Anything else is rejected, never coerced into text.
        """
        node = _require_name(node_name, "node name")
        if action_type not in ("message", "policy-decision"):
            raise _invalid(
                "Invalid LangGraph event: node action_type must be "
                "message or policy-decision"
            )
        text: str | None = None
        metadata: dict[str, object] | None = None
        if isinstance(output, str):
            if not output.strip():
                raise _invalid(
                    "Invalid LangGraph event: node output text is empty"
                )
            text = output
        elif isinstance(output, Mapping):
            metadata = _scalar_metadata(output)
        else:
            raise _invalid(
                "Invalid LangGraph event: node output must be text or "
                "a scalar mapping"
            )
        return ActivityInput(
            agent_id=self._agent_id,
            action_type=action_type,
            action=f"langgraph:{node}",
            policy_context=self._policy_context,
            activity_id=activity_id,
            occurred_at=occurred_at,
            text_snippet=text,
            metadata=metadata,
        )
