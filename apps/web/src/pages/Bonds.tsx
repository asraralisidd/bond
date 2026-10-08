/**
 * Bonds: create, look up by id, release/withdraw intents.
 * Amounts shown are owner-visible commitments only — public views
 * elsewhere never carry them.
 */
import { useState } from "react";
import { api, ApiError } from "../api/client.js";
import type { BondView } from "../api/types.js";
import { PageHeader, StatusBadge } from "../components/chrome.js";
import { TxBadge } from "../components/lifecycle.js";
import { useToast } from "../app/toast.js";
import { recents, remember } from "../lib/recent.js";

/** Privacy-oriented bond state: what the protocol discloses. */
function privacyState(status: string): string {
  if (status === "WITHDRAWN") {
    return "RELEASED";
  }
  if (status === "WITHDRAWABLE") {
    return "VERIFIED";
  }
  if (
    status === "ACTIVE" ||
    status === "LOCKED" ||
    status === "PARTIALLY_SLASHED" ||
    status === "FULLY_SLASHED"
  ) {
    return "LOCKED";
  }
  return "PRIVATE";
}

function BondCard({
  bond,
  onChanged,
}: {
  bond: BondView;
  onChanged: () => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);

  async function advance(txPurpose: string, txAgent: string) {
    setBusy(true);
    try {
      const tx = await api.createTransaction({
        purpose: txPurpose,
        agentId: txAgent,
        bondId: bond.bondId,
        idempotencyKey: crypto.randomUUID(),
      });
      remember({
        kind: "transaction",
        id: tx.transactionId,
        agentId: txAgent,
        label: `${txPurpose} → ${tx.status}`,
      });
      await api.advanceTransaction(tx.transactionId, "WALLET_APPROVAL");
      await api.advanceTransaction(tx.transactionId, "PENDING");
      toast.notify(
        "info",
        `Transaction ${tx.transactionId.slice(0, 8)}… submitted (SIMULATED)`,
      );
      onChanged();
    } catch (err) {
      toast.notify(
        "error",
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function setStatus(status: string) {
    setBusy(true);
    try {
      await api.setBondStatus(bond.bondId, status);
      toast.notify("success", `Bond → ${status}`);
      onChanged();
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
    <div className="card">
      <h2 className="mono">{bond.bondId.slice(0, 12)}…</h2>
      <dl className="kv">
        <dt>Status</dt>
        <dd>
          <StatusBadge status={bond.status} />
        </dd>
        <dt>Disclosure</dt>
        <dd>
          <StatusBadge status={privacyState(bond.status)} />
        </dd>
        <dt>Agent</dt>
        <dd className="mono">{bond.agentId.slice(0, 8)}…</dd>
        <dt>Policy</dt>
        <dd className="mono">{bond.policyVersion}</dd>
        <dt>Slashed total</dt>
        <dd className="mono">{bond.slashedTotalMinorUnits}</dd>
        <dt>Withdrawal</dt>
        <dd>{bond.withdrawalConsumed ? "consumed" : "not consumed"}</dd>
      </dl>
      <div className="row mt">
        {(bond.status === "ACTIVE" || bond.status === "PARTIALLY_SLASHED") && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => setStatus("WITHDRAWABLE")}
          >
            Mark withdrawable
          </button>
        )}
        {bond.status === "WITHDRAWABLE" && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => advance("WITHDRAW", bond.agentId)}
          >
            Withdraw (SIMULATED tx)
          </button>
        )}
        {bond.status === "CREATED" && (
          <button
            type="button"
            className="btn btn-sm"
            disabled={busy}
            onClick={() => advance("FUND_BOND", bond.agentId)}
          >
            Fund (SIMULATED tx)
          </button>
        )}
      </div>
    </div>
  );
}

export function BondsPage() {
  const toast = useToast();
  const [agentId, setAgentId] = useState("");
  const [amount, setAmount] = useState("");
  const [lookup, setLookup] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<BondView | null>(null);
  const recent = recents("bond");

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bond = await api.createBond({
        agentId: agentId.trim(),
        commitmentMinorUnits: amount.trim(),
      });
      remember({
        kind: "bond",
        id: bond.bondId,
        agentId: bond.agentId,
        label: `${bond.status} · policy ${bond.policyVersion}`,
      });
      toast.notify("success", "Bond intent created");
      setCurrent(bond);
    } catch (err) {
      const message =
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err);
      setError(message);
    } finally {
      setBusy(false);
    }
  }

  async function lookupBond(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const bond = await api.getBond(lookup.trim());
      setCurrent(bond);
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
        title="Bonds"
        intro="Collateral intents and lifecycle. Chain effects move through explicitly tracked SIMULATED transactions — never silently."
      />
      <div className="grid grid-2">
        <div className="card">
          <h2>Create bond</h2>
          {error ? (
            <div
              className="alert alert-error"
              role="alert"
              style={{ marginBottom: "0.8rem" }}
            >
              {error}
            </div>
          ) : null}
          <form className="form" onSubmit={create}>
            <div className="field">
              <label htmlFor="bond-agent">Agent ID</label>
              <input
                id="bond-agent"
                className="mono"
                value={agentId}
                onChange={(e) => setAgentId(e.target.value)}
                placeholder="agent uuid"
                required
              />
            </div>
            <div className="field">
              <label htmlFor="bond-amount">
                Commitment (minor units, digits)
              </label>
              <input
                id="bond-amount"
                className="mono"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="e.g. 10000"
                inputMode="numeric"
                required
              />
              <span className="hint">
                Owner-visible only. Public views never carry amounts.
              </span>
            </div>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Creating…" : "Create bond"}
            </button>
          </form>
        </div>
        <div className="card">
          <h2>Look up bond</h2>
          <form className="form" onSubmit={lookupBond}>
            <div className="field">
              <label htmlFor="bond-lookup">Bond ID</label>
              <input
                id="bond-lookup"
                className="mono"
                value={lookup}
                onChange={(e) => setLookup(e.target.value)}
                placeholder="bond uuid"
                required
              />
            </div>
            <button type="submit" className="btn" disabled={busy}>
              Look up
            </button>
          </form>
          {recent.length > 0 ? (
            <>
              <h3 className="mt">Created in this browser</h3>
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th scope="col">Bond</th>
                      <th scope="col">Note</th>
                      <th scope="col">Open</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recent.map((r) => (
                      <tr key={r.id}>
                        <td className="mono">{r.id.slice(0, 8)}…</td>
                        <td>{r.label}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-sm btn-ghost"
                            onClick={() => setLookup(r.id)}
                          >
                            Load
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          ) : null}
        </div>
      </div>
      {current ? (
        <div className="mt">
          <BondCard
            bond={current}
            onChanged={async () => {
              try {
                setCurrent(await api.getBond(current.bondId));
              } catch {
                // keep stale view on read failure
              }
            }}
          />
        </div>
      ) : null}
      <TxNote />
    </>
  );
}

function TxNote() {
  return (
    <div className="hero-strip mt">
      <strong>SIMULATED transactions</strong> execute normative rules in-memory
      and are labeled as such everywhere.{" "}
      <TxBadge status="SUBMITTED" mode="SIMULATED" /> is not confirmation —{" "}
      <TxBadge status="CONFIRMED" mode="REAL" /> only follows chain finality.
    </div>
  );
}
