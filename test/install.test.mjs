import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { install as installImplementation, platformPaths, uninstall as uninstallImplementation, updateAgents, updateConfig, updateHooks, updateRequirements } from "../src/install.mjs";
import { appendAudit } from "../src/audit.mjs";

function temp() { return fs.mkdtempSync(path.join(os.tmpdir(), "codex-dispatcher-test-")); }
function snapshotTree(root) {
  if (!fs.existsSync(root)) return { exists: false, entries: [] };
  const entries = [];
  const visit = (current, relative = ".") => {
    const stat = fs.lstatSync(current);
    const entry = { path: relative, mode: stat.mode, type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : "file" };
    if (stat.isDirectory()) {
      entries.push(entry);
      for (const child of fs.readdirSync(current).sort()) visit(path.join(current, child), path.join(relative, child));
    } else if (stat.isSymbolicLink()) {
      entry.target = fs.readlinkSync(current);
      entries.push(entry);
    } else {
      entry.bytes = fs.readFileSync(current).toString("base64");
      entries.push(entry);
    }
  };
  visit(root);
  return { exists: true, entries };
}
function lstatSnapshot(file) {
  try {
    const stat = fs.lstatSync(file);
    return stat.isSymbolicLink() ? { exists: true, type: "symlink", target: fs.readlinkSync(file) } : { exists: true, type: "file", bytes: fs.readFileSync(file).toString("base64") };
  } catch (error) { if (error?.code === "ENOENT") return { exists: false }; throw error; }
}
function fakeRunner(command, args) {
  if (command === "npm") return "10.0.0\n";
  if (args[0] === "--version") return "codex 1.0\n";
  if (args.join(" ") === "debug models") return JSON.stringify({ models: [
    { slug: "gpt-5.6-sol", supported_reasoning_levels: [{ effort: "ultra" }] },
    { slug: "gpt-5.3-codex-spark", supported_reasoning_levels: [{ effort: "low" }] },
    { slug: "gpt-5.6-luna", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "gpt-5.6-terra", supported_reasoning_levels: [{ effort: "high" }] }
  ] });
  return "hooks enabled\nmulti_agent enabled\n";
}
function install(options = {}) { return installImplementation({ ...options, runner: options.runner ?? fakeRunner }); }
function uninstall(options = {}) { return uninstallImplementation({ ...options, runner: options.runner ?? fakeRunner }); }

test("installation uses the injected runner for the staged offline npm install", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    return fakeRunner(command, args);
  };
  install({ home: root, codexHome, runner });
  const npmInstall = calls.find(({ command, args }) => command === "npm" && args[0] === "install");
  assert.deepEqual(npmInstall?.args, ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"]);
  assert.equal(npmInstall?.options?.cwd, path.join(codexHome, ".dispatcher-" + process.pid + ".installing"));
  assert.equal(calls.filter(({ command, args }) => command === "npm" && args[0] === "install").length, 1);
});

