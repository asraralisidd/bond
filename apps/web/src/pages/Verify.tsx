/**
 * Public verification: anyone can check an agent without credentials.
 * Precise security language only — never "safe".
 */
import { useState } from "react";
import { api, ApiError } from "../api/client.js";
import type {
  PublicAgentVerification,
  PublicEligibilityView,
} from "../api/types.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { LifecycleStepper } from "../components/lifecycle.js";

export function VerifyPage() {
  const [agentId, setAgentId] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PublicAgentVerification | null>(null);
  const [eligibility, setEligibility] = useState<PublicEligibilityView | null>(
    null,
  );

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    setEligibility(null);
    try {
      const [verification, elig] = await Promise.all([
        api.verifyAgent(agentId.trim()),
        api.verifyEligibility(agentId.trim()).catch(() => null),
      ]);
      setResult(verification);
      setEligibility(elig);
    } catch (err) {
      setError(
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <PageHeader
        title="Verify agent"
        intro="Public record check. No sign-in required, and no private data is ever exposed here — amounts, witnesses, and evidence stay hidden."
      />
      <div className="card">
        <form className="form" onSubmit={onSubmit}>
          <div className="field">
            <label htmlFor="verify-agent">Agent ID</label>
            <input
              id="verify-agent"
              className="mono"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              placeholder="agent uuid"
              required
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? "Verifying…" : "Verify"}
          </button>
        </form>
      </div>
      {error ? (
        <div className="alert alert-error mt" role="alert">
          {error}
        </div>
      ) : null}
      {result ? (
        <div className="card mt" data-testid="verification-result">
          <h2>
            Verdict: <StatusBadge status={result.verification.result} />
          </h2>
          <dl className="kv">
            <dt>Registration</dt>
            <dd>{result.verification.registrationStatus}</dd>
            <dt>Bond</dt>
            <dd>{result.verification.bondStatus ?? "none"}</dd>
            <dt>Reputation</dt>
            <dd>{result.verification.reputationStanding}</dd>
            <dt>Confirmed slashes</dt>
            <dd>{result.verification.slashCount}</dd>
            <dt>Policy</dt>
            <dd className="mono">{result.verification.policyVersion}</dd>
            <dt>Evaluated</dt>
            <dd className="mono">{result.verification.asOf}</dd>
          </dl>
          <div className="mt">
            <LifecycleStepper
              agentStatus={result.verification.registrationStatus}
            />
          </div>
          {result.reputation ? (
            <>
              <h3 className="mt">Public reputation summary</h3>
              <dl className="kv">
                <dt>Standing</dt>
                <dd>
                  <StatusBadge status={result.reputation.standing} />
                </dd>
                <dt>Confirmed flags</dt>
                <dd>{result.reputation.confirmedFlags}</dd>
                <dt>Partial / full slashes</dt>
                <dd>
                  {result.reputation.partialSlashes} /{" "}
                  {result.reputation.fullSlashes}
                </dd>
              </dl>
            </>
          ) : null}
          {result.slashHistory.length > 0 ? (
            <>
              <h3 className="mt">Enforcement history</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Scope</th>
                      <th scope="col">Severity</th>
                      <th scope="col">Completed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.slashHistory.map((s) => (
                      <tr key={s.slashEventId}>
                        <td>
                          <StatusBadge
                            status={
                              s.band === "full"
                                ? "FULLY_SLASHED"
                                : "PARTIALLY_SLASHED"
                            }
                          />
                        </td>
                        <td>
                          <StatusBadge status={s.severity} />
                        </td>
                        <td className="mono">{s.completedAt ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : (
            <p className="muted mt">
              No confirmed findings on record. That is absence of evidence — not
              proof of safety.
            </p>
          )}
          {eligibility ? (
            <>
              <h3 className="mt">Eligibility</h3>
              <dl className="kv">
                <dt>Eligible</dt>
                <dd>{eligibility.eligible ? "yes" : "no"}</dd>
                <dt>Policy</dt>
                <dd className="mono">{eligibility.policyVersion}</dd>
                <dt>Statements</dt>
                <dd>{eligibility.proofs.length}</dd>
              </dl>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
