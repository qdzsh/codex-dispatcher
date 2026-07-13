import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { evaluateSolTool, routeTask } from "../src/policy.mjs";
import { handleHook } from "../src/hook.mjs";

function withTrustedWorker(run) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-trusted-worker-"));
  const codexHome = path.join(root, ".codex"); const wrapperDirectory = path.join(root, ".local", "bin"); const wrapper = path.join(wrapperDirectory, "codex-worker");
  fs.mkdirSync(path.dirname(path.join(codexHome, "state", "codex-dispatcher.json")), { recursive: true, mode: 0o700 }); fs.mkdirSync(wrapperDirectory, { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const manifest = { version: 4, paths: { stateFile: path.join(codexHome, "state", "codex-dispatcher.json"), wrapperFiles: [wrapper] }, hashes_after: { [wrapper]: crypto.createHash("sha256").update(fs.readFileSync(wrapper)).digest("hex") } };
  fs.writeFileSync(manifest.paths.stateFile, JSON.stringify(manifest), { mode: 0o600 }); fs.chmodSync(manifest.paths.stateFile, 0o600);
  const oldHome = process.env.CODEX_HOME; const oldPath = process.env.PATH; process.env.CODEX_HOME = codexHome; process.env.PATH = wrapperDirectory;
  try { return run({ root, wrapper, wrapperDirectory, manifest }); }
  finally { if (oldHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = oldHome; if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; fs.rmSync(root, { recursive: true, force: true }); }
}

test("routes the cheapest capable worker", () => {
  assert.equal(routeTask({ task: "Read-only lookup: find the definition of parseConfig.", intent: "read-only" }).model, "gpt-5.3-codex-spark");
  assert.equal(routeTask({ task: "Implement a small validation helper in one file.", intent: "write" }).model, "gpt-5.6-luna");
  assert.equal(routeTask({ task: "Perform an independent verification of the implementation.", independent_verification: true }).model, "gpt-5.6-terra");
});

test("Git execution capability requires a write-capable route", () => {
  const route = routeTask({ task: "Commit the prepared change.", git_access: true });
  assert.equal(route.tier, "luna");
  assert.equal(route.intent, "write");
  assert.equal(route.git_access, true);
  assert.equal(route.sandbox, "danger-full-access");
  assert.throws(() => routeTask({ task: "Inspect a commit.", intent: "read-only", git_access: true }), /write-capable route/i);
  assert.throws(() => routeTask({ task: "Commit the prepared change.", git_access: "true" }), /must be a boolean/i);
});

test("Terra owns high-risk and multi-file work", () => {
  assert.equal(routeTask({ task: "Review authentication security boundaries." }).tier, "terra");
  assert.equal(routeTask({ task: "Update ordinary code.", files: ["a.ts", "b.ts"] }).tier, "terra");
  assert.equal(routeTask({ task: "Debug a nondeterministic race condition." }).tier, "terra");
  assert.equal(routeTask({ task: "Change a wire protocol serializer." }).tier, "terra");
});

test("routing never selects Sol and escalation is monotonic", () => {
  const cases = [
    { task: "Locate one constant", intent: "read-only" },
    { task: "Write README details", intent: "write" },
    { task: "Security audit" }
  ];
  for (const input of cases) {
    const route = routeTask(input);
    assert.notEqual(route.model, "gpt-5.6-sol");
    assert.deepEqual(route.escalation_order, ["spark", "luna", "terra"].slice(["spark", "luna", "terra"].indexOf(route.tier)));
  }
});

test("PreToolUse policy blocks Sol mutations, builds, tests, deploys, and fan-out", () => {
  assert.equal(evaluateSolTool({ tool_name: "apply_patch", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: "npm test" } }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "spawn_agent", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "followup_task", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "exec_command", tool_input: { command: "touch bypass" } }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "functions.exec", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "read_mcp_resource", tool_input: {} }).allowed, true);
  assert.equal(evaluateSolTool({ tool_name: "mcp__xcodebuildmcp__build", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "mcp__codex_worker_dispatcher__dispatch_worker", tool_input: {} }).allowed, true);
  assert.equal(evaluateSolTool({ tool_name: "mcp__codex_worker_dispatcher__prepare_git_operation", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "mcp__codex_worker_dispatcher__execute_git_operation", tool_input: {} }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: "git push --force origin main" } }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: "gh repo delete owner/repo --yes" } }).allowed, false);
  assert.equal(evaluateSolTool({ tool_name: "mcp__codex_worker_dispatcher__delete_repository", tool_input: {} }).allowed, false);
});

