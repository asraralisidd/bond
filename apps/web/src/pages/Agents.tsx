/**
 * My Agents: owner-scoped registry list + registration entry.
 */
import { api, useApi } from "../api/client.js";
import type { AgentView } from "../api/types.js";
import { DataState } from "../components/DataState.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";

export function AgentsPage() {
  const agents = useApi(() => api.listAgents(100), []);

  return (
    <>
      <PageHeader
        title="My Agents"
        intro="Agents registered under your operator identity. Selection opens lifecycle, bond, risk, and enforcement detail."
        actions={
          <a className="btn btn-primary" href="#/agents/new">
            Register agent
          </a>
        }
      />
      <DataState<AgentView[]>
        loading={agents.loading}
        error={agents.error}
        data={agents.data}
        onRetry={agents.reload}
        empty={{
          title: "No agents registered",
          body: "Register an agent to bond collateral, prove eligibility, and monitor risk.",
          action: (
            <a className="btn btn-primary" href="#/agents/new">
              Register your first agent
            </a>
          ),
        }}
      >
        {(rows) => (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Agent</th>
                  <th scope="col">Platform</th>
                  <th scope="col">Type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Sync</th>
                  <th scope="col">Detail</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.agentId}>
                    <td className="mono">{a.agentId.slice(0, 8)}…</td>
                    <td>{a.platform}</td>
                    <td>{a.agentType}</td>
                    <td>
                      <StatusBadge status={a.status} />
                    </td>
                    <td>
                      <StatusBadge status={a.syncStatus} />
                    </td>
                    <td>
                      <a href={`#/agents/${a.agentId}`}>Open</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </DataState>
    </>
  );
}
