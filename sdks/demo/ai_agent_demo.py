"""End-to-end AI agent security demo (Phase 17).

An external AI-powered agent operating under BOND:

    Model Provider -> AIAgent -> bond_sdk -> BOND API -> Risk Engine
        -> Risk Flags -> Attestation -> Enforcement (SIMULATED)

BOND is NOT the model. The default scripted provider needs no API key,
no internet, and no wallet. Enforcement effects are SIMULATED and
always labeled as such — this demo never claims live blockchain
execution.
"""

from __future__ import annotations

import os
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from secrets import token_hex
from typing import Any, Callable, Protocol, TextIO

from bond_sdk import (
    ActivityPolicyContext,
    BondApiError,
    BondClient,
    build_activity,
)

POLICY_VERSION = "bond-policy-v1"
SPEND_LIMIT = "1000"

AI_DEMO_PLATFORM = "bond-demo"
AI_DEMO_AGENT_TYPE = "custom"
AI_DEMO_CAPABILITIES = ("demo-messaging", "demo-tool-use")

BENIGN_REF = "ai-demo-agent-benign-v1"
RISKY_REF = "ai-demo-agent-risky-v1"

FIXED_OCCURRED_AT = "2026-01-01T00:00:00.000Z"


# ---------------------------------------------------------------------------
# Model layer: provider-neutral, scripted by default.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class ModelResponse:
    """One model-generated action. Untrusted until build_activity()."""

    action: str
    action_type: str
    parameters: dict[str, Any]


class ModelProvider(Protocol):
    """Minimal model interface: prompt + context in, action out."""

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        ...


class ScriptedModelProvider:
    """Deterministic canned actions. No key, no network, no model.

    Scenarios derived from the verified BOND risk rules:
    - "benign": allowlisted action, declared tool, spend under limit
      (all rule guards pass → zero findings).
    - "risky": denylisted action at 3x the spend limit (policy-denylist
      high/90 + spend-limit-breach high/85).
    """

    def __init__(self, scenario: str) -> None:
        if scenario not in ("benign", "risky"):
            raise BondApiError(
                "INVALID_IDENTIFIER",
                f"Unknown demo scenario: {scenario}",
                0,
                None,
            )
        self._scenario = scenario

    @property
    def name(self) -> str:
        return f"scripted:{self._scenario}"

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        del prompt, context
        if self._scenario == "benign":
            return ModelResponse(
                action="pay-vendor",
                action_type="transfer",
                parameters={
                    "amount_minor_units": "500",
                    "metadata": {"vendor": "demo-vendor"},
                },
            )
        return ModelResponse(
            action="self-transfer",
            action_type="transfer",
            parameters={
                "amount_minor_units": "3000",
                "metadata": {"vendor": "demo-vendor"},
            },
        )


class EnvModelProvider:
    """Live-model placeholder with honest gating.

    Resolves provider configuration from the environment but refuses to
    execute: no provider request/response format has been verified in
    this environment, so claiming support would be fabrication. Fails
    clearly instead.
    """

    def __init__(self, provider: str | None, api_key: str | None) -> None:
        if not provider or not api_key:
            raise BondApiError(
                "UNAUTHORIZED",
                "live-model mode requires BOND_MODEL_PROVIDER and "
                "BOND_MODEL_API_KEY to be set.",
                0,
                None,
            )
        self._provider = provider

    @property
    def name(self) -> str:
        return f"live:{self._provider}"

    def generate(
        self, prompt: str, context: dict[str, Any]
    ) -> ModelResponse:
        del prompt, context
        raise BondApiError(
            "INVALID_IDENTIFIER",
            f"live-model provider '{self._provider}' is not verified in "
            "this environment: no request/response format has been "
            "exercised. Use scripted mode.",
            0,
            None,
        )


