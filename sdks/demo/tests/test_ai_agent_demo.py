"""AI demo unit tests. Stub model + stub client only — no network, no
database, no wallet, no model keys. A live run against the local stack
is performed manually per the README.
"""

import io
import sys

import pytest

sys.path.insert(0, "sdks/demo")

from bond_sdk import BondApiError  # noqa: E402
from ai_agent_demo import (  # noqa: E402
    AIDemoConfig,
    AIAgent,
    EnvModelProvider,
    ScriptedModelProvider,
    main,
)


class StubClient:
    """Recording stand-in for BondClient (risky-scenario flow)."""

    def __init__(self):
        self.calls = []
        self.token = None

    def create_setup_grant(self, scopes, **kwargs):
        self.calls.append(("create_setup_grant", tuple(scopes)))
        return {
            "metadata": {"grantId": "grant-ai-1", "scopes": list(scopes)},
            "secret": "grant-secret-xyz",
        }

    def health(self):
        self.calls.append("health")
        return {"status": "ok"}

    def create_session(self, dev_key, external_key):
        self.calls.append("create_session")
        assert dev_key == "SECRET-TOKEN-XYZ"
        return {"token": "SECRET-TOKEN-XYZ", "operatorId": "op_ai"}

    def set_token(self, token):
        self.calls.append("set_token")
        self.token = token

    def register_agent(self, **kwargs):
        self.calls.append("register_agent")
        return {
            "agentId": "agent-ai-1",
            "agentType": "custom",
            "status": "REGISTERED",
            "externalRef": kwargs["external_ref"],
        }

    def close(self):
        self.calls.append("close")

    def create_agent_credential(self, agent_id, **kwargs):
        self.calls.append("create_agent_credential")
        return {
            "metadata": {
                "credentialId": "cred-ai-1",
                "agentId": agent_id,
                "status": "ACTIVE",
            },
            "secret": "agent-secret-xyz",
        }

    def revoke_agent_credential(self, agent_id, credential_id, **kwargs):
        self.calls.append(("revoke_agent_credential", credential_id))
        return {"revoked": True, "credentialId": credential_id}

    def analyze_activity(self, agent_id, activity):
        self.calls.append(("analyze_activity", activity["actionType"]))
        return {
            "analysisId": "an-ai-1",
            "score": {"score": 85},
            "flagIds": ["flag-ai-1"],
        }

    def list_flags(self, agent_id):
        self.calls.append("list_flags")
        return [
            {
                "riskFlagId": "flag-ai-1",
                "severity": "high",
                "category": "overspend",
            }
        ]

    def get_flag(self, flag_id):
        self.calls.append(("get_flag", flag_id))
        return {
            "riskFlagId": flag_id,
            "severity": "high",
            "category": "overspend",
        }

    def get_agent(self, agent_id):
        self.calls.append("get_agent")
        return {"agentId": "agent-ai-1", "status": "FLAGGED"}

    def verify_agent(self, agent_id):
        self.calls.append("verify_agent")
        return {"verification": {"result": "caution"}}

    def create_bond(self, **kwargs):
        self.calls.append("create_bond")
        return {"bondId": "bond-ai-1", "status": "CREATED"}

    def set_bond_status(self, bond_id, status):
        self.calls.append(("set_bond_status", status))
        return {"bondId": bond_id, "status": status}

    def get_bond(self, bond_id):
        self.calls.append("get_bond")
        return {"bondId": bond_id, "status": "PARTIALLY_SLASHED"}

    def register_attestor(self, **kwargs):
        self.calls.append("register_attestor")
        return {"attestorId": kwargs["attestor_id"]}

    def request_attestation(self, **kwargs):
        self.calls.append("request_attestation")
        assert kwargs["threshold"] == 2
        return {"attestationId": "att-ai-1", "status": "requested"}

    def submit_verdict(self, attestation_id, **kwargs):
        self.calls.append(("submit_verdict", kwargs["attestor_id"]))
        assert kwargs["verdict"] == "confirm"
        return {"status": "recorded", "verdicts": 1}

    def get_attestation(self, attestation_id):
        self.calls.append("get_attestation")
        return {"attestationId": attestation_id, "status": "quorum-met"}

    def issue_decision(self, attestation_id, action=None):
        self.calls.append(("issue_decision", action))
        assert action == "partial-slash"
        return {"status": "decided", "action": "partial-slash"}

    def enforce_attestation(self, attestation_id, amount_minor_units=None):
        self.calls.append("enforce_attestation")
        return {
            "transactionId": "tx-ai-1",
            "purpose": "ENFORCEMENT",
            "status": "SUBMITTED",
        }

    def get_transaction(self, transaction_id):
        self.calls.append("get_transaction")
        return {"transactionId": transaction_id, "status": "SUBMITTED"}

    def close(self):
        self.calls.append("close")


