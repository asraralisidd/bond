"""BOND SDK framework adapters.

Mapping-only helpers that translate external agent-framework events
into :class:`~bond_sdk.activity.ActivityInput` objects. Adapters hold
mapping configuration only: no network, no credentials, no storage.
Callers submit through ``BondClient`` themselves.
"""

from .langgraph import LangGraphActivityAdapter
from .crewai import CrewAIActivityAdapter
from .autogen import AutoGenActivityAdapter
from .generic import GenericFrameworkAdapter

__all__ = [
    "LangGraphActivityAdapter",
    "CrewAIActivityAdapter",
    "AutoGenActivityAdapter",
    "GenericFrameworkAdapter",
]
