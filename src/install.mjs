#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentsPolicyBlock, GLOBAL_DEVELOPER_POLICY, SOL_EFFORT, SOL_MODEL, WORKERS } from "./constants.mjs";
import { readOwnerOnlyRegularFile } from "./private-state.mjs";

const sourceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_BEGIN = "# BEGIN CODEX DISPATCHER MANAGED CONFIG";
const CONFIG_END = "# END CODEX DISPATCHER MANAGED CONFIG";
const AGENTS_BEGIN = "<!-- BEGIN CODEX DISPATCHER POLICY -->";
const AGENTS_END = "<!-- END CODEX DISPATCHER POLICY -->";
const LEGACY_CONFIG_BEGIN = "# BEGIN CODEX TOKEN DISPATCHER MANAGED CONFIG";
const LEGACY_CONFIG_END = "# END CODEX TOKEN DISPATCHER MANAGED CONFIG";
const LEGACY_AGENTS_BEGIN = "<!-- BEGIN CODEX TOKEN DISPATCHER POLICY -->";
const LEGACY_AGENTS_END = "<!-- END CODEX TOKEN DISPATCHER POLICY -->";
const MANIFEST_VERSION = 5;

function quoteToml(value) { return JSON.stringify(String(value)); }
function stamp() { return new Date().toISOString().replace(/[-:.]/g, ""); }
function sha(file) {
  const stat = fs.lstatSync(file);
  const value = stat.isSymbolicLink() ? `symlink\0${fs.readlinkSync(file)}` : fs.readFileSync(file);
  return crypto.createHash("sha256").update(value).digest("hex");
}
function exists(file) { return fs.existsSync(file); }
function isOwnedLegacyReleaseState(manifest, file) {
  if (!manifest?.hashes_after?.[file] || !exists(file)) return false;
  try {
    readOwnerOnlyRegularFile(file);
    return manifest.hashes_after[file] === sha(file);
  } catch { return false; }
}
function lstatExists(file) { try { fs.lstatSync(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
function read(file) { return exists(file) ? fs.readFileSync(file, "utf8") : ""; }
function treeHash(target) {
  if (!exists(target)) return null;
  const digest = crypto.createHash("sha256");
  const visit = (current, relative = "") => {
    const stat = fs.lstatSync(current); digest.update(`${relative}\0${stat.mode}\0${stat.size}\0`);
    if (stat.isDirectory()) for (const item of fs.readdirSync(current).sort()) visit(path.join(current, item), path.join(relative, item));
    else if (stat.isSymbolicLink()) digest.update(fs.readlinkSync(current));
    else digest.update(fs.readFileSync(current));
  };
  visit(target); return digest.digest("hex");
}

export function platformPaths({ platform = process.platform, home = os.homedir(), codexHome, programData = process.env.ProgramData || process.env.PROGRAMDATA || "C:\\ProgramData" } = {}) {
  const resolvedHome = codexHome || process.env.CODEX_HOME || path.join(home, ".codex");
  const windows = platform === "win32";
  return {
    platform,
    codexHome: resolvedHome,
    destination: path.join(resolvedHome, "dispatcher"),
    configFile: path.join(resolvedHome, "config.toml"),
    agentsFile: path.join(resolvedHome, "AGENTS.md"),
    hooksFile: path.join(resolvedHome, "hooks.json"),
    stateFile: path.join(resolvedHome, "state", "codex-dispatcher.json"),
    releaseStateFile: path.join(resolvedHome, "state", "codex-dispatcher-release.json"),
    backupBase: path.join(resolvedHome, "backups"),
    requirementsFile: windows ? path.win32.join(programData, "OpenAI", "Codex", "requirements.toml") : "/etc/codex/requirements.toml",
    wrapperDir: windows ? path.join(resolvedHome, "bin") : path.join(home, ".local", "bin"),
    wrapperFiles: windows
      ? [path.join(resolvedHome, "bin", "codex-dispatcher.cmd"), path.join(resolvedHome, "bin", "codex-worker.cmd")]
      : [path.join(home, ".local", "bin", "codex-dispatcher"), path.join(home, ".local", "bin", "codex-worker")]
  };
}

export function atomicWrite(file, content, mode = 0o600) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, mode); } catch {}
}

export function removeManagedBlock(text, begin, end) {
  let output = String(text || "");
  while (true) {
    const start = output.indexOf(begin);
    if (start < 0) return output.replace(/\n{3,}/g, "\n\n");
    const finish = output.indexOf(end, start);
    if (finish < 0) throw new Error(`Managed block starts with ${begin} but has no closing marker.`);
    output = `${output.slice(0, start)}${output.slice(finish + end.length)}`;
  }
}

function replaceRootScalar(text, key, value) {
  const at = text.search(/^\s*\[/m); const root = text.slice(0, at < 0 ? text.length : at); const rest = text.slice(at < 0 ? text.length : at);
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); const expression = new RegExp(`^[\\t ]*${escaped}\\s*=.*$`, "m");
  return expression.test(root) ? `${root.replace(expression, `${key} = ${value}`)}${rest}` : `${key} = ${value}\n${root}${rest}`;
}

