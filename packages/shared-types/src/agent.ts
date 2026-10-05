/**
 * Agent domain: registered claim + lifecycle state machine.
 *
 * Phase 0 doc 03 §3.3 terminology is used verbatim, with one resolved
 * deviation (see ATTESTED note below).
 *
 * ATTESTED DECISION (Phase 1 resolution of the Phase 0 open question):
 * `ATTESTED` is NOT an Agent lifecycle state. Attestation lives on the
 * independent Attestation/decision record (see attestation.ts); the agent
 * moves FLAGGED → SLASHED when an enforcement decision executes, or
 * FLAGGED → RESOLVED when the flag is dismissed. A derived "attested"
 * badge can be computed from the linked decision — it is not stored on
 * the agent. Rationale: keeps a single attestation lifecycle instead of a
 * confusing duplicate, exactly as Phase 0 recommended.
 */
import { DomainError } from "./errors.js";
import type { AgentId, OperatorId } from "./ids.js";
import type { AgentStatus, AgentType } from "./enums.js";

export interface Agent {
  readonly agentId: AgentId;
  readonly operatorId: OperatorId;
  /** Free-form ecosystem label. Metadata only — never branches behavior. */
  readonly platform: string;
  readonly agentType: AgentType;
  readonly capabilities: readonly string[];
  /** Provider-side reference (assistant ID, deployment URL, …). Frozen at registration. */
  readonly externalRef: string;
  readonly status: AgentStatus;
  readonly registeredAt: string;
  readonly updatedAt: string;
}

type AgentTransitionMap = Readonly<Record<AgentStatus, readonly AgentStatus[]>>;

const AGENT_TRANSITIONS: AgentTransitionMap = {
  // Start state: registration is the only way into the lifecycle.
  UNREGISTERED: ["REGISTERED"],
  // Bond must attach before anything else (Phase 0: REGISTERED → ELIGIBLE/ACTIVE invalid).
  REGISTERED: ["BONDED"],
  BONDED: ["ELIGIBLE", "WITHDRAWABLE"],
  ELIGIBLE: ["ACTIVE", "WITHDRAWABLE"],
  ACTIVE: ["FLAGGED", "SUSPENDED", "WITHDRAWABLE"],
  FLAGGED: ["ACTIVE", "RESOLVED", "SLASHED", "SUSPENDED", "WITHDRAWABLE"],
  // SLASHED recovers only via RESOLVED (Phase 0: SLASHED → ACTIVE invalid).
  SLASHED: ["RESOLVED"],
  // Suspension returns to a durable state; WITHDRAWABLE is terminal.
  SUSPENDED: ["ACTIVE", "FLAGGED", "RESOLVED"],
  RESOLVED: ["ACTIVE", "SUSPENDED", "WITHDRAWABLE"],
  // Terminal: a new bond starts a new lifecycle, never reactivation.
  WITHDRAWABLE: [],
};

export function isAgentStatus(value: unknown): value is AgentStatus {
  return (
    typeof value === "string" &&
    (Object.keys(AGENT_TRANSITIONS) as AgentStatus[]).includes(
      value as AgentStatus,
    )
  );
}

export function canTransitionAgent(
  from: AgentStatus,
  to: AgentStatus,
): boolean {
  return AGENT_TRANSITIONS[from].includes(to);
}

/**
 * Deterministic agent transition. Returns the target status when valid;
 * throws INVALID_AGENT_TRANSITION otherwise. Pure function.
 */
export function transitionAgentStatus(
  from: AgentStatus,
  to: AgentStatus,
): AgentStatus {
  if (!canTransitionAgent(from, to)) {
    throw new DomainError(
      "INVALID_AGENT_TRANSITION",
      `Invalid agent transition: ${from} → ${to}`,
      { from, to },
    );
  }
  return to;
}

/** Agent states with no outgoing transitions. */
export function isTerminalAgentStatus(status: AgentStatus): boolean {
  return AGENT_TRANSITIONS[status].length === 0;
}