# ---------------------------------------------------------------------------
# Agent configuration.
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class AIDemoConfig:
    """Demo configuration from the environment. No secrets stored."""

    api_url: str = "http://localhost:4000"
    dev_auth_token: str | None = None
    external_key: str = "ai-demo-operator"
    mode: str = "scripted"
    scenario: str = "benign"

    @staticmethod
    def from_env(env: dict[str, str] | None = None) -> AIDemoConfig:
        source = env if env is not None else os.environ
        return AIDemoConfig(
            api_url=source.get("BOND_API_URL", "http://localhost:4000"),
            dev_auth_token=source.get("BOND_DEV_AUTH_TOKEN"),
            external_key=source.get(
                "BOND_DEV_EXTERNAL_KEY", "ai-demo-operator"
            ),
            mode=source.get("BOND_DEMO_MODE", "scripted"),
            scenario=source.get("BOND_DEMO_SCENARIO", "benign"),
        )


def _policy(benign: bool) -> ActivityPolicyContext:
    return ActivityPolicyContext(
        policy_version=POLICY_VERSION,
        allowed_actions=("pay-vendor",),
        declared_tools=("transfers",),
        denylisted_actions=() if benign else ("self-transfer",),
        spend_limit_minor_units=SPEND_LIMIT,
    )


# ---------------------------------------------------------------------------
# Agent driver.
# ---------------------------------------------------------------------------

EmitFn = Callable[[str], None]


