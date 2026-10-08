/**
 * Attestation detail: quorum state, verdicts, expiry, decision, and the
 * explicit enforcement path (amount + tracked SIMULATED transaction).
 */
import { useState } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import type { AttestationView } from "../api/types.js";
import { DataState } from "../components/DataState.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { AttestationQuorum } from "../components/vectors.js";
import { useToast } from "../app/toast.js";
import { remember } from "../lib/recent.js";

export function AttestationDetailPage({
  attestationId,
}: {
  attestationId: string;
}) {
  const detail = useApi(
    () => api.getAttestation(attestationId),
    [attestationId],
  );
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [attestorId, setAttestorId] = useState("");
  const [secret, setSecret] = useState("");
  const [verdict, setVerdict] = useState("confirm");
  const [amount, setAmount] = useState("");

  async function act(label: string, fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      toast.notify("success", label);
      detail.reload();
    } catch (err) {
      toast.notify(
        "error",
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function enforce() {
    setBusy(true);
    try {
      const tx = await api.enforceAttestation(
        attestationId,
        amount.trim() || undefined,
      );
      remember({
        kind: "transaction",
        id: tx.transactionId,
        agentId: detail.data?.agentId ?? null,
        label: `ENFORCEMENT → ${tx.status}`,
      });
      toast.notify(
        "info",
        `Enforcement intent ${tx.transactionId.slice(0, 8)}… (SIMULATED)`,
      );
      detail.reload();
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
        title="Attestation"
        intro="Quorum state, verdicts, expiry, and the enforcement path."
        actions={
          <a className="btn btn-ghost btn-sm" href="#/attestations">
            ← Attestations
          </a>
        }
      />
      <DataState<AttestationView>
        loading={detail.loading}
        error={detail.error}
        data={detail.data}
        onRetry={detail.reload}
        empty={{
          title: "Attestation not found",
          body: "Check the identifier.",
        }}
      >
        {(a) => {
          const confirms = a.verdicts.filter(
            (v) => v.verdict === "confirm",
          ).length;
          const rejects = a.verdicts.filter(
            (v) => v.verdict === "reject",
          ).length;
          return (
            <>
              <div className="card">
                <h2>Decision state</h2>
                <AttestationQuorum
                  confirms={confirms}
                  rejects={rejects}
                  threshold={a.threshold}
                  decided={a.decision !== null && a.decision !== undefined}
                />
                <dl className="kv mt">
                  <dt>Attestation</dt>
                  <dd className="mono">{a.attestationId}</dd>
                  <dt>Status</dt>
                  <dd>
                    <StatusBadge status={a.status} />
                  </dd>
                  <dt>Quorum</dt>
                  <dd>
                    {confirms} confirm / {rejects} reject · threshold{" "}
                    {a.threshold}
                  </dd>
                  <dt>Flag</dt>
                  <dd className="mono">{a.flagId}</dd>
                  <dt>Agent</dt>
                  <dd className="mono">{a.agentId}</dd>
                  <dt>Expires</dt>
                  <dd className="mono">{a.expiresAt}</dd>
                  <dt>Decision</dt>
                  <dd>
                    {a.decision ? (
                      <span className="mono">
                        {a.decision.action} ·{" "}
                        {a.decision.decisionId.slice(0, 8)}…
                      </span>
                    ) : (
                      "none yet"
                    )}
                  </dd>
                </dl>
                <div className="row mt">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      act("Evaluation recorded", () =>
                        api.evaluateAttestation(a.attestationId),
                      )
                    }
                  >
                    Run auto-evaluation
                  </button>
                  {a.status === "quorum-met" && !a.decision ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={() =>
                        act("Decision issued", () =>
                          api.issueDecision(a.attestationId),
                        )
                      }
                    >
                      Issue decision
                    </button>
                  ) : null}
                </div>
              </div>
              <div className="card mt">
                <h2>Verdicts</h2>
                {a.verdicts.length === 0 ? (
                  <p className="muted">No verdicts recorded yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table className="data">
                      <thead>
                        <tr>
                          <th scope="col">Attestor</th>
                          <th scope="col">Verdict</th>
                          <th scope="col">Issued</th>
                        </tr>
                      </thead>
                      <tbody>
                        {a.verdicts.map((v, i) => (
                          <tr key={`${v.attestorId}-${i}`}>
                            <td className="mono">
                              {v.attestorId.slice(0, 8)}…
                            </td>
                            <td>
                              <StatusBadge status={v.verdict} />
                            </td>
                            <td className="mono">{v.issuedAt}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                <h3 className="mt">Submit verdict (attestor credential)</h3>
                <form
                  className="form"
                  onSubmit={(e) => {
                    e.preventDefault();
                    act("Verdict recorded", () =>
                      api.submitVerdict(a.attestationId, {
                        attestorId: attestorId.trim(),
                        verdict,
                        secret,
                      }),
                    );
                  }}
                >
                  <div className="grid grid-2">
                    <div className="field">
                      <label htmlFor="v-attestor">Attestor ID</label>
                      <input
                        id="v-attestor"
                        className="mono"
                        value={attestorId}
                        onChange={(e) => setAttestorId(e.target.value)}
                        required
                      />
                    </div>
                    <div className="field">
                      <label htmlFor="v-verdict">Verdict</label>
                      <select
                        id="v-verdict"
                        value={verdict}
                        onChange={(e) => setVerdict(e.target.value)}
                      >
                        <option value="confirm">confirm</option>
                        <option value="reject">reject</option>
                        <option value="abstain">abstain</option>
                      </select>
                    </div>
                  </div>
                  <div className="field">
                    <label htmlFor="v-secret">Attestor secret</label>
                    <input
                      id="v-secret"
                      type="password"
                      value={secret}
                      onChange={(e) => setSecret(e.target.value)}
                      autoComplete="off"
                      required
                    />
                    <span className="hint">
                      Sent once with this request. Never stored, never
                      displayed.
                    </span>
                  </div>
                  <button type="submit" className="btn" disabled={busy}>
                    Submit verdict
                  </button>
                </form>
              </div>
              {a.decision ? (
                <div className="card mt">
                  <h2>Enforcement</h2>
                  <p className="muted">
                    Creates an explicit enforcement transaction intent. Partial
                    slashes need an amount; full slashes consume the remainder
                    by policy.
                  </p>
                  <div className="field" style={{ maxWidth: "280px" }}>
                    <label htmlFor="enf-amount">
                      Amount (minor units, partial only)
                    </label>
                    <input
                      id="enf-amount"
                      className="mono"
                      value={amount}
                      onChange={(e) => setAmount(e.target.value)}
                      inputMode="numeric"
                      placeholder="e.g. 1000"
                    />
                  </div>
                  <div className="row mt">
                    <button
                      type="button"
                      className="btn btn-danger"
                      disabled={busy}
                      onClick={enforce}
                    >
                      Enforce decision (SIMULATED tx)
                    </button>
                  </div>
                </div>
              ) : null}
            </>
          );
        }}
      </DataState>
    </div>
  );
}