def risky_config():
    return AIDemoConfig(
        api_url="http://localhost:4000",
        dev_auth_token="SECRET-TOKEN-XYZ",
        external_key="ai-demo-operator",
        mode="scripted",
        scenario="risky",
    )


def behavioral_config():
    return AIDemoConfig(
        api_url="http://localhost:4000",
        dev_auth_token="SECRET-TOKEN-XYZ",
        external_key="ai-demo-operator",
        mode="scripted",
        scenario="behavioral",
    )


def test_scripted_provider_deterministic():
    benign = ScriptedModelProvider("benign")
    first = benign.generate("p", {})
    second = benign.generate("p", {})
    assert first == second
    assert first.action == "pay-vendor"
    assert first.action_type == "transfer"
    assert first.parameters["amount_minor_units"] == "500"

    risky = ScriptedModelProvider("risky")
    response = risky.generate("p", {})
    assert response.action == "self-transfer"
    assert response.parameters["amount_minor_units"] == "3000"

    with pytest.raises(BondApiError):
        ScriptedModelProvider("nonsense")


def test_live_model_without_key_fails_safely():
    with pytest.raises(BondApiError) as exc_info:
        EnvModelProvider(None, None)
    assert "BOND_MODEL_API_KEY" in exc_info.value.message
    provider = EnvModelProvider("openai", "sk-test")
    with pytest.raises(BondApiError) as exc_info2:
        provider.generate("p", {})
    assert "not verified" in exc_info2.value.message


def test_benign_and_risky_activity_inputs_valid():
    from bond_sdk import ActivityPolicyContext, build_activity

    benign = ScriptedModelProvider("benign").generate("p", {})
    built_benign = build_activity(
        agent_id="agent-ai-1",
        action_type=benign.action_type,  # type: ignore[arg-type]
        action=benign.action,
        policy_context=ActivityPolicyContext(
            policy_version="bond-policy-v1",
            allowed_actions=("pay-vendor",),
            declared_tools=("transfers",),
            spend_limit_minor_units="1000",
        ),
        **benign.parameters,
    )
    assert built_benign["actionType"] == "transfer"

    risky = ScriptedModelProvider("risky").generate("p", {})
    built_risky = build_activity(
        agent_id="agent-ai-1",
        action_type=risky.action_type,  # type: ignore[arg-type]
        action=risky.action,
        policy_context=ActivityPolicyContext(
            policy_version="bond-policy-v1",
            allowed_actions=("pay-vendor",),
            declared_tools=("transfers",),
            denylisted_actions=("self-transfer",),
            spend_limit_minor_units="1000",
        ),
        **risky.parameters,
    )
    assert built_risky["amountMinorUnits"] == "3000"


def test_malformed_model_output_fails_safely():
    from bond_sdk import ActivityPolicyContext, build_activity

    with pytest.raises(BondApiError):
        build_activity(
            agent_id="agent-ai-1",
            action_type="teleport",  # type: ignore[arg-type]
            action="move",
            policy_context=ActivityPolicyContext(
                policy_version="bond-policy-v1"
            ),
        )


