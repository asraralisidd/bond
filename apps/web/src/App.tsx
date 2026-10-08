/**
 * BOND dashboard application: session + toast providers, auth-gated
 * shell, hash routing. Public verification stays accessible signed out.
 */
import { useRoute } from "./app/router.js";
import { SessionProvider, useSession } from "./app/session.js";
import { ToastProvider } from "./app/toast.js";
import { Layout } from "./components/chrome.js";
import { DashboardPage } from "./pages/Dashboard.js";
import { AgentsPage } from "./pages/Agents.js";
import { AgentDetailPage } from "./pages/AgentDetail.js";
import { AgentNewPage } from "./pages/AgentNew.js";
import { BondsPage } from "./pages/Bonds.js";
import { RiskPage } from "./pages/Risk.js";
import { AttestationsPage } from "./pages/Attestations.js";
import { AttestationDetailPage } from "./pages/AttestationDetail.js";
import { LandingPage } from "./pages/Landing.js";
import { SecurityPage } from "./pages/Security.js";
import { VerifyPage } from "./pages/Verify.js";
import { TransactionsPage } from "./pages/Transactions.js";
import { LoginPage } from "./pages/Login.js";

function Guarded({ children }: { children: React.ReactNode }) {
  const session = useSession();
  if (!session.token) {
    return <LoginPage />;
  }
  return <>{children}</>;
}

function DashboardOrLanding() {
  const session = useSession();
  if (!session.token) {
    return <LandingPage />;
  }
  return (
    <Guarded>
      <DashboardPage />
    </Guarded>
  );
}

function Routes() {
  const route = useRoute();
  const [name, ...rest] = route.segments;

  if (name === "login") {
    return <LoginPage />;
  }
  if (name === "verify") {
    return <VerifyPage />;
  }
  if (name === "dashboard" && rest.length === 0) {
    return <DashboardOrLanding />;
  }
  if (name === "agents" && rest.length === 0) {
    return (
      <Guarded>
        <AgentsPage />
      </Guarded>
    );
  }
  if (name === "agents" && rest[0] === "new") {
    return (
      <Guarded>
        <AgentNewPage />
      </Guarded>
    );
  }
  if (name === "agents" && rest[0]) {
    return (
      <Guarded>
        <AgentDetailPage agentId={rest[0]} />
      </Guarded>
    );
  }
  if (name === "bonds") {
    return (
      <Guarded>
        <BondsPage />
      </Guarded>
    );
  }
  if (name === "risk") {
    return (
      <Guarded>
        <RiskPage />
      </Guarded>
    );
  }
  if (name === "attestations" && rest.length === 0) {
    return (
      <Guarded>
        <AttestationsPage />
      </Guarded>
    );
  }
  if (name === "attestations" && rest[0]) {
    return (
      <Guarded>
        <AttestationDetailPage attestationId={rest[0]} />
      </Guarded>
    );
  }
  if (name === "security") {
    return (
      <Guarded>
        <SecurityPage />
      </Guarded>
    );
  }
  if (name === "transactions") {
    return (
      <Guarded>
        <TransactionsPage initialId={rest[0]} />
      </Guarded>
    );
  }
  return (
    <Guarded>
      <DashboardPage />
    </Guarded>
  );
}

export function App() {
  return (
    <SessionProvider>
      <ToastProvider>
        <Layout>
          <Routes />
        </Layout>
      </ToastProvider>
    </SessionProvider>
  );
}
