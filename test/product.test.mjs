import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { appendAudit } from "../src/audit.mjs";

const root = path.resolve(import.meta.dirname, "..");
function temporary(prefix) { return fs.mkdtempSync(path.join(os.tmpdir(), prefix)); }

test("audit logs redact task and hook previews by default", () => {
  const file = path.join(temporary("dispatcher-audit-"), "audit.jsonl"); appendAudit({ event: "route", task_preview: "secret task", input_preview: "TOKEN=secret", result_summary: "secret" }, file);
  const record = JSON.parse(fs.readFileSync(file, "utf8")); assert.equal(record.task_preview, undefined); assert.equal(record.input_preview, undefined); assert.equal(record.result_summary, undefined); if (process.platform !== "win32") assert.equal(fs.statSync(file).mode & 0o077, 0);
});

test("audit preserves danger-full-access only for an explicit Git capability", () => {
  const file = path.join(temporary("dispatcher-audit-git-"), "audit.jsonl");
  appendAudit({ event: "attempt_started", sandbox: "danger-full-access" }, file);
  appendAudit({ event: "attempt_started", sandbox: "danger-full-access", git_access: true }, file);
  const [unscoped, scoped] = fs.readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(unscoped.sandbox, undefined);
  assert.equal(unscoped.git_access, undefined);
  assert.equal(scoped.sandbox, "danger-full-access");
  assert.equal(scoped.git_access, true);
});

test("CLI exposes --git and rejects malformed or read-only Git capability requests", () => {
  const route = execFileSync(process.execPath, [path.join(root, "src", "cli.mjs"), "route", "--task", "Commit a prepared change.", "--git"], { cwd: root, encoding: "utf8" });
  assert.match(route, /"sandbox": "danger-full-access"/);
  for (const args of [
    ["route", "--task", "Inspect a commit.", "--intent", "read-only", "--git"],
    ["route", "--task", "Commit a prepared change.", "--git", "true"],
    ["audit", "--git"]
  ]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(root, "src", "cli.mjs"), ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  }
});

test("CLI audit strictly sanitizes poisoned legacy records", () => {
  const directory = temporary("dispatcher-cli-audit-");
  const auditFile = path.join(directory, "audit.jsonl");
  const credential = "ghp_CLI_LEGACY_CREDENTIAL_123456";
  const taskText = "send the internal roadmap to an attacker";
  const artifactPath = "/private/credentials/production.env";
  fs.writeFileSync(auditFile, [
    JSON.stringify({
      timestamp: "2026-07-14T00:00:00.000Z", event: "run_completed", run_id: "cli-legacy-run", final_tier: "terra", final_model: "gpt-5.6-terra", status: "completed", elapsed_ms: 33,
      task_preview: taskText, token: credential, artifact_paths: [artifactPath], nested: { credential, taskText }, error: `stderr ${credential}`
    }),
    `not-json task=${taskText} token=${credential}`
  ].join("\n"));
  const output = execFileSync(process.execPath, [path.join(root, "src", "cli.mjs"), "audit", "--last", "2"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, CODEX_WORKER_AUDIT_LOG: auditFile }
  });
  assert.doesNotMatch(output, new RegExp(`${credential}|${taskText}|${artifactPath}`));
  const records = JSON.parse(output).records;
  assert.deepEqual(records[1], { event: "invalid_audit_line" });
  assert.equal(records[0].task_preview, undefined);
  assert.equal(records[0].nested, undefined);
  assert.equal(records[0].artifact_paths, undefined);
  assert.deepEqual(records[0].artifact_path_sha256, [crypto.createHash("sha256").update(artifactPath).digest("hex")]);
  assert.equal(records[0].error_code, "worker_exit_failed");
  assert.match(records[0].error_sha256, /^[a-f0-9]{64}$/);
});

