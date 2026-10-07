"""Local/custom model usage normalization.

Accepts a small family of common key spellings so self-hosted and
custom providers map without bespoke code. Anything outside the
accepted keys is ignored — never coerced, never fabricated. Costs
map only from explicit digit-string fields; no price tables exist
anywhere in BOND, so undocumented cost shapes stay absent.
"""

from __future__ import annotations

from typing import Any

from ._core import NormalizedModelUsage, normalize_usage


def _response_provider(response: Any) -> str | None:
    if isinstance(response, dict):
        value = response.get("provider")
        if isinstance(value, str) and value.strip():
            return value.strip()
    return None


def normalize_local_usage(
    response: Any,
    *,
    provider: str | None = None,
    model: str | None = None,
) -> NormalizedModelUsage:
    """Normalize a local/custom provider usage mapping or object."""
    resolved = provider
    if resolved is None:
        resolved = _response_provider(response) or "local"
    return normalize_usage(
        provider=resolved,
        response=response,
        model=model,
        input_keys=(
            "input_tokens",
            "prompt_tokens",
            "promptTokenCount",
            "prompt_token_count",
        ),
        output_keys=(
            "output_tokens",
            "completion_tokens",
            "candidatesTokenCount",
            "candidates_token_count",
        ),
        total_keys=(
            "total_tokens",
            "totalTokenCount",
            "total_token_count",
        ),
        cost_keys=(
            "cost_minor_units",
            "cost",
            "estimated_cost_minor_units",
        ),
    )