class AIAgent:
    """External agent operating under BOND via the Python SDK only."""

    def __init__(
        self,
        config: AIDemoConfig,
        client: BondClient,
        model: ModelProvider,
    ) -> None:
        self._config = config
        self._client = client
        self._model = model

    def run(self, out: TextIO = sys.stdout) -> dict[str, Any]:
        """Execute the end-to-end flow. Returns a safe summary dict."""

        def emit(text: str) -> None:
            print(text, file=out)

        summary: dict[str, Any] = {
            "mode": self._config.mode,
            "scenario": self._config.scenario,
            "model": getattr(self._model, "name", "unknown"),
        }

        emit("BOND AI AGENT SECURITY DEMO")
        emit("")
        emit("Mode:")
        emit(f"  {summary['mode']}")

        # 1. Health check.
        self._client.health()

        # 2-3. Authenticate + register (deterministic, rerun-safe).
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
        external_ref = (
            BENIGN_REF if self._config.scenario == "benign" else RISKY_REF
        )
        agent = self._register(external_ref)
        agent_id = agent["agentId"]
        summary["agentId"] = agent_id

        emit("")
        emit("Agent:")
        emit(f"  ID: {agent_id}")
        emit(f"  Type: {agent.get('agentType', 'custom')}")
        emit("Model:")
        emit(f"  Provider: {summary['model']}")
        emit(f"  Mode: {summary['mode']}")
        emit("")
        emit("Scenario:")
        emit(f"  {summary['scenario']}")

        # 4-8. Model generates; SDK validates; API analyzes.
        response = self._model.generate(
            "act under bond policy",
            {"agentId": agent_id, "scenario": self._config.scenario},
        )
        parameters = dict(response.parameters)
        # activity_id intentionally left for the SDK to generate fresh per
        # run: flag IDs derive deterministically from activity content,
        # so reusing an ID across runs would collide server-side.
        parameters.setdefault("occurred_at", FIXED_OCCURRED_AT)
        activity = build_activity(
            agent_id=agent_id,
            action_type=response.action_type,  # type: ignore[arg-type]
            action=response.action,
            policy_context=_policy(self._config.scenario == "benign"),
            **parameters,
        )
        outcome = self._client.analyze_activity(agent_id, activity)
        score = outcome.get("score") or {}
        summary["analysisId"] = outcome.get("analysisId")
        summary["score"] = score.get("score")
        summary["flagIds"] = outcome.get("flagIds") or []

        emit("")
        emit("Activity:")
        emit(f"  Type: {response.action_type}")
        emit(f"  Action: {response.action}")
        emit("")
        emit("Risk:")
        emit(f"  score: {summary['score']}")
        emit(f"  flags: {len(summary['flagIds'])}")

        # 9-11. Flags (from this run's analysis, not stale history),
        # status, public verification.
        flags = [
            self._client.get_flag(flag_id)
            for flag_id in summary["flagIds"]
        ]
        summary["flags"] = [
            {
                "riskFlagId": flag.get("riskFlagId"),
                "severity": flag.get("severity"),
                "category": flag.get("category"),
            }
            for flag in flags
            if isinstance(flag, dict)
        ]
        recorded = self._client.list_flags(agent_id) or []
        summary["flagCount"] = len(summary["flags"])
        summary["totalFlagsOnRecord"] = len(recorded)
        current = self._client.get_agent(agent_id)
        summary["agentStatus"] = current.get("status", "unknown")
        verification = self._client.verify_agent(agent_id)
        summary["verification"] = (
            verification.get("verification", {}).get("result", "unknown")
            if isinstance(verification, dict)
            else "unknown"
        )

        emit("")
        emit("Agent Status:")
        emit(f"  {summary['agentStatus']}")
        emit("")
        emit("Public Verification:")
        emit(f"  {summary['verification']}")

        if self._config.scenario == "benign":
            self._report_benign(summary, emit)
        else:
            self._report_risky(summary, emit, agent_id)

        emit("")
        emit("Enforcement:")
        emit(f"  {summary.get('enforcement', 'not-applicable')}")
        return summary

    def _report_benign(
        self, summary: dict[str, Any], emit: EmitFn
    ) -> None:
        if summary["flags"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                f"Benign scenario produced {len(summary['flags'])} "
                "unexpected flags.",
                0,
                None,
            )
        emit("")
        emit("Risk Findings:")
        emit("  none — No confirmed findings were returned for this analysis.")

    def _report_risky(
        self, summary: dict[str, Any], emit: EmitFn, agent_id: str
    ) -> None:
        if not summary["flags"]:
            raise BondApiError(
                "INVALID_ACTIVITY_INPUT",
                "Risky scenario produced no flags; expected findings.",
                0,
                None,
            )
        emit("")
        emit("Risk Findings:")
        for flag in summary["flags"]:
            emit(
                f"  - {flag.get('riskFlagId')}: "
                f"{flag.get('category')} / {flag.get('severity')}"
            )
        self._attest_and_enforce(summary, emit, agent_id)

    def _attest_and_enforce(
        self, summary: dict[str, Any], emit: EmitFn, agent_id: str
    ) -> None:
        # Bond required for enforcement (genuine local operation).
        bond_id = self._ensure_bond(agent_id)
        summary["bondId"] = bond_id

        # Two independent demo attestors with per-run identities and
        # fresh secrets (server rejects re-registration of an existing
        # attestor id, and only the current secret authenticates verdicts,
        # so reruns must not reuse attestor ids).
        run_suffix = token_hex(4)
        secrets = [token_hex(16), token_hex(16)]
        attestor_ids: list[str] = []
        for index, secret in enumerate(secrets, start=1):
            created = self._client.register_attestor(
                attestor_id=f"ai-demo-attestor-{index}-{run_suffix}",
                organization="ai-demo-org",
                secret=secret,
            )
            attestor_ids.append(created["attestorId"])

        flag_id = summary["flags"][0]["riskFlagId"]
        expires_at = (
            datetime.now(timezone.utc) + timedelta(hours=1)
        ).isoformat()
        requested = self._client.request_attestation(
            flag_id=flag_id,
            attestor_ids=attestor_ids,
            threshold=2,
            expires_at=expires_at,
        )
        attestation_id = requested["attestationId"]
        summary["attestationId"] = attestation_id

        for attestor_id, secret in zip(attestor_ids, secrets):
            self._client.submit_verdict(
                attestation_id,
                attestor_id=attestor_id,
                verdict="confirm",
                secret=secret,
            )
        attestation = self._client.get_attestation(attestation_id)
        summary["quorum"] = attestation.get("status", "unknown")
        if summary["quorum"] != "quorum-met":
            raise BondApiError(
                "INVALID_ATTESTATION",
                f"Quorum not met (status: {summary['quorum']}).",
                0,
                None,
            )

        decision = self._client.issue_decision(
            attestation_id, action="partial-slash"
        )
        summary["decision"] = decision.get("action")

        emit("")
        emit("Attestation:")
        emit(f"  id: {attestation_id}")
        emit(f"  quorum: {summary['quorum']}")
        emit("")
        emit("Decision:")
        emit(f"  action: {summary['decision']}")

        enforced = self._client.enforce_attestation(
            attestation_id, amount_minor_units="1000"
        )
        summary["transactionId"] = enforced.get("transactionId")
        tx = self._client.get_transaction(summary["transactionId"])
        summary["transactionStatus"] = tx.get("status", "unknown")
        # SIMULATED boundary: the reference below is an adapter receipt,
        # never a blockchain confirmation.
        summary["enforcement"] = "SIMULATED"

        emit("")
        emit("Transaction:")
        emit(f"  id: {summary['transactionId']}")
        emit(f"  status: {summary['transactionStatus']}")

        self._release_bond(summary, emit, bond_id)

    def _ensure_bond(self, agent_id: str) -> str | None:
        try:
            bond = self._client.create_bond(
                agent_id=agent_id, commitment_minor_units="10000"
            )
            bond_id = bond["bondId"]
        except BondApiError as exc:
            # Rerun path: a live bond already exists, or the agent has
            # moved past REGISTERED. Release/withdraw then proceeds only
            # if a bond handle is available; enforcement reports BLOCKED
            # otherwise — never fabricated.
            if "live bond" in exc.message or "REGISTERED" in exc.message:
                return None
            raise
        for status in ("PENDING", "ACTIVE"):
            self._client.set_bond_status(bond_id, status)
        return bond_id

    def _release_bond(
        self, summary: dict[str, Any], emit: EmitFn, bond_id: str | None
    ) -> None:
        if bond_id is None:
            summary["release"] = "skipped (no bond handle this run)"
            emit("")
            emit("Release:")
            emit(f"  {summary['release']}")
            return
        bond = self._client.get_bond(bond_id)
        if bond.get("status") in ("ACTIVE", "LOCKED", "PARTIALLY_SLASHED"):
            released = self._client.set_bond_status(bond_id, "WITHDRAWABLE")
            summary["release"] = released.get("status", "WITHDRAWABLE")
        else:
            summary["release"] = (
                f"skipped (bond status {bond.get('status')})"
            )
        emit("")
        emit("Release:")
        emit(f"  {summary['release']}")

    def _register(self, external_ref: str) -> dict[str, Any]:
        try:
            return self._client.register_agent(
                platform="bond-demo",
                agent_type="custom",
                capabilities=["demo-messaging", "demo-tool-use"],
                external_ref=external_ref,
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
                        and row.get("externalRef") == external_ref
                    ):
                        return row
            raise


def _select_model(config: AIDemoConfig) -> ModelProvider:
    if config.mode in ("", "scripted"):
        return ScriptedModelProvider(config.scenario)
    if config.mode == "live-model":
        return EnvModelProvider(
            os.environ.get("BOND_MODEL_PROVIDER"),
            os.environ.get("BOND_MODEL_API_KEY"),
        )
    raise BondApiError(
        "INVALID_IDENTIFIER",
        f"Unknown BOND_DEMO_MODE: {config.mode}.",
        0,
        None,
    )


def main(argv: list[str] | None = None) -> int:
    """Entry point. Returns process exit code (0 ok, 1 failure)."""
    del argv
    client: BondClient | None = None
    try:
        config = AIDemoConfig.from_env()
        if config.scenario not in ("benign", "risky"):
            raise BondApiError(
                "INVALID_IDENTIFIER",
                f"Unknown BOND_DEMO_SCENARIO: {config.scenario}.",
                0,
                None,
            )
        model = _select_model(config)
        if config.mode == "live-model":
            # Probe now so misconfiguration fails before any BOND state.
            model.generate("ping", {})
        client = BondClient(base_url=config.api_url)
        AIAgent(config, client, model).run()
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
