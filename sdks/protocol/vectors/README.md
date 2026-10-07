# BOND Protocol Vectors (canonical)

These fixtures are the **source of truth for cross-language protocol
compatibility** between `@bond/sdk` (TypeScript) and `bond_sdk`
(Python). Both SDK test suites read **these exact files** — no copies,
no forks. If the suites disagree, one of the SDKs is wrong (or the
fixture is; see below).

## Purpose

Prevent TypeScript and Python SDK behavior from drifting apart:
identical inputs must serialize to identical wire JSON, identical
responses must map to identical error/data shapes.

## What is covered

- `registration.json` — valid registration payloads (exact wire JSON)
  plus invalid cases with deterministic server codes.
- `activities.json` — all seven action types with representative
  optionals, plus invalid cases both SDK builders must reject with
  `INVALID_ACTIVITY_INPUT`.
- `errors.json` — HTTP status + headers + body mapped into SDK error
  classes (code/message/status/requestId/retryAfter).
- `envelopes.json` — successful `{data}` responses unwrapped by SDKs.

## How TypeScript consumes vectors

`packages/sdk/src/vectors.test.ts` loads the JSON files from disk,
builds payloads with `buildActivity`, sends canned requests through a
mocked `fetchFn`, and deep-compares results against `expected`. No
network access. Fixture `input` keys are already camelCase, matching
the TS builder input shape.

## How Python consumes vectors

`sdks/python/tests/test_vectors.py` loads the **same files** and maps
the canonical camelCase inputs to `ActivityInput` snake_case fields via
an explicit, reviewed translation table (test-only). It then asserts
`to_dict()` deep-equals `expected`, and drives mocked-transport error /
envelope cases identically to the TS runner.

## Adding a new vector

1. Add the entry to the appropriate file with a unique `name`.
2. Use synthetic values only — no credentials, tokens, wallet
   secrets, keys, witnesses, personal data, or real endpoints.
3. Keep dynamic fields fixed (UUIDs/timestamps as literal strings) so
   comparisons stay exact — no fuzzy matching, no normalization beyond
   standard JSON parsing.
4. Run both suites; both must pass unmodified apart from the new case.

## Stability requirement

Equivalent serialization must remain byte-stable: do not reorder,
rename, or restate fixtures to make a failing SDK pass. A red vector
means an SDK (or rarely, the fixture) is wrong — fix the code, not the
fixture, and document genuine discrepancies in the Phase 16.3 report.

## Intentionally NOT covered

Backend validation beyond the deterministic client-side subset (the API
test suite owns that); wallet challenge/signature flows (covered by
backend auth tests with real crypto); chain/contract behavior; timing
or performance characteristics.
