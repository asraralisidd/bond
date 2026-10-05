# 01 — Product vision & scope

## 1.1 Vision

BOND is a real, deployable, platform-agnostic **Agent Security & Collateral
Protocol**. It lets an operator stake collateral ("bond") against the behavior
of an AI agent, have the agent's activity risk-assessed with AI assistance,
have adverse findings independently attested, and have proven violations
enforced automatically (slashing) — while keeping sensitive information
private and keeping public verification possible.

It is **not** a hackathon demo: every flow in this spec must be implementable,
auditable, and operable. Where a flow cannot yet be specified (notably all
Midnight/Compact touchpoints), the gap is marked **[VERIFY-MIDNIGHT]** instead
of papered over.

## 1.2 What BOND provides

1. **Agent registration** — a verifiable on-record identity for an agent,
   owned by an operator, independent of the platform the agent runs on.
2. **Collateral / bond management** — locking value against an agent's good
   behavior; release, partial/full slashing, and withdrawal under clear rules.
3. **Privacy-preserving eligibility** — an operator can prove an agent meets
   bond requirements without exposing unnecessary private information.
4. **AI-assisted risk analysis** — a Risk Engine that turns activity/evidence
   into structured risk flags. Advisory only; never authoritative on-chain.
5. **Independent attestation** — human- or machine-operated attestors that
   verify risk flags against evidence and sign enforcement decisions under a
   configurable threshold (initial concept: 2-of-3).
6. **Reputation** — a historical, non-token record derived from behavior:
   clean history, violations, slashes, resolved incidents.
7. **Automated slashing / enforcement** — contract-executed outcomes driven
   only by attested decisions, never by the Risk Engine alone.
8. **Public agent verification** — any third party can check an agent's
   registration, eligibility, bond status, reputation, and enforcement
   history without accessing private data.

## 1.3 Platform-agnostic stance

BOND must support agents from different ecosystems without hardcoding the
core protocol to one provider:

- OpenAI-based agents, Anthropic/Claude-based agents, Google/Gemini-based agents
- LangChain, LangGraph, CrewAI, AutoGen
- Custom Python agents, custom Node.js agents
- Future agent platforms

Consequences (binding on later phases):

- The core domain (agents, bonds, flags, attestations, slashes) contains
  **no provider-specific fields or logic**. A `platform` label is metadata
  for routing/display, never a behavioral switch in the core protocol.
- Provider-specific concerns live in **adapters/SDKs outside the core**
  (see doc 03). If a provider needs new data captured, it arrives as generic
  evidence, not as provider-shaped domain objects.
- BOND never executes the agent itself. It observes evidence _about_ the
  agent and manages collateral _around_ the agent.

## 1.4 Non-goals for the initial build

- Becoming an agent runtime, orchestrator, or model provider.
- Cross-chain support (Midnight only, initially).
- DAO governance, token-based reputation, or a BOND token.
- MPC/HSM infrastructure, automatic agent wallet creation.
- Multi-region deployment, heavy data infrastructure (see doc 15 for the
  full out-of-scope list).
