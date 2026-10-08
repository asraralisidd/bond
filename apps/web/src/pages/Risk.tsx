/**
 * Risk Intelligence: run analyses, inspect findings with structured
 * explanations. Evidence shown as references only — never content.
 */
import { useState } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import type { RiskFlagView } from "../api/types.js";
import { DataState } from "../components/DataState.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { RiskGauge, TechnicalCard, VectorRisk } from "../components/vectors.js";
import { useToast } from "../app/toast.js";

const ACTION_TYPES = [
  "tool-call",
  "transfer",
  "message",
  "policy-decision",
  "auth",
  "config-change",
  "external-report",
];

export function RiskPage() {
  const toast = useToast();
  const [agentId, setAgentId] = useState("");
  const [queried, setQueried] = useState<string | null>(null);
  const flags = useApi(
    () => (queried ? api.listFlags(queried) : Promise.resolve([])),
    [queried],
  );

  const [activityId, setActivityId] = useState("");
  const [actionType, setActionType] = useState("transfer");
  const [action, setAction] = useState("");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastScore, setLastScore] = useState<number | null>(null);
  const [lastLevel, setLastLevel] = useState("NOMINAL");

  async function runAnalysis(e: React.FormEvent) {
    e.preventDefault();
    if (!queried) {
      setError("Load an agent's flags first (enter an agent ID above).");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await api.analyzeActivity(queried, {
        activityId: activityId.trim() || `act-${Date.now()}`,
        occurredAt: new Date().toISOString(),
        actionType,
        action: action.trim(),
        ...(amount.trim() ? { amountMinorUnits: amount.trim() } : {}),
        policyContext: {
          policyVersion: "bond-policy-v1",
          ...(limit.trim() ? { spendLimitMinorUnits: limit.trim() } : {}),
        },
      });
      toast.notify(
        "success",
        result.flagIds.length > 0
          ? `${result.flagIds.length} finding(s) recorded`
          : "No findings — nothing to review",
      );
      setLastScore(result.score?.score ?? null);
      setLastLevel(
        result.score?.severity
          ? String(result.score.severity).toUpperCase()
          : "NOMINAL",
      );
      flags.reload();
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-enter">
      <PageHeader
        title="Risk Intelligence"
        intro="Deterministic, explainable findings. Every finding carries its rule, severity, confidence, and evidence references — never secret evidence."
      />
      <div className="grid grid-2">
        <div className="card">
          <h2>Findings by agent</h2>
          <form
            className="form"
            onSubmit={(e) => {
              e.preventDefault();
              setQueried(agentId.trim() || null);
            }}
          >
            <div className="field">
              <label htmlFor="risk-agent">Agent ID</label>
              <input
                id="risk-agent"
                className="mono"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="agent uuid"
              />
            </div>
            <button type="submit" className="btn">
              Load findings
            </button>
          </form>
        </div>
        <TechnicalCard
          title="Latest score"
          icon={<VectorRisk size={18} />}
          tone="warn"
        >
          <RiskGauge score={lastScore} level={lastLevel} />
          <p
            className="muted"
            style={{ fontSize: "0.8rem", marginTop: "0.4rem" }}
          >
            Score from the most recent analysis run on this page.
          </p>
        </TechnicalCard>
      </div>
      {queried ? (
        <div className="card mt">
          <h2>Run analysis</h2>
          {error ? (
            <div
              className="alert alert-error"
              role="alert"
              style={{ marginBottom: "0.8rem" }}
            >
              {error}
            </div>
          ) : null}
          <form className="form" onSubmit={runAnalysis}>
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="risk-activity">Activity ID</label>
                <input
                  id="risk-activity"
                  value={activityId}
                  onChange={(e) => setActivityId(e.target.value)}
                  placeholder="auto-generated if blank"
                />
              </div>
              <div className="field">
                <label htmlFor="risk-type">Action type</label>
                <select
                  id="risk-type"
                  value={actionType}
                  onChange={(e) => setActionType(e.target.value)}
                >
                  {ACTION_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label htmlFor="risk-action">Action</label>
              <input
                id="risk-action"
                value={action}
                onChange={(e) => setAction(e.target.value)}
                placeholder="e.g. pay-vendor"
                required
              />
            </div>
            <div className="grid grid-2">
              <div className="field">
                <label htmlFor="risk-amount">
                  Amount (minor units, optional)
                </label>
                <input
                  id="risk-amount"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 5000"
                />
              </div>
              <div className="field">
                <label htmlFor="risk-limit">Spend limit (optional)</label>
                <input
                  id="risk-limit"
                  value={limit}
                  onChange={(e) => setLimit(e.target.value)}
                  inputMode="numeric"
                  placeholder="e.g. 1000"
                />
              </div>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Analyzing…" : "Run analysis"}
            </button>
          </form>
        </div>
      ) : null}
      <div className="mt">
        <DataState<RiskFlagView[]>
          loading={flags.loading}
          error={flags.error}
          data={queried ? flags.data : []}
          onRetry={flags.reload}
          empty={{
            title: queried ? "No findings" : "No agent selected",
            body: queried
              ? "This agent has no recorded findings. Absence of flags is not proof of safety."
              : "Enter an agent ID above to inspect its findings.",
          }}
        >
          {(rows) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Flag</th>
                    <th scope="col">Category</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Confidence</th>
                    <th scope="col">Status</th>
                    <th scope="col">Evidence refs</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((f) => (
                    <tr key={f.riskFlagId}>
                      <td className="mono">{f.riskFlagId.slice(0, 8)}…</td>
                      <td>{f.category}</td>
                      <td>
                        <StatusBadge status={f.severity} />
                      </td>
                      <td>{Math.round(f.confidence * 100)}%</td>
                      <td>
                        <StatusBadge status={f.status} />
                      </td>
                      <td className="mono">{f.evidenceIds.length} ref(s)</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </DataState>
      </div>
      {queried &&
      !flags.loading &&
      !flags.error &&
      (flags.data ?? []).length > 0 ? (
        <TechnicalCard
          title="Security event timeline"
          icon={<VectorRisk size={18} />}
          tone="neutral"
        >
          <ol className="event-timeline">
            {(flags.data ?? []).map((f) => (
              <li
                key={f.riskFlagId}
                className={`event-item event-item-${
                  f.severity === "critical"
                    ? "bad"
                    : f.severity === "high"
                      ? "bad"
                      : f.severity === "medium"
                        ? "warn"
                        : f.severity === "low"
                          ? "info"
                          : "warn"
                }`}
              >
                <span className="mono">{f.riskFlagId.slice(0, 8)}…</span>{" "}
                {f.category} · <StatusBadge status={f.severity} /> ·{" "}
                <StatusBadge status={f.status} />
              </li>
            ))}
          </ol>
        </TechnicalCard>
      ) : null}
    </div>
  );
}
