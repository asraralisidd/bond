"""DeepSeek usage normalization.

[VERIFY-PROVIDER]: DeepSeek exposes an OpenAI-compatible chat API,
so the usage envelope mirrors OpenAI — ``usage.prompt_tokens /
completion_tokens / total_tokens`` with top-level ``model`` and
``id``. Kept as a separate adapter so future divergence only
touches this module. No ``openai``/``deepseek`` package import.
"""

from __future__ import annotations

from typing import Any

from ._core import NormalizedModelUsage, normalize_usage


def normalize_deepseek_usage(
    response: Any,
    *,
    model: str | None = None,
) -> NormalizedModelUsage:
    """Normalize a DeepSeek chat-style response object."""
    return normalize_usage(
        provider="deepseek",
        response=response,
        model=model,
        input_keys=("prompt_tokens",),
        output_keys=("completion_tokens",),
        total_keys=("total_tokens",),
    )
