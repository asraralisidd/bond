"""Provider-neutral model usage normalization (Phase 24).

Pure mapping helpers translating provider response shapes into BOND's
normalized usage representation. No provider SDK imports, no network,
no credentials, no storage — callers pass already-obtained response
objects (mappings or attribute-bearing objects).

Security: only usage counters and model identifiers are extracted.
Prompts, completions, hidden reasoning, and API keys are never read
— unknown fields are ignored, never serialized.

BOND does not store provider API keys.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any

from ..errors import BondApiError

MAX_SAFE_TOKENS = 2**53 - 1


def _invalid(message: str) -> BondApiError:
    return BondApiError("INVALID_ACTIVITY_INPUT", message, 0, None)


@dataclass(frozen=True)
class NormalizedModelUsage:
    """Provider-neutral usage. All counters optional; absent stays absent."""

    provider: str
    model: str | None = None
    input_tokens: int | None = None
    output_tokens: int | None = None
    total_tokens: int | None = None
    estimated_cost_minor_units: str | None = None
    provider_request_id: str | None = None


def _require_name(value: object, field_name: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            f"Invalid provider usage: {field_name} must be a non-empty string"
        )
    return value.strip()


def _optional_tokens(value: object, field_name: str) -> int | None:
    """Strict non-negative ints; bools/floats/strings rejected, never coerced."""
    if value is None:
        return None
    if (
        not isinstance(value, int)
        or isinstance(value, bool)
        or value < 0
        or value > MAX_SAFE_TOKENS
    ):
        raise _invalid(
            f"Invalid provider usage: {field_name} must be a non-negative integer"
        )
    return value


def _optional_cost(value: object, field_name: str) -> str | None:
    """Explicit digit-string costs only. No price tables, no fabrication."""
    if value is None:
        return None
    if (
        not isinstance(value, str)
        or not value.isdigit()
        or len(value) > 30
    ):
        raise _invalid(
            f"Invalid provider usage: {field_name} must be a digit string"
        )
    return value


def _optional_request_id(value: object) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        raise _invalid(
            "Invalid provider usage: request id must be a non-empty string"
        )
    return value.strip()


def _read(source: Any, *names: str) -> Any:
    """Read the first present field from a mapping or object."""
    for name in names:
        if isinstance(source, dict):
            if name in source:
                return source[name]
        else:
            value = getattr(source, name, None)
            if value is not None:
                return value
    return None


def _usage_block(source: Any) -> Any:
    """Locate the nested usage object across known envelope keys."""
    if source is None:
        return None
    for key in ("usage", "usageMetadata", "usage_metadata"):
        block = _read(source, key)
        if block is not None:
            return block
    return None





def normalize_usage(
    *,
    provider: str,
    response: Any,
    model: str | None = None,
    model_keys: tuple[str, ...] = ("model", "modelVersion", "model_version"),
    input_keys: tuple[str, ...] = ("input_tokens",),
    output_keys: tuple[str, ...] = ("output_tokens",),
    total_keys: tuple[str, ...] = ("total_tokens",),
    cost_keys: tuple[str, ...] = ("cost_minor_units", "cost"),
    request_id_keys: tuple[str, ...] = ("id", "request_id", "requestId"),
) -> NormalizedModelUsage:
    """Shared core: extract and validate usage from a response envelope.

    Total rule (documented, deterministic): an explicitly supplied
    total is kept as the provider's authority even when it disagrees
    with input+output — never silently rewritten. When absent, the
    total is derived as input+output only if at least one side is
    present; otherwise it stays absent. Nothing is invented.
    """
    provider_name = _require_name(provider, "provider")
    if response is None:
        raise _invalid("Invalid provider usage: response is required")
    block = _usage_block(response)
    if block is None:
        block = response
    resolved_model = model
    if resolved_model is None:
        for key in model_keys:
            candidate = _read(response, key) or _read(block, key)
            if isinstance(candidate, str) and candidate.strip():
                resolved_model = candidate.strip()
                break
    input_tokens = _optional_tokens(
        _read(block, *input_keys), "input_tokens"
    )
    output_tokens = _optional_tokens(
        _read(block, *output_keys), "output_tokens"
    )
    total_tokens = _optional_tokens(_read(block, *total_keys), "total_tokens")
    if total_tokens is None and (
        input_tokens is not None or output_tokens is not None
    ):
        total_tokens = (input_tokens or 0) + (output_tokens or 0)
    cost = _optional_cost(_read(block, *cost_keys), "cost")
    request_id = _optional_request_id(_read(response, *request_id_keys))
    return NormalizedModelUsage(
        provider=provider_name,
        model=resolved_model,
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=total_tokens,
        estimated_cost_minor_units=cost,
        provider_request_id=request_id,
    )