def test_risky_flow_end_to_end_offline():
    client = StubClient()
    agent_stub = StubClient()
    seen_tokens = []

    def factory(base_url, token):
        seen_tokens.append(token)
        assert token.startswith("cred-ai-1.")
        return agent_stub

    out = io.StringIO()
    summary = AIAgent(
        risky_config(),
        client,
        ScriptedModelProvider("risky"),
        agent_client_factory=factory,
        grant_client_factory=lambda base_url, token: StubClient(),
    ).run(out=out)
    assert summary["agentId"] == "agent-ai-1"
    assert summary["credentialId"] == "cred-ai-1"
    assert summary["credentialRevoked"] is True
    assert summary["quorum"] == "quorum-met"
    assert summary["decision"] == "partial-slash"
    assert summary["transactionId"] == "tx-ai-1"
    assert summary["enforcement"] == "SIMULATED"
    assert summary["release"] == "WITHDRAWABLE"
    # Agent-scoped calls went through the agent client, not the operator.
    agent_verbs = [
        c if isinstance(c, str) else c[0] for c in agent_stub.calls
    ]
    for verb in (
        "analyze_activity",
        "get_flag",
        "list_flags",
        "get_agent",
        "verify_agent",
    ):
        assert verb in agent_verbs
    operator_verbs = [
        c if isinstance(c, str) else c[0] for c in client.calls
    ]
    assert "analyze_activity" not in operator_verbs
    assert ("revoke_agent_credential", "cred-ai-1") in client.calls
    # Delegated setup: the operator minted a registration grant and the
    # registration itself ran outside the operator client.
    assert ("create_setup_grant", ("agent:register",)) in client.calls
    assert "register_agent" not in operator_verbs
    text = out.getvalue()
    for marker in (
        "BOND AI AGENT SECURITY DEMO",
        "Mode:\n  scripted",
        "Scenario:\n  risky",
        "Enforcement:\n  SIMULATED",
        "cred-ai-1",
    ):
        assert marker in text
    # No fake chain claims, no secrets.
    assert "CONFIRMED" not in text
    assert "0x" not in text
    assert "SECRET-TOKEN-XYZ" not in text
    assert "agent-secret-xyz" not in text
    assert "Authorization" not in text
    assert "Bearer" not in text


def test_benign_flow_zero_flags():
    class BenignClient(StubClient):
        def analyze_activity(self, agent_id, activity):
            self.calls.append(("analyze_activity", activity["actionType"]))
            return {"analysisId": "an-b", "score": None, "flagIds": []}

        def list_flags(self, agent_id):
            self.calls.append("list_flags")
            return []

    config = AIDemoConfig(
        api_url="http://localhost:4000",
        dev_auth_token="SECRET-TOKEN-XYZ",
        external_key="ai-demo-operator",
        mode="scripted",
        scenario="benign",
    )
    out = io.StringIO()
    summary = AIAgent(
        config,
        BenignClient(),
        ScriptedModelProvider("benign"),
        agent_client_factory=lambda base_url, token: BenignClient(),
        grant_client_factory=lambda base_url, token: BenignClient(),
    ).run(out=out)
    assert summary["flags"] == []
    assert summary["credentialRevoked"] is True
    assert "enforcement" not in summary
    assert "No confirmed findings" in out.getvalue()


def test_attestation_submission_uses_sdk_only():
    client = StubClient()
    agent_stub = StubClient()
    AIAgent(
        risky_config(),
        client,
        ScriptedModelProvider("risky"),
        agent_client_factory=lambda base_url, token: agent_stub,
        grant_client_factory=lambda base_url, token: StubClient(),
    ).run(out=io.StringIO())
    verbs = [c if isinstance(c, str) else c[0] for c in client.calls]
    assert "request_attestation" in verbs
    assert verbs.count("register_attestor") == 2
    assert sum(1 for c in client.calls if c[0] == "submit_verdict") == 2


def test_credential_revoked_even_on_failure():
    class FailingAgentClient(StubClient):
        def analyze_activity(self, agent_id, activity):
            raise BondApiError("INTERNAL_ERROR", "boom", 500, None)

    client = StubClient()
    with pytest.raises(BondApiError):
        AIAgent(
            risky_config(),
            client,
            ScriptedModelProvider("risky"),
            agent_client_factory=lambda base_url, token: FailingAgentClient(),
            grant_client_factory=lambda base_url, token: StubClient(),
        ).run(out=io.StringIO())
    assert ("revoke_agent_credential", "cred-ai-1") in client.calls


