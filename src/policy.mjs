import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { SOL_MODEL, TIERS, WORKERS } from "./constants.mjs";
import { readOwnerOnlyRegularFile } from "./private-state.mjs";

const TERRA_PATTERNS = [
  /\bsecurity\b|\bvulnerab(?:ility|ilities)\b|\bthreat model\b|\bauth(?:entication|orization)?\b|\bcrypto(?:graphy|graphic)?\b/i,
  /\bprotocol\b|\bwire format\b|\bserialization\b|\bdata migration\b|\bschema migration\b|\bdatabase\b|\bdata loss\b|\bcorruption\b/i,
  /\bconcurren(?:cy|t)\b|\brace condition\b|\bdeadlock\b|\bdistributed\b|\bproduction incident\b/i,
  /\bhard debug\b|\bdifficult debug\b|\bnondeterministic\b|\bflaky\b|\broot cause\b/i,
  /\bindependent (?:review|verification)\b|\bverify independently\b|\bsecurity review\b/i,
  /\bmulti[- ]file\b|\bcross[- ]module\b|\bacross (?:multiple|several) (?:files|modules|packages)\b/i
];

const MUTATION_PATTERN = /\b(?:add|build|change|create|delete|deploy|document|edit|fix|generate|implement|migrate|modify|patch|publish|refactor|remove|rename|rewrite|test|update|write)\b/i;
const READ_ONLY_PATTERN = /\b(?:read[- ]only|look\s*up|lookup|find|locate|inspect|list|search|summarize|explain|identify|show)\b/i;
const BROAD_PATTERN = /\b(?:architecture|end[- ]to[- ]end|broad|deep research|comprehensive|whole codebase|entire repository|many modules)\b/i;

function tierAtLeast(tier, minimumTier) {
  if (!minimumTier) return tier;
  const current = TIERS.indexOf(tier);
  const minimum = TIERS.indexOf(minimumTier);
  if (minimum < 0) throw new Error(`Unknown minimum tier: ${minimumTier}`);
  return TIERS[Math.max(current, minimum)];
}

export function normalizeIntent(intent = "auto") {
  if (!["auto", "read-only", "write"].includes(intent)) {
    throw new Error(`Invalid intent: ${intent}. Expected auto, read-only, or write.`);
  }
  return intent;
}

function normalizeGitAccess(gitAccess) {
  if (gitAccess === undefined) return false;
  if (typeof gitAccess !== "boolean") throw new Error("git_access must be a boolean when provided.");
  return gitAccess;
}

export function routeTask(input) {
  const task = String(input?.task || "").trim();
  if (!task) throw new Error("task must be a non-empty string.");

  const requestedIntent = normalizeIntent(input.intent);
  const gitAccess = normalizeGitAccess(input.git_access);
  if (gitAccess && requestedIntent === "read-only") {
    throw new Error("git_access requires a write-capable route and cannot be combined with read-only intent.");
  }
  const intent = gitAccess ? "write" : requestedIntent;
  const files = Array.isArray(input.files) ? input.files.filter(Boolean) : [];
  const expectedArtifacts = Array.isArray(input.expected_artifacts) ? input.expected_artifacts.filter(Boolean) : [];
  const independentVerification = input.independent_verification === true;
  const combined = [task, ...files, ...expectedArtifacts].join(" ");
  const terraPattern = TERRA_PATTERNS.find((pattern) => pattern.test(combined));
  const multiFile = files.length > 1 || expectedArtifacts.length > 1;
  const mutation = gitAccess || intent === "write" || expectedArtifacts.length > 0 || MUTATION_PATTERN.test(task);
  const narrowReadOnly = intent === "read-only" || (READ_ONLY_PATTERN.test(task) && !mutation);

  let tier;
  let reason;
  if (independentVerification) {
    tier = "terra";
    reason = "Independent verification requires Terra.";
  } else if (multiFile) {
    tier = "terra";
    reason = "Multiple files or artifacts require Terra.";
  } else if (terraPattern) {
    tier = "terra";
    reason = `High-complexity or high-risk signal matched ${terraPattern}.`;
  } else if (mutation) {
    tier = "luna";
    reason = "Ordinary mutation, code, test, or documentation work routes to Luna.";
  } else if (narrowReadOnly && !BROAD_PATTERN.test(task) && task.length <= 1200) {
    tier = "spark";
    reason = "Narrow read-only work routes to Spark.";
  } else {
    tier = "luna";
    reason = "Default non-trivial work routes to Luna.";
  }

  const raisedTier = tierAtLeast(tier, input.minimum_tier);
  if (raisedTier !== tier) reason += ` Raised to the requested minimum tier ${raisedTier}.`;
  if (gitAccess) reason += " Git access requires a write-capable route.";
  const worker = WORKERS[raisedTier];
  return {
    tier: raisedTier,
    model: worker.model,
    effort: worker.effort,
    sandbox: gitAccess ? "danger-full-access" : (intent === "read-only" ? "read-only" : worker.sandbox),
    reason,
    intent,
    git_access: gitAccess,
    escalation_order: TIERS.slice(TIERS.indexOf(raisedTier)),
    sol_worker_allowed: false
  };
}

