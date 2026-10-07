"""Agent-scoped client (Phase 18, OFF-CHAIN only).

A thin, restricted view over :class:`BondClient` for callers holding an
agent credential: only the five capabilities an agent credential may
carry are exposed. Everything else (bonds, transactions, attestations,
credential management) stays on ``BondClient`` with operator sessions.
The credential itself lives in the wrapped client, in memory only.
"""

from __future__ import annotations

from typing import Any

from .auth import TokenProvider
from .client import BondClient


class BondAgentClient:
    """Restricted client for agent-credential holders.

    Construct with a ``BondClient`` configured with an agent credential
    (``"<credentialId>.<secret>"``), e.g.::

        op = BondClient(base_url=..., token=operator_token)
        created = op.create_agent_credential(agent_id)
        agent = BondAgentClient(
            BondClient(base_url=..., token=created["secret"])
        )
        agent.analyze_activity(agent_id, activity)
    """

    def __init__(self, client: BondClient) -> None:
        self._client = client

    def set_token(self, token: str | TokenProvider | None) -> None:
        """Replace the in-memory agent credential (never persisted)."""
        self._client.set_token(token)

    @property
    def last_request_id(self) -> str | None:
        """Request id of the most recently completed API call."""
        return self._client.last_request_id

    def analyze_activity(
        self,
        agent_id: str,
        activity: dict[str, Any],
        delegation_id: str | None = None,
    ) -> Any:
        """Submit activity (requires activity:submit, or delegation)."""
        return self._client.analyze_activity(
            agent_id, activity, delegation_id=delegation_id
        )

    def list_flags(self, agent_id: str) -> Any:
        """List own risk flags (requires risk:read)."""
        return self._client.list_flags(agent_id)

    def get_flag(self, flag_id: str) -> Any:
        """Fetch one owned risk flag (requires risk:read)."""
        return self._client.get_flag(flag_id)

    def list_events(
        self,
        limit: int | None = None,
        cursor: str | None = None,
        event_type: str | None = None,
    ) -> Any:
        """Poll own event feed (requires risk:read)."""
        return self._client.list_events(
            limit=limit, cursor=cursor, event_type=event_type
        )

    def get_agent(self, agent_id: str) -> Any:
        """Fetch own agent record (requires agent:read)."""
        return self._client.get_agent(agent_id)

    def get_reputation(self, agent_id: str, limit: int = 20) -> Any:
        """Fetch own reputation (requires reputation:read)."""
        return self._client.get_agent_reputation(agent_id, limit=limit)

    def get_policy(self, agent_id: str) -> Any:
        """Fetch own effective policy (requires agent:read; read-only)."""
        return self._client.get_agent_policy(agent_id)

    def create_delegation(
        self, delegator_agent_id: str, delegation: dict[str, Any]
    ) -> Any:
        """Delegate authority (server verifies caps + self-access)."""
        return self._client.create_delegation(delegator_agent_id, delegation)

    def list_delegations(
        self, agent_id: str, role: str = "all", live_only: bool = True
    ) -> Any:
        """List delegations involving an agent (server scopes access)."""
        return self._client.list_delegations(
            agent_id, role=role, live_only=live_only
        )

    def get_delegation(self, delegation_id: str) -> Any:
        """Fetch one delegation (delegator, delegate, or operator)."""
        return self._client.get_delegation(delegation_id)

    def revoke_delegation(
        self, delegation_id: str, reason: str | None = None
    ) -> Any:
        """Revoke own delegation (delegator only; idempotent)."""
        return self._client.revoke_delegation(delegation_id, reason=reason)

    def verify_agent(self, agent_id: str) -> Any:
        """Public verification (requires verification:read)."""
        return self._client.verify_agent(agent_id)