test("config, agents, hooks, and requirements preserve unrelated content idempotently", () => {
  const original = `model = "old"\n\n[features]\napps = true\n\n[mcp_servers.existing]\nurl = "https://example.invalid"\n`;
  const config = updateConfig(updateConfig(original, "/tmp/dispatcher"), "/tmp/dispatcher");
  assert.match(config, /\[mcp_servers\.existing\]/); assert.equal((config.match(/BEGIN CODEX DISPATCHER MANAGED CONFIG/g) || []).length, 2);
  const indentedRootScalar = updateConfig(`  model = "old"\n[features]\napps = true\n`, "/tmp/dispatcher"); assert.equal((indentedRootScalar.match(/^[\t ]*model\s*=/gm) || []).length, 1);
  assert.match(updateAgents("# Keep\n"), /# Keep/);
  const hooks = JSON.parse(updateHooks(JSON.stringify({ hooks: { SessionStart: [] } }), "/tmp/dispatcher/src/hook.mjs"));
  assert.equal(hooks.hooks.SessionStart.length, 0); assert.equal(hooks.hooks.PreToolUse.length, 1);
  assert.match(updateRequirements("[features]\napps = true\n"), /^apps = true$/m);
});

test("TOML table matching accepts whitespace and comments without matching nearby tables or mutating on abort", () => {
  const configOriginal = "model = \"old\"\n  [features] # keep this exact header\napps = true\n[features.extra]\nkeep = true\n";
  const config = updateConfig(configOriginal, "/tmp/dispatcher");
  assert.match(config, /^  \[features\] # keep this exact header$/m);
  assert.equal((config.match(/^\s*\[features\]\s*(?:#.*)?$/gm) || []).length, 1);
  assert.match(config, /^\[features\.extra\]$/m);
  const requirementsOriginal = "\t[models.new_thread]\t# managed default\nmodel = \"old\"\n[models.new_thread.extra]\nkeep = true\n  [features] # feature note\napps = true\n[features_extra]\nkeep = true\n";
  const requirements = updateRequirements(requirementsOriginal);
  assert.match(requirements, /^\t\[models\.new_thread\]\t# managed default$/m);
  assert.match(requirements, /^  \[features\] # feature note$/m);
  assert.equal((requirements.match(/^\s*\[models\.new_thread\]\s*(?:#.*)?$/gm) || []).length, 1);
  assert.equal((requirements.match(/^\s*\[features\]\s*(?:#.*)?$/gm) || []).length, 1);
  assert.match(requirements, /^\[models\.new_thread\.extra\]$/m);
  assert.match(requirements, /^\[features_extra\]$/m);

  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  const configFile = path.join(codexHome, "config.toml"); const hooksFile = path.join(codexHome, "hooks.json");
  fs.writeFileSync(configFile, configOriginal); fs.writeFileSync(hooksFile, "{ not valid JSON");
  assert.throws(() => install({ home: root, codexHome, runner: fakeRunner }), /JSON/);
  assert.equal(fs.readFileSync(configFile, "utf8"), configOriginal);
  assert.equal(fs.readFileSync(hooksFile, "utf8"), "{ not valid JSON");
});

test("requirements table edits preserve CRLF, headers, unrelated boundaries, and a missing final newline", () => {
  const original = "\t[models.new_thread]\t# managed default\r\nmodel = \"old\"\r\n[models.new_thread.extra]\r\nkeep = true\r\n  [features] # feature note\r\napps = true\r\n[features_extra]\r\nkeep = true";
  const expected = "\t[models.new_thread]\t# managed default\r\nmodel = \"gpt-5.6-sol\"\r\nmodel_reasoning_effort = \"ultra\"\r\n[models.new_thread.extra]\r\nkeep = true\r\n  [features] # feature note\r\napps = true\r\nmulti_agent = false\r\n[features_extra]\r\nkeep = true";
  assert.equal(updateRequirements(original), expected);
  assert.equal(updateRequirements(original).endsWith("\n"), false);

  const quotedAndBlank = "  # untouched leading whitespace\r\n\r\n[\"models.new_thread\"]\r\nkeep = true\r\n\r\n";
  const appended = updateRequirements(quotedAndBlank);
  assert.equal(appended.startsWith(quotedAndBlank), true);
  assert.match(appended, /^\["models\.new_thread"\]\r$/m);
  assert.equal((appended.match(/^\[models\.new_thread\](?:[\t ]*(?:#.*)?)?\r$/gm) || []).length, 1);
  assert.equal((appended.match(/^\[features\](?:[\t ]*(?:#.*)?)?\r$/gm) || []).length, 1);
  assert.equal(appended.includes("\n"), true);
  assert.equal(appended.replaceAll("\r\n", "").includes("\r"), false);
});

test("platform paths are deterministic for Unix and Windows", () => {
  assert.equal(platformPaths({ platform: "darwin", home: "/Users/a" }).requirementsFile, "/etc/codex/requirements.toml");
  assert.equal(platformPaths({ platform: "linux", home: "/home/a" }).requirementsFile, "/etc/codex/requirements.toml");
  const win = platformPaths({ platform: "win32", home: "C:\\Users\\A", programData: "C:\\ProgramData" });
  assert.match(win.requirementsFile, /ProgramData.*OpenAI.*Codex.*requirements\.toml/i); assert.ok(win.wrapperFiles.every((file) => file.endsWith(".cmd")));
});

test("fresh user-only installation is idempotent and preserves existing files", () => {
  const root = temp(); const codexHome = path.join(root, "space home", ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "[features]\napps = true\n"); fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# User policy\n"); fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } }));
  const one = install({ home: path.join(root, "space home"), codexHome, runner: fakeRunner, managed: false }); const two = install({ home: path.join(root, "space home"), codexHome, runner: fakeRunner, managed: false });
  assert.equal(one.status, "installed"); assert.equal(two.status, "installed"); assert.match(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), /# User policy/); assert.equal((fs.readFileSync(path.join(codexHome, "config.toml"), "utf8").match(/BEGIN CODEX DISPATCHER MANAGED CONFIG/g) || []).length, 2);
  const worker = platformPaths({ home: path.join(root, "space home"), codexHome }).wrapperFiles[1];
  assert.ok(fs.existsSync(path.join(codexHome, "dispatcher", "src", "cli.mjs"))); assert.ok(fs.existsSync(worker));
  const stateFile = path.join(codexHome, "state", "codex-dispatcher.json"); const manifest = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(manifest.version, 5); assert.equal(manifest.hashes_after[worker], crypto.createHash("sha256").update(fs.readFileSync(worker)).digest("hex")); if (process.platform !== "win32") assert.equal(fs.statSync(stateFile).mode & 0o077, 0);
});

test("second CLI install stdout excludes preserved baseline content", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const secret = "FAKE_INSTALL_SECRET_8b3b7c9f";
  const shimDirectory = path.join(root, "bin"); fs.mkdirSync(shimDirectory, { recursive: true }); const npmShim = path.join(shimDirectory, process.platform === "win32" ? "npm.cmd" : "npm");
  fs.writeFileSync(npmShim, process.platform === "win32" ? "@echo off\r\nexit /b 0\r\n" : "#!/bin/sh\nexit 0\n"); if (process.platform !== "win32") fs.chmodSync(npmShim, 0o755);
  const cli = path.resolve(import.meta.dirname, "../src/cli.mjs"); const environment = { ...process.env, PATH: `${shimDirectory}${path.delimiter}${process.env.PATH || ""}` }; const runCli = () => execFileSync(process.execPath, [cli, "install", "--skip-preflight", "--home", root, "--codex-home", codexHome], { encoding: "utf8", env: environment });
  fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, "config.toml"), `token = "${secret}"\n`);
  runCli();
  fs.appendFileSync(path.join(codexHome, "config.toml"), "# user edit\n");
  const stdout = runCli(); const stateFile = path.join(codexHome, "state", "codex-dispatcher.json"); const manifest = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.match(manifest.user_preservations[path.join(codexHome, "config.toml")].content, new RegExp(secret)); if (process.platform !== "win32") assert.equal(fs.statSync(stateFile).mode & 0o077, 0);
  assert.doesNotMatch(stdout, new RegExp(secret)); assert.doesNotMatch(stdout, /user_preservations|baseline-config/); assert.deepEqual(JSON.parse(stdout), { status: "installed", managed: false, destination: path.join(codexHome, "dispatcher"), state_file: stateFile, preserved_file_count: 1 });
});

test("installation rolls back changed files after an injected late failure", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true }); const config = path.join(codexHome, "config.toml"); fs.writeFileSync(config, "model = \"before\"\n");
  assert.throws(() => install({ home: root, codexHome, runner: fakeRunner, injectFailure: "after-user-files" }));
  assert.equal(fs.readFileSync(config, "utf8"), "model = \"before\"\n");
});

test("uninstall restores untouched files but preserves later edits", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true }); const config = path.join(codexHome, "config.toml"); fs.writeFileSync(config, "model = \"before\"\n");
  install({ home: root, codexHome, runner: fakeRunner }); assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled"); assert.equal(fs.readFileSync(config, "utf8"), "model = \"before\"\n");
  install({ home: root, codexHome, runner: fakeRunner }); fs.appendFileSync(config, "# User edit\n"); const result = uninstall({ home: root, codexHome }); assert.equal(result.status, "uninstalled"); assert.match(fs.readFileSync(config, "utf8"), /# User edit/); assert.doesNotMatch(fs.readFileSync(config, "utf8"), /BEGIN CODEX DISPATCHER MANAGED CONFIG/);
  install({ home: root, codexHome, runner: fakeRunner }); fs.appendFileSync(path.join(codexHome, "dispatcher", "README.md"), "local runtime edit\n"); const runtimeResult = uninstall({ home: root, codexHome }); assert.equal(runtimeResult.status, "partially_uninstalled"); assert.ok(fs.existsSync(path.join(codexHome, "dispatcher", "README.md")));
});

test("Windows managed install writes requirements and fails before user files without elevated pwsh 7", () => {
  const root = temp(); const codexHome = path.join(root, "Codex Home"); const requirements = path.join(root, "ProgramData", "OpenAI", "Codex", "requirements.toml");
  install({ platform: "win32", home: root, codexHome, requirementsFile: requirements, managed: true, windowsElevated: true, runner: fakeRunner }); assert.match(fs.readFileSync(requirements, "utf8"), /gpt-5\.6-sol/);
  const blockedHome = path.join(root, "blocked"); fs.mkdirSync(blockedHome, { recursive: true }); const config = path.join(blockedHome, "config.toml"); fs.writeFileSync(config, "model = \"before\"\n");
  assert.throws(() => install({ platform: "win32", home: root, codexHome: blockedHome, managed: true, requirementsFile: path.join(root, "blocked-requirements.toml"), runner(command, args) { if (command === "pwsh") throw new Error("not elevated"); return fakeRunner(command, args); } }), /elevated pwsh 7.*powershell\.exe is not supported/i);
  assert.equal(fs.readFileSync(config, "utf8"), "model = \"before\"\n"); assert.equal(fs.existsSync(path.join(blockedHome, "dispatcher")), false);
});

test("update preserves user edits separately from the immutable uninstall baseline", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "requirements.toml"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n[features]\napps = true\n"); fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# baseline\n"); fs.writeFileSync(path.join(codexHome, "hooks.json"), JSON.stringify({ hooks: { SessionStart: [] } })); fs.writeFileSync(requirements, "[features]\napps = true\n");
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner }); const configFile = path.join(codexHome, "config.toml"); fs.writeFileSync(configFile, `${fs.readFileSync(configFile, "utf8").replace('model = "gpt-5.6-sol"', 'model = "user-model"')}# user config\n`); fs.appendFileSync(path.join(codexHome, "AGENTS.md"), "# user agents\n"); const hookFile = path.join(codexHome, "hooks.json"); fs.writeFileSync(hookFile, JSON.stringify({ hooks: { SessionStart: [{ matcher: "*", hooks: [{ type: "command", command: "node user-hook.mjs" }] }], PreToolUse: JSON.parse(fs.readFileSync(hookFile)).hooks.PreToolUse } })); fs.writeFileSync(requirements, `${fs.readFileSync(requirements, "utf8").replace('model = "gpt-5.6-sol"', 'model = "user-requirements-model"')}# user requirements\n`);
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner }); const result = uninstall({ home: root, codexHome, requirementsFile: requirements }); assert.equal(result.status, "uninstalled");
  assert.match(fs.readFileSync(configFile, "utf8"), /model = "user-model"/); assert.match(fs.readFileSync(configFile, "utf8"), /# user config/); assert.match(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), /# user agents/); assert.match(fs.readFileSync(hookFile, "utf8"), /user-hook/); assert.match(fs.readFileSync(requirements, "utf8"), /user-requirements-model/); assert.match(fs.readFileSync(requirements, "utf8"), /# user requirements/); assert.doesNotMatch(fs.readFileSync(configFile, "utf8"), /CODEX DISPATCHER MANAGED/);
});

test("changed dispatcher scalars are preserved and hook cleanup removes only the dispatcher command", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "requirements.toml"); fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(requirements, "[models.new_thread]\nmodel = \"before\"\n");
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner }); const config = path.join(codexHome, "config.toml"); fs.writeFileSync(config, fs.readFileSync(config, "utf8").replace('model = "gpt-5.6-sol"', 'model = "user-model"').replace("hooks = true", "hooks = false")); fs.writeFileSync(requirements, fs.readFileSync(requirements, "utf8").replace('model = "gpt-5.6-sol"', 'model = "user-requirements-model"'));
  const hookFile = path.join(codexHome, "hooks.json"); const hooks = JSON.parse(fs.readFileSync(hookFile)); hooks.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command: 'node "/opt/other-dispatcher/src/hook.mjs"' }] }); fs.writeFileSync(hookFile, JSON.stringify(hooks));
  const result = uninstall({ home: root, codexHome, requirementsFile: requirements }); assert.equal(result.status, "uninstalled"); assert.match(fs.readFileSync(config, "utf8"), /model = "user-model"/); assert.match(fs.readFileSync(config, "utf8"), /hooks = false/); assert.match(fs.readFileSync(requirements, "utf8"), /user-requirements-model/); const cleaned = fs.readFileSync(hookFile, "utf8"); assert.match(cleaned, /other-dispatcher/); const commands = JSON.parse(cleaned).hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command)); assert.equal(commands.some((command) => command.includes(path.join(codexHome, "dispatcher", "src", "hook.mjs"))), false);
});

test("legacy blocks migrate, indented unmanaged developer instructions fail before mutation, and overrides agree", () => {
  const legacy = "# BEGIN CODEX TOKEN DISPATCHER MANAGED CONFIG\ndeveloper_instructions = \"\"\"old\"\"\"\n# END CODEX TOKEN DISPATCHER MANAGED CONFIG\n"; assert.doesNotMatch(updateConfig(legacy, "/tmp/dispatcher"), /TOKEN DISPATCHER/); assert.doesNotMatch(updateAgents("<!-- BEGIN CODEX TOKEN DISPATCHER POLICY -->\nold\n<!-- END CODEX TOKEN DISPATCHER POLICY -->"), /TOKEN DISPATCHER/);
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true }); const config = path.join(codexHome, "config.toml"); const original = "  developer_instructions = \"do not touch\"\nmodel = \"unchanged\"\n"; fs.writeFileSync(config, original); assert.throws(() => install({ home: root, codexHome, runner: fakeRunner }), /unmanaged root developer_instructions/); const after = fs.readFileSync(config, "utf8"); assert.equal(after, original); assert.equal((after.match(/^[\t ]*developer_instructions\s*=/gm) || []).length, 1); assert.equal(fs.existsSync(path.join(codexHome, "dispatcher")), false);
  const models = { sol: "custom-sol", spark: "custom-spark", luna: "custom-luna", terra: "custom-terra" }; const agents = updateAgents("", models); const policy = updateConfig("", "/tmp/dispatcher", models); assert.match(agents, /custom-sol/); assert.match(agents, /custom-spark/); assert.match(policy, /custom-terra/); assert.match(updateRequirements("", models), /custom-sol/);
});

