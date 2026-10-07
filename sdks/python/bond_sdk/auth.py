"""Token handling for the BOND Python SDK.

Current BOND authentication is operator-scoped: there are NOT yet
per-agent credentials. An external agent authenticates with an operator
bearer token (dev-key session for development, wallet challenge-response
for production) and acts with that operator's authority. Document this
limitation honestly: do NOT imply an agent token is narrowly scoped.

Tokens live in memory only. This module never writes tokens to files,
never logs tokens, and never includes tokens in exception messages.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Union

TokenProvider = Callable[[], Union[str, None]]


def resolve_token(token: Union[str, TokenProvider, None]) -> str | None:
    """Resolve a static token or provider to a bearer value or None.

    Empty strings are treated as absent (no Authorization header sent).
    """
    if token is None:
        return None
    value = token() if callable(token) else token
    if not isinstance(value, str) or not value:
        return None
    return value
