# ADR-001 — Platform-agnostic agent architecture

- **Status:** Accepted (Phase 0).
- **Context:** Agents originate from many ecosystems (OpenAI, Claude, Gemini,
  LangChain, CrewAI, AutoGen, custom stacks). Binding the core protocol to
  one provider would fragment collateral, reputation, and enforcement.
- **Decision:** The core domain (agents, bonds, flags, attestations,
  slashes) carries no provider-specific logic. A `platform` label is
  metadata only. Provider specifics live in SDK/adapters outside the core;
  everything crossing into the core arrives as generic Evidence.
- **Consequences:** Core stays stable as providers churn; adapter authors
  bear provider-mapping work; `platform` must never become a behavioral
  switch (enforced by review, Phase 1+).
- **Verification:** No external dependency; pure design discipline.
