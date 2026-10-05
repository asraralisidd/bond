/**
 * Public contract views: bands and statuses only.
 *
 * Excluded by construction: commitment/slashed amounts, operator IDs,
 * nullifiers, and any internal material. Views are fresh allowlisted
 * objects, never spreads of internal state.
 */
import type {
  ContractAgentState,
  ContractBondState,
  ContractLedger,
} from "./state.js";

export interface PublicContractAgentView {
  readonly agentId: string;
  readonly status: ContractAgentState["status"];
  readonly bondStatus: ContractBondState["status"] | null;
  readonly slashCount: number;
}

export interface PublicContractLedgerView {
  readonly agents: readonly PublicContractAgentView[];
  readonly contractVersion: ContractLedger["contractVersion"];
  readonly policyVersion: ContractLedger["policyVersion"];
}

export function toPublicContractLedgerView(
  ledger: ContractLedger,
): PublicContractLedgerView {
  const agents = Object.values(ledger.agents)
    .sort((a, b) => (a.agentId < b.agentId ? -1 : 1))
    .map((agent) => ({
      agentId: agent.agentId,
      status: agent.status,
      bondStatus:
        agent.bondId === null
          ? null
          : (ledger.bonds[agent.bondId]?.status ?? null),
      slashCount: agent.slashCount,
    }));
  return {
    agents,
    contractVersion: ledger.contractVersion,
    policyVersion: ledger.policyVersion,
  };
}