test("Windows wrappers safely quote an installed path", () => {
  const root = temp(); const codexHome = path.join(root, "Codex Home"); const result = install({ platform: "win32", home: root, codexHome, programData: path.join(root, "Program Data"), runner: fakeRunner });
  const wrapper = fs.readFileSync(result.paths.wrapperFiles[0], "utf8"); assert.match(wrapper, /^@echo off/m); assert.match(wrapper, /node ".*Codex Home.*cli\.mjs" %\*/);
});

test("installed Windows hooks use pwsh 7 with safely quoted paths and retain unrelated hooks", () => {
  const root = temp(); const codexHome = path.join(root, "Codex O'Brien Home");
  const hooksFile = path.join(codexHome, "hooks.json"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(hooksFile, JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node user-hook.mjs", commandWindows: "pwsh -NoProfile -NonInteractive -Command \"& node 'C:/user-hook.mjs'\"" }] }] } }));
  install({ platform: "win32", home: root, codexHome, programData: path.join(root, "Program Data"), runner: fakeRunner });
  const commands = JSON.parse(fs.readFileSync(hooksFile, "utf8")).hooks.PreToolUse.flatMap((group) => group.hooks);
  const installed = commands.find((hook) => hook.statusMessage === "Enforcing Sol orchestrator policy");
  assert.equal(installed.command, `node ${JSON.stringify(path.join(codexHome, "dispatcher", "src", "hook.mjs"))}`);
  assert.match(installed.commandWindows, /^pwsh -NoProfile -NonInteractive -Command /);
  assert.match(installed.commandWindows, /O''Brien Home/);
  assert.doesNotMatch(installed.commandWindows, /powershell\.exe/i);
  assert.ok(commands.some((hook) => hook.command === "node user-hook.mjs"));
  const refreshed = JSON.parse(updateHooks(fs.readFileSync(hooksFile, "utf8"), path.join(codexHome, "dispatcher", "src", "hook.mjs"))).hooks.PreToolUse.flatMap((group) => group.hooks);
  assert.equal(refreshed.filter((hook) => hook.statusMessage === "Enforcing Sol orchestrator policy").length, 1);
  assert.ok(refreshed.some((hook) => hook.command === "node user-hook.mjs"));
});

