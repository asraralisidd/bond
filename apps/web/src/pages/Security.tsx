/**
 * Security: confirmed slash/enforcement history aggregated across owned
 * agents via public verification. Only confirmed records appear —
 * unconfirmed activity is never shown as enforcement.
 */
import { api, useApi } from "../api/client.js";
import { DataState } from "../components/DataState.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { PrincipleQuote } from "../components/vectors.js";
import { TechnicalCard, VectorSlash } from "../components/vectors.js";

interface SlashRow {
  agentId: string;
  slashEventId: string;
  band: string;
  severity: string;
  completedAt: string | null;
}

export function SecurityPage() {
  const agents = useApi(() => api.listAgents(100), []);
  const slashes = useApi(async () => {
    const rows = await api.listAgents(100);
    const out: SlashRow[] = [];
    for (const a of rows) {
      const verification = await api.verifyAgent(a.agentId).catch(() => null);
      if (!verification) {
        continue;
      }
      for (const s of verification.slashHistory) {
        out.push({
          agentId: a.agentId,
          slashEventId: s.slashEventId,
          band: s.band,
          severity: s.severity,
          completedAt: s.completedAt,
        });
      }
    }
    return out;
  }, []);

  return (
    <div className="page-enter">
      <PageHeader
        title="Slash Events"
        intro="Confirmed enforcement history. Every row below links to a confirmed slash record — nothing provisional is listed as enforcement."
      />
      <PrincipleQuote
        quote="Separate detection from enforcement."
        tone="neutral"
        compact
      />
      <TechnicalCard
        title="Enforcement ledger"
        icon={<VectorSlash size={18} />}
        tone="bad"
      >
        <DataState<SlashRow[]>
          loading={agents.loading || slashes.loading}
          error={agents.error ?? slashes.error}
          data={slashes.data}
          onRetry={() => {
            agents.reload();
            slashes.reload();
          }}
          empty={{
            title: "No confirmed slash events",
            body: "No enforcement has been confirmed for your agents. This is absence of confirmed findings — not proof of safety.",
          }}
        >
          {(rows) => (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th scope="col">Event</th>
                    <th scope="col">Agent</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Severity</th>
                    <th scope="col">Completed</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((s) => (
                    <tr key={s.slashEventId}>
                      <td className="mono">{s.slashEventId.slice(0, 8)}…</td>
                      <td className="mono">
                        <a href={`#/agents/${s.agentId}`}>
                          {s.agentId.slice(0, 8)}…
                        </a>
                      </td>
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
          )}
        </DataState>
      </TechnicalCard>
    </div>
  );
}
