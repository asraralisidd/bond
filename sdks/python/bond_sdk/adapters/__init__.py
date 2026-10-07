"""BOND SDK framework adapters.

Mapping-only helpers that translate external agent-framework events
into :class:`~bond_sdk.activity.ActivityInput` objects. Adapters hold
mapping configuration only: no network, no credentials, no storage.
Callers submit through ``BondClient`` themselves.
"""

from .langgraph import LangGraphActivityAdapter

__all__ = ["LangGraphActivityAdapter"]