def test_no_forbidden_imports():
    import pathlib
    import re

    source = pathlib.Path("sdks/demo/ai_agent_demo.py").read_text()
    import_lines = [
        line
        for line in source.splitlines()
        if re.match(r"^\s*(import|from)\s+", line)
    ]
    joined = "\n".join(import_lines)
    for forbidden in [
        "apps.",
        "psycopg",
        "web3",
        "eth_account",
        "midnight",
        "bond_attestor",
        "risk_engine",
    ]:
        assert forbidden not in joined, forbidden
    # No secret material anywhere in the source.
    assert "sk-" not in source
    assert "mnemonic" not in source
    assert "seed_phrase" not in source


def test_main_failure_paths_nonzero(capsys, monkeypatch):
    monkeypatch.setenv("BOND_API_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("BOND_DEV_AUTH_TOKEN", "bad")
    monkeypatch.delenv("BOND_DEV_EXTERNAL_KEY", raising=False)
    monkeypatch.delenv("BOND_DEMO_MODE", raising=False)
    monkeypatch.delenv("BOND_DEMO_SCENARIO", raising=False)
    assert main([]) == 1
    captured = capsys.readouterr()
    assert "demo failed:" in captured.err
    assert "bad" not in captured.err


def test_behavioral_flow_reports_rule_ids_and_versions():
    class BehavioralAgentClient(StubClient):
        def analyze_activity(self, agent_id, activity):
            self.calls.append(("analyze_activity", activity["actionType"]))
            n = sum(1 for c in self.calls if c[0] == "analyze_activity")
            factors = []
            if n >= 11:
                factors.append(
                    {
                        "ruleId": "activity-burst",
                        "severity": "medium",
                        "category": "anomalous-behavior",
                    }
                )
            if n >= 14:
                factors.append(
                    {
                        "ruleId": "spend-velocity",
                        "severity": "medium",
                        "category": "overspend",
                    }
                )
            if n == 16:
                factors.append(
                    {
                        "ruleId": "novel-tool",
                        "severity": "low",
                        "category": "capability-mismatch",
                    }
                )
            if n >= 18:
                factors.append(
                    {
                        "ruleId": "repeat-violation",
                        "severity": "high",
                        "category": "policy-violation",
                    }
                )
            return {
                "analysisId": f"an-b-{n}",
                "score": {"score": 30, "factors": factors},
                "flagIds": [],
            }

        def list_flags(self, agent_id):
            self.calls.append("list_flags")
            return [
                {
                    "riskFlagId": "rf-01234567-activity-burst",
                    "severity": "medium",
                    "category": "anomalous-behavior",
                    "modelVersion": (
                        "bond-risk-engine/engine-v1 "
                        "ruleset/ruleset-v2 scoring/scoring-v2"
                    ),
                }
            ]

    client = StubClient()
    agent_stub = BehavioralAgentClient()
    out = io.StringIO()
    summary = AIAgent(
        behavioral_config(),
        client,
        ScriptedModelProvider("behavioral"),
        agent_client_factory=lambda base_url, token: agent_stub,
        grant_client_factory=lambda base_url, token: StubClient(),
    ).run(out=out)
    assert summary["behavioralSteps"] == 19
    for rule_id in (
        "activity-burst",
        "spend-velocity",
        "novel-tool",
        "repeat-violation",
    ):
        assert rule_id in summary["behavioralRuleIds"], rule_id
    assert summary["behavioralModelVersions"] == [
        "bond-risk-engine/engine-v1 ruleset/ruleset-v2 scoring/scoring-v2"
    ]
    assert summary["credentialRevoked"] is True
    assert (
        sum(1 for c in agent_stub.calls if c[0] == "analyze_activity") == 19
    )
    text = out.getvalue()
    for rule_id in (
        "activity-burst",
        "spend-velocity",
        "novel-tool",
        "repeat-violation",
    ):
        assert rule_id in text, rule_id
    assert "ruleset-v2" in text
    assert "grant-secret-xyz" not in text
    assert "agent-secret-xyz" not in text
