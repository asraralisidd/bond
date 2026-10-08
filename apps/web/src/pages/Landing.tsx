/**
 * Public landing: protocol identity, architecture diagram, security
 * layers, and lifecycle timeline. No API calls, no session required —
 * entry points link to wallet sign-in and public verification.
 */
import {
  ArchitectureDiagram,
  PrincipleQuote,
  SecurityTimeline,
  TechnicalCard,
  VectorAttestor,
  VectorBond,
  VectorRisk,
  VectorShield,
  VectorZK,
} from "../components/vectors.js";

const LAYERS = [
  {
    title: "Private Collateral",
    icon: <VectorBond size={18} />,
    tone: "accent" as const,
    body: "Bond commitments stay sealed. Only status transitions and slash totals reach public state — principals never do.",
  },
  {
    title: "ZK Eligibility",
    icon: <VectorZK size={18} />,
    tone: "violet" as const,
    body: "Prove collateral sufficiency without exposing amounts, salts, or secrets. Nullifiers prevent replay.",
  },
  {
    title: "AI Risk Intelligence",
    icon: <VectorRisk size={18} />,
    tone: "warn" as const,
    body: "Deterministic rules, behavioral detectors, and policy checks turn agent activity into explainable findings.",
  },
  {
    title: "Automated Enforcement",
    icon: <VectorAttestor size={18} />,
    tone: "good" as const,
    body: "Independent attestor quorum decides. Enforcement executes deterministically — never on a raw flag alone.",
  },
];

export function LandingPage() {
  return (
    <div className="page-enter">
      <section className="hero" aria-labelledby="landing-title">
        <span className="hero-eyebrow">
          <VectorShield size={14} /> AI SECURITY INFRASTRUCTURE
        </span>
        <h1 id="landing-title">
          BOND
          <br />
          <span className="grad">
            Privacy-Preserving Security Infrastructure for Autonomous AI Agents
          </span>
        </h1>
        <p className="hero-sub">
          Collateral, risk intelligence, independent attestation, and automated
          enforcement for autonomous AI agents.
        </p>
        <div className="hero-actions">
          <a className="btn btn-primary btn-lg" href="#/login">
            Connect Wallet
          </a>
          <a className="btn btn-lg" href="#/verify">
            Verify Agent
          </a>
        </div>
      </section>

      <PrincipleQuote
        quote="Autonomy without accountability is a security gap."
        supporting="BOND turns autonomous agent behavior into verifiable, enforceable security."
        tone="accent"
      />

      <h2 className="section-label">Protocol pipeline</h2>
      <ArchitectureDiagram />
      <PrincipleQuote
        quote="AI detects. Attestors verify. The protocol enforces."
        tone="accent"
      />

      <h2 className="section-label">Security layers</h2>
      <div className="layer-grid">
        {LAYERS.map((layer) => (
          <TechnicalCard
            key={layer.title}
            title={layer.title}
            icon={layer.icon}
            tone={layer.tone}
          >
            <p>{layer.body}</p>
          </TechnicalCard>
        ))}
      </div>

      <h2 className="section-label">How BOND works</h2>
      <div className="tcard">
        <SecurityTimeline />
        <p
          className="muted"
          style={{ marginTop: "0.8rem", fontSize: "0.85rem" }}
        >
          Every stage is enforced by protocol rules and recorded as auditable
          events — registration through withdrawal.
        </p>
      </div>
    </div>
  );
}
