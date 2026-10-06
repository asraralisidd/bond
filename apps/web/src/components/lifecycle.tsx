/**
 * Lifecycle stepper: REGISTER → BOND → PROVE → OPERATE → ASSESS →
 * ATTEST → ENFORCE. Pure visual derived from statuses — never state.
 */
const STEPS = [
  "REGISTER",
  "BOND",
  "PROVE",
  "OPERATE",
  "ASSESS",
  "ATTEST",
  "ENFORCE",
] as const;

function stepIndexFor(agentStatus: string, bondStatus: string | null): number {
  if (agentStatus === "SLASHED") {
    return 6;
  }
  if (agentStatus === "FLAGGED") {
    return 5;
  }
  if (agentStatus === "ACTIVE") {
    return 3;
  }
  if (agentStatus === "ELIGIBLE") {
    return 2;
  }
  if (agentStatus === "BONDED" || bondStatus !== null) {
    return 1;
  }
  return 0;
}

export function LifecycleStepper({
  agentStatus,
  bondStatus = null,
}: {
  agentStatus: string;
  bondStatus?: string | null;
}) {
  const current = stepIndexFor(agentStatus, bondStatus);
  return (
    <ol
      className="stepper"
      aria-label={`Protocol progress: stage ${current + 1} of ${STEPS.length}`}
      style={{ listStyle: "none", margin: 0, paddingLeft: 0 }}
    >
      {STEPS.map((step, i) => (
        <li
          key={step}
          className={`step${i < current ? " done" : ""}${i === current ? " current" : ""}`}
          aria-current={i === current ? "step" : undefined}
        >
          <span className="step-dot" aria-hidden="true">
            {i < current ? "✓" : i + 1}
          </span>
          <span className="step-label">{step}</span>
          {i < STEPS.length - 1 ? (
            <span className="step-line" aria-hidden="true" />
          ) : null}
        </li>
      ))}
    </ol>
  );
}

/** Transaction state badge: SIMULATED receipts are always marked. */
export function TxBadge({
  status,
  mode,
}: {
  status: string;
  mode?: string | null;
}) {
  return (
    <span className="row" style={{ gap: "0.4rem" }}>
      <span
        className={`badge ${
          status === "CONFIRMED"
            ? "badge-good"
            : status === "FAILED"
              ? "badge-bad"
              : "badge-warn"
        }`}
      >
        {status}
      </span>
      {mode && mode !== "REAL" ? (
        <span className="badge badge-warn" title="Simulated execution">
          {mode}
        </span>
      ) : null}
    </span>
  );
}