test("user-only mode leaves requirements alone and Unix managed mode uses its configured requirement target", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml");
  install({ platform: "linux", home: root, codexHome, requirementsFile: requirements, runner: fakeRunner, managed: false }); assert.equal(fs.existsSync(requirements), false);
  install({ platform: "linux", home: root, codexHome, requirementsFile: requirements, runner: fakeRunner, managed: true, noSudo: true }); assert.match(fs.readFileSync(requirements, "utf8"), /model = "gpt-5\.6-sol"/);
});

test("managed upgrade appends a requirements baseline once, rolls it back on failure, and restores exact prior state", () => {
  for (const kind of ["regular", "symlink", "absent"]) {
    const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml");
    install({ home: root, codexHome, requirementsFile: requirements, managed: false, runner: fakeRunner });
    if (kind === "regular") { fs.mkdirSync(path.dirname(requirements), { recursive: true }); fs.writeFileSync(requirements, "# exact regular baseline\n"); }
    if (kind === "symlink") { const target = path.join(root, "requirement target.toml"); fs.writeFileSync(target, "# exact symlink target content\n"); fs.mkdirSync(path.dirname(requirements), { recursive: true }); fs.symlinkSync(target, requirements); }
    const stateFile = path.join(codexHome, "state", "codex-dispatcher.json"); const beforeState = fs.readFileSync(stateFile, "utf8"); const beforeHome = snapshotTree(codexHome); const beforeRequirements = lstatSnapshot(requirements);
    assert.throws(() => install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner, injectFailure: "after-destination-removal" }), /Injected failure/);
    assert.equal(fs.readFileSync(stateFile, "utf8"), beforeState); assert.deepEqual(snapshotTree(codexHome), beforeHome); assert.deepEqual(lstatSnapshot(requirements), beforeRequirements);
    install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner });
    const upgraded = JSON.parse(fs.readFileSync(stateFile, "utf8")); const baseline = upgraded.backups.find((record) => record.target === requirements);
    assert.ok(baseline); assert.equal(upgraded.backups.filter((record) => record.target === requirements).length, 1);
    assert.equal(uninstall({ home: root, codexHome, requirementsFile: requirements }).status, "uninstalled");
    assert.deepEqual(lstatSnapshot(requirements), beforeRequirements);
  }
});

test("failed managed augmentation restores the complete CODEX_HOME tree for every backups-parent state", () => {
  for (const setup of ["absent", "empty", "unrelated"]) {
    const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml");
    fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n");
    fs.mkdirSync(path.dirname(requirements), { recursive: true }); fs.writeFileSync(requirements, "# exact requirements baseline\n");
    const first = install({ home: root, codexHome, requirementsFile: requirements, managed: false, runner: fakeRunner });
    const manifest = JSON.parse(fs.readFileSync(first.paths.stateFile, "utf8"));
    if (setup === "absent") fs.rmSync(first.paths.backupBase, { recursive: true, force: true });
    if (setup === "empty") fs.rmSync(manifest.backup_root, { recursive: true, force: true });
    if (setup === "unrelated") { const unrelated = path.join(first.paths.backupBase, "user-backups", "keep.bin"); fs.mkdirSync(path.dirname(unrelated), { recursive: true }); fs.writeFileSync(unrelated, Buffer.from([0, 255, 16, 32])); }
    fs.symlinkSync("user-symlink-target", path.join(codexHome, "user-symlink"));
    const before = snapshotTree(codexHome);
    assert.throws(() => install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner, injectFailure: "after-destination-removal" }), /Injected failure after destination removal/);
    assert.deepEqual(snapshotTree(codexHome), before, setup);
    if (setup === "unrelated") assert.ok(fs.existsSync(path.join(manifest.backup_root, "baseline-config.toml")));
  }
});