function isExactTomlTableHeader(line, table) {
  const escaped = table.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^[\\t ]*\\[${escaped}\\][\\t ]*(?:#.*)?$`).test(line);
}
function tableStart(lines, table) { return lines.findIndex((line) => isExactTomlTableHeader(line, table)); }
function tomlLines(text) {
  const lines = []; let start = 0; const lineEnding = /\r\n|\n|\r/g; let match;
  while ((match = lineEnding.exec(text))) {
    lines.push({ start, end: match.index, text: text.slice(start, match.index), ending: match[0] });
    start = match.index + match[0].length;
  }
  if (start < text.length) lines.push({ start, end: text.length, text: text.slice(start), ending: "" });
  return lines;
}
function preferredTomlLineEnding(text) { return text.match(/\r\n|\n|\r/)?.[0] || "\n"; }
function isTomlTableHeader(line) { return /^[\t ]*\[\[?/.test(line); }
function setTableScalar(text, table, key, value) {
  const source = String(text || ""); const lines = tomlLines(source); const start = lines.findIndex((line) => isExactTomlTableHeader(line.text, table)); const ending = preferredTomlLineEnding(source);
  if (start < 0) {
    const separator = source ? `${source.endsWith("\n") || source.endsWith("\r") ? "" : ending}${ending}` : "";
    return `${source}${separator}[${table}]${ending}${key} = ${value}${ending}`;
  }
  let end = lines.length; for (let index = start + 1; index < lines.length; index += 1) if (isTomlTableHeader(lines[index].text)) { end = index; break; }
  const pattern = new RegExp(`^[\\t ]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`); const index = lines.findIndex((line, lineIndex) => lineIndex > start && lineIndex < end && pattern.test(line.text));
  if (index >= 0) return `${source.slice(0, lines[index].start)}${key} = ${value}${source.slice(lines[index].end)}`;
  const insertion = end < lines.length ? lines[end].start : source.length;
  const prefix = insertion > 0 && !source.slice(0, insertion).endsWith("\n") && !source.slice(0, insertion).endsWith("\r") ? ending : "";
  return `${source.slice(0, insertion)}${prefix}${key} = ${value}${ending}${source.slice(insertion)}`;
}

function rootScalarLine(text, key) {
  const firstTable = String(text || "").search(/^\s*\[/m); const root = String(text || "").slice(0, firstTable < 0 ? undefined : firstTable);
  const expression = new RegExp(`^[\\t ]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*$`, "m"); return root.match(expression)?.[0] || null;
}

function tableScalarLine(text, table, key) {
  const lines = String(text || "").split("\n"); const start = tableStart(lines, table); if (start < 0) return null;
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) if (new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[index])) return lines[index];
  return null;
}

function removeRootScalar(text, key) {
  const firstTable = text.search(/^\s*\[/m); const root = text.slice(0, firstTable < 0 ? text.length : firstTable); const rest = text.slice(firstTable < 0 ? text.length : firstTable);
  const expression = new RegExp(`^[\\t ]*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=.*(?:\\n|$)`, "m"); return `${root.replace(expression, "")}${rest}`;
}

function removeTableScalar(text, table, key) {
  const lines = String(text || "").split("\n"); const start = tableStart(lines, table); if (start < 0) return text;
  for (let index = start + 1; index < lines.length && !/^\s*\[/.test(lines[index]); index += 1) if (new RegExp(`^\\s*${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*=`).test(lines[index])) { lines.splice(index, 1); break; }
  return lines.join("\n");
}

function restoreScalarIfInstalled(current, baseline, installed, table, key) {
  const locate = table ? tableScalarLine : rootScalarLine; const currentLine = locate(current, ...(table ? [table, key] : [key])); const installedLine = locate(installed, ...(table ? [table, key] : [key]));
  if (!currentLine || currentLine !== installedLine) return current;
  const baselineLine = locate(baseline, ...(table ? [table, key] : [key]));
  if (baselineLine) return table ? setTableScalar(current, table, key, baselineLine.split("=").slice(1).join("=").trim()) : replaceRootScalar(current, key, baselineLine.split("=").slice(1).join("=").trim());
  return table ? removeTableScalar(current, table, key) : removeRootScalar(current, key);
}

export function updateConfig(original, destination, models = {}) {
  let text = removeManagedBlock(removeManagedBlock(original, LEGACY_CONFIG_BEGIN, LEGACY_CONFIG_END), CONFIG_BEGIN, CONFIG_END).trimEnd() + "\n";
  const firstTable = text.search(/^\s*\[/m);
  const root = text.slice(0, firstTable < 0 ? text.length : firstTable);
  if (/^[\t ]*developer_instructions\s*=/m.test(root)) throw new Error("An unmanaged root developer_instructions key already exists; refusing to overwrite it.");
  const sol = models.sol || SOL_MODEL; const effort = models.sol_effort || SOL_EFFORT;
  text = replaceRootScalar(text, "model", quoteToml(sol)); text = replaceRootScalar(text, "model_reasoning_effort", quoteToml(effort));
  text = setTableScalar(text, "features", "hooks", "true"); text = setTableScalar(text, "features", "multi_agent", "false");
  const configuredPolicy = GLOBAL_DEVELOPER_POLICY.replaceAll(SOL_MODEL, sol).replaceAll(WORKERS.spark.model, models.spark || WORKERS.spark.model).replaceAll(WORKERS.luna.model, models.luna || WORKERS.luna.model).replaceAll(WORKERS.terra.model, models.terra || WORKERS.terra.model);
  const policy = `${CONFIG_BEGIN}\ndeveloper_instructions = \"\"\"\n${configuredPolicy}\n\"\"\"\n${CONFIG_END}\n`;
  const first = text.search(/^\s*\[/m); text = first < 0 ? `${text.trimEnd()}\n\n${policy}` : `${text.slice(0, first).trimEnd()}\n\n${policy}${text.slice(first)}`;
  return `${text.trimEnd()}\n\n${CONFIG_BEGIN}\n[mcp_servers.codex_worker_dispatcher]\ncommand = "node"\nargs = [${quoteToml(path.join(destination, "src", "server.mjs"))}]\nenabled = true\nstartup_timeout_sec = 30\ntool_timeout_sec = 7200\nenabled_tools = ["route_task", "dispatch_worker", "audit_tail"]\n${CONFIG_END}\n`;
}

export function updateAgents(original, models = {}) { const text = removeManagedBlock(removeManagedBlock(original, LEGACY_AGENTS_BEGIN, LEGACY_AGENTS_END), AGENTS_BEGIN, AGENTS_END).trimEnd(); return `${text}${text ? "\n\n" : ""}${agentsPolicyBlock(models)}\n`; }
function powershellQuote(value) { return `'${String(value).replaceAll("'", "''")}'`; }
function windowsHookCommand(hookScript) { return `pwsh -NoProfile -NonInteractive -Command "& node ${powershellQuote(hookScript)}"`; }
export function updateHooks(original, hookScript) {
  const document = original?.trim() ? JSON.parse(original) : { hooks: {} }; if (!document || typeof document !== "object" || Array.isArray(document)) throw new Error("hooks.json must contain a JSON object.");
  document.hooks ||= {};
  for (const event of ["PreToolUse", "UserPromptSubmit"]) {
    if (!Array.isArray(document.hooks[event])) document.hooks[event] = [];
    document.hooks[event] = document.hooks[event].map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((hook) => !isDispatcherHook(hook, hookScript));
      return hooks.length ? { ...group, hooks } : null;
    }).filter(Boolean);
  }
  if (document.hooks.UserPromptSubmit.length === 0) delete document.hooks.UserPromptSubmit;
  document.hooks.PreToolUse.push({ matcher: "*", hooks: [{ type: "command", command: `node ${JSON.stringify(hookScript)}`, commandWindows: windowsHookCommand(hookScript), timeout: 10, statusMessage: "Enforcing Sol orchestrator policy" }] });
  return `${JSON.stringify(document, null, 2)}\n`;
}
export function updateRequirements(original, models = {}) {
  const sol = models.sol || SOL_MODEL; const effort = models.sol_effort || SOL_EFFORT; let text = String(original || "");
  text = setTableScalar(text, "models.new_thread", "model", quoteToml(sol)); text = setTableScalar(text, "models.new_thread", "model_reasoning_effort", quoteToml(effort)); text = setTableScalar(text, "features", "multi_agent", "false"); return text;
}

function run(command, args, options = {}) { const result = spawnSync(command, args, { cwd: options.cwd, env: options.env || process.env, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }); if (result.error || result.status !== 0) throw new Error(result.error?.message || result.stderr?.trim() || `${command} exited with ${result.status}`); return result.stdout; }
function commandRunner(runner) {
  if (runner === undefined) return run;
  if (typeof runner !== "function") throw new TypeError("runner must be a function.");
  return runner;
}
export function verifyCapabilities({ runner = run, skip = false, models = {} } = {}) {
  if (skip) return { skipped: true };
  const version = runner("codex", ["--version"]); if (!version) throw new Error("Codex did not return a version. Install or update Codex, then rerun.");
  runner("npm", ["--version"]); const catalog = JSON.parse(runner("codex", ["debug", "models"])); const entries = new Map((catalog.models || []).map((item) => [item.slug, item]));
  const required = [{ model: models.sol || SOL_MODEL, effort: SOL_EFFORT }, { model: models.spark || WORKERS.spark.model, effort: WORKERS.spark.effort }, { model: models.luna || WORKERS.luna.model, effort: WORKERS.luna.effort }, { model: models.terra || WORKERS.terra.model, effort: WORKERS.terra.effort }];
  for (const worker of required) { const entry = entries.get(worker.model); if (!entry) throw new Error(`Your Codex entitlement does not include ${worker.model}. Use --model-sol/--model-spark/--model-luna/--model-terra with entitled models, or ask an administrator.`); if (!(entry.supported_reasoning_levels || []).some((value) => value.effort === worker.effort)) throw new Error(`${worker.model} does not support ${worker.effort} reasoning effort.`); }
  const features = runner("codex", ["features", "list"]); if (!/^hooks\s+/m.test(features) || !/^multi_agent\s+/m.test(features)) throw new Error("This Codex build must support hooks and multi_agent. Update Codex and retry."); return { codex: version.trim() };
}

function copySource(destination) { fs.cpSync(sourceRoot, destination, { recursive: true, filter(source) { const rel = path.relative(sourceRoot, source).split(path.sep); return !rel.some((item) => ["node_modules", ".git", "logs", "backups", "state", ".DS_Store"].includes(item) || item.endsWith(".tmp") || item.endsWith(".tgz")); } }); }
function backup(target, root, label) { const record = { target, existed: lstatExists(target), label }; if (record.existed) { record.file = path.join(root, label); fs.mkdirSync(path.dirname(record.file), { recursive: true, mode: 0o700 }); fs.cpSync(target, record.file, { recursive: true, dereference: false, verbatimSymlinks: true }); } return record; }
function backupText(target, root, label, text, existed = exists(target)) { const record = { target, existed, label }; if (existed) { record.file = path.join(root, label); atomicWrite(record.file, text); } return record; }
function restore(record) { if (record.existed) { fs.rmSync(record.target, { recursive: true, force: true }); fs.mkdirSync(path.dirname(record.target), { recursive: true }); fs.cpSync(record.file, record.target, { recursive: true, dereference: false, verbatimSymlinks: true }); } else fs.rmSync(record.target, { recursive: true, force: true }); }
function uniqueBackupRoot(base, prefix) {
  let root;
  do { root = path.join(base, `${prefix}-${stamp()}-${crypto.randomUUID()}`); } while (exists(root));
  return root;
}
function removeTransactionBackups(root) {
  fs.rmSync(root, { recursive: true, force: true });
}
function missingDirectories(directories) {
  return [...new Set(directories)].filter((directory) => !lstatExists(directory));
}
function removeEmptyDirectories(directories) {
  for (const directory of [...directories].reverse()) {
    if (!lstatExists(directory)) continue;
    const stat = fs.lstatSync(directory);
    if (stat.isDirectory() && fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  }
}
function wrapperContent(platform, cli) { return platform === "win32" ? `@echo off\r\nnode "${cli}" %*\r\n` : `#!/bin/sh\nexec node ${JSON.stringify(cli)} "$@"\n`; }
function assertOwnedArtifactsUnmodified(manifest, paths) {
  if (!manifest) return;
  const hashes = manifest.hashes_after || {};
  const check = (file, label, hash) => {
    if (!Object.hasOwn(hashes, file)) return;
    const actual = exists(file) ? hash(file) : null;
    if (actual !== hashes[file]) throw new Error(`The managed ${label} was modified: ${file}. Restore its installed contents to update, or retain your edits and skip this update.`);
  };
  for (const file of paths.wrapperFiles) check(file, "wrapper", sha);
  check(paths.destination, "runtime", treeHash);
}
function ensureSystemRequirements(paths, content, options, runner) {
  if (options.managed !== true) return false;
  if (options.platform === "win32") { atomicWrite(paths.requirementsFile, content, 0o644); return true; }
  try { atomicWrite(paths.requirementsFile, content, 0o644); return true; }
  catch (error) { if (options.noSudo) throw new Error(`Cannot write ${paths.requirementsFile} in managed mode: ${error.message}. Re-run with privilege or use --user-only.`); const temporary = path.join(os.tmpdir(), `codex-dispatcher-${process.pid}.toml`); atomicWrite(temporary, content, 0o644); try { runner("sudo", ["install", "-d", "-m", "0755", path.dirname(paths.requirementsFile)]); runner("sudo", ["install", "-m", "0644", temporary, paths.requirementsFile]); return true; } finally { fs.rmSync(temporary, { force: true }); } }
}
function verifyWindowsElevation(options, runner) {
  if (options.platform !== "win32" || options.managed !== true || options.windowsElevated === true) return;
  try {
    runner("pwsh", ["-NoProfile", "-NonInteractive", "-Command", "$p = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent()); if ($p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 0 }; exit 1"]);
  } catch {
    throw new Error("Managed mode on Windows requires an elevated pwsh 7 session before any files are changed. Start pwsh as Administrator and rerun the same command; powershell.exe is not supported.");
  }
}

export function install(options = {}) {
  const runner = commandRunner(options.runner);
  const platform = options.platform || process.platform; const paths = platformPaths({ platform, home: options.home, codexHome: options.codexHome, programData: options.programData }); if (options.requirementsFile) paths.requirementsFile = options.requirementsFile;
  const previousManifest = exists(paths.stateFile) ? JSON.parse(read(paths.stateFile)) : null;
  if (previousManifest?.managed === true && options.managed === false) throw new Error("This installation is managed. --user-only cannot safely remove its system requirements during update; uninstall first, then reinstall with --user-only.");
  const managed = options.managed ?? previousManifest?.managed ?? false;
  const models = { ...(previousManifest?.models || {}), ...(options.models || {}) };
  // Version 1.2 wrote this private release state. Remove it only when the prior
  // manifest proves its bytes are still installer-owned; edited private state is
  // deliberately left dormant and untouched.
  const retireLegacyReleaseState = isOwnedLegacyReleaseState(previousManifest, paths.releaseStateFile);
  verifyCapabilities({ runner, skip: options.skipPreflight, models }); verifyWindowsElevation({ ...options, platform, managed }, runner);
  assertOwnedArtifactsUnmodified(previousManifest, paths);
  // Parse and validate every generated user-facing file before creating backups or
  // replacing the runtime, so malformed or unmanaged configuration is untouched.
  const desired = {
    config: updateConfig(read(paths.configFile), paths.destination, models),
    agents: updateAgents(read(paths.agentsFile), models),
    hooks: updateHooks(read(paths.hooksFile), path.join(paths.destination, "src", "hook.mjs")),
    requirements: updateRequirements(read(paths.requirementsFile), models)
  };
  // Durable baselines remain for uninstall/recovery. Transaction backups are kept
  // separately and are always removed after either commit or rollback.
  const backupBaseExisted = exists(paths.backupBase);
  const stateDirectoryExisted = exists(path.dirname(paths.stateFile));
  if (previousManifest && (!previousManifest.backup_root || !Array.isArray(previousManifest.backups))) throw new Error("The installed dispatcher state has no durable uninstall baseline. Reinstall only after preserving your current configuration, or restore a valid state file.");
  // The first successful install owns this root for its entire lifetime. Updates
  // may change the installed payload, but must never recapture the pre-install
  // baseline: uninstall needs the exact bytes that existed before first install.
  const backupRoot = previousManifest?.backup_root || uniqueBackupRoot(paths.backupBase, "dispatcher-install");
  const createdDurableBackupRoot = !previousManifest;
  const addsManagedRequirementsBaseline = previousManifest?.managed === false && managed === true;
  const transactionBackupRoot = uniqueBackupRoot(paths.backupBase, "dispatcher-transaction");
  const missingBackupDirectories = missingDirectories([paths.backupBase, backupRoot, transactionBackupRoot]);
  const targets = [
    [paths.configFile, "config.toml"], [paths.agentsFile, "AGENTS.md"], [paths.hooksFile, "hooks.json"], [paths.destination, "dispatcher"],
    ...paths.wrapperFiles.map((file, index) => [file, `wrapper-${index}`]), ...(managed ? [[paths.requirementsFile, "requirements.toml"]] : []), ...(retireLegacyReleaseState ? [[paths.releaseStateFile, "legacy-release-state.json"]] : []), [paths.stateFile, "state.json"]
  ]; const transactionBackups = targets.map(([file, label]) => backup(file, transactionBackupRoot, label)); const temporary = path.join(paths.codexHome, `.dispatcher-${process.pid}.installing`);
  let mutationStarted = false;
  let addedRequirementsBaseline = null;
  try {
    fs.rmSync(temporary, { recursive: true, force: true }); copySource(temporary); runner("npm", ["install", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: temporary });
    let baselineBackups = previousManifest?.backups || [
      backup(paths.configFile, backupRoot, "baseline-config.toml"), backup(paths.agentsFile, backupRoot, "baseline-AGENTS.md"), backup(paths.hooksFile, backupRoot, "baseline-hooks.json"),
      ...paths.wrapperFiles.map((file, index) => backup(file, backupRoot, `baseline-wrapper-${index}`)), backup(paths.destination, backupRoot, "baseline-dispatcher"),
      ...(managed ? [backup(paths.requirementsFile, backupRoot, "baseline-requirements.toml")] : [])
    ];
    // A user-only install deliberately has no requirements baseline.  The first
    // explicit managed upgrade is therefore the one and only time that entry is
    // appended; all first-install records stay immutable.
    if (addsManagedRequirementsBaseline) {
      addedRequirementsBaseline = backup(paths.requirementsFile, backupRoot, "baseline-requirements.toml");
      baselineBackups = [...baselineBackups, addedRequirementsBaseline];
    }
    // Once an update incorporates a user edit, record that fact separately from
    // the immutable baseline. A later untouched uninstall then removes only our
    // managed changes instead of restoring over that user-authored content.
    const preservedOnUninstall = new Set(previousManifest?.preserve_on_uninstall || []);
    const userPreservations = { ...(previousManifest?.user_preservations || {}) };
    if (previousManifest) for (const file of [paths.configFile, paths.agentsFile, paths.hooksFile, ...(managed ? [paths.requirementsFile] : [])]) {
      if (!exists(file) || !Object.hasOwn(previousManifest.hashes_after || {}, file) || previousManifest.hashes_after[file] === sha(file)) continue;
      preservedOnUninstall.add(file);
      const baseline = baselineText(previousManifest, file);
      const content = file === paths.configFile ? cleanChangedConfig(read(file), baseline, paths, previousManifest.models || {})
        : file === paths.agentsFile ? removeManagedBlock(removeManagedBlock(read(file), LEGACY_AGENTS_BEGIN, LEGACY_AGENTS_END), AGENTS_BEGIN, AGENTS_END)
          : file === paths.hooksFile ? removeManagedHook(read(file), path.join(paths.destination, "src", "hook.mjs"))
            : cleanChangedRequirements(read(file), baseline, previousManifest.models || {});
      userPreservations[file] = { content };
    }
    const { config, agents, hooks, requirements } = desired;
    // Mark the transaction before a destructive operation; rename can fail after
    // the old runtime has already been removed.
    mutationStarted = true; fs.rmSync(paths.destination, { recursive: true, force: true });
    if (options.injectFailure === "after-destination-removal") throw new Error("Injected failure after destination removal.");
    fs.renameSync(temporary, paths.destination);
    atomicWrite(path.join(paths.destination, "models.json"), `${JSON.stringify({ sol: models.sol || SOL_MODEL, spark: models.spark || WORKERS.spark.model, luna: models.luna || WORKERS.luna.model, terra: models.terra || WORKERS.terra.model }, null, 2)}\n`);
    atomicWrite(paths.configFile, config); atomicWrite(paths.agentsFile, agents, 0o644); atomicWrite(paths.hooksFile, hooks); if (retireLegacyReleaseState) fs.rmSync(paths.releaseStateFile, { force: true }); for (const file of paths.wrapperFiles) atomicWrite(file, wrapperContent(platform, path.join(paths.destination, "src", "cli.mjs")), platform === "win32" ? 0o644 : 0o755);
    if (options.injectFailure === "after-user-files") throw new Error("Injected failure after user-file writes.");
    ensureSystemRequirements(paths, requirements, { ...options, platform, managed }, runner);
    if (options.injectFailure === "after-system-requirements") throw new Error("Injected failure after system requirements mutation.");
    const files = [paths.configFile, paths.agentsFile, paths.hooksFile, ...paths.wrapperFiles, ...(managed ? [paths.requirementsFile] : [])].filter(exists); const manifest = { version: MANIFEST_VERSION, installed_at: new Date().toISOString(), paths, managed, models, backup_root: backupRoot, backup_base_existed: previousManifest?.backup_base_existed ?? backupBaseExisted, state_directory_existed: previousManifest?.state_directory_existed ?? stateDirectoryExisted, backups: baselineBackups, retired_legacy_release_state: retireLegacyReleaseState, preserve_on_uninstall: [...preservedOnUninstall].sort(), user_preservations: userPreservations, hashes_after: { ...Object.fromEntries(files.map((file) => [file, sha(file)])), [paths.destination]: treeHash(paths.destination) } };
    atomicWrite(paths.stateFile, `${JSON.stringify(manifest, null, 2)}\n`);
    removeTransactionBackups(transactionBackupRoot);
    return { status: "installed", ...manifest };
  } catch (error) {
    const rollbackFailures = [];
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (cleanup) { rollbackFailures.push(`temporary runtime cleanup failed: ${cleanup.message}`); }
    if (mutationStarted) for (const item of [...transactionBackups].reverse()) {
      try {
        if (managed && item.target === paths.requirementsFile) restoreSystemRequirements(item, paths.requirementsFile, { ...options, platform }, runner);
        else restore(item);
      } catch (rollback) { rollbackFailures.push(`target restore failed for ${item.target}: ${rollback.message}`); }
    }
    // Only a first-install failure owns a new durable root. An update rollback
    // must retain the prior manifest and its original baseline byte-for-byte.
    if (createdDurableBackupRoot) try { fs.rmSync(backupRoot, { recursive: true, force: true }); } catch (cleanup) { rollbackFailures.push(`new durable backup cleanup failed: ${cleanup.message}`); }
    else if (addedRequirementsBaseline?.file) try { fs.rmSync(addedRequirementsBaseline.file, { force: true }); } catch (cleanup) { rollbackFailures.push(`managed requirements baseline cleanup failed: ${cleanup.message}`); }
    if (!rollbackFailures.length) try { removeTransactionBackups(transactionBackupRoot); removeEmptyDirectories(missingBackupDirectories); } catch (cleanup) { rollbackFailures.push(`transaction backup cleanup failed: ${cleanup.message}`); }
    if (rollbackFailures.length) throw new Error(`Installation failed: ${error.message}; rollback also failed: ${rollbackFailures.join("; ")}; recovery backups retained at ${transactionBackupRoot}`);
    throw error;
  }
}

// The manifest intentionally contains private baseline and preservation data
// needed to safely undo an installation. Never expose it through CLI output.
export function publicInstallResult(manifest) {
  return {
    status: manifest.status,
    managed: manifest.managed,
    destination: manifest.paths.destination,
    state_file: manifest.paths.stateFile,
    preserved_file_count: manifest.preserve_on_uninstall?.length || 0
  };
}

function managedRemoval(file, updater) { if (!exists(file)) return; atomicWrite(file, updater(read(file))); }
function baselineText(manifest, file) { const record = manifest.backups.find((item) => item.target === file); return record?.existed && record.file && exists(record.file) ? read(record.file) : ""; }
function cleanChangedConfig(current, baseline, paths, models) {
  let output = removeManagedBlock(removeManagedBlock(current, LEGACY_CONFIG_BEGIN, LEGACY_CONFIG_END), CONFIG_BEGIN, CONFIG_END);
  const installed = updateConfig(baseline, paths.destination, models);
  output = restoreScalarIfInstalled(output, baseline, installed, null, "model");
  output = restoreScalarIfInstalled(output, baseline, installed, null, "model_reasoning_effort");
  output = restoreScalarIfInstalled(output, baseline, installed, "features", "hooks");
  output = restoreScalarIfInstalled(output, baseline, installed, "features", "multi_agent");
  return `${output.trimEnd()}\n`;
}
function cleanChangedRequirements(current, baseline, models) {
  let output = current; const installed = updateRequirements(baseline, models);
  output = restoreScalarIfInstalled(output, baseline, installed, "models.new_thread", "model");
  output = restoreScalarIfInstalled(output, baseline, installed, "models.new_thread", "model_reasoning_effort");
  output = restoreScalarIfInstalled(output, baseline, installed, "features", "multi_agent");
  return `${output.trimEnd()}\n`;
}
function restoreUserScalarIfUnchanged(current, baseline, preserved, table, key) {
  const locate = table ? tableScalarLine : rootScalarLine; const args = table ? [table, key] : [key];
  const currentLine = locate(current, ...args); const baselineLine = locate(baseline, ...args); const preservedLine = locate(preserved, ...args);
  if (currentLine !== baselineLine || preservedLine === baselineLine) return current;
  if (!preservedLine) return table ? removeTableScalar(current, table, key) : removeRootScalar(current, key);
  const value = preservedLine.split("=").slice(1).join("=").trim(); return table ? setTableScalar(current, table, key, value) : replaceRootScalar(current, key, value);
}
function restorePreservedConfig(current, baseline, preserved) {
  let output = current;
  output = restoreUserScalarIfUnchanged(output, baseline, preserved, null, "model");
  output = restoreUserScalarIfUnchanged(output, baseline, preserved, null, "model_reasoning_effort");
  output = restoreUserScalarIfUnchanged(output, baseline, preserved, "features", "hooks");
  return restoreUserScalarIfUnchanged(output, baseline, preserved, "features", "multi_agent");
}
function restorePreservedRequirements(current, baseline, preserved) {
  let output = current;
  output = restoreUserScalarIfUnchanged(output, baseline, preserved, "models.new_thread", "model");
  output = restoreUserScalarIfUnchanged(output, baseline, preserved, "models.new_thread", "model_reasoning_effort");
  return restoreUserScalarIfUnchanged(output, baseline, preserved, "features", "multi_agent");
}
function isDispatcherHookCommand(command, hookScript) {
  const value = String(command || "").trim(); const current = `node ${JSON.stringify(hookScript)}`;
  if (value === current || value === `node "${hookScript}"`) return true;
  const quoted = value.match(/^node\s+(?:"([^"]+)"|'([^']+)'|(\S+))$/);
  if (!quoted) return false;
  const script = (quoted[1] || quoted[2] || quoted[3]).replaceAll("\\", "/");
  if (hookScript && script === hookScript.replaceAll("\\", "/")) return true;
  // This is the exact former install location, not a broad dispatcher basename.
  return /(?:^|\/)\.codex\/(?:worker-dispatcher|codex-token-dispatcher)\/src\/hook\.mjs$/.test(script);
}
function isDispatcherWindowsHookCommand(command, hookScript) {
  const value = String(command || "").trim();
  if (value === windowsHookCommand(hookScript)) return true;
  const match = value.match(/^pwsh\s+-NoProfile\s+-NonInteractive\s+-Command\s+"&\s+node\s+'((?:''|[^'])*)'"$/);
  if (!match) return false;
  return match[1].replaceAll("''", "'").replaceAll("\\", "/") === String(hookScript || "").replaceAll("\\", "/");
}
function isDispatcherHook(hook, hookScript) {
  return isDispatcherHookCommand(hook?.command, hookScript) || isDispatcherWindowsHookCommand(hook?.commandWindows, hookScript);
}
function removeManagedHook(original, hookScript = "") {
  const document = JSON.parse(original); if (!document || typeof document !== "object" || Array.isArray(document) || !document.hooks || typeof document.hooks !== "object") throw new Error("hooks.json changed into an unsupported shape; retaining it for retry.");
  for (const event of ["PreToolUse", "UserPromptSubmit"]) if (Array.isArray(document.hooks[event])) {
    document.hooks[event] = document.hooks[event].map((group) => {
      if (!Array.isArray(group?.hooks)) return group;
      const hooks = group.hooks.filter((hook) => !isDispatcherHook(hook, hookScript));
      return hooks.length ? { ...group, hooks } : null;
    }).filter(Boolean);
  }
  return `${JSON.stringify(document, null, 2)}\n`;
}
function writeSystemRequirements(file, content, options, runner) {
  try { atomicWrite(file, content, 0o644); }
  catch (error) {
    if (options.platform === "win32") throw new Error(`Cannot write ${file}: ${error.message}. Start pwsh 7 as Administrator and retry.`);
    if (options.noSudo) throw new Error(`Cannot write ${file}: ${error.message}. Re-run with privilege or without --no-sudo.`);
    const temporary = path.join(os.tmpdir(), `codex-dispatcher-uninstall-${process.pid}.toml`); atomicWrite(temporary, content, 0o644);
    try { runner("sudo", ["install", "-d", "-m", "0755", path.dirname(file)]); runner("sudo", ["install", "-m", "0644", temporary, file]); }
    finally { fs.rmSync(temporary, { force: true }); }
  }
}
function removeSystemRequirements(file, options, runner) {
  try { fs.rmSync(file, { force: true }); }
  catch (error) {
    if (options.platform === "win32") throw new Error(`Cannot remove ${file}: ${error.message}. Start pwsh 7 as Administrator and retry.`);
    if (options.noSudo) throw new Error(`Cannot remove ${file}: ${error.message}. Re-run with privilege or without --no-sudo.`);
    runner("sudo", ["rm", "-f", "--", file]);
  }
}
function restoreSystemRequirements(record, file, options, runner) {
  if (!record?.existed) return removeSystemRequirements(file, options, runner);
  const stat = fs.lstatSync(record.file);
  if (!stat.isSymbolicLink()) return writeSystemRequirements(file, fs.readFileSync(record.file, "utf8"), options, runner);
  const target = fs.readlinkSync(record.file);
  try {
    fs.rmSync(file, { recursive: true, force: true }); fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o755 }); fs.symlinkSync(target, file);
  } catch (error) {
    if (options.platform === "win32") throw new Error(`Cannot restore symbolic link ${file}: ${error.message}. Start pwsh 7 as Administrator and retry.`);
    if (options.noSudo) throw new Error(`Cannot restore symbolic link ${file}: ${error.message}. Re-run with privilege or without --no-sudo.`);
    runner("sudo", ["ln", "-sfn", target, file]);
  }
}
function restoreManagedRequirements(manifest, paths, options, runner) {
  const file = paths.requirementsFile; if (!lstatExists(file)) return false;
  const original = manifest.backups.find((item) => item.target === file);
  const untouched = manifest.hashes_after[file] === sha(file);
  const preserveUserContent = manifest.preserve_on_uninstall?.includes(file);
  if (untouched && !preserveUserContent) restoreSystemRequirements(original, file, options, runner);
  else { const baseline = baselineText(manifest, file); const cleaned = cleanChangedRequirements(read(file), baseline, manifest.models || {}); writeSystemRequirements(file, manifest.user_preservations?.[file] ? restorePreservedRequirements(cleaned, baseline, manifest.user_preservations[file].content) : cleaned, options, runner); }
  return true;
}
function removeDurableInstallArtifacts(manifest, paths) {
  const root = manifest.backup_root;
  // Only remove the private install root this manifest created. Never sweep a
  // shared backups directory, which may contain user-created recovery data.
  if (root && path.dirname(root) === paths.backupBase && path.basename(root).startsWith("dispatcher-install-")) fs.rmSync(root, { recursive: true, force: true });
  if (manifest.backup_base_existed === false && exists(paths.backupBase) && fs.readdirSync(paths.backupBase).length === 0) fs.rmdirSync(paths.backupBase);
  const stateDirectory = path.dirname(paths.stateFile);
  if (manifest.state_directory_existed === false && exists(stateDirectory) && fs.readdirSync(stateDirectory).length === 0) fs.rmdirSync(stateDirectory);
}
export function uninstall(options = {}) {
  const runner = commandRunner(options.runner);
  const platform = options.platform || process.platform; const paths = platformPaths({ platform, home: options.home, codexHome: options.codexHome, programData: options.programData }); if (options.requirementsFile) paths.requirementsFile = options.requirementsFile; if (!exists(paths.stateFile)) return { status: "not_installed", paths };
  const manifest = JSON.parse(read(paths.stateFile)); const restored = []; const retained = [];
  if (manifest.managed) {
    // Windows must establish elevation before any user-scoped file is touched.
    verifyWindowsElevation({ ...options, platform, managed: true }, runner);
    try { if (restoreManagedRequirements(manifest, paths, { ...options, platform }, runner)) restored.push(paths.requirementsFile); }
    catch (error) { return { status: "partially_uninstalled", restored, retained: [`${paths.requirementsFile} (managed requirements retained: ${error.message})`] }; }
  }
  const restoreOrClean = (file, clean, label = file) => { const original = manifest.backups.find((item) => item.target === file); const untouched = exists(file) && manifest.hashes_after[file] === sha(file); const preserveUserContent = manifest.preserve_on_uninstall?.includes(file); if (untouched && original && !preserveUserContent) { restore(original); restored.push(file); } else if (exists(file)) { try { clean(); } catch { retained.push(label); } } };
  restoreOrClean(paths.configFile, () => managedRemoval(paths.configFile, (text) => { const baseline = baselineText(manifest, paths.configFile); const cleaned = cleanChangedConfig(text, baseline, paths, manifest.models || {}); return manifest.user_preservations?.[paths.configFile] ? restorePreservedConfig(cleaned, baseline, manifest.user_preservations[paths.configFile].content) : cleaned; }));
  restoreOrClean(paths.agentsFile, () => managedRemoval(paths.agentsFile, (text) => removeManagedBlock(removeManagedBlock(text, LEGACY_AGENTS_BEGIN, LEGACY_AGENTS_END), AGENTS_BEGIN, AGENTS_END)));
  restoreOrClean(paths.hooksFile, () => managedRemoval(paths.hooksFile, (text) => removeManagedHook(text, path.join(paths.destination, "src", "hook.mjs"))), `${paths.hooksFile} (managed hook retained; edited after install)`);
  if (manifest.retired_legacy_release_state) {
    const original = manifest.backups.find((item) => item.target === paths.releaseStateFile);
    if (original) { restore(original); restored.push(paths.releaseStateFile); }
  }
  for (const file of paths.wrapperFiles) restoreOrClean(file, () => retained.push(`${file} (wrapper retained; edited after install)`));
  const destinationBackup = manifest.backups.find((item) => item.target === paths.destination); if (destinationBackup && exists(paths.destination) && !options.keepRuntime) { if (manifest.hashes_after[paths.destination] === treeHash(paths.destination)) { if (destinationBackup.existed) restore(destinationBackup); else fs.rmSync(paths.destination, { recursive: true, force: true }); restored.push(paths.destination); } else retained.push(`${paths.destination} (runtime retained; edited after install)`); }
  if (!retained.length) { fs.rmSync(paths.stateFile, { force: true }); removeDurableInstallArtifacts(manifest, paths); } return { status: retained.length ? "partially_uninstalled" : "uninstalled", restored, retained };
}

export function main() { process.stdout.write(`${JSON.stringify(publicInstallResult(install()), null, 2)}\n`); }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { main(); } catch (error) { process.stderr.write(`Installation failed: ${error.message}\n`); process.exitCode = 1; } }
