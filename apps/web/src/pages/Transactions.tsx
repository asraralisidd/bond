/**
 * Transaction tracker: look up any transaction, advance its lifecycle,
 * and confirm it. SIMULATED receipts stay visibly simulated; CONFIRMED
 * appears only after explicit confirmation/finality.
 */
import { useState } from "react";
import { api, ApiError, useApi } from "../api/client.js";
import type { TransactionView } from "../api/types.js";
import { DataState } from "../components/DataState.js";
import { PageHeader } from "../components/chrome.js";
import { TxBadge } from "../components/lifecycle.js";
import { useToast } from "../app/toast.js";
import { remember } from "../lib/recent.js";

const ADVANCE_ORDER: Record<string, string | null> = {
  IDLE: "WALLET_APPROVAL",
  WALLET_APPROVAL: "PENDING",
};

export function TransactionsPage({ initialId }: { initialId?: string }) {
  const [txId, setTxId] = useState(initialId ?? "");
  const [queried, setQueried] = useState<string | null>(initialId ?? null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  const tx = useApi(
    () =>
      queried
        ? api.getTransaction(queried)
        : Promise.reject(new Error("no-tx")),
    [queried],
  );

  async function advance() {
    if (!tx.data) {
      return;
    }
    const next = ADVANCE_ORDER[tx.data.status];
    if (!next) {
      toast.notify(
        "info",
        "Worker or explicit confirm moves this state forward",
      );
      return;
    }
    setBusy(true);
    try {
      const updated = await api.advanceTransaction(tx.data.transactionId, next);
      remember({
        kind: "transaction",
        id: updated.transactionId,
        agentId: updated.agentId ?? null,
        label: `${updated.purpose} → ${updated.status}`,
      });
      toast.notify("success", `Transaction → ${updated.status}`);
      tx.reload();
    } catch (err) {
      toast.notify(
        "error",
        err instanceof ApiError ? `${err.code}: ${err.message}` : String(err),
      );
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!tx.data) {
      return;
    }
    setBusy(true);
    try {
      const updated = await api.confirmTransaction(tx.data.transactionId);
      toast.notify("success", `Transaction → ${updated.status}`);
      tx.reload();
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
        title="Transactions"
        intro="Explicit lifecycle tracking. Submission and confirmation are separate, visible steps — a submitted transaction is never shown as confirmed."
      />
      <div className="card">
        <form
          className="form"
          onSubmit={(e) => {
            e.preventDefault();
            setQueried(txId.trim() || null);
          }}
        >
          <div className="field">
            <label htmlFor="tx-id">Transaction ID</label>
            <input
              id="tx-id"
              className="mono"
              value={txId}
              onChange={(e) => setTxId(e.target.value)}
              placeholder="transaction uuid"
              required
            />
          </div>
          <button type="submit" className="btn">
            Track
          </button>
        </form>
      </div>
      {queried ? (
        <div className="mt">
          <DataState<TransactionView>
            loading={tx.loading}
            error={tx.error?.message === "no-tx" ? null : tx.error}
            data={tx.error ? null : tx.data}
            onRetry={tx.reload}
            empty={{
              title: "No transaction loaded",
              body: "Enter an ID above.",
            }}
          >
            {(t) => (
              <div className="card">
                <h2>
                  <TxBadge
                    status={t.status}
                    mode={
                      t.chainTxId?.startsWith("sim-")
                        ? "SIMULATED"
                        : t.chainTxId
                          ? "REAL"
                          : null
                    }
                  />
                </h2>
                <dl className="kv">
                  <dt>Transaction</dt>
                  <dd className="mono">{t.transactionId}</dd>
                  <dt>Purpose</dt>
                  <dd className="mono">{t.purpose}</dd>
                  <dt>Chain ref</dt>
                  <dd className="mono">{t.chainTxId ?? "—"}</dd>
                  <dt>Confirmed</dt>
                  <dd className="mono">{t.confirmedAt ?? "—"}</dd>
                </dl>
                <div className="row mt">
                  {ADVANCE_ORDER[t.status] ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      disabled={busy}
                      onClick={advance}
                    >
                      Advance to {ADVANCE_ORDER[t.status]}
                    </button>
                  ) : null}
                  {t.status === "SUBMITTED" ? (
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy}
                      onClick={confirm}
                    >
                      Confirm (explicit)
                    </button>
                  ) : null}
                </div>
              </div>
            )}
          </DataState>
        </div>
      ) : null}
    </div>
  );
}
