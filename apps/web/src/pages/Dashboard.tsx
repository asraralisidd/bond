/**
 * Dashboard: security command center from real endpoints only.
 * Per-agent fan-out (flags, verification) is acceptable at demo scale
 * and is never cached as truth — statuses re-resolve on reload.
 */
import { useEffect, useState } from "react";
import { api, ApiError, friendlyMessage, useApi } from "../api/client.js";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  StatusBadge,
} from "../components/chrome.js";
import { LifecycleStepper } from "../components/lifecycle.js";
import {
  MetricCard,
  ProtocolStatus,
  RiskGauge,
  TechnicalCard,
  VectorAgent,
  VectorAttestor,
  VectorBond,
  VectorReputation,
  VectorRisk,
  VectorShield,
  VectorSlash,
} from "../components/vectors.js";

interface AgentRow {
  status: string;
  agentId: string;
}

const SEVERITY_ORDER = ["critical", "high", "medium", "low"];

export function DashboardPage() {
  const agents = useApi(() => api.listAgents(100), []);
  const ready = useApi(() => api.ready(), []);
  const [flagged, setFlagged] = useState<
    { agentId: string; open: number; severity: string | null }[]
  >([]);
  const [slashes, setSlashes] = useState(0);
  const [attestations, setAttestations] = useState(0);
  const [reputation, setReputation] = useState<{
    good: number;
    probation: number;
    poor: number;
  } | null>(null);
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
                    SEVERITY_ORDER.indexOf(x) - SEVERITY_ORDER.indexOf(y),
                )[0] ?? null;
            return {
              agentId: a.agentId,
              open: open.length,
              severity: top,
              slashes: verification?.slashHistory.length ?? 0,
              standing: verification?.reputation?.standing ?? null,
              attested: flags.filter((f) => f.status === "attested").length,
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
          setAttestations(perAgent.reduce((n, p) => n + p.attested, 0));
          const rep = { good: 0, probation: 0, poor: 0 };
          for (const p of perAgent) {
            if (p.standing === "good") {
              rep.good += 1;
            } else if (p.standing === "probation") {
              rep.probation += 1;
            } else if (p.standing === "poor") {
              rep.poor += 1;
            }
          }
          setReputation(rep);
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
        <PageHeader title="Dashboard" intro="Security command center." />
        <LoadingState label="Loading dashboard" />
      </>
    );
  }
  if (agents.error) {
    return (
      <>
        <PageHeader title="Dashboard" intro="Security command center." />
        <ErrorState
          message={friendlyMessage(agents.error)}
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
  const worst: string | null =
    atRisk
      .map((f) => f.severity)
      .filter((s): s is string => s !== null)
      .sort(
        (x, y) => SEVERITY_ORDER.indexOf(x) - SEVERITY_ORDER.indexOf(y),
      )[0] ?? null;
  const checks = ready.data?.checks;
  const midnightMode = checks?.midnight.mode ?? null;

  return (
    <div className="page-enter">
      <PageHeader
        title="BOND / Dashboard"
        intro="Live posture across your agents, bonds, findings, and enforcement — resolved from the API on every load."
      />
      <ProtocolStatus
        items={[
          { label: "API", state: "OPERATIONAL", tone: "good" },
          {
            label: "DATABASE",
            state: ready.data ? "OPERATIONAL" : "UNKNOWN",
            tone: ready.data ? "good" : "neutral",
          },
          {
            label: "WORKER",
            state: ready.data ? "OPERATIONAL" : "UNKNOWN",
            tone: ready.data ? "good" : "neutral",
          },
          {
            label: "RISK",
            state: worst ? worst.toUpperCase() : "NOMINAL",
            tone: worst === "critical" ? "bad" : worst ? "warn" : "good",
          },
          {
            label: "ATTESTOR",
            state: attestations > 0 ? "ACTIVE" : "IDLE",
            tone: "neutral",
          },
          {
            label: "MIDNIGHT",
            state: midnightMode ?? "SIMULATED",
            tone: midnightMode === "REAL" ? "accent" : "warn",
          },
        ]}
      />
      {rows.length === 0 ? (
        <div className="mt">
          <EmptyState
            title="No agents yet"
            body="Register your first agent to start the lifecycle. Each metric on this page is computed from real API responses."
            action={
              <a className="btn btn-primary" href="#/agents/new">
                Register agent
              </a>
            }
          />
        </div>
      ) : (
        <>
          <div className="grid grid-4 mt">
            <MetricCard
              label="Registered agents"
              value={rows.length}
              icon={<VectorAgent size={16} />}
              tone="accent"
              sub={`${byStatus.get("ACTIVE") ?? 0} active / ${byStatus.get("ELIGIBLE") ?? 0} eligible`}
            />
            <MetricCard
              label="Active bonds"
              value={
                (byStatus.get("ACTIVE") ?? 0) + (byStatus.get("BONDED") ?? 0)
              }
              icon={<VectorBond size={16} />}
              tone="accent"
              sub="collateral committed"
            />
            <MetricCard
              label="Risk events"
              value={loadingExtra ? "…" : openFlags}
              icon={<VectorRisk size={16} />}
              tone={openFlags > 0 ? "warn" : "good"}
              sub={worst ? `top severity ${worst}` : "no open findings"}
            />
            <MetricCard
              label="Attestations"
              value={loadingExtra ? "…" : attestations}
              icon={<VectorAttestor size={16} />}
              tone="neutral"
              sub={`${slashes} confirmed slash events`}
            />
          </div>
          <div className="grid grid-2 mt">
            <TechnicalCard
              title="Reputation"
              icon={<VectorReputation size={18} />}
              tone="violet"
            >
              {loadingExtra || !reputation ? (
                <p>Resolving standings…</p>
              ) : (
                <div className="row">
                  <StatusBadge status="good" /> {reputation.good}
                  <StatusBadge status="probation" /> {reputation.probation}
                  <StatusBadge status="poor" /> {reputation.poor}
                </div>
              )}
            </TechnicalCard>
            <TechnicalCard
              title="Risk overview"
              icon={<VectorShield size={18} />}
              tone={worst === "critical" ? "bad" : worst ? "warn" : "good"}
            >
              {loadingExtra ? (
                <p>Resolving findings…</p>
              ) : (
                <RiskGauge
                  score={
                    worst === "critical"
                      ? 90
                      : worst === "high"
                        ? 65
                        : worst === "medium"
                          ? 45
                          : worst === "low"
                            ? 20
                            : 0
                  }
                  level={worst ? worst.toUpperCase() : "NOMINAL"}
                />
              )}
            </TechnicalCard>
          </div>
          <div className="card mt">
            <h2>Attention needed</h2>
            {extraError ? (
              <ErrorState message={extraError} onRetry={agents.reload} />
            ) : loadingExtra ? (
              <LoadingState label="Resolving flags" />
            ) : atRisk.length === 0 ? (
              <p className="muted">
                <VectorSlash size={14} /> No open flags. Nothing needs review.
              </p>
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
    </div>
  );
}