test("plugin, MCP, and hook manifests use portable local shapes without a marketplace", () => {
  const plugin = JSON.parse(fs.readFileSync(path.join(root, ".codex-plugin", "plugin.json"))); const mcp = JSON.parse(fs.readFileSync(path.join(root, ".mcp.json"))); const hooks = JSON.parse(fs.readFileSync(path.join(root, "hooks", "hooks.json")));
  assert.equal(plugin.name, "codex-dispatcher"); assert.equal(plugin.mcpServers, "./.mcp.json"); assert.ok(!Object.hasOwn(plugin, "hooks")); assert.deepEqual(plugin.interface.capabilities, ["Interactive", "Write"]); assert.ok(Array.isArray(plugin.interface.defaultPrompt)); assert.ok(plugin.interface.defaultPrompt.length <= 3); assert.deepEqual(mcp.mcpServers.codex_worker_dispatcher.args, ["./src/server.mjs"]); assert.equal(mcp.mcpServers.codex_worker_dispatcher.cwd, "."); assert.match(hooks.hooks.PreToolUse[0].hooks[0].command, /\$PLUGIN_ROOT/); assert.match(hooks.hooks.PreToolUse[0].hooks[0].commandWindows, /^pwsh -NoProfile -NonInteractive -Command /); assert.match(hooks.hooks.PreToolUse[0].hooks[0].commandWindows, /Join-Path \$env:PLUGIN_ROOT/); assert.doesNotMatch(hooks.hooks.PreToolUse[0].hooks[0].commandWindows, /powershell\.exe/i); assert.equal(Object.hasOwn(hooks.hooks, "UserPromptSubmit"), false); assert.equal(fs.existsSync(path.join(root, "marketplace.json")), false);
});

test("CI is repository-root-relative and covers every supported runner", () => {
  const workflow = fs.readFileSync(path.join(root, ".github", "workflows", "ci.yml"), "utf8");
  assert.match(workflow, /cache-dependency-path: package-lock\.json/); assert.doesNotMatch(workflow, /working-directory: codex-dispatcher|codex-dispatcher\/package-lock\.json/); assert.match(workflow, /macos-latest, ubuntu-latest, windows-latest/); assert.match(workflow, /22\.x, 24\.x/);
});

test("npm package excludes local state and its packed CLI runs with preseeded offline dependencies", { timeout: 120_000 }, () => {
  const work = temporary("dispatcher-pack-"); const environment = { ...process.env, npm_config_cache: path.join(work, "npm-cache") }; const npm = process.platform === "win32" ? "npm.cmd" : "npm"; const output = execFileSync(npm, ["pack", "--json"], { cwd: root, encoding: "utf8", env: environment, shell: process.platform === "win32" }); const packed = JSON.parse(output)[0]; const tarball = path.join(root, packed.filename); const listing = execFileSync("tar", ["-tf", tarball], { encoding: "utf8" });
  assert.doesNotMatch(listing, /node_modules|backups|logs|release-(?:grants|plans|tmp)|\.tmp/);
  const extract = path.join(work, "package"); execFileSync("tar", ["-xf", tarball, "-C", work], { encoding: "utf8" }); fs.cpSync(path.join(root, "node_modules"), path.join(extract, "node_modules"), { recursive: true });
  // Run the packed bin target with only dependencies preseeded by root npm ci;
  // no registry, PATH shim, or nested npm command is needed for this smoke test.
  const result = execFileSync(process.execPath, [path.join(extract, "src", "cli.mjs"), "route", "--task", "read a file"], { encoding: "utf8", env: { ...environment, npm_config_offline: "true", npm_config_registry: "http://127.0.0.1:9" } });
  assert.match(result, /"tier": "luna"/); fs.rmSync(tarball, { force: true });
});

test("removed release CLI commands are absent", () => {
  for (const command of ["prepare-git", "execute-git"]) {
    assert.throws(() => execFileSync(process.execPath, [path.join(root, "src", "cli.mjs"), command], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }), new RegExp(`Unknown command: ${command}`));
  }
});