test("managed requirements symlinks survive install, update, and uninstall with their exact target", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml"); const target = path.join(root, "requirements source.toml");
  fs.writeFileSync(target, "[features]\napps = true\n"); fs.mkdirSync(path.dirname(requirements), { recursive: true }); fs.symlinkSync(target, requirements);
  const baseline = lstatSnapshot(requirements);
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner });
  assert.equal(fs.lstatSync(requirements).isSymbolicLink(), false);
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, runner: fakeRunner });
  assert.equal(fs.lstatSync(requirements).isSymbolicLink(), false);
  assert.equal(uninstall({ home: root, codexHome, requirementsFile: requirements }).status, "uninstalled");
  assert.deepEqual(lstatSnapshot(requirements), baseline);
});

test("audit storage allowlists provenance and never persists secret worker text", () => {
  const file = path.join(temp(), "audit.jsonl"); const secret = "UNIQUE_AUDIT_SECRET_741"; const old = process.env.CODEX_DISPATCHER_AUDIT_FULL_TEXT;
  process.env.CODEX_DISPATCHER_AUDIT_FULL_TEXT = "1";
  try {
    appendAudit({ event: "attempt_finished", run_id: "run-1", tier: "terra", model: "gpt-5.6-terra", effort: "high", sandbox: "workspace-write", exit_code: 1, elapsed_ms: 9, status: "failed", stdout: secret, stderr: secret, error: `failure ${secret}`, result_summary: secret, task_preview: secret, nested: { attempt: { error: secret, stdout: secret } }, artifact_paths: ["src/install.mjs"] }, file);
  } finally {
    if (old === undefined) delete process.env.CODEX_DISPATCHER_AUDIT_FULL_TEXT; else process.env.CODEX_DISPATCHER_AUDIT_FULL_TEXT = old;
  }
  const raw = fs.readFileSync(file, "utf8"); const record = JSON.parse(raw);
  assert.doesNotMatch(raw, new RegExp(secret)); assert.equal(record.event, "attempt_finished"); assert.equal(record.run_id, "run-1"); assert.equal(record.model, "gpt-5.6-terra"); assert.equal(record.exit_code, 1); assert.equal(record.artifact_paths, undefined); assert.deepEqual(record.artifact_path_sha256, [crypto.createHash("sha256").update("src/install.mjs").digest("hex")]); assert.equal(record.error_code, "worker_failed"); assert.match(record.error_sha256, /^[a-f0-9]{64}$/);
});

test("plain updates inherit managed mode and model overrides, while managed downgrade fails before mutation", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml");
  const models = { sol: "custom-sol", spark: "custom-spark", luna: "custom-luna", terra: "custom-terra" };
  install({ home: root, codexHome, requirementsFile: requirements, managed: true, models, skipPreflight: true });
  const update = install({ home: root, codexHome, requirementsFile: requirements, skipPreflight: true });
  assert.equal(update.managed, true); assert.deepEqual(update.models, models); assert.deepEqual(JSON.parse(fs.readFileSync(path.join(codexHome, "dispatcher", "models.json"), "utf8")), models); assert.match(fs.readFileSync(requirements, "utf8"), /custom-sol/);
  const config = path.join(codexHome, "config.toml"); const before = fs.readFileSync(config, "utf8");
  assert.throws(() => install({ home: root, codexHome, requirementsFile: requirements, managed: false, skipPreflight: true }), /uninstall first, then reinstall with --user-only/i);
  assert.equal(fs.readFileSync(config, "utf8"), before); assert.ok(fs.existsSync(requirements)); assert.ok(fs.existsSync(path.join(codexHome, "state", "codex-dispatcher.json")));
});

test("updates preserve newly authored files that were absent before installation", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  install({ home: root, codexHome, runner: fakeRunner });
  fs.writeFileSync(path.join(codexHome, "config.toml"), `${fs.readFileSync(path.join(codexHome, "config.toml"), "utf8")}# user config\n`);
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), `${fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8")}# user agents\n`);
  const hooksFile = path.join(codexHome, "hooks.json"); const hooks = JSON.parse(fs.readFileSync(hooksFile)); hooks.hooks.SessionStart = [{ matcher: "*", hooks: [{ type: "command", command: "node user-hook.mjs" }] }]; fs.writeFileSync(hooksFile, JSON.stringify(hooks));
  install({ home: root, codexHome, runner: fakeRunner });
  assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled");
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /# user config/); assert.match(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), /# user agents/); assert.match(fs.readFileSync(hooksFile, "utf8"), /user-hook/);
});

test("updates reject modified wrappers or runtime before mutating files, while untouched updates succeed", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner });
  const wrapper = first.paths.wrapperFiles[0]; const runtimeReadme = path.join(codexHome, "dispatcher", "README.md"); const tracked = [path.join(codexHome, "config.toml"), path.join(codexHome, "AGENTS.md"), path.join(codexHome, "hooks.json"), path.join(codexHome, "state", "codex-dispatcher.json"), wrapper, runtimeReadme]; const snapshot = () => Object.fromEntries(tracked.map((file) => [file, fs.readFileSync(file, "utf8")]));
  const beforeWrapperAbort = snapshot(); fs.appendFileSync(wrapper, "# user wrapper\n"); const modifiedWrapper = fs.readFileSync(wrapper, "utf8"); assert.throws(() => install({ home: root, codexHome, runner: fakeRunner }), /managed wrapper.*Restore its installed contents to update, or retain your edits and skip this update/i); assert.equal(fs.readFileSync(wrapper, "utf8"), modifiedWrapper); for (const file of tracked.filter((file) => file !== wrapper)) assert.equal(fs.readFileSync(file, "utf8"), beforeWrapperAbort[file]);
  fs.writeFileSync(wrapper, beforeWrapperAbort[wrapper]); const beforeRuntimeAbort = snapshot(); fs.appendFileSync(runtimeReadme, "user runtime edit\n"); const modifiedRuntime = fs.readFileSync(runtimeReadme, "utf8"); assert.throws(() => install({ home: root, codexHome, runner: fakeRunner }), /managed runtime.*Restore its installed contents to update, or retain your edits and skip this update/i); assert.equal(fs.readFileSync(runtimeReadme, "utf8"), modifiedRuntime); for (const file of tracked.filter((file) => file !== runtimeReadme)) assert.equal(fs.readFileSync(file, "utf8"), beforeRuntimeAbort[file]);
  fs.writeFileSync(runtimeReadme, beforeRuntimeAbort[runtimeReadme]); assert.equal(install({ home: root, codexHome, runner: fakeRunner }).status, "installed");
});

