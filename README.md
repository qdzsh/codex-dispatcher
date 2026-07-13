# Codex Dispatcher

[![CI](https://github.com/qdzsh/codex-dispatcher/actions/workflows/ci.yml/badge.svg)](https://github.com/qdzsh/codex-dispatcher/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE) [![Node.js >= 22.7](https://img.shields.io/badge/node-%3E%3D22.7-339933?logo=nodedotjs&logoColor=white)](package.json)

Codex Dispatcher installs a local, auditable policy that keeps Sol Ultra focused on orchestration and sends bounded work to explicitly pinned leaf workers.

## At a glance

```
Sol Ultra (read-only orchestrator)
                │ route / dispatch
                ▼
     deterministic dispatcher
                │ pinned model, no native fan-out
      ┌─────────┼─────────┐
      ▼         ▼         ▼
  Spark      Luna      Terra
 read-only   ordinary   complex / high-risk
      └─────────┬─────────┘
                ▼
   declared artifacts + verification
                ▼
       Sol reviews the evidence
```

Sol is never a worker. It can inspect, plan, choose a route, review evidence, and respond to the user; worker processes do the bounded work. Every dispatched worker is a leaf: it cannot use native multi-agent fan-out or call the dispatcher again.

## Why use it?

Use Codex Dispatcher when a team wants predictable model selection, local provenance, and a clear separation between orchestration and execution. Typical uses include:

- Keeping a high-reasoning orchestrator out of file mutation, test, and deployment commands.
- Sending a narrow lookup to a low-cost read-only worker while sending a security review or multi-file change to a higher tier.
- Requiring declared output files and verification evidence before a worker result is accepted.
- Inspecting the route, pinned model, attempts, and escalation after the fact.

It is not a hosted task service, a general workflow engine, an authorization system, or a complete operating-system sandbox. The installed policy and hooks are guardrails against accidental behavior. Continue to use OS permissions, repository controls, review, and organization policy for real security boundaries.

## Prerequisites

- Node.js **>= 22.7** and npm.
- A current Codex CLI with `hooks` and `multi_agent` features.
- An account entitled to the configured model slugs and their requested reasoning levels.
- On native Windows, PowerShell 7 (`pwsh`) for managed mode and Windows hook execution. `powershell.exe` is not used or supported by the installer.

The defaults are `gpt-5.6-sol`, `gpt-5.3-codex-spark`, `gpt-5.6-luna`, and `gpt-5.6-terra`. Some model slugs may be private, undocumented, or released gradually to accounts or organizations. The installer checks the local `codex debug models` catalog before changing files. Override a model only when your local catalog supports that slug and reasoning level.

## Quick start

The default is the safe **user-only** install: it changes your Codex user configuration, not the system requirement file.

```sh
npx --yes github:qdzsh/codex-dispatcher install
npx --yes github:qdzsh/codex-dispatcher doctor
```

Then start a new Codex session. If Codex asks to trust hooks, open `/hooks`, review the command and policy, and trust it only if they are appropriate for your machine. Use Codex naturally after that; normal prompts do not need worker or model names.

The installer does not edit shell profiles or `PATH`. Until you add the wrapper directory to `PATH`, use `npx --yes github:qdzsh/codex-dispatcher` before the appropriate command, including `doctor`, `install` (or an update), and `uninstall`. The installed wrappers are at:

- macOS/Linux: `$HOME/.local/bin/codex-dispatcher` and `$HOME/.local/bin/codex-worker`. When `--home DIR` is supplied, the basis is `DIR/.local/bin/` instead of `$HOME/.local/bin/`.
- Native Windows: `%CODEX_HOME%\bin\codex-dispatcher.cmd` and `%CODEX_HOME%\bin\codex-worker.cmd`.

For example, a fully quoted literal Unix wrapper path does not require a `PATH` change and is equivalent to the `npx` doctor command. Use the resolved path rather than shell expansion syntax:

```sh
"/Users/you/.local/bin/codex-dispatcher" doctor
```

In PowerShell 7, if `CODEX_HOME` is set, call the Windows wrapper with:

```powershell
& "$env:CODEX_HOME\bin\codex-dispatcher.cmd" doctor
```

For example: “Update the parser tests and run the focused test suite.” The installed policy routes the work.

## Installation modes

| Mode | Files and authority | Privileges | Use it when |
| --- | --- | --- | --- |
| User-only (default) | Installs the runtime, configuration, policy, MCP server entry, and hook registration under `CODEX_HOME`. On macOS/Linux, wrappers are under `$HOME/.local/bin` (or the `--home` basis); on Windows, they are under `%CODEX_HOME%\bin`. | No elevation. | A personal machine or a safe default for a shared machine. |
| Managed (`--managed`) | Does everything in user-only mode and writes system requirements that provide the Sol model and reasoning defaults for new threads, while pinning `features.multi_agent = false`. | Administrator on Windows; direct write or `sudo` on macOS/Linux. | You administer the machine and want system-level new-thread defaults plus the pinned multi-agent feature setting. |

Managed system requirement locations follow the [Codex managed-configuration locations and precedence documentation](https://learn.chatgpt.com/docs/enterprise/managed-configuration#locations-and-precedence):

- macOS and Linux: `/etc/codex/requirements.toml`
- Windows: `%ProgramData%\OpenAI\Codex\requirements.toml`

The [requirements reference](https://learn.chatgpt.com/docs/config-file/config-reference#requirementstoml) defines `[models.new_thread]` as defaults for new threads, not a model lock. An explicit `--model` choice or a launch-time model/reasoning `--config` choice takes precedence. This installer does pin `[features].multi_agent = false` in managed mode.

### Common install commands

```sh
# Fresh installs default to user-only; an update with no mode flag retains the prior mode
npx --yes github:qdzsh/codex-dispatcher install

# Managed macOS/Linux install; sudo is requested only if the direct write fails
npx --yes github:qdzsh/codex-dispatcher install --managed

# Avoid a sudo attempt and fail safely if the system file is not writable
npx --yes github:qdzsh/codex-dispatcher install --managed --no-sudo

# A custom Codex home whose name contains spaces
npx --yes github:qdzsh/codex-dispatcher install --codex-home "$HOME/Codex Home"
```

On Windows, run **PowerShell 7**, not `powershell.exe`. Start it as Administrator before using managed mode:

```powershell
pwsh -NoProfile
npx --yes github:qdzsh/codex-dispatcher install --managed
```

Custom Windows Codex homes work with either an environment variable or the explicit option:

```powershell
$env:CODEX_HOME = 'C:\Users\you\Codex Home'
npx --yes github:qdzsh/codex-dispatcher install

npx --yes github:qdzsh/codex-dispatcher install --codex-home 'C:\Users\you\Codex Home'
```

`CODEX_HOME` is respected when `--codex-home` is omitted. The generated Windows wrappers are `.cmd` files in `%CODEX_HOME%\bin`; macOS/Linux wrappers are shell launchers in `$HOME/.local/bin` (or `DIR/.local/bin` when `--home DIR` is supplied). The installer does not edit shell profiles or `PATH`. Use the GitHub `npx` form when those directories are not on `PATH`, or call a wrapper by its fully quoted path.

### Distribution status

Install from GitHub with the command above. The following command is **available only after npm publication**; it is not a current installation method:

```sh
npx --yes @qdzsh/codex-dispatcher install
```

The repository includes a plugin manifest and hook metadata following the [official plugin structure](https://learn.chatgpt.com/docs/build-plugins#plugin-structure). It does not claim a live marketplace listing or marketplace publication.

## Routing and execution

## Git and GitHub operations

Version 2.0 removes the release lane. Dispatcher-launched workers may use any Git command and GitHub CLI repository operation directly when it is within their bounded assigned task, using the user's existing credentials. There is no grant, owner allowlist, release plan, acknowledgement digest, or second confirmation. Sol remains orchestrator-only and is still denied direct Git and GitHub mutations.

**Warning:** a worker can commit, push, force-push, create tags, delete branches, and run `gh` repository operations with the user's credentials. Repository content and task text can contain malicious instructions; prompt injection or unsafe task scope can cause irreversible remote changes. Review the repository and task carefully, restrict credentials and repository permissions, and dispatch only work you are prepared to authorize.

| Tier | Pinned default | Effort | Sandbox | Selected for |
| --- | --- | --- | --- | --- |
| Spark | `gpt-5.3-codex-spark` | low | read-only | Narrow read-only lookup. |
| Luna | `gpt-5.6-luna` | medium | workspace-write | Ordinary code, tests, and documentation. |
| Terra | `gpt-5.6-terra` | high | workspace-write | Multi-file work, difficult debugging, security, protocol/data work, and independent verification. |

Escalation is one-way: **Spark → Luna → Terra**. Sol is not in that sequence and can never be selected as a worker.

The router considers declared files and artifacts, explicit intent, independent-verification requests, and task language. More than one declared file or artifact selects Terra. High-risk/complex signals such as security, protocol/data migration, concurrency, difficult debugging, or a multi-file request select Terra. An ordinary mutation or one declared artifact selects at least Luna. `--minimum-tier` can raise a route but cannot lower it. `--intent read-only` also makes the dispatched worker sandbox read-only.

For a bounded repository Git or GitHub CLI task, pass `--git` to the CLI or `git_access: true` to `route_task` or `dispatch_worker`. This is an execution capability, not an authorization workflow: it needs no grant, allowlist, digest, acknowledgement, or confirmation. It requires a write-capable route (`--intent read-only` with Git access is rejected), prevents Spark selection, and gives only that dispatched task the `danger-full-access` sandbox required for network and Git metadata access. Ordinary write tasks remain `workspace-write`; `danger-full-access` is not a worker default. The worker still cannot delegate, call the dispatcher, deploy, publish packages, or broaden the assigned scope.

Workers receive an explicit model, reasoning effort, sandbox, a no-native-multi-agent setting, and a disabled dispatcher MCP server. A worker must return structured JSON with its model identity. When artifacts are declared, they must exist within the supplied working directory. With `--verify` or independent verification, the worker must include verification entries and every one must report `passed`. A failed attempt, missing result, mismatched model, missing artifact, or insufficient verification advances only to the next tier; the audit records every attempt and escalation.

### Model overrides and preflight

Pass any supported override during installation:

```sh
npx --yes github:qdzsh/codex-dispatcher install \
  --model-spark your-supported-spark \
  --model-luna your-supported-luna
```

Unspecified model overrides inherit from the existing installation; a first install uses the defaults. The installer verifies Codex and npm, confirms the four models and requested reasoning levels in the local catalog, and checks that `hooks` and `multi_agent` are available. `--skip-preflight` bypasses those checks and is for isolated automated tests only, not a way to bypass entitlement or make unsupported models work.

## CLI reference

Both `codex-dispatcher` and `codex-worker` are aliases for the same CLI. `route`, `dispatch`, `audit`, and `doctor` emit JSON. `route` and `dispatch` read task text from standard input when `--task` is omitted; they reject an omitted task when standard input is a terminal.

The bare `codex-dispatcher` and `codex-worker` commands require the installed wrapper directory to be on `PATH`. Without that setup, use the GitHub `npx` form for `route`, `dispatch`, and `audit` as well; it runs the same public CLI command. For reliable direct wrapper invocation, use a quoted full path, for example:

```sh
# macOS/Linux
"/Users/you/.local/bin/codex-worker" audit --last 20
```

```powershell
# PowerShell 7, with CODEX_HOME set
& "$env:CODEX_HOME\bin\codex-worker.cmd" audit --last 20
```

| Command | Purpose | Key options |
| --- | --- | --- |
| `install` | Install or update the runtime and managed configuration. | `--user-only`, `--managed`, `--codex-home DIR`, `--home DIR`, `--model-sol SLUG`, `--model-spark SLUG`, `--model-luna SLUG`, `--model-terra SLUG`, `--skip-preflight`, `--no-sudo` |
| `uninstall` | Restore or safely clean installation-owned content. | `--codex-home DIR`, `--home DIR`, `--no-sudo` |
| `doctor` | Report workers, Sol-worker protection, resolved paths, and local capability preflight. | none |
| `route` | Choose a tier without executing work. | `--task TEXT`, `--intent auto\|read-only\|write`, `--git`, repeated `--file PATH`, repeated `--expect PATH`, `--minimum-tier spark\|luna\|terra` |
| `dispatch` | Route and execute one bounded leaf task. | `route` options plus `--cwd DIR`, `--verify`, `--independent-verification`, `--timeout SECONDS` |
| `audit` | Read local provenance records. | `--last N` (1–200; default 20) |
| `help` | Print usage. | none |

`--home` controls the home basis used to resolve platform defaults and is primarily useful for controlled environments. `--codex-home` is the direct choice for a custom Codex home. Options unrelated to the selected command are parsed but have no effect; use the options listed for that command.

Examples:

```sh
# See the route only
npx --yes github:qdzsh/codex-dispatcher route --task "Locate one symbol" --intent read-only

# Read task text from stdin
printf '%s' 'Explain this configuration' | npx --yes github:qdzsh/codex-dispatcher route --intent read-only

# Create one declared artifact and require passed verification
npx --yes github:qdzsh/codex-dispatcher dispatch --task "Create report.md" --cwd . \
  --expect report.md --verify

# Run a bounded repository Git task with the task-specific execution capability
npx --yes github:qdzsh/codex-dispatcher dispatch --task "Commit the prepared change" --cwd . --git

# Request a separate higher-tier verification pass
npx --yes github:qdzsh/codex-dispatcher dispatch --task "Independently verify the change" --cwd . \
  --independent-verification --verify

# Inspect recent model and escalation provenance
npx --yes github:qdzsh/codex-dispatcher audit --last 20
```

Successful install returns `installed`; uninstall returns `uninstalled` or `not_installed`; route and completed dispatch return JSON results. `failed` and `partially_uninstalled` results exit with status 1. Argument, preflight, task, working-directory, or execution errors also exit with status 1 and a message on standard error. A failed dispatch returns its attempts and final error in JSON so the caller can inspect the audit trail.

## What installation changes

Installation copies a self-contained runtime, creates the two wrappers, and merges only clearly delimited managed content into the user configuration, user policy, and hook configuration. It adds a local MCP server with `route_task`, `dispatch_worker`, and `audit_tail`; both install modes register only the `PreToolUse` guardrail. Managed mode additionally writes system requirements: Sol model and reasoning defaults for new threads plus the pinned `features.multi_agent = false` setting. The new-thread model values remain defaults, so explicit `--model` or model/reasoning `--config` launch choices override them.

Before the first successful install, the installer captures a durable baseline of every item it owns. It writes temporary transaction backups during each install/update, uses atomic writes where applicable, and restores the transaction if a later step fails. The original baseline is not recaptured on update, so a clean uninstall can restore the exact pre-install content.

Updates inherit the prior mode and model settings unless flags explicitly change them. For safety, an update aborts before mutation if the installed runtime or either wrapper differs from the recorded installed hash. Restore those owned files before updating, or retain your local edits and skip the update.

A managed install cannot be changed in place to `--user-only`; uninstall it first, then install user-only. This prevents an orphaned system requirement file.

Uninstall restores untouched files from the original baseline. If a user changed configuration after installation, it removes only recognized managed blocks where safe. Edited hooks, wrappers, runtime, or managed requirements are retained rather than overwritten, and the result is `partially_uninstalled` so it can be resolved deliberately. `--no-sudo` makes a Unix managed cleanup fail safely instead of requesting sudo. `--keepRuntime` exists in the install API but is not a supported CLI flag.

The installer recognizes and replaces legacy `codex-token-dispatcher` / `worker-dispatcher` managed configuration markers and their exact former hook command during installation. It does not delete arbitrary legacy directories: review and remove any old runtime only after confirming it is no longer in use.

## Hooks and trust

The hook is a Codex `PreToolUse` guardrail for Sol: it can deny unsupported mutation, native fan-out, and unclassified commands while allowing the dispatcher and a deliberately small read-only inspection grammar. It is registered in both install modes; on Windows its `commandWindows` uses `pwsh -NoProfile -NonInteractive`, never `powershell.exe`.

The shell policy is deny-by-default and validates each accepted argv position. The direct inspection commands are `cat`, `grep`, `head`, `ls`, `pwd`, `rg`, `shasum`, `stat`, `tail`, and `wc`; each has only the flags documented by the installed policy. `sed`, `find`, `file`, and `which` are intentionally unavailable. `rg` accepts only a small search-flag subset and never `--pre` or archive-search execution. Git is limited to explicit `--no-pager --no-optional-locks` forms for `diff` and `show` (both require the exact ordered `--no-ext-diff --no-textconv` flags), `log`, `ls-files`, selected `rev-parse` queries, and `grep`. Branch, status, config, arbitrary output formatting, pager, external-diff, textconv, fsmonitor, and optional-lock paths are not accepted. Quoted option tokens, `--flag=value` forms, aliases, shell expansion, command builtins, and command chaining fail closed. Single-quoted positional data is treated literally, including ordinary task text and commit titles; double-quoted data is accepted only without expansion syntax. CLI fallback accepts an exact installed `codex-worker` wrapper path (quoted paths with spaces are supported), or the bare name only when manual `PATH` resolution reaches that same wrapper. Each decision reads the owner-only installer manifest and verifies the wrapper is a regular owned executable with its recorded SHA-256; missing/malformed manifests, symlinks, modified wrappers, suffix lookalikes, and earlier `PATH` entries fail closed.

Read the [official Codex hooks documentation](https://learn.chatgpt.com/docs/hooks) before enabling it. In particular, `PreToolUse` interception is incomplete by design, so a hook cannot provide complete enforcement or security isolation. Review plugin-provided hooks and trust them with `/hooks` in a new interactive session when Codex requires it. Managed mode supplies system new-thread defaults and pins the multi-agent feature; it neither makes the model defaults unoverrideable nor turns the hook into an OS-enforced control.

## Privacy and audit

The local JSONL audit is an allowlist, not a redaction pass. It preserves only validated provenance fields such as event type, run/attempt identifiers, tier, model, effort, sandbox, the boolean `git_access` capability, timings, status, task SHA-256, and hashed/coded errors. `danger-full-access` is retained only when that exact record has `git_access: true`; malformed or unscoped sandbox values are dropped. Artifact paths are never persisted or returned as text: they are stored as stable SHA-256 values in `artifact_path_sha256`. Readers apply the same strict allowlist to current and legacy lines, migrate legacy `artifact_paths` values to hashes on read, drop unknown or nested fields, and return only `{"event":"invalid_audit_line"}` for malformed JSON. It intentionally does not persist task previews, prompts, tool-input previews, worker stdout/stderr, result summaries, nested worker output, or raw error text.

Use `npx --yes github:qdzsh/codex-dispatcher audit --last 20`, an installed `codex-worker` wrapper, or the MCP `audit_tail` tool to inspect recent records. `CODEX_WORKER_AUDIT_LOG` and `CODEX_WORKER_HOOK_AUDIT_LOG` can redirect the two local audit logs.

`CODEX_WORKER_CODEX_BIN` overrides the `codex` executable used to launch dispatched workers. It is intended for controlled environments that need a specific worker executable. It does not affect install or `doctor` preflight: those always resolve `codex` from `PATH`.

There is deliberately **no full-text audit opt-in**. In particular, setting `CODEX_DISPATCHER_AUDIT_FULL_TEXT=1` does not make raw task or worker text persist. Treat task text as sensitive anyway: do not include secrets, credentials, customer data, or private transcripts. The audit directory is created owner-only and audit files are written owner-only where the operating system honors those permissions.

## Platform support

| Platform | Implementation | Privilege behavior | Verification status |
| --- | --- | --- | --- |
| macOS | Shell wrappers; managed requirement at `/etc/codex/requirements.toml`. | Direct write first, then `sudo` if needed. | Native functional verification run locally. |
| Linux | Shell wrappers; managed requirement at `/etc/codex/requirements.toml`. | Direct write first, then `sudo` if needed; `--no-sudo` fails safely. | Deterministic platform simulation passes. |
| Windows | Quoted `.cmd` wrappers and `pwsh` hook command; managed requirement under `%ProgramData%`. | Managed install/uninstall requires an elevated PowerShell 7 session before user files change. | Deterministic platform simulation passes. |

The repository's GitHub Actions matrix is configured for macOS, Ubuntu, and Windows on Node 22 and 24. Native matrix runs occur after the repository is pushed; this README does not claim those remote runs have already passed.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| `codex` or `npm` is missing | Install Node >= 22.7 with npm and install/update the Codex CLI, then rerun `npx --yes github:qdzsh/codex-dispatcher doctor`. |
| A model is unsupported or unentitled | Run `codex debug models`, use an entitled account, ask the organization administrator, or install with a locally supported `--model-*` override. |
| Codex does not run the hook | Start a new session, open `/hooks`, review/trust the hook when applicable, and confirm the Codex build reports hooks support in `npx --yes github:qdzsh/codex-dispatcher doctor`. |
| Windows managed mode fails | Launch an elevated **PowerShell 7** session (`pwsh`) and rerun the same command. Do not use `powershell.exe`. |
| Unix managed mode cannot write the system file | Re-run with the required privilege, allow the targeted sudo prompt, or choose user-only mode. Use `--no-sudo` when a noninteractive safe failure is required. |
| An update says the runtime or wrapper was modified | The installer refused to overwrite it. Restore the installed copy to update, or preserve the edit and defer the update. |
| `--user-only` is rejected for an existing managed install | Run `npx --yes github:qdzsh/codex-dispatcher uninstall` first, then install again with `--user-only`. |
| GitHub install is offline or blocked | The GitHub `npx` install needs access to fetch the package and dependencies. For a checked-out copy with dependencies already installed, tests and route/pack checks can run offline. |
| Need routing evidence or preflight details | Run `npx --yes github:qdzsh/codex-dispatcher audit --last 20` and `npx --yes github:qdzsh/codex-dispatcher doctor`; both return JSON suitable for inspection. |

## Development

```sh
npm ci
npm run check
npm test
npm pack --dry-run --json
```

`npm ci` installs the locked dependency set. After dependencies are present, the test suite runs offline: it uses fake Codex capabilities and does not require Codex authentication, model access, or a network request. An isolated pack dry run is also part of the package check. The currently verified baseline is **60 tests**; treat that as a snapshot, not a permanent count.

Validate plugin metadata against the official plugin requirements before publishing or listing it. The plugin manifest is present, but publishing to npm or a marketplace is not part of this repository's current status.

## Repository layout

- `src/cli.mjs` — command-line interface and JSON command results.
- `src/install.mjs` — platform paths, preflight, transactional install/update, wrappers, and uninstall.
- `src/policy.mjs` — deterministic routing and Sol guardrail decisions.
- `src/runner.mjs` — pinned leaf execution, artifact checks, verification acceptance, and escalation.
- `src/audit.mjs` — privacy-preserving JSONL audit storage.
- `src/server.mjs` — MCP tools: routing, dispatch, and audit.
- `src/hook.mjs` and `hooks/` — PreToolUse guardrail metadata.
- `schemas/` — worker result schema.
- `test/` — deterministic unit, product, MCP, runner, and installer tests.

## Contributing, security, and license

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution expectations, [SECURITY.md](SECURITY.md) for private vulnerability reporting guidance, and [LICENSE](LICENSE) for the MIT license. Releases, npm publication, and marketplace publication should be treated as unavailable until explicitly announced by the project.

## FAQ

**Do I have to name Spark, Luna, Terra, or Sol in my prompt?** No. Use natural prompts; the installed policy routes bounded work.

**Can Sol edit files or run tests after installation?** The policy and hook are designed to keep Sol orchestrator-only. They are guardrails, not a security boundary.

**How do I see which model actually ran?** Use `npx --yes github:qdzsh/codex-dispatcher audit --last 20`, an installed `codex-worker` wrapper, or MCP `audit_tail`.

**Does managed mode lock every new thread to Sol?** No. Its `[models.new_thread]` values are defaults. An explicit `--model` or launch-time model/reasoning `--config` setting takes precedence; managed mode does pin `features.multi_agent = false`. See the [requirements reference](https://learn.chatgpt.com/docs/config-file/config-reference#requirementstoml).

**Does `--skip-preflight` unlock unavailable models?** No. It only skips checks for isolated tests; the local Codex installation must still support and entitle every configured model.
