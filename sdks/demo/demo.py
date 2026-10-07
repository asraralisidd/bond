"""Deterministic BOND agent-integration demo (Phase 16.4).

A scripted custom agent proving that an external AI agent integrates
with BOND through the Python SDK only:

    Demo Agent -> bond_sdk -> BOND API -> Risk Engine -> flags/status

Not an AI model. No model API keys. No live Midnight. See README.md.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from typing import Any, TextIO

from bond_sdk import (
    ActivityPolicyContext,
    BondApiError,
    BondClient,
    build_activity,
)

POLICY_VERSION = "bond-policy-v1"

# Deterministic demo identity. Same triple on every run so reruns hit
# the server's duplicate-triple guard instead of creating new agents.
DEMO_PLATFORM = "bond-demo"
DEMO_AGENT_TYPE = "custom"
DEMO_CAPABILITIES = ("demo-messaging", "demo-tool-use")
DEMO_EXTERNAL_REF = "demo-agent-v1"


@dataclass(frozen=True)
class DemoConfig:
    """Demo configuration from the environment. No secrets stored."""

    api_url: str = "http://localhost:4000"
    dev_auth_token: str | None = None
    external_key: str = "demo-operator"

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> DemoConfig:
        source = env if env is not None else os.environ
        return DemoConfig(
            api_url=source.get("BOND_API_URL", "http://localhost:4000"),
            dev_auth_token=source.get("BOND_DEV_AUTH_TOKEN"),
            external_key=source.get("BOND_DEV_EXTERNAL_KEY", "demo-operator"),
        )


def scripted_activities(agent_id: str) -> list[dict[str, Any]]:
    """Deterministic, harmless activity sequence (message/tool/transfer)."""
    policy = ActivityPolicyContext(policy_version=POLICY_VERSION)
    return [
        build_activity(
            agent_id=agent_id,
            action_type="message",
            action="demo-greeting",
            policy_context=policy,
            activity_id="demo-act-message-001",
            text_snippet="Hello from the BOND demo agent.",
            metadata={"channel": "demo"},
        ),
        build_activity(
            agent_id=agent_id,
            action_type="tool-call",
            action="demo-lookup",
            policy_context=policy,
            activity_id="demo-act-tool-001",
            tool="demo-kb",
            metadata={"query": "demo policies"},
        ),
        build_activity(
            agent_id=agent_id,
            action_type="transfer",
            action="demo-payout",
            policy_context=policy,
            activity_id="demo-act-transfer-001",
            amount_minor_units="100",
            metadata={"recipient": "demo-vendor"},
        ),
    ]


class DemoAgent:
    """Scripted agent driving the BOND Python SDK (injected client)."""

    def __init__(self, config: DemoConfig, client: BondClient) -> None:
        self._config = config
        self._client = client

    def run(self, out: TextIO = sys.stdout) -> dict[str, Any]:
        """Execute the integration flow. Returns a safe summary dict."""

        def emit(text: str) -> None:
            print(text, file=out)

        summary: dict[str, Any] = {}

        emit("================================")
        emit("BOND Agent Integration Demo")
        emit("================================")

        # [1/7] Connectivity.
        self._client.health()
        emit("[1/7] Connecting to BOND       ✓")

        # Authenticate (dev session; token stays inside the SDK client).
        if not self._config.dev_auth_token:
            raise BondApiError(
                "UNAUTHORIZED",
                "BOND_DEV_AUTH_TOKEN is not set.",
                0,
                None,
            )
        session = self._client.create_session(
            self._config.dev_auth_token, self._config.external_key
        )
        self._client.set_token(session["token"])

        # [2/7] Deterministic registration (rerun-safe).
        agent = self._register()
        agent_id = agent["agentId"]
        summary["agentId"] = agent_id
        emit("[2/7] Registering agent        ✓")

        # [3/7] + [4/7] Report each scripted activity, capture analysis.
        analyses: list[dict[str, Any]] = []
        total = len(scripted_activities(agent_id))
        for index, activity in enumerate(scripted_activities(agent_id), start=1):
            outcome = self._client.analyze_activity(agent_id, activity)
            score = outcome.get("score") or {}
            analyses.append(
                {
                    "analysisId": outcome.get("analysisId"),
                    "score": score.get("score"),
                    "flagIds": outcome.get("flagIds") or [],
                }
            )
            emit(f"[3/7] Reporting activity {index}/{total}      ✓")
        summary["analyses"] = analyses
        first = analyses[0]
        emit("[4/7] Risk analysis            ✓")

        # [5/7] Flags.
        flags = self._client.list_flags(agent_id) or []
        summary["flagCount"] = len(flags)
        emit("[5/7] Reading flags            ✓")

        # [6/7] Agent status.
        current = self._client.get_agent(agent_id)
        summary["status"] = current.get("status", "unknown")
        emit("[6/7] Reading agent status     ✓")

        # [7/7] Public verification (unauthenticated, scoped projection).
        verification = self._client.verify_agent(agent_id)
        summary["verification"] = (
            verification.get("verification", {}).get("result", "unknown")
            if isinstance(verification, dict)
            else "unknown"
        )
        emit("[7/7] Public verification      ✓")

        emit("")
        emit(f"Agent ID: {summary['agentId']}")
        emit(f"Analysis ID: {first.get('analysisId')}")
        emit(f"Risk Score: {first.get('score')}")
        emit(f"Flags: {summary['flagCount']}")
        emit(f"Status: {summary['status']}")
        emit(f"Verification: {summary['verification']}")
        return summary

    def _register(self) -> dict[str, Any]:
        try:
            return self._client.register_agent(
                platform=DEMO_PLATFORM,
                agent_type=DEMO_AGENT_TYPE,
                capabilities=list(DEMO_CAPABILITIES),
                external_ref=DEMO_EXTERNAL_REF,
            )
        except BondApiError as exc:
            # Rerun path: the deterministic triple already exists.
            if (
                exc.code == "INVALID_IDENTIFIER"
                and "already registered" in exc.message
            ):
                agents = self._client.list_agents(limit=100) or []
                for row in agents:
                    if (
                        isinstance(row, dict)
                        and row.get("externalRef") == DEMO_EXTERNAL_REF
                    ):
                        return row
            raise


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns process exit code (0 ok, 1 failure)."""
    del argv
    client: BondClient | None = None
    try:
        config = DemoConfig.from_env()
        client = BondClient(base_url=config.api_url)
        DemoAgent(config, client).run()
        return 0
    except BondApiError as exc:
        print(f"demo failed: {exc.code}: {exc.message}", file=sys.stderr)
        return 1
    except Exception as exc:  # never leak internals beyond a message
        print(f"demo failed: {exc}", file=sys.stderr)
        return 1
    finally:
        if client is not None:
            try:
                client.close()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
