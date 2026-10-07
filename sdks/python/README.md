# BOND Python SDK (`bond-sdk` 0.1.0)

Framework-free Python client for the BOND agent security and collateral
protocol. Model-provider agnostic (OpenAI, Claude, Gemini, DeepSeek,
local models) and framework agnostic (plain scripts, FastAPI, Flask,
custom agents; LangGraph/CrewAI later via thin mapping layers).

Behavioral twin of the TypeScript `@bond/sdk`: same endpoints, methods,
envelopes, error codes, idempotency rules, and activity contract.

## Installation

```bash
pip install ./sdks/python        # from the bond repository root
# runtime dependency: httpx
```

Requires Python 3.10+.

## Basic usage

```python
from bond_sdk import BondClient, build_activity, ActivityPolicyContext

client = BondClient(
    base_url="http://localhost:4000",
    token="sess_...",  # operator bearer token, kept in memory only
)

# Register this agent (operator action).
agent = client.register_agent(
    platform="custom",
    agent_type="custom",
    capabilities=["transfers"],
    external_ref="my-agent-1",
)

# Report activity (agent integration operation).
payload = build_activity(
    agent_id=agent["agentId"],
    action_type="transfer",
    action="pay-vendor",
    policy_context=ActivityPolicyContext(policy_version="bond-policy-v1"),
    metadata={"vendor": "acme"},
)
result = client.analyze_activity(agent["agentId"], payload)

# Check status.
me = client.get_agent(agent["agentId"])
flags = client.list_flags(agent["agentId"])

# Public (unauthenticated) self-check.
print(client.verify_agent(agent["agentId"]))
```

With a token provider (rotation-friendly):

```python
client = BondClient(base_url="...", token_provider=lambda: current_token())
```

## Authentication

BOND authentication is currently **operator-scoped**: there are no
per-agent credentials. An external agent uses an operator bearer token
obtained out of band:

- development: `POST /api/v1/auth/session` with the dev key
  (`client.create_session(dev_key, external_key)`)
- production: wallet challenge-response
  (`client.request_wallet_challenge()` → sign → `client.verify_wallet_challenge(...)`)

Do NOT imply an agent token is narrowly scoped — it carries the
operator's full authority. Tokens live in memory only: never written
to files, never logged, never included in exception messages.

## Reporting activity

Build payloads with `build_activity(...)` (or `ActivityInput(...).to_dict()`).
Defaults: `activity_id` (UUID4) and `occurred_at` (current UTC ISO
timestamp). Supported `action_type` values: `tool-call`, `transfer`,
`message`, `policy-decision`, `auth`, `config-change`,
`external-report`. The server validates everything; the SDK fails fast
client-side on malformed input.

## Checking status

`get_agent()` (status, policy version), `list_flags()` / `get_flag()`
(risk findings), `get_transaction()` (lifecycle state),
`verify_agent()` (public, unauthenticated).

## Error handling

All failures raise `BondApiError` with `code`, `message`, `status`,
`request_id`, and `retry_after` (populated from `Retry-After` on 429s,
else `None`). Stable machine-readable codes match the backend envelope
(`NOT_FOUND`, `FORBIDDEN`, `RATE_LIMITED`, `IDEMPOTENCY_CONFLICT`,
...). The SDK never retries automatically — on 429, back off using
`retry_after` and let the caller decide.

## Idempotency

Mutations send a fresh `Idempotency-Key` UUID4 per logical request
(`new_idempotency_key()`). Pass an explicit key to retry the identical
request; a reused key with a different payload returns 409
`IDEMPOTENCY_CONFLICT`. Transaction/attestation intents take an
explicit `idempotency_key` argument (no silent generation, except
`request_attestation`/`enforce_attestation` which fill one in when
omitted — mirroring the TypeScript SDK).

## Privacy / NEVER-send rules

The SDK redacts secret-like metadata keys client-side (defense in
depth; the backend remains authoritative) and truncates free text.
NEVER intentionally send: private keys, wallet seeds, wallet secrets,
ZK witnesses, blinding values, signing secrets, raw credentials,
unrelated session tokens, or full user secrets. Client-side redaction
does not guarantee secrets can never reach the server — keep secrets
out of activity payloads entirely.

## Operator-scoped credential limitation

There are no per-agent API keys in this BOND version. Every operation
in this SDK runs with the authority of the operator whose token is
configured. Operate one BOND operator per integration boundary, scope
agents via server-side ownership checks, and rotate tokens on any
suspected exposure.

## Example custom-agent integration

See `Basic usage` above: authenticate out-of-band → `register_agent`
once → per action, `build_activity` + `analyze_activity` → poll
`list_flags` / `get_agent` for standing. Keep the token in process
memory or a secret manager; never commit it, never log it.

## LangGraph adapter (optional)

`bond_sdk.adapters.langgraph.LangGraphActivityAdapter` maps
LangGraph-style events to `ActivityInput` — nothing more. It holds
mapping configuration only (agent id + policy context); it never
touches the network, tokens, or credentials.

```python
from bond_sdk import BondClient
from bond_sdk.activity import ActivityPolicyContext
from bond_sdk.adapters import LangGraphActivityAdapter

adapter = LangGraphActivityAdapter(
    "agent-1",
    ActivityPolicyContext(policy_version="bond-policy-v1"),
)
activity = adapter.from_tool_call(
    "transfers", {"vendor": "acme"}
)  # ActivityInput
result = client.analyze_activity("agent-1", activity.to_dict())
```

Mappers: `from_message` (text / text-block content → `message`),
`from_tool_call` (name/args → `tool-call`, scalar args only),
`from_node_output` (text or scalar mapping → `message` or
`policy-decision`, action namespaced `langgraph:<node>`). Unknown
shapes raise `BondApiError(INVALID_ACTIVITY_INPUT)` — never silently
converted. The caller submits through `BondClient`; the adapter
performs no I/O.

Installation: the adapter is duck-typed and imports without LangGraph
installed. No `bond-sdk[langgraph]` version is declared yet —
[VERIFY-LANGGRAPH]: no LangGraph version has been verified in this
environment, so no compatibility claim is made. Install LangGraph
separately at a version you have verified if you need its runtime.

What it does NOT do: no HTTP, no database, no Risk Engine / Attestor /
Midnight imports, no wallet or key handling, no credential storage, no
blockchain submission, no bond creation, no protocol expansion.
Address↔key ownership is unproven (as everywhere in BOND); sessions
bind the signing key only.