test("legacy hooks migrate at both former locations and path styles without removing similar commands", () => {
  const original = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [
    { type: "command", command: 'node "/Users/a/.codex/worker-dispatcher/src/hook.mjs"' },
    { type: "command", command: 'node "C:\\Users\\a\\.codex\\worker-dispatcher\\src\\hook.mjs"' },
    { type: "command", command: "node /Users/a/.codex/worker-dispatcher/src/hook.mjs" },
    { type: "command", command: 'node "/Users/a/.codex/codex-token-dispatcher/src/hook.mjs"' },
    { type: "command", command: 'node "C:\\Users\\a\\.codex\\codex-token-dispatcher\\src\\hook.mjs"' },
    { type: "command", command: 'node "/opt/other-dispatcher/src/hook.mjs"' },
    { type: "command", command: 'node "/opt/my-codex-token-dispatcher/src/hook.mjs"' },
    { type: "command", command: 'echo /Users/a/.codex/codex-token-dispatcher/src/hook.mjs' }
  ] }] } });
  const hookScript = "/tmp/.codex/dispatcher/src/hook.mjs"; const commands = JSON.parse(updateHooks(original, hookScript)).hooks.PreToolUse.flatMap((group) => group.hooks.map((hook) => hook.command));
  const recognizedLegacy = commands.filter((command) => /^node\s+/.test(command) && /(?:^|\/)\.codex\/(?:worker-dispatcher|codex-token-dispatcher)\/src\/hook\.mjs$/.test(command.replaceAll("\\", "/")));
  assert.equal(commands.filter((command) => command === `node ${JSON.stringify(hookScript)}`).length, 1); assert.equal(recognizedLegacy.length, 0); assert.equal(commands.some((command) => command.includes("other-dispatcher")), true); assert.equal(commands.some((command) => command.includes("my-codex-token-dispatcher")), true); assert.equal(commands.some((command) => command.startsWith("echo ")), true);
});

test("runtime replacement failure after destination removal restores the complete CODEX_HOME tree exactly", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner }); const before = snapshotTree(codexHome);
  assert.throws(() => install({ home: root, codexHome, runner: fakeRunner, injectFailure: "after-destination-removal" }), /Injected failure after destination removal/);
  assert.deepEqual(snapshotTree(codexHome), before);
  assert.ok(fs.existsSync(first.paths.destination));
});

test("rollback preserves pre-existing unrelated durable backup content", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner }); const unrelated = path.join(first.paths.backupBase, "user-backups", "keep.bin"); fs.mkdirSync(path.dirname(unrelated), { recursive: true }); fs.writeFileSync(unrelated, Buffer.from([0, 255, 16, 32])); const before = snapshotTree(codexHome);
  assert.throws(() => install({ home: root, codexHome, runner: fakeRunner, injectFailure: "after-destination-removal" }), /Injected failure after destination removal/);
  assert.deepEqual(snapshotTree(codexHome), before);
  assert.deepEqual(fs.readFileSync(unrelated), Buffer.from([0, 255, 16, 32]));
});

test("install, update, and uninstall restore existing CODEX_HOME files byte-for-byte", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n[features]\napps = true\n");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Existing policy\n\nKeep this exact spacing.\n");
  fs.writeFileSync(path.join(codexHome, "hooks.json"), "{\n  \"hooks\": {\n    \"SessionStart\": []\n  }\n}\n");
  const initial = snapshotTree(codexHome);
  install({ home: root, codexHome, runner: fakeRunner }); install({ home: root, codexHome, runner: fakeRunner });
  assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled");
  assert.deepEqual(snapshotTree(codexHome), initial);
});

test("multiple updates retain the first-install baseline for exact uninstall restoration", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n[features]\napps = true\n");
  fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Existing policy\n");
  fs.writeFileSync(path.join(codexHome, "hooks.json"), "{\"hooks\":{\"SessionStart\":[]}}\n");
  const initial = snapshotTree(codexHome);
  install({ home: root, codexHome, runner: fakeRunner }); install({ home: root, codexHome, runner: fakeRunner }); install({ home: root, codexHome, runner: fakeRunner });
  assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled");
  assert.deepEqual(snapshotTree(codexHome), initial);
});

test("failed update retains the original durable baseline for a later exact uninstall", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n"); fs.writeFileSync(path.join(codexHome, "AGENTS.md"), "# Existing policy\n"); fs.writeFileSync(path.join(codexHome, "hooks.json"), "{\"hooks\":{}}\n");
  const initial = snapshotTree(codexHome);
  install({ home: root, codexHome, runner: fakeRunner });
  assert.throws(() => install({ home: root, codexHome, runner: fakeRunner, injectFailure: "after-destination-removal" }), /Injected failure after destination removal/);
  assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled");
  assert.deepEqual(snapshotTree(codexHome), initial);
});

test("initially absent targets retain user content while unrelated backups survive install, update, and uninstall", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const unrelated = path.join(codexHome, "backups", "user-backups", "keep.bin"); fs.mkdirSync(path.dirname(unrelated), { recursive: true }); fs.writeFileSync(unrelated, Buffer.from([0, 255, 16, 32]));
  install({ home: root, codexHome, runner: fakeRunner });
  const config = path.join(codexHome, "config.toml"); fs.appendFileSync(config, "# user authored after install\n");
  install({ home: root, codexHome, runner: fakeRunner });
  assert.equal(uninstall({ home: root, codexHome }).status, "uninstalled");
  assert.match(fs.readFileSync(config, "utf8"), /# user authored after install/); assert.doesNotMatch(fs.readFileSync(config, "utf8"), /CODEX DISPATCHER MANAGED/);
  assert.equal(fs.existsSync(path.join(codexHome, "AGENTS.md")), false); assert.equal(fs.existsSync(path.join(codexHome, "hooks.json")), false); assert.equal(fs.existsSync(path.join(codexHome, "dispatcher")), false);
  assert.deepEqual(fs.readFileSync(unrelated), Buffer.from([0, 255, 16, 32]));
});

