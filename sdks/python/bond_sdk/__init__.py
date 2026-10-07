"""Framework-free Python SDK for the BOND protocol.

No AI-model, framework, wallet, or blockchain dependencies. The token
lives in memory only and is never persisted or logged.
"""

from .activity import (
    ACTIVITY_TYPES,
    ActivityInput,
    ActivityPolicyContext,
    ActivityType,
    ReporterSeverity,
    build_activity,
)
from .agent import BondAgentClient
from .auth import TokenProvider, resolve_token
from .client import BondClient, new_idempotency_key, resolve_api_base
from .errors import BondApiError, friendly_message, parse_retry_after
from .redact import (
    is_secret_like_key,
    redact_metadata,
    truncate_snippet,
)

__all__ = [
    "ACTIVITY_TYPES",
    "ActivityInput",
    "ActivityPolicyContext",
    "ActivityType",
    "BondAgentClient",
    "BondApiError",
    "BondClient",
    "ReporterSeverity",
    "TokenProvider",
    "build_activity",
    "friendly_message",
    "is_secret_like_key",
    "new_idempotency_key",
    "parse_retry_after",
    "redact_metadata",
    "resolve_api_base",
    "resolve_token",
    "truncate_snippet",
]

__version__ = "0.1.0"
