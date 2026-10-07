"""Gemini usage normalization.

[VERIFY-PROVIDER]: field paths follow the public Gemini
``GenerateContentResponse`` shape — ``usageMetadata.promptTokenCount
/ candidatesTokenCount / totalTokenCount``. Gemini responses do not
reliably echo the model, so callers should pass ``model``
explicitly; the ``modelVersion``/``model`` keys are best-effort
fallbacks. No Google package import; duck-typed.
"""

from __future__ import annotations

from typing import Any

from ._core import NormalizedModelUsage, normalize_usage


def normalize_gemini_usage(
    response: Any,
    *,
    model: str | None = None,
) -> NormalizedModelUsage:
    """Normalize a Gemini generate-content-style response object."""
    return normalize_usage(
        provider="gemini",
        response=response,
        model=model,
        input_keys=("promptTokenCount", "prompt_token_count"),
        output_keys=("candidatesTokenCount", "candidates_token_count"),
        total_keys=("totalTokenCount", "total_token_count"),
    )
