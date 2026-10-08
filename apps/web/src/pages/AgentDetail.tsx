/**
 * Agent detail: identity header plus IDENTITY / SECURITY / RISK
 * INTELLIGENCE / COLLATERAL / ATTESTATIONS / ACTIVITY sections.
 * Sections render only data the API actually returns — no raw
 * object dumps.
 */
import { useState } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import type { AgentView } from "../api/types.js";
import { DataState } from "../components/DataState.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { LifecycleStepper } from "../components/lifecycle.js";
import {
  TechnicalCard,
  VectorActivity,
  VectorAgent,
  VectorAttestor,
  VectorBond,
  VectorRisk,
  VectorShield,
} from "../components/vectors.js";
import { useToast } from "../app/toast.js";
import { recents } from "../lib/recent.js";

const SUSPENDABLE = new Set(["ACTIVE", "FLAGGED", "RESOLVED"]);

export function AgentDetailPage({ agentId }: { agentId: string }) {
  const agent = useApi(() => api.getAgent(agentId), [agentId]);
  const flags = useApi(() => api.listFlags(agentId), [agentId]);
  const verification = useApi(() => api.verifyAgent(agentId), [agentId]);
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const linked = recents("bond", agentId);
  const txs = recents("transaction", agentId);

  async function setStatus(status: string) {
    setBusy(true);
    try {
      await api.setAgentStatus(agentId, status);
      toast.notify("success", `Agent → ${status}`);
      agent.reload();
    } catch (err) {
      toast.notify(
        "error",
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter">
      <PageHeader
        title="Agent detail"
        intro="Identity, security posture, risk intelligence, collateral, and local activity for this agent."
        actions={
          <a className="btn btn-ghost btn-sm" href="#/agents">
            ← All agents
          </a>
        }
      />
      <DataState<AgentView>
        loading={agent.loading}
        error={agent.error}
        data={agent.data}
        onRetry={agent.reload}
        empty={{
          title: "Agent not found",
          body: "It may belong to another operator.",
        }}
      >
        {(a) => (
          <>
            <div className="identity-head">
              <span className="identity-avatar" aria-hidden="true">
                <VectorAgent size={30} />
              </span>
              <div>
                <p className="identity-name">
                  AGENT {a.externalRef || a.agentId.slice(0, 8)}
                </p>
                <p className="identity-id mono">{a.agentId}</p>
              </div>
              <div className="identity-badges">
                <StatusBadge
                  status={
                    verification.data?.verification.result === "trusted"
                      ? "VERIFIED"
                      : verification.data?.verification.result === "caution"
                        ? "CAUTION"
                        : "UNVERIFIED"
                  }
                />
                <StatusBadge status={a.status} />
              </div>
            </div>

            <h2 className="section-label">Identity</h2>
            <div className="card">
              <dl className="kv">
                <dt>Agent ID</dt>
                <dd className="mono">{a.agentId}</dd>
                <dt>Status</dt>
                <dd>
                  <StatusBadge status={a.status} />
                </dd>
                <dt>Platform / type</dt>
                <dd>
                  {a.platform} / {a.agentType}
                </dd>
                <dt>Capabilities</dt>
                <dd>
                  {a.capabilities.length > 0 ? a.capabilities.join(", ") : "—"}
                </dd>
                <dt>External ref</dt>
                <dd className="mono">{a.externalRef}</dd>
                <dt>Policy</dt>
                <dd className="mono">{a.policyVersion}</dd>
                <dt>Chain sync</dt>
                <dd>
                  <StatusBadge status={a.syncStatus} />
                </dd>
              </dl>
            </div>

            <h2 className="section-label">Security</h2>
            <div className="card">
              <h2>Protocol lifecycle</h2>
              <LifecycleStepper agentStatus={a.status} />
              {SUSPENDABLE.has(a.status) ? (
                <div className="row mt">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setStatus("SUSPENDED")}
                  >
                    Suspend
                  </button>
                </div>
              ) : null}
              {a.status === "SUSPENDED" ? (
                <div className="row mt">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() => setStatus("ACTIVE")}
                  >
                    Resume to ACTIVE
                  </button>
                </div>
              ) : null}
              <h3 className="mt">Public verification</h3>
              {verification.loading ? (
                <p className="muted">Resolving public record…</p>
              ) : verification.error ? (
                <p className="muted">
                  Public record unavailable ({verification.error.code}).
                </p>
              ) : verification.data ? (
                <dl className="kv">
                  <dt>Verdict</dt>
                  <dd>
                    <StatusBadge
                      status={verification.data.verification.result}
                    />
                  </dd>
                  <dt>Bond</dt>
                  <dd>{verification.data.bond?.status ?? "none"}</dd>
                  <dt>Reputation</dt>
                  <dd>{verification.data.reputation?.standing ?? "—"}</dd>
                  <dt>Slashes</dt>
                  <dd>{verification.data.slashHistory.length}</dd>
                </dl>
              ) : null}
            </div>

            <h2 className="section-label">Risk intelligence</h2>
            <TechnicalCard
              title="Findings"
              icon={<VectorRisk size={18} />}
              tone="warn"
            >
              {flags.loading ? (
                <p className="muted">Loading flags…</p>
              ) : flags.error ? (
                <p className="muted">Flags unavailable ({flags.error.code}).</p>
              ) : (flags.data ?? []).length === 0 ? (
                <p className="muted">No flags recorded for this agent.</p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Category</th>
                        <th scope="col">Severity</th>
                        <th scope="col">Status</th>
                        <th scope="col">Confidence</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(flags.data ?? []).map((f) => (
                        <tr key={f.riskFlagId}>
                          <td>{f.category}</td>
                          <td>
                            <StatusBadge status={f.severity} />
                          </td>
                          <td>
                            <StatusBadge status={f.status} />
                          </td>
                          <td>{Math.round(f.confidence * 100)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TechnicalCard>

            <h2 className="section-label">Collateral</h2>
            <TechnicalCard
              title="Linked bond"
              icon={<VectorBond size={18} />}
              tone="accent"
            >
              {linked.length === 0 ? (
                <p className="muted">
                  No bond created in this browser for this agent yet.{" "}
                  <a href="#/bonds">Create or look up a bond</a>.
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr>
                        <th scope="col">Bond</th>
                        <th scope="col">Note</th>
                      </tr>
                    </thead>
                    <tbody>
                      {linked.map((b) => (
                        <tr key={b.id}>
                          <td className="mono">{b.id.slice(0, 8)}…</td>
                          <td>{b.label}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </TechnicalCard>

            <h2 className="section-label">Attestations</h2>
            <TechnicalCard
              title="Quorum activity"
              icon={<VectorAttestor size={18} />}
              tone="neutral"
            >
              <p className="muted">
                Attestations over this agent&apos;s flags are requested and
                decided under <a href="#/attestations">Attestations</a>.
              </p>
            </TechnicalCard>

            {txs.length > 0 ? (
              <>
                <h2 className="section-label">Activity</h2>
                <TechnicalCard
                  title="Local transaction history"
                  icon={<VectorActivity size={18} />}
                  tone="neutral"
                >
                  <p className="muted">
                    Transactions submitted from this browser (local history, not
                    chain truth).
                  </p>
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Transaction</th>
                          <th scope="col">Note</th>
                        </tr>
                      </thead>
                      <tbody>
                        {txs.map((t) => (
                          <tr key={t.id}>
                            <td className="mono">{t.id.slice(0, 8)}…</td>
                            <td>{t.label}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </TechnicalCard>
              </>
            ) : null}
            <div className="card mt">
              <h2>
                <VectorShield size={15} /> Standing
              </h2>
              <p className="muted">
                Verification verdict and lifecycle govern this agent&apos;s
                standing — see Security above.
              </p>
            </div>
          </>
        )}
      </DataState>
    </div>
  );
}
