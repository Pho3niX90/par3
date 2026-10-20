# Sidekick benchmark

Measures whether Sidekick mode keeps quality while cutting cost. It compares two Par3 arms on the same Terminal-Bench 4.0 tasks (66 tasks, run with Harbor):

| Arm         | Lead                                            | Sidekick                                      |
| ----------- | ----------------------------------------------- | --------------------------------------------- |
| A: solo     | Claude Opus 5.5, effort `max` (Claude provider) | none                                          |
| B: Sidekick | Claude Opus 5.5, effort `max`                   | GPT-6 Luna, reasoning `high` (Codex provider) |

For each task it records pass/fail (Harbor's verifier reward), wall time, and API-equivalent cost. The runs use subscriptions. Cost is computed afterwards from per-turn token counts at public API prices (`prices.json`), with cache reads and cache writes priced separately. Copilot is excluded because it bills per request, not per token.

## Process

1. **Smoke**: 5 tasks, arm B only. Check that the server starts, delegation happens, children settle, and every turn has complete usage.
2. **Tuning**: a 20-task stratified subset (spread across categories and difficulty), arms A and B. Adjust the lead's playbook (the Sidekick orchestration instructions), never individual tasks.
3. **Scored**: all 66 tasks, arms A and B, then re-run the tasks where A and B disagree (`report.ts` lists them). Re-runs are averaged per task.

## Running

```sh
# Credentials stay in your shell, never in the repo or results.
export CLAUDE_CODE_OAUTH_TOKEN=...            # from `claude setup-token`
export CODEX_AUTH_JSON="$(cat ~/.codex/auth.json)"
export PAR3_VERSION=<exact version under test>

# One Harbor job per arm (flags follow Harbor's CLI; check `harbor run --help` for your version).
PYTHONPATH=scripts/evals/sidekick/harbor-agent harbor run \
  --dataset terminal-bench@4.0 --agent-import-path par3_agent:Par3SoloAgent ...
PYTHONPATH=scripts/evals/sidekick/harbor-agent harbor run \
  --dataset terminal-bench@4.0 --agent-import-path par3_agent:Par3SidekickAgent ...

# Price each job, then compare.
node scripts/evals/sidekick/cost.ts --job-dir <job A> --out-dir scripts/evals/sidekick/results/A
node scripts/evals/sidekick/cost.ts --job-dir <job B> --out-dir scripts/evals/sidekick/results/B
node scripts/evals/sidekick/report.ts --a scripts/evals/sidekick/results/A \
  --b scripts/evals/sidekick/results/B --out scripts/evals/sidekick/results/report.md
```

`cost.ts --export <par3-export.json> --out <file> --reward <0|1>` prices a single export. `results/` is gitignored; only code and the price table are committed. Tests: `vp test run scripts/evals/sidekick`.

## How it works

- `harbor-agent/par3_agent.py` is the Harbor installed agent. It installs Node 24, the pinned `@paritylabs/par3` build, and the Claude and Codex CLIs in the task container, uploads the driver, and runs it.
- `harbor-agent/driver.ts` starts `par3 serve` with a fresh `T3CODE_HOME` in the container's temp dir (never a developer's `~/.t3`), issues a bearer session with `par3 auth session issue`, and talks to the server's WebSocket RPC (`rpc.ts`). It creates a project for the task workspace, launches a thread with the arm's lead and sidekick in `full-access` mode with the task instruction as the first message, polls until the lead and every delegated child settle twice in a row, writes `par3-export.json`, and stops the server by the PID it spawned.
- `usage.ts` slims each thread projection and turns it into one record per provider turn, using the turn's run model selection (the effective model and options for that turn). Tokens come from `providerTurns[].turnTokenUsage`, where input includes cache reads and writes and output includes reasoning.
- `cost.ts` rolls usage up per model, prices it, and writes per-task results: cost, time, lead/sidekick token and cost share, cache-hit ratio, and delegation diagnostics.
- `report.ts` gives per-arm pass rate, cost and time, paired-bootstrap 95% intervals (seeded, so re-runs reproduce), B − A, diagnostics, and the Artificial Analysis reference rows.

## Fairness rules

- No task-specific prompts. Each task's instruction is sent unchanged; the only difference between arms is the sidekick.
- Freeze the playbook (Par3 version and orchestration instructions) before the scored run, and run both arms on that same version.
- Every attempt hashes test and verifier files in the workspace before and after the run (`--protect` in the driver). Any change is flagged in the report for manual review as possible reward hacking.
- The claim "equal or better at X% lower cost" is printed only when B − A is not significantly negative (the 95% interval's upper bound is not below zero) and B is cheaper. While a price is unverified or a turn has incomplete usage, the claim is marked provisional.

## Caveats

- Subscription plans may cap effort, context or model choice. The per-turn records keep the model and options each turn actually ran with ("Effective models" in the report). Check them before comparing with API runs.
- Usage from a provider's native subagents inside a turn (`hasSubagents`) is not in `turnTokenUsage`. Sidekick instructions forbid using them for delegated work; the report counts the turns where they appeared.
- Cache writes are priced at the 5-minute TTL rate, because turn usage does not record the TTL.
- Cost uses standard short-context API rates. Aggregated turn usage cannot reconstruct per-request long-context or fast-mode pricing; treat runs that use those tiers as estimates.

## What this does not claim

It reports a Terminal-Bench 4.0 pass rate and cost per task for these two Par3 configurations. It does not produce an Artificial Analysis Coding Agent Index number. The AA rows in the report (Claude Code + Opus 5.5: 66, $13.04/task; Devin Fusion: 68.1, $9.01/task) are Coding Agent Index figures, shown as context. Fill in AA's per-suite Terminal-Bench numbers (`DEFAULT_REFERENCE_ROWS` in `report.ts`, or `--reference <file.json>`) before comparing directly.

## Needs checking against a live run

- Harbor interface: `BaseInstalledAgent.install/run`, `exec_as_root/exec_as_agent`, `environment.upload_file`, the `/logs/agent` mount, trial names `<task>__<suffix>`, and `result.json` → `verifier_result.rewards.reward`.
- Par3 headless flow: `par3 serve --base-dir --host --port <cwd>`, whether `auth session issue` default scopes allow `projects.mutate` and `orchestration.launchThread`, and the raw Effect RPC JSON framing in `rpc.ts`.
- Delegation diagnostics assume each `delegate_task` call (including a `continueTaskId` follow-up) is one app-owned subagent node on the lead, and that a follow-up reuses the earlier task's child thread.