test("successful normal updates retain durable baselines but leave no ephemeral transaction backups", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); fs.mkdirSync(codexHome, { recursive: true }); fs.writeFileSync(path.join(codexHome, "config.toml"), "model = \"before\"\n");
  const first = install({ home: root, codexHome, runner: fakeRunner }); const firstManifest = JSON.parse(fs.readFileSync(first.paths.stateFile, "utf8")); const baseline = firstManifest.backups.find((record) => record.target === first.paths.configFile);
  assert.ok(baseline?.file); assert.equal(fs.readFileSync(baseline.file, "utf8"), "model = \"before\"\n");
  const update = install({ home: root, codexHome, runner: fakeRunner }); assert.equal(update.status, "installed"); const updateManifest = JSON.parse(fs.readFileSync(first.paths.stateFile, "utf8")); assert.equal(updateManifest.backup_root, firstManifest.backup_root); assert.deepEqual(updateManifest.backups, firstManifest.backups);
  const backupEntries = fs.readdirSync(first.paths.backupBase);
  assert.equal(backupEntries.some((entry) => entry.startsWith("dispatcher-transaction-")), false);
  assert.ok(fs.existsSync(baseline.file)); assert.equal(fs.readFileSync(baseline.file, "utf8"), "model = \"before\"\n");
});

test("managed uninstall restores requirements, checks Windows elevation first, and retains state if privileged cleanup fails", () => {
  const existingRoot = temp(); const existingHome = path.join(existingRoot, ".codex"); const existingRequirements = path.join(existingRoot, "etc", "codex", "requirements.toml"); fs.mkdirSync(path.dirname(existingRequirements), { recursive: true }); fs.writeFileSync(existingRequirements, "# baseline\n");
  install({ home: existingRoot, codexHome: existingHome, requirementsFile: existingRequirements, managed: true, runner: fakeRunner }); assert.equal(uninstall({ home: existingRoot, codexHome: existingHome, requirementsFile: existingRequirements }).status, "uninstalled"); assert.equal(fs.readFileSync(existingRequirements, "utf8"), "# baseline\n");
  const absentRoot = temp(); const absentHome = path.join(absentRoot, ".codex"); const absentRequirements = path.join(absentRoot, "etc", "codex", "requirements.toml"); install({ home: absentRoot, codexHome: absentHome, requirementsFile: absentRequirements, managed: true, runner: fakeRunner }); assert.equal(uninstall({ home: absentRoot, codexHome: absentHome, requirementsFile: absentRequirements }).status, "uninstalled"); assert.equal(fs.existsSync(absentRequirements), false);
  const windowsRoot = temp(); const windowsHome = path.join(windowsRoot, "Codex Home"); const windowsRequirements = path.join(windowsRoot, "ProgramData", "OpenAI", "Codex", "requirements.toml"); install({ platform: "win32", home: windowsRoot, codexHome: windowsHome, requirementsFile: windowsRequirements, managed: true, windowsElevated: true, runner: fakeRunner }); const windowsConfig = path.join(windowsHome, "config.toml"); const windowsBefore = fs.readFileSync(windowsConfig, "utf8"); assert.throws(() => uninstall({ platform: "win32", home: windowsRoot, codexHome: windowsHome, requirementsFile: windowsRequirements, runner(command, args) { if (command === "pwsh") throw new Error("not elevated"); return fakeRunner(command, args); } }), /elevated pwsh 7/i); assert.equal(fs.readFileSync(windowsConfig, "utf8"), windowsBefore); assert.ok(fs.existsSync(path.join(windowsHome, "state", "codex-dispatcher.json")));
  if (process.platform !== "win32") { const blockedRoot = temp(); const blockedHome = path.join(blockedRoot, ".codex"); const blockedRequirements = path.join(blockedRoot, "etc", "codex", "requirements.toml"); install({ home: blockedRoot, codexHome: blockedHome, requirementsFile: blockedRequirements, managed: true, runner: fakeRunner }); const blockedConfig = path.join(blockedHome, "config.toml"); const blockedBefore = fs.readFileSync(blockedConfig, "utf8"); fs.chmodSync(path.dirname(blockedRequirements), 0o500); try { const result = uninstall({ home: blockedRoot, codexHome: blockedHome, requirementsFile: blockedRequirements, noSudo: true }); assert.equal(result.status, "partially_uninstalled"); assert.match(result.retained[0], /managed requirements retained/); assert.equal(fs.readFileSync(blockedConfig, "utf8"), blockedBefore); assert.ok(fs.existsSync(path.join(blockedHome, "state", "codex-dispatcher.json"))); } finally { fs.chmodSync(path.dirname(blockedRequirements), 0o700); } }
});

test("model overrides are persisted consistently in policy, AGENTS, models.json, and runtime routing constants", async () => {
  const config = updateConfig("", "/tmp/dispatcher", { sol: "entitled-sol" }); const req = updateRequirements("", { sol: "entitled-sol" }); assert.match(config, /model = "entitled-sol"/); assert.match(req, /model = "entitled-sol"/);
  const root = temp(); const codexHome = path.join(root, ".codex"); const models = { sol: "custom-sol", spark: "custom-spark", luna: "custom-luna", terra: "custom-terra" }; install({ home: root, codexHome, runner: fakeRunner, skipPreflight: true, models });
  const settings = JSON.parse(fs.readFileSync(path.join(codexHome, "dispatcher", "models.json"))); assert.deepEqual(settings, models); assert.match(fs.readFileSync(path.join(codexHome, "AGENTS.md"), "utf8"), /custom-terra/); assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /custom-spark/);
  const runtime = await import(`${pathToFileURL(path.join(codexHome, "dispatcher", "src", "constants.mjs")).href}?test=${Date.now()}`); assert.equal(runtime.SOL_MODEL, "custom-sol"); assert.equal(runtime.WORKERS.spark.model, "custom-spark"); assert.equal(runtime.WORKERS.luna.model, "custom-luna"); assert.equal(runtime.WORKERS.terra.model, "custom-terra");
});

