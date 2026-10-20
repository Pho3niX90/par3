"""Harbor installed-agent adapter that runs Terminal-Bench tasks through Par3.

ASSUMED Harbor interface (from harbor/agents/installed/base.py and claude_code.py on main,
read 2026-10-20; VERIFY against the Harbor version you install):

- ``BaseInstalledAgent`` (``harbor.agents.installed.base``) with
  ``async install(self, environment)`` and ``async run(self, instruction, environment, context)``,
  plus ``exec_as_root`` / ``exec_as_agent(environment, command, env=None, cwd=None, timeout_sec=None)``.
- ``populate_context_post_run(self, context)`` fills ``AgentContext`` token fields after the run.
- ``self.logs_dir`` on the host is mounted at ``/logs/agent`` inside the container.
- ``environment.upload_file(source_path, target_path)`` copies a host file into the container
  (creating parent directories).

Usage (from the repo root):

    PYTHONPATH=scripts/evals/sidekick/harbor-agent harbor run \
      --dataset terminal-bench@4.0 --agent-import-path par3_agent:Par3SidekickAgent ...

Arms: ``Par3SoloAgent`` (A) and ``Par3SidekickAgent`` (B). Subscription credentials come from the
host environment and are never written to the repo: ``CLAUDE_CODE_OAUTH_TOKEN`` for Claude and
``CODEX_AUTH_JSON`` (the contents of ``~/.codex/auth.json``) for Codex.
"""

from __future__ import annotations

import json
import os
import shlex
from pathlib import Path

from harbor.agents.installed.base import BaseInstalledAgent
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARNESS_DIR = Path(__file__).resolve().parent.parent
REMOTE_HARNESS_DIR = "/installed-agent/par3-sidekick"
REMOTE_OUT_DIR = "/logs/agent/par3"
# Pin the Par3 build under test; the scored run must use one version for both arms.
PAR3_VERSION = os.environ.get("PAR3_VERSION")


class _Par3Agent(BaseInstalledAgent):
    ARM = ""

    @staticmethod
    def name() -> str:
        return "par3"

    async def install(self, environment: BaseEnvironment) -> None:
        if not PAR3_VERSION or PAR3_VERSION == "latest":
            raise ValueError("Set PAR3_VERSION to the exact build under test for both arms.")
        # Node 24 runs the TypeScript driver directly (type stripping is on by default).
        await self.exec_as_root(
            environment,
            "command -v node >/dev/null && node -e 'process.exit(+process.versions.node.split(\".\")[0] < 24)' "
            "|| (apt-get update && apt-get install -y curl ca-certificates git "
            "&& curl -fsSL https://deb.nodesource.com/setup_24.x | bash - && apt-get install -y nodejs)",
        )
        # Both providers probe and spawn their CLI, including Claude's bundled Agent SDK path.
        await self.exec_as_root(
            environment,
            f"npm install -g @paritylabs/par3@{shlex.quote(PAR3_VERSION)} @openai/codex @anthropic-ai/claude-code",
        )
        # Only the driver and the shared usage module; never results/ or host credentials.
        for relative in ("usage.ts", "harbor-agent/arms.ts", "harbor-agent/rpc.ts", "harbor-agent/driver.ts"):
            await environment.upload_file(
                source_path=HARNESS_DIR / relative,
                target_path=f"{REMOTE_HARNESS_DIR}/{relative}",
            )

    async def run(
        self, instruction: str, environment: BaseEnvironment, context: AgentContext
    ) -> None:
        env = {"PAR3_TASK_INSTRUCTION": instruction}
        claude_token = os.environ.get("CLAUDE_CODE_OAUTH_TOKEN")
        if claude_token:
            env["CLAUDE_CODE_OAUTH_TOKEN"] = claude_token
        codex_auth = os.environ.get("CODEX_AUTH_JSON")
        if codex_auth:
            env["CODEX_AUTH_JSON"] = codex_auth
        # VERIFY: logs_dir is <job>/<trial>/agent and trial names are "<task>__<suffix>", so
        # re-runs of one task share a task id and pair across arms in report.ts.
        task_id = Path(self.logs_dir).parent.name.rsplit("__", 1)[0]
        command = (
            'if [ -n "${CODEX_AUTH_JSON:-}" ]; then mkdir -p ~/.codex && '
            'printf "%s" "$CODEX_AUTH_JSON" > ~/.codex/auth.json && chmod 600 ~/.codex/auth.json; fi; '
            f"node {REMOTE_HARNESS_DIR}/harbor-agent/driver.ts"
            f" --arm {self.ARM} --task-id {shlex.quote(str(task_id))}"
            f" --workspace \"$PWD\" --out-dir {REMOTE_OUT_DIR}"
            " --instruction-env PAR3_TASK_INSTRUCTION"
        )
        await self.exec_as_agent(environment, command, env=env)

    def populate_context_post_run(self, context: AgentContext) -> None:
        """Harbor's own token columns; cost.ts computes the priced numbers offline."""
        export_path = Path(self.logs_dir) / "par3" / "par3-export.json"
        if not export_path.exists():
            return
        export = json.loads(export_path.read_text())
        totals = {"input": 0, "cached": 0, "output": 0}
        for thread in export.get("threads", []):
            for turn in thread.get("providerTurns", []):
                usage = turn.get("turnTokenUsage") or {}
                totals["input"] += usage.get("inputTokens") or 0
                totals["cached"] += usage.get("cachedInputTokens") or 0
                totals["output"] += usage.get("outputTokens") or 0
        context.n_input_tokens = totals["input"]
        context.n_cache_tokens = totals["cached"]
        context.n_output_tokens = totals["output"]


class Par3SoloAgent(_Par3Agent):
    """Arm A: Opus 5.5 at max effort, no sidekick."""

    ARM = "A"

    @staticmethod
    def name() -> str:
        return "par3-solo"


class Par3SidekickAgent(_Par3Agent):
    """Arm B: Opus 5.5 at max effort leading, GPT-6 Luna (high) on Codex as the sidekick."""

    ARM = "B"

    @staticmethod
    def name() -> str:
        return "par3-sidekick"
