"""Anthropic usage normalization.

[VERIFY-PROVIDER]: field paths follow the public Anthropic messages
shape — ``usage.input_tokens / output_tokens``, top-level ``model``
and ``id``. Anthropic responses carry no total; the shared core
derives it as input+output (documented derivation, not provider
data). No ``anthropic`` package import; duck-typed.
"""

from __future__ import annotations

from typing import Any

from ._core import NormalizedModelUsage, normalize_usage


def normalize_anthropic_usage(
    response: Any,
    *,
    model: str | None = None,
) -> NormalizedModelUsage:
    """Normalize an Anthropic messages-style response object."""
    return normalize_usage(
        provider="anthropic",
        response=response,
        model=model,
        input_keys=("input_tokens",),
        output_keys=("output_tokens",),
        total_keys=("total_tokens",),
    )
