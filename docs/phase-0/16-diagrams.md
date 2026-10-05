# 16 — Architecture diagrams

> All diagrams are conceptual. Chain-side details are
> **[VERIFY-MIDNIGHT]** and subject to official-docs confirmation.

## 16.1 Overall system architecture

```mermaid
flowchart TB
    EXT["External agent platform<br/>(OpenAI / Claude / Gemini / LangChain / custom)"]
    SDK["BOND SDK / Adapter<br/>(provider-specific, outside core)"]
    API["BOND API<br/>apps/api · /api/v1"]
    REG["Agent Registry<br/>(off-chain record + identity)"]
    RISK["Risk Engine<br/>detection → assessment → flag<br/>advisory only"]
    ATT["Attestor System<br/>independent quorum · 2-of-3 concept"]
    ADAPT["Midnight Adapter<br/>sole chain-facing seam"]
    CONTRACT[("Compact Contract<br/>Midnight")]
    OPERATOR(["Operator + Midnight Wallet"])

    EXT --> SDK --> API --> REG --> RISK --> ATT --> ADAPT --> CONTRACT
    OPERATOR --> API
    OPERATOR -. wallet signs .-> ADAPT
    CONTRACT -. confirms .-> API
```

## 16.2 Agent integration

```mermaid
sequenceDiagram
    participant O as Operator
    participant S as SDK / Adapter
    participant A as BOND API
    participant R as Registry
    participant P as Public verification
    O->>S: register(platform, type, capabilities, ext-ref)
    S->>A: POST /api/v1/agents (idempotency key)
    A->>R: bind agentId ↔ (operator, platform, ext-ref)
    R-->>A: agentId (duplicate triple → reject)
    A-->>S: agentId
    S->>A: POST /api/v1/risk evidence (hash + descriptor)
    A->>A: attach to agentId → risk analysis
    P->>A: GET /api/v1/public/agent-status?agentId=
    A-->>P: public-safe projection only
    Note over O,P: BOND never executes the agent
```

## 16.3 Agent lifecycle

```mermaid
stateDiagram-v2
    [*] --> UNREGISTERED
    UNREGISTERED --> REGISTERED: operator registers (off-chain)
    REGISTERED --> BONDED: bond confirmed (chain)
    BONDED --> ELIGIBLE: policy + ZK check pass
    ELIGIBLE --> ACTIVE: operator marks in-service
    ACTIVE --> FLAGGED: risk flag opened (auto)
    FLAGGED --> ATTESTED: quorum decision recorded
    FLAGGED --> RESOLVED: dismissed / expired
    ATTESTED --> SLASHED: enforcement executed
    ATTESTED --> RESOLVED: no enforcement
    SLASHED --> RESOLVED: incident closed
    ACTIVE --> SUSPENDED: pause (operator/policy)
    FLAGGED --> SUSPENDED: pause
    SUSPENDED --> ACTIVE: resume
    BONDED --> WITHDRAWABLE: bond released
    WITHDRAWABLE --> [*]
    note right of FLAGGED: invalid: FLAGGED→ACTIVE<br/>without resolution
```

## 16.4 Bond lifecycle

```mermaid
stateDiagram-v2
    [*] --> CREATED: intent (off-chain)
    CREATED --> PENDING: funding tx submitted
    PENDING --> ACTIVE: funding confirmed (chain)
    PENDING --> FAILED: timeout / tx failed
    ACTIVE --> LOCKED: flag open / dispute / cooldown
    LOCKED --> ACTIVE: reason cleared
    ACTIVE --> PARTIALLY_SLASHED: attested partial enforcement
    LOCKED --> PARTIALLY_SLASHED: pre-attested decision executes
    PARTIALLY_SLASHED --> FULLY_SLASHED: collateral exhausted
    ACTIVE --> WITHDRAWABLE: release conditions met
    PARTIALLY_SLASHED --> WITHDRAWABLE: release of remainder
    WITHDRAWABLE --> WITHDRAWN: withdrawal confirmed (nullifier)
    CREATED --> CANCELLED: operator cancels pre-funding
    note right of WITHDRAWABLE: single-use withdrawal<br/>nullifier [CONTRACT-VERIFY]
```

## 16.5 Risk → Attestation → Enforcement

```mermaid
flowchart LR
    EV["Evidence"] --> D["Detection"]
    D --> RA["Risk Assessment<br/>severity + confidence<br/>model/version"]
    RA --> RF[("Risk Flag<br/>open")]
    RF --> AR["Attestation request<br/>(expiry set)"]
    AR --> V1["Attestor 1<br/>confirm/reject/abstain"]
    AR --> V2["Attestor 2"]
    AR --> V3["Attestor 3"]
    V1 & V2 & V3 --> Q{"threshold met?<br/>2-of-3 concept"}
    Q -->|yes| DEC[("Enforcement decision<br/>id + nullifier + expiry")]
    Q -->|no / expired| DIS[("dismissed / expired")]
    DEC --> ADAPT["Midnight Adapter"]
    ADAPT --> C[("Contract executes<br/>quorum + freshness<br/>+ scope + nullifier")]
    style RA fill:none
    style RF fill:none
```

## 16.6 Wallet / transaction flow

```mermaid
stateDiagram-v2
    [*] --> idle
    idle --> wallet_approval: operator initiates chain action
    wallet_approval --> pending: signed in wallet
    wallet_approval --> idle: rejected / disconnected (draft kept)
    pending --> submitted: adapter submits
    submitted --> confirmed: chain confirms
    submitted --> failed: on-chain failure / expiry
    pending --> failed: submission error
    confirmed --> [*]
    failed --> idle: retry with same idempotency key
    note right of submitted: never show pending/submitted as success
```

## 16.7 Public verification

```mermaid
flowchart TB
    Q["Query: agentId<br/>(+ optional policyVersion pin)"]
    R1["registration status"]
    R2["eligibility + policy version"]
    R3["bond status band"]
    R4["reputation band + counts"]
    R5["enforcement history"]
    V{"verdict rules vN"}
    OUT(["trusted / caution / untrusted<br/>+ asOf freshness"])
    PRIV[("private data<br/>never leaves boundary")]
    Q --> R1 & R2 & R3 & R4 & R5 --> V --> OUT
    PRIV -. blocked .-> OUT
```