test("Sol shell policy accepts only documented safe argv", () => {
  withTrustedWorker(({ wrapper }) => {
    const safeCommands = [
    "cat README.md",
    "cat 'README with spaces.md'",
    "grep -n 'policy' src/policy.mjs",
    "head -n 20 README.md",
    "ls .",
    "pwd",
    "stat README.md",
    "tail -n 20 README.md",
    "wc README.md",
    "shasum README.md",
    "rg -i -n policy src",
    "git --no-pager --no-optional-locks diff --no-ext-diff --no-textconv",
    "git --no-pager --no-optional-locks log",
    "git --no-pager --no-optional-locks ls-files",
    "git --no-pager --no-optional-locks show --no-ext-diff --no-textconv HEAD",
    "git --no-pager --no-optional-locks rev-parse --show-toplevel",
    "git --no-pager --no-optional-locks grep policy src",
    "codex --version",
    "codex features list",
    "codex mcp get context7",
    "codex-worker route --task 'find literal $(data); safely' --intent read-only",
    "codex-worker dispatch --task \"inspect policy\" --cwd /tmp --verify --independent-verification",
    `'${wrapper}' dispatch --task 'inspect literal \`data\`' --cwd /tmp --verify`,
    `\"${wrapper}\" dispatch --task \"inspect policy\" --cwd /tmp --verify`,
    ];
    for (const command of safeCommands) {
      assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, true, command);
    }
  });
});

test("CLI fallback trusts only the manifest-pinned wrapper identity", () => {
  withTrustedWorker(({ root, wrapper, wrapperDirectory, manifest }) => {
    const command = "codex-worker dispatch --task inspect --cwd /tmp --verify";
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, true);
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: `'${wrapper}.backup' dispatch --task inspect --cwd /tmp --verify` } }).allowed, false, "suffix lookalike");
    const fakeDirectory = path.join(root, "attacker-bin"); fs.mkdirSync(fakeDirectory); fs.writeFileSync(path.join(fakeDirectory, "codex-worker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    process.env.PATH = `${fakeDirectory}${path.delimiter}${wrapperDirectory}`;
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, "PATH hijack");
    process.env.PATH = wrapperDirectory;
    fs.appendFileSync(wrapper, "# modified\n");
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, "hash mismatch");
    fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.unlinkSync(wrapper); fs.symlinkSync(path.join(fakeDirectory, "codex-worker"), wrapper);
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, "symlink substitution");
    fs.unlinkSync(wrapper); fs.writeFileSync(wrapper, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    fs.writeFileSync(manifest.paths.stateFile, "{ malformed", { mode: 0o600 });
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, "malformed manifest");
    fs.unlinkSync(manifest.paths.stateFile);
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, "missing manifest");
  });
});