test("v1.2 updates remove owned release state and UserPromptSubmit hooks without changing the original backup", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner });
  const releaseFile = first.paths.releaseStateFile; fs.writeFileSync(releaseFile, JSON.stringify({ version: 2, owners: ["qdzsh"], plan_key: crypto.randomBytes(32).toString("base64") }), { mode: 0o600 });
  const stateFile = first.paths.stateFile; const legacy = JSON.parse(fs.readFileSync(stateFile, "utf8")); const originalBackups = structuredClone(legacy.backups);
  legacy.version = 4; legacy.hashes_after[releaseFile] = crypto.createHash("sha256").update(fs.readFileSync(releaseFile)).digest("hex"); fs.writeFileSync(stateFile, JSON.stringify(legacy));
  const hooksFile = path.join(codexHome, "hooks.json"); const hooks = JSON.parse(fs.readFileSync(hooksFile)); const userPromptSubmit = { matcher: "user", hooks: [{ type: "command", command: "node user-hook.mjs", timeout: 42 }] }; const sessionStart = { matcher: "resume", hooks: [{ type: "command", command: "node session-start.mjs" }] }; hooks.hooks.UserPromptSubmit = [{ matcher: "*", hooks: [{ type: "command", command: `node ${JSON.stringify(path.join(codexHome, "dispatcher", "src", "hook.mjs"))}`, statusMessage: "Issuing release prepare or execution confirmation grants" }] }, userPromptSubmit]; hooks.hooks.SessionStart = [sessionStart]; fs.writeFileSync(hooksFile, JSON.stringify(hooks));
  const updated = install({ home: root, codexHome, runner: fakeRunner }); const next = JSON.parse(fs.readFileSync(stateFile, "utf8")); const nextHooks = JSON.parse(fs.readFileSync(hooksFile));
  assert.equal(updated.status, "installed"); assert.equal(next.version, 5); assert.equal(next.retired_legacy_release_state, true); assert.equal(fs.existsSync(releaseFile), false); assert.deepEqual(next.backups, originalBackups);
  assert.deepEqual(nextHooks.hooks.UserPromptSubmit, [userPromptSubmit]); assert.deepEqual(nextHooks.hooks.SessionStart, [sessionStart]); assert.equal(nextHooks.hooks.UserPromptSubmit.flatMap((group) => group.hooks).some((hook) => /dispatcher\/src\/hook\.mjs/.test(hook.command)), false);
  assert.match(fs.readFileSync(path.join(codexHome, "config.toml"), "utf8"), /enabled_tools = \["route_task", "dispatch_worker", "audit_tail"\]/);
});

test("v1.2 hook updates delete an empty UserPromptSubmit key after retiring its release handler", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner });
  const releaseFile = first.paths.releaseStateFile; fs.writeFileSync(releaseFile, JSON.stringify({ version: 2, owners: ["qdzsh"], plan_key: crypto.randomBytes(32).toString("base64") }), { mode: 0o600 });
  const stateFile = first.paths.stateFile; const legacy = JSON.parse(fs.readFileSync(stateFile, "utf8")); legacy.version = 4; legacy.hashes_after[releaseFile] = crypto.createHash("sha256").update(fs.readFileSync(releaseFile)).digest("hex"); fs.writeFileSync(stateFile, JSON.stringify(legacy));
  const hooksFile = path.join(codexHome, "hooks.json"); const hooks = JSON.parse(fs.readFileSync(hooksFile, "utf8")); const sessionStart = [{ matcher: "resume", hooks: [{ type: "command", command: "node session-start.mjs" }] }]; hooks.hooks.SessionStart = sessionStart; hooks.hooks.UserPromptSubmit = [{ matcher: "*", hooks: [{ type: "command", command: `node ${JSON.stringify(path.join(codexHome, "dispatcher", "src", "hook.mjs"))}`, statusMessage: "Issuing release prepare or execution confirmation grants" }] }]; fs.writeFileSync(hooksFile, JSON.stringify(hooks));
  install({ home: root, codexHome, runner: fakeRunner }); const nextHooks = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  assert.equal(Object.hasOwn(nextHooks.hooks, "UserPromptSubmit"), false); assert.deepEqual(nextHooks.hooks.SessionStart, sessionStart);
});

test("v1.2 updates retain user-modified private release state dormant and owner-only", () => {
  const root = temp(); const codexHome = path.join(root, ".codex"); const first = install({ home: root, codexHome, runner: fakeRunner }); const releaseFile = first.paths.releaseStateFile;
  fs.writeFileSync(releaseFile, JSON.stringify({ version: 2, owners: ["qdzsh"], plan_key: crypto.randomBytes(32).toString("base64") }), { mode: 0o600 }); const stateFile = first.paths.stateFile; const legacy = JSON.parse(fs.readFileSync(stateFile, "utf8")); legacy.version = 4; legacy.hashes_after[releaseFile] = crypto.createHash("sha256").update(fs.readFileSync(releaseFile)).digest("hex"); fs.writeFileSync(stateFile, JSON.stringify(legacy)); fs.appendFileSync(releaseFile, "\nuser-owned"); fs.chmodSync(releaseFile, 0o600);
  install({ home: root, codexHome, runner: fakeRunner }); const next = JSON.parse(fs.readFileSync(stateFile, "utf8")); assert.equal(next.retired_legacy_release_state, false); assert.equal(fs.existsSync(releaseFile), true); if (process.platform !== "win32") assert.equal(fs.statSync(releaseFile).mode & 0o077, 0);
});

test("hook migration removes dispatcher UserPromptSubmit hooks and managed post-requirements failure restores the requirement baseline", () => {
  const hooks = JSON.parse(updateHooks(JSON.stringify({ hooks: { SessionStart: [], UserPromptSubmit: [{ matcher: "x", hooks: [{ type: "command", command: "node other.mjs" }] }] } }), "/tmp/dispatcher/src/hook.mjs"));
  assert.equal(hooks.hooks.PreToolUse.length, 1); assert.equal(hooks.hooks.UserPromptSubmit.length, 1); assert.equal(hooks.hooks.UserPromptSubmit[0].hooks[0].command, "node other.mjs");
  const root = temp(); const codexHome = path.join(root, ".codex"); const requirements = path.join(root, "etc", "codex", "requirements.toml"); fs.mkdirSync(path.dirname(requirements), { recursive: true }); fs.writeFileSync(requirements, "# baseline\n");
  assert.throws(() => install({ home: root, codexHome, requirementsFile: requirements, managed: true, injectFailure: "after-system-requirements" }), /Injected failure after system requirements mutation/);
  assert.equal(fs.readFileSync(requirements, "utf8"), "# baseline\n");
});
