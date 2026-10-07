"""DemoAgent unit tests. Stub transport only — no network, no wallet,
no live API. A separate live run against the local stack is performed
manually per the README.
"""

import io
import sys

import pytest

sys.path.insert(0, "sdks/demo")

from bond_sdk import BondApiError  # noqa: E402
from demo import (  # noqa: E402
    DEMO_EXTERNAL_REF,
    DemoAgent,
    DemoConfig,
    main,
    scripted_activities,
)


class StubClient:
    """Recording stand-in for BondClient."""

    def __init__(self, analyses=None, flags=None):
        self.calls = []
        self.token = None
        self._analyses = analyses
        self._flags = flags if flags is not None else []
        self._agent = {
            "agentId": "agent-demo-1",
            "platform": "bond-demo",
            "agentType": "custom",
            "status": "REGISTERED",
            "externalRef": DEMO_EXTERNAL_REF,
        }

    def health(self):
        self.calls.append("health")
        return {"status": "ok"}

    def create_session(self, dev_key, external_key):
        self.calls.append("create_session")
        assert dev_key == "SECRET-TOKEN-XYZ"
        return {"token": "SECRET-TOKEN-XYZ", "operatorId": "op_demo"}

    def set_token(self, token):
        self.calls.append("set_token")
        self.token = token

    def register_agent(self, **kwargs):
        self.calls.append("register_agent")
        assert kwargs["platform"] == "bond-demo"
        assert kwargs["agent_type"] == "custom"
        assert kwargs["external_ref"] == DEMO_EXTERNAL_REF
        return dict(self._agent)

    def analyze_activity(self, agent_id, activity):
        self.calls.append(("analyze_activity", activity["actionType"]))
        assert agent_id == "agent-demo-1"
        if self._analyses is not None:
            return self._analyses.pop(0)
        return {"analysisId": "a-1", "score": {"score": 0.1}, "flagIds": []}

    def list_flags(self, agent_id):
        self.calls.append("list_flags")
        return list(self._flags)

    def get_agent(self, agent_id):
        self.calls.append("get_agent")
        return dict(self._agent)

    def verify_agent(self, agent_id):
        self.calls.append("verify_agent")
        return {"verification": {"result": "trusted"}}

    def close(self):
        self.calls.append("close")


def make_config():
    return DemoConfig(
        api_url="http://localhost:4000",
        dev_auth_token="SECRET-TOKEN-XYZ",
        external_key="demo-operator",
    )


def test_config_from_env():
    config = DemoConfig.from_env(
        {
            "BOND_API_URL": "https://bond.example",
            "BOND_DEV_AUTH_TOKEN": "tok",
            "BOND_DEV_EXTERNAL_KEY": "op",
        }
    )
    assert config.api_url == "https://bond.example"
    assert config.dev_auth_token == "tok"
    assert config.external_key == "op"
    defaults = DemoConfig.from_env({})
    assert defaults.api_url == "http://localhost:4000"
    assert defaults.dev_auth_token is None
    assert defaults.external_key == "demo-operator"


def test_activity_sequence_deterministic():
    activities = scripted_activities("agent-demo-1")
    assert [a["actionType"] for a in activities] == [
        "message",
        "tool-call",
        "transfer",
    ]
    assert [a["activityId"] for a in activities] == [
        "demo-act-message-001",
        "demo-act-tool-001",
        "demo-act-transfer-001",
    ]
    assert all(a["agentId"] == "agent-demo-1" for a in activities)


def test_happy_path_summary_and_output():
    client = StubClient(
        analyses=[
            {"analysisId": "an-1", "score": {"score": 0.2}, "flagIds": ["f-1"]},
            {"analysisId": "an-2", "score": {"score": 0.0}, "flagIds": []},
            {"analysisId": "an-3", "score": {"score": 0.5}, "flagIds": []},
        ],
        flags=[{"riskFlagId": "f-1"}],
    )
    out = io.StringIO()
    summary = DemoAgent(make_config(), client).run(out=out)
    assert summary["agentId"] == "agent-demo-1"
    assert summary["status"] == "REGISTERED"
    assert summary["flagCount"] == 1
    assert summary["verification"] == "trusted"
    assert summary["analyses"][0]["analysisId"] == "an-1"
    text = out.getvalue()
    for marker in (
        "[1/7]",
        "[2/7]",
        "[3/7]",
        "[4/7]",
        "[5/7]",
        "[6/7]",
        "[7/7]",
        "Agent ID: agent-demo-1",
    ):
        assert marker in text
    # No secret output: token, headers, credentials must never appear.
    assert "SECRET-TOKEN-XYZ" not in text
    assert "Authorization" not in text
    assert "Bearer" not in text


def test_rerun_reuses_existing_agent():
    class ConflictClient(StubClient):
        def register_agent(self, **kwargs):
            self.calls.append("register_agent")
            raise BondApiError(
                "INVALID_IDENTIFIER",
                "Agent already registered for this operator/platform/reference",
                400,
                None,
            )

        def list_agents(self, limit=100):
            self.calls.append("list_agents")
            return [
                {
                    "agentId": "agent-demo-1",
                    "externalRef": DEMO_EXTERNAL_REF,
                    "status": "REGISTERED",
                }
            ]

    out = io.StringIO()
    summary = DemoAgent(make_config(), ConflictClient()).run(out=out)
    assert summary["agentId"] == "agent-demo-1"


def test_missing_dev_token_fails_cleanly():
    config = DemoConfig(api_url="http://localhost:4000", dev_auth_token=None)
    with pytest.raises(BondApiError) as exc_info:
        DemoAgent(config, StubClient()).run(out=io.StringIO())
    assert exc_info.value.code == "UNAUTHORIZED"


def test_main_failure_returns_nonzero(capsys, monkeypatch):
    monkeypatch.setenv("BOND_API_URL", "http://127.0.0.1:1")
    monkeypatch.setenv("BOND_DEV_AUTH_TOKEN", "bad")
    monkeypatch.delenv("BOND_DEV_EXTERNAL_KEY", raising=False)
    assert main([]) == 1
    captured = capsys.readouterr()
    assert "demo failed:" in captured.err
    assert "bad" not in captured.err
