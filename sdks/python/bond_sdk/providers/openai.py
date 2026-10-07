"""OpenAI usage normalization.

[VERIFY-PROVIDER]: field paths follow the public OpenAI chat
completions shape — ``usage.prompt_tokens / completion_tokens /
total_tokens``, top-level ``model`` and ``id``. If the installed
client version differs, only these key tuples need adjustment.
No ``openai`` package import; duck-typed mappings or objects.
"""

from __future__ import annotations

from typing import Any

from ._core import NormalizedModelUsage, normalize_usage


def normalize_openai_usage(
    response: Any,
    *,
    model: str | None = None,
) -> NormalizedModelUsage:
    """Normalize an OpenAI chat-completion-style response object."""
    return normalize_usage(
        provider="openai",
        response=response,
        model=model,
        input_keys=("prompt_tokens",),
        output_keys=("completion_tokens",),
        total_keys=("total_tokens",),
    )