export function resolveExpectedArtifacts(cwd, expectedArtifacts = []) {
  const root = path.resolve(cwd);
  return expectedArtifacts.map((value) => {
    if (typeof value !== "string" || !value.trim()) throw new Error("Expected artifact paths must be non-empty strings.");
    const absolute = path.resolve(root, value);
    const relative = path.relative(root, absolute);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Expected artifact escapes the working directory: ${value}`);
    }
    return { requested: value, absolute, relative: relative || "." };
  });
}

export function isSolModel(model) {
  return model === SOL_MODEL || model === "gpt-5.6";
}

const READ_ONLY_NATIVE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
  "view_image",
  "web_fetch",
  "web_search"
]);

const NATIVE_FANOUT_PATTERN = /^(?:spawn_agent|spawn_agents_on_csv|followup_task|send_input|send_message|interrupt_agent|list_agents|wait_agent|resume_agent|close_agent|agent|task)$/i;

/*
 * Sol's shell policy is deliberately a grammar, not a blocklist.  Do not add a
 * command to a shared set: each command must validate every argv position it
 * accepts. This parser accepts only literal argv text; it never attempts to
 * emulate shell expansion. Single-quoted text is literal data. Double-quoted
 * text is accepted only when it contains no expansion syntax. Quote metadata
 * lets validators reject quoted flags (for example `rg "--pre"`) while
 * allowing quoted positional data and wrapper paths containing spaces.
 */
const UNSAFE_UNQUOTED_CHARACTER = /[\n\r;&|<>`$()\\*?\[\]{}!#~]/;
const UNSAFE_DOUBLE_QUOTED_CHARACTER = /[\n\r`$\\!]/;
const GREP_FLAGS = new Set(["-F", "-H", "-S", "-c", "-i", "-l", "-n", "-v", "-w"]);
const RG_FLAGS = new Set(["-F", "-H", "-S", "-c", "-i", "-l", "-n", "-w"]);
const GIT_GREP_FLAGS = new Set(["-F", "-i", "-l", "-n", "-w"]);

function shellTokens(command) {
  if (typeof command !== "string" || !command.trim()) return null;
  const tokens = [];
  let value = "";
  let quoteCharacter = null;
  let quoteKind = "none";
  let active = false;
  const finish = () => {
    if (!active) return;
    tokens.push({ value, quoted: quoteKind !== "none", quote: quoteKind });
    value = "";
    quoteKind = "none";
    active = false;
  };

  for (const character of command) {
    if (quoteCharacter) {
      if (character === quoteCharacter) {
        quoteCharacter = null;
      } else {
        if (quoteKind !== "single" && UNSAFE_DOUBLE_QUOTED_CHARACTER.test(character)) return null;
        value += character;
      }
      active = true;
      continue;
    }
    if (character === "'" || character === '"') {
      const nextKind = character === "'" ? "single" : "double";
      quoteKind = quoteKind === "none" || quoteKind === nextKind ? nextKind : "mixed";
      quoteCharacter = character;
      active = true;
    } else if (/\s/.test(character)) {
      finish();
    } else {
      if (UNSAFE_UNQUOTED_CHARACTER.test(character)) return null;
      value += character;
      active = true;
    }
  }
  if (quoteCharacter) return null;
  finish();
  return tokens.length ? tokens : null;
}

function isOption(token) {
  return token.value.startsWith("-");
}

function arePositionals(tokens) {
  return tokens.every((token) => token.value && !isOption(token));
}

function splitAllowedFlags(tokens, allowed) {
  let index = 0;
  while (index < tokens.length && isOption(tokens[index])) {
    if (tokens[index].quoted || !allowed.has(tokens[index].value)) return null;
    index += 1;
  }
  return tokens.slice(index);
}

function validateSearch(tokens, flags) {
  const positionals = splitAllowedFlags(tokens, flags);
  return Boolean(positionals && positionals.length >= 1 && arePositionals(positionals));
}

function validateNumberAndPaths(tokens) {
  if (!tokens.length) return true;
  if (tokens[0].value !== "-n" || tokens[0].quoted || !tokens[1] || !/^\d+$/.test(tokens[1].value)) return false;
  return arePositionals(tokens.slice(2));
}

function validateSimplePaths(tokens) {
  return arePositionals(tokens);
}

function validateReadOnlyCommand(tokens) {
  const [command, ...args] = tokens;
  if (command.quoted) return false;
  switch (command.value) {
    case "cat":
    case "ls":
    case "stat":
    case "wc":
    case "shasum":
      return validateSimplePaths(args);
    case "pwd":
      return args.length === 0;
    case "head":
    case "tail":
      return validateNumberAndPaths(args);
    case "grep":
      return validateSearch(args, GREP_FLAGS);
    case "rg":
      return validateSearch(args, RG_FLAGS);
    default:
      return false;
  }
}

function hasExactValues(tokens, values) {
  return tokens.length === values.length && tokens.every((token, index) => !token.quoted && token.value === values[index]);
}

function isReadOnlyGit(tokens) {
  if (!tokens?.length || tokens[0].quoted || tokens[0].value !== "git") return false;
  const args = tokens.slice(1);
  if (args.length < 3 || !hasExactValues(args.slice(0, 2), ["--no-pager", "--no-optional-locks"])) return false;
  const [subcommand, ...rest] = args.slice(2);
  if (subcommand.quoted) return false;
  switch (subcommand.value) {
    case "diff":
      return hasExactValues(rest, ["--no-ext-diff", "--no-textconv"]);
    case "log":
    case "ls-files":
      return rest.length === 0;
    case "show":
      return hasExactValues(rest, ["--no-ext-diff", "--no-textconv", "HEAD"]);
    case "rev-parse":
      return hasExactValues(rest, ["HEAD"]) || hasExactValues(rest, ["--git-dir"]) || hasExactValues(rest, ["--is-inside-work-tree"]) || hasExactValues(rest, ["--show-toplevel"]);
    case "grep":
      return validateSearch(rest, GIT_GREP_FLAGS);
    default:
      return false;
  }
}

function isReadOnlyCodex(tokens) {
  if (!tokens?.length || tokens[0].quoted || tokens[0].value !== "codex") return false;
  const args = tokens.slice(1);
  return hasExactValues(args, ["--version"])
    || hasExactValues(args, ["doctor"])
    || hasExactValues(args, ["features", "list"])
    || hasExactValues(args, ["mcp", "list"])
    || (args.length === 3 && hasExactValues(args.slice(0, 2), ["mcp", "get"]) && arePositionals(args.slice(2)))
    || hasExactValues(args, ["debug", "models"])
    || hasExactValues(args, ["debug", "prompt-input"]);
}

function consumeFlagValue(argv, index, flags, values, repeatable = new Set()) {
  const flag = argv[index];
  const value = argv[index + 1];
  if (!flag || !value || flag.quoted || !flags.has(flag.value) || isOption(value) || (values[flag.value] && !repeatable.has(flag.value))) return null;
  values[flag.value] ||= [];
  values[flag.value].push(value);
  return index + 2;
}

function consumeBooleanFlag(argv, index, flags, values) {
  const flag = argv[index];
  if (!flag || flag.quoted || !flags.has(flag.value) || values[flag.value]) return null;
  values[flag.value] = true;
  return index + 1;
}

function installationManifestPath() {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return path.resolve(codexHome, "state", "codex-dispatcher.json");
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/*
 * A CLI fallback is intentionally tied to the installer manifest rather than
 * a name or a suffix. The manifest is private, and both it and the wrapper
 * must remain owner-only regular files. This check is repeated for every hook
 * decision so a wrapper replacement, symlink, PATH change, or hash change
 * cannot inherit a prior decision.
 */
function trustedWorkerWrappers() {
  const manifestFile = installationManifestPath();
  let manifest;
  try { manifest = JSON.parse(readOwnerOnlyRegularFile(manifestFile)); }
  catch { return null; }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)
    || !Number.isInteger(manifest.version) || manifest.version < 3
    || !manifest.paths || typeof manifest.paths !== "object"
    || path.resolve(String(manifest.paths.stateFile || "")) !== manifestFile
    || !Array.isArray(manifest.paths.wrapperFiles)
    || !manifest.hashes_after || typeof manifest.hashes_after !== "object" || Array.isArray(manifest.hashes_after)) return null;

  const wrappers = [];
  for (const rawWrapper of manifest.paths.wrapperFiles) {
    if (typeof rawWrapper !== "string" || !path.isAbsolute(rawWrapper) || path.resolve(rawWrapper) !== rawWrapper) return null;
    const expected = manifest.hashes_after[rawWrapper];
    if (typeof expected !== "string" || !/^[a-f0-9]{64}$/i.test(expected)) return null;
    try {
      // Wrapper files are installed executable (normally 0755), while only
      // their manifest is private. Reject substituted symlinks and a wrapper
      // no longer owned by this user before comparing the installer hash.
      const stat = fs.lstatSync(rawWrapper);
      if (!stat.isFile() || stat.isSymbolicLink() || (typeof process.getuid === "function" && stat.uid !== process.getuid())
        || (process.platform !== "win32" && (stat.mode & 0o100) === 0)) return null;
      if (sha256File(rawWrapper) !== expected) return null;
    } catch { return null; }
    wrappers.push(rawWrapper);
  }
  return wrappers.length ? wrappers : null;
}

function resolveBareWorkerFromPath() {
  for (const entry of String(process.env.PATH || "").split(path.delimiter)) {
    const candidate = path.resolve(entry || process.cwd(), "codex-worker");
    try {
      // Deliberately stop at the first PATH entry that names a file. A fake
      // earlier wrapper must be rejected, not skipped in favor of a later one.
      if (fs.lstatSync(candidate).isFile() || fs.lstatSync(candidate).isSymbolicLink()) return candidate;
    } catch { /* continue PATH lookup */ }
  }
  return null;
}

function isDispatcherExecutable(token) {
  if (!token || (token.quoted && !["single", "double"].includes(token.quote))) return false;
  const wrappers = trustedWorkerWrappers();
  if (!wrappers) return false;
  if (token.value === "codex-worker") {
    const resolved = resolveBareWorkerFromPath();
    return Boolean(resolved && wrappers.includes(resolved));
  }
  return path.isAbsolute(token.value) && wrappers.includes(token.value);
}

function isDispatcherCli(tokens) {
  if (!tokens?.length || !isDispatcherExecutable(tokens[0])) return false;
  const args = tokens.slice(1);
  if (hasExactValues(args, ["--version"]) || hasExactValues(args, ["doctor"])) return true;
  if (args[0]?.value === "audit" && !args[0].quoted) {
    return args.length === 1 || (args.length === 3 && !args[1].quoted && args[1].value === "--last" && /^\d+$/.test(args[2].value));
  }

  const command = args[0];
  if (!command || command.quoted || !["route", "dispatch"].includes(command.value)) return false;
  const values = {};
  const allowed = command.value === "route"
    ? new Set(["--task", "--intent", "--file", "--expect", "--minimum-tier"])
    : new Set(["--task", "--cwd", "--intent", "--file", "--expect", "--minimum-tier", "--timeout"]);
  const booleanFlags = command.value === "dispatch" ? new Set(["--verify", "--independent-verification", "--git"]) : new Set(["--git"]);
  const repeatable = new Set(["--file", "--expect"]);
  for (let index = 1; index < args.length;) {
    const booleanNext = consumeBooleanFlag(args, index, booleanFlags, values);
    if (booleanNext !== null) {
      index = booleanNext;
      continue;
    }
    const next = consumeFlagValue(args, index, allowed, values, repeatable);
    if (next === null) return false;
    index = next;
  }
  const one = (flag) => values[flag]?.length === 1;
  const validIntent = !values["--intent"] || ["auto", "read-only", "write"].includes(values["--intent"][0].value);
  const validMinimum = !values["--minimum-tier"] || ["spark", "luna", "terra"].includes(values["--minimum-tier"][0].value);
  const compatibleGitAccess = !values["--git"] || values["--intent"]?.[0].value !== "read-only";
  if (command.value === "route") return one("--task") && validIntent && validMinimum && compatibleGitAccess;
  if (command.value === "dispatch") return one("--task") && one("--cwd") && validIntent && validMinimum && compatibleGitAccess && (!values["--timeout"] || /^\d+$/.test(values["--timeout"][0].value));
  return one("--task") && one("--cwd") && (!values["--intent"] || ["auto", "read-only", "write"].includes(values["--intent"][0].value)) && (!values["--minimum-tier"] || ["spark", "luna", "terra"].includes(values["--minimum-tier"][0].value)) && (!values["--timeout"] || /^\d+$/.test(values["--timeout"][0].value));
}

export function evaluateSolTool(input) {
  const toolName = String(input?.tool_name || "");
  if (NATIVE_FANOUT_PATTERN.test(toolName)) {
    return { allowed: false, reason: "Sol native fan-out is disabled; use the worker dispatcher." };
  }
  if (toolName === "apply_patch" || /^(?:Edit|Write)$/i.test(toolName)) {
    return { allowed: false, reason: "Sol is orchestrator-only and cannot edit files. Dispatch a Luna or Terra worker." };
  }
  if (toolName.startsWith("mcp__")) {
    if (/^mcp__codex_worker_dispatcher__(?:route_task|dispatch_worker|audit_tail)$/.test(toolName)) {
      return { allowed: true, reason: "Dispatcher MCP call is allowed." };
    }
    if (/^mcp__(?:openaiDeveloperDocs|context7|linkup|ctxe)__/.test(toolName)) {
      return { allowed: true, reason: "Known read-only research MCP call is allowed." };
    }
    return { allowed: false, reason: `Sol cannot call potentially mutating MCP tool ${toolName}; route work through the dispatcher.` };
  }
  if (toolName !== "Bash") {
    if (READ_ONLY_NATIVE_TOOLS.has(toolName)) return { allowed: true, reason: "Known read-only native tool is allowed." };
    return { allowed: false, reason: `Sol cannot call unclassified native tool ${toolName || "<missing>"}; use a known read-only tool or the dispatcher.` };
  }

  const tokens = shellTokens(input?.tool_input?.command);
  if (!tokens) return { allowed: false, reason: "Sol shell commands must be one simple, non-chained read-only command." };
  if (isDispatcherCli(tokens)) return { allowed: true, reason: "Dispatcher CLI fallback is allowed." };
  if (validateReadOnlyCommand(tokens)) {
    return { allowed: true, reason: "Simple read-only shell command is allowed." };
  }
  if (isReadOnlyGit(tokens) || isReadOnlyCodex(tokens)) return { allowed: true, reason: "Read-only inspection command is allowed." };
  return { allowed: false, reason: "Sol cannot run builds, tests, mutations, deployments, interpreters, or unclassified shell commands; use the dispatcher." };
}