test("Sol shell policy fails closed for former bypasses and flag spellings", () => {
  const dangerousCommands = [
    "sed -n '1p' README.md",
    "sed -i'' 's/a/b/' README.md",
    "sed 'w output.txt' README.md",
    "sed 'e touch output.txt' README.md",
    "find .",
    "find . -fprint output.txt",
    "find . -fprintf output.txt x",
    "find . -fls output.txt",
    "find . -exec touch output.txt ;",
    "find . -execdir touch output.txt ;",
    "find . -delete",
    "find . -ok touch output.txt ;",
    "find . -okdir touch output.txt ;",
    "rg --pre /bin/cat README.md",
    "rg --pre=/bin/cat README.md",
    "rg '--pre' /bin/cat README.md",
    "rg --search-zip policy README.md",
    "rg -z policy README.md",
    "rg --fixed-strings policy README.md",
    "rg -i=policy README.md",
    "grep --fixed-strings policy README.md",
    "grep '-n' policy README.md",
    "head -20 README.md",
    "tail --lines=20 README.md",
    "ls -la",
    "stat --format=%n README.md",
    "git branch -f main",
    "git branch --delete main",
    "git status --short",
    "git diff",
    "git --no-pager --no-optional-locks diff --ext-diff",
    "git --no-pager --no-optional-locks diff --no-ext-diff --textconv",
    "git --no-pager --no-optional-locks show HEAD",
    "git --no-pager --no-optional-locks show --textconv",
    "git --no-pager --no-optional-locks show --no-textconv --no-ext-diff HEAD",
    "git --no-pager --no-optional-locks grep --open-files-in-pager policy",
    "git --no-pager --no-optional-locks log --format=%x00",
    "git -c core.pager=cat log",
    "git --paginate log",
    "git --no-pager --no-optional-locks status",
    "git --no-pager --no-optional-locks config core.fsmonitor false",
    "git --no-pager --no-optional-locks rev-parse --show-toplevel=ignored",
    "codex --version --config x=y",
    "codex doctor --full",
    "command touch bypass",
    "command -- touch bypass",
    "command sh -c 'touch bypass'",
    "command -V ls",
    "builtin eval 'touch bypass'",
    "exec touch bypass",
    "env GIT_PAGER=cat git log",
    "cat README.md; touch bypass",
    "rg policy $(pwd)",
    "codex-worker install --managed",
    "codex-worker dispatch --task=x --cwd /tmp",
    "codex-worker dispatch '--task' x --cwd /tmp",
    "codex-worker dispatch --task --cwd /tmp",
    "codex-worker dispatch --task x --cwd /tmp --cwd /elsewhere",
    "codex-worker dispatch --task x --cwd /tmp '--verify'",
    "codex-worker dispatch --task x --cwd /tmp --verify true",
    "codex-worker dispatch --task x --cwd /tmp --verify --verify",
    "codex-worker route --task x --verify",
    "codex-worker route --task x --git --intent read-only",
    "codex-worker route --task x --git true",
    "codex-worker dispatch --task x --cwd /tmp --git --git",
    "codex-worker prepare-git --operation commit --cwd /tmp --grant-id grant --verify",
    "codex-worker execute-git --plan-id plan --acknowledgement-digest digest --execution-grant-id execution --verify",
    "codex-worker dispatch --task \"$(touch bypass)\" --cwd /tmp",
    "codex-worker dispatch --task \"`touch bypass`\" --cwd /tmp",
    "codex-worker dispatch --task x --cwd /tmp; touch bypass",
    "'/tmp/Codex Worker/.local/bin/codex-worker.backup' dispatch --task x --cwd /tmp",
    "'/tmp/Codex Worker/not.local/bin/codex-worker' dispatch --task x --cwd /tmp",
    "codex-worker audit --last=1"
  ];
  for (const command of dangerousCommands) {
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command } }).allowed, false, command);
  }
});

test("Sol shell policy permits only well-formed dispatcher Git capability invocations", () => {
  withTrustedWorker(() => {
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: "codex-worker route --task 'commit a change' --git" } }).allowed, true);
    assert.equal(evaluateSolTool({ tool_name: "Bash", tool_input: { command: "codex-worker dispatch --task 'push a branch' --cwd /tmp --git --verify" } }).allowed, true);
  });
});

test("hook emits a denial only for Sol", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-hook-test-"));
  const audit = path.join(directory, "audit.jsonl");
  const denied = handleHook({ hook_event_name: "PreToolUse", model: "gpt-5.6-sol", tool_name: "Bash", tool_input: { command: "touch forbidden" } }, audit);
  assert.match(denied.output, /orchestrator-only|cannot run/i);
  const worker = handleHook({ hook_event_name: "PreToolUse", model: "gpt-5.6-luna", tool_name: "Bash", tool_input: { command: "npm test" } }, audit);
  assert.equal(worker.output, null);
});

test("UserPromptSubmit is inert after release-lane removal", () => {
  assert.deepEqual(handleHook({ hook_event_name: "UserPromptSubmit", model: "gpt-5.6-sol", prompt: "commit and push" }), { output: null, decision: null });
});
