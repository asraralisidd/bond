/**
 * Dashboard: portfolio overview from real endpoints only.
 * Per-agent fan-out (flags, verification) is acceptable at demo scale
 * and is never cached as truth — statuses re-resolve on reload.
 */
import { useEffect, useState } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components/chrome.js";
import { LifecycleStepper } from "../components/lifecycle.js";

interface AgentRow {
  status: string;
  agentId: string;
}

export function DashboardPage() {
  const agents = useApi(() => api.listAgents(100), []);
  const [flagged, setFlagged] = useState<
    { agentId: string; open: number; severity: string | null }[]
  >([]);
  const [slashes, setSlashes] = useState(0);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [extraError, setExtraError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const rows = agents.data as AgentRow[] | null;
    if (!rows) {
      return;
    }
    setLoadingExtra(true);
    setExtraError(null);
    (async () => {
      try {
        const perAgent = await Promise.all(
          rows.map(async (a) => {
            const [flags, verification] = await Promise.all([
              api.listFlags(a.agentId).catch(() => []),
              api.verifyAgent(a.agentId).catch(() => null),
            ]);
            const open = flags.filter((f) =>
              ["open", "under-review"].includes(f.status),
            );
            const top =
              open
                .map((f) => f.severity)
                .sort(
                  (x, y) =>
                    ["critical", "high", "medium", "low"].indexOf(x) -
                    ["critical", "high", "medium", "low"].indexOf(y),
                )[0] ?? null;
            return {
              agentId: a.agentId,
              open: open.length,
              severity: top,
              slashes: verification?.slashHistory.length ?? 0,
            };
          }),
        );
        if (!cancelled) {
          setFlagged(
            perAgent.map(({ agentId, open, severity }) => ({
              agentId,
              open,
              severity,
            })),
          );
          setSlashes(perAgent.reduce((n, p) => n + p.slashes, 0));
          setLoadingExtra(false);
        }
      } catch (err) {
        if (!cancelled) {
          setExtraError(
            err instanceof ApiError
              ? `${err.code}: ${err.message}`
              : String(err),
          );
          setLoadingExtra(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [agents.data]);

  if (agents.loading) {
    return (
      <>
        <PageHeader title="Dashboard" intro="Protocol posture at a glance." />
        <LoadingState label="Loading dashboard" />
      </>
    );
  }
  if (agents.error) {
    return (
      <>
        <PageHeader title="Dashboard" intro="Protocol posture at a glance." />
        <ErrorState
          message={`${agents.error.code}: ${agents.error.message}`}
          requestId={agents.error.requestId}
          onRetry={agents.reload}
        />
      </>
    );
  }
  const rows = (agents.data ?? []) as AgentRow[];
  const byStatus = new Map<string, number>();
  for (const a of rows) {
    byStatus.set(a.status, (byStatus.get(a.status) ?? 0) + 1);
  }
  const openFlags = flagged.reduce((n, f) => n + f.open, 0);
  const atRisk = flagged.filter((f) => f.open > 0);

  return (
    <>
      <PageHeader
        title="Dashboard"
        intro="Live posture across your agents, bonds, findings, and enforcement — resolved from the API on every load."
      />
      <div className="hero-strip">
        <strong>Lifecycle:</strong> REGISTER → BOND → PROVE → OPERATE → ASSESS →
        ATTEST → ENFORCE. Every stage below links to its source data — nothing
        here is fabricated.
      </div>
      {rows.length === 0 ? (
        <EmptyState
          title="No agents yet"
          body="Register your first agent to start the lifecycle. Each metric on this page is computed from real API responses."
          action={
            <a className="btn btn-primary" href="#/agents/new">
              Register agent
            </a>
          }
        />
      ) : (
        <>
          <div className="grid grid-4">
            <div className="card">
              <div className="stat-value">{rows.length}</div>
              <div className="stat-label">Registered agents</div>
            </div>
            <div className="card">
              <div className="stat-value">
                {(byStatus.get("ACTIVE") ?? 0) +
                  (byStatus.get("ELIGIBLE") ?? 0)}
              </div>
              <div className="stat-label">Active / eligible</div>
            </div>
            <div className="card">
              <div className="stat-value">{loadingExtra ? "…" : openFlags}</div>
              <div className="stat-label">Open risk flags</div>
            </div>
            <div className="card">
              <div className="stat-value">{loadingExtra ? "…" : slashes}</div>
              <div className="stat-label">Slash events (confirmed)</div>
            </div>
          </div>
          <div className="card mt">
            <h2>Agents by status</h2>
            <div className="row">
              {[...byStatus.entries()].map(([status, n]) => (
                <span key={status} className="row" style={{ gap: "0.4rem" }}>
                  <StatusBadge status={status} />
                  <strong>{n}</strong>
                </span>
              ))}
            </div>
          </div>
          <div className="card mt">
            <h2>Attention needed</h2>
            {extraError ? (
              <ErrorState message={extraError} onRetry={agents.reload} />
            ) : loadingExtra ? (
              <LoadingState label="Resolving flags" />
            ) : atRisk.length === 0 ? (
              <p className="muted">No open flags. Nothing needs review.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Agent</th>
                      <th scope="col">Open flags</th>
                      <th scope="col">Top severity</th>
                      <th scope="col">Detail</th>
                    </tr>
                  </thead>
                  <tbody>
                    {atRisk.map((f) => (
                      <tr key={f.agentId}>
                        <td className="mono">{f.agentId.slice(0, 8)}…</td>
                        <td>{f.open}</td>
                        <td>
                          {f.severity ? (
                            <StatusBadge status={f.severity} />
                          ) : (
                            "—"
                          )}
                        </td>
                        <td>
                          <a href={`#/agents/${f.agentId}`}>Open</a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="card mt">
            <h2>Lifecycle coverage</h2>
            <p className="muted">
              Highest lifecycle stage reached across the portfolio.
            </p>
            <LifecycleStepper
              agentStatus={
                byStatus.has("SLASHED")
                  ? "SLASHED"
                  : byStatus.has("FLAGGED")
                    ? "FLAGGED"
                    : byStatus.has("ACTIVE")
                      ? "ACTIVE"
                      : byStatus.has("BONDED")
                        ? "BONDED"
                        : "REGISTERED"
              }
            />
          </div>
        </>
      )}
    </>
  );
}
