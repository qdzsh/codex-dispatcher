import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { appendAudit, artifactPathDigest, auditPath, taskDigest } from "./audit.mjs";
import { TIERS, WORKERS, WORKER_DEVELOPER_INSTRUCTIONS } from "./constants.mjs";
import { resolveExpectedArtifacts, routeTask } from "./policy.mjs";

const moduleRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const defaultSchema = path.join(moduleRoot, "schemas", "worker-result.schema.json");
const STANDARD_SANDBOXES = new Set(["read-only", "workspace-write"]);
const GIT_SANDBOX = "danger-full-access";

function compactTaskPreview(task) {
  return String(task).replace(/\s+/g, " ").trim().slice(0, 200);
}

export function buildWorkerArgs({ model, effort, sandbox, cwd, outputFile, schemaFile = defaultSchema, gitAccess = false }) {
  if (typeof gitAccess !== "boolean" || (gitAccess && sandbox !== GIT_SANDBOX) || (!gitAccess && !STANDARD_SANDBOXES.has(sandbox))) {
    throw new Error("Invalid worker sandbox for the requested capability.");
  }
  return [
    "-m", model,
    "-c", `model_reasoning_effort=${JSON.stringify(effort)}`,
    "-c", "features.multi_agent=false",
    "-c", "mcp_servers.codex_worker_dispatcher.enabled=false",
    "-c", `developer_instructions=${JSON.stringify(WORKER_DEVELOPER_INSTRUCTIONS)}`,
    "-a", "never",
    "-s", sandbox,
    "-C", cwd,
    "exec",
    "--skip-git-repo-check",
    "--json",
    "--output-schema", schemaFile,
    "-o", outputFile,
    "-"
  ];
}

function workerPrompt({ task, worker, expectedArtifacts, requireVerification, previousFailure }) {
  const expected = expectedArtifacts.length
    ? expectedArtifacts.map((artifact) => `- ${artifact.relative}`).join("\n")
    : "- None declared.";
  const previous = previousFailure ? `\nPrevious lower-tier attempt failed:\n${previousFailure}\n` : "";
  const gitCapability = worker.git_access
    ? "This task has the Git execution capability and its danger-full-access sandbox. You may use Git commands and GitHub CLI repository operations directly when they are within this task, using the user's existing credentials. This includes git commit, git push and force-push, tags, branch deletion, and gh repository operations. No authorization fields, grant, owner allowlist, release plan, acknowledgement digest, or second confirmation is required."
    : "Git and GitHub CLI operations are not granted execution capability for this task; respect the selected sandbox.";
  return `Execute this bounded worker task:\n\n${task}\n\nAssigned worker:\n- tier: ${worker.tier}\n- pinned model: ${worker.model}\n- reasoning effort: ${worker.effort}\n- sandbox: ${worker.sandbox}\n- git execution capability: ${worker.git_access ? "enabled" : "disabled"}\n\nExpected artifacts relative to the working directory:\n${expected}\n\nRequirements:\n- Do not spawn or delegate to any agent and do not call the dispatcher.\n- ${gitCapability}\n- Do not deploy or publish packages.\n- Report worker_model exactly as ${worker.model}.\n- Set status to needs_escalation when this tier is insufficient.\n- ${requireVerification ? "Run relevant verification and return only passed evidence for completion." : "Include any verification performed; it may be empty when not applicable."}\n- Return only the schema-compliant JSON result.${previous}`;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env || process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const maxBytes = options.maxBytes || 16 * 1024 * 1024;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    child.stdout.on("data", (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= maxBytes) stdout.push(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= maxBytes) stderr.push(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
    }, options.timeoutMs || 1_800_000);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, error, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), elapsed_ms: Date.now() - started });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, timedOut, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8"), elapsed_ms: Date.now() - started });
    });
    child.stdin.end(options.input || "");
  });
}

function parseWorkerResult(outputFile) {
  if (!fs.existsSync(outputFile)) throw new Error("Worker did not produce its structured output file.");
  let value;
  try { value = JSON.parse(fs.readFileSync(outputFile, "utf8")); }
  catch (error) { throw new Error(`Worker output is not valid JSON: ${error.message}`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Worker output must be a JSON object.");
  return value;
}

function completionError({ processResult, result, worker, expectedArtifacts, requireVerification }) {
  if (processResult.error) return processResult.error.message;
  if (processResult.timedOut) return "Worker timed out.";
  if (processResult.code !== 0) return processResult.stderr.trim().slice(-1200) || `codex exited with ${processResult.code}.`;
  if (!result) return "Worker result was unavailable.";
  if (result.worker_model !== worker.model) return `Worker reported model ${result.worker_model || "missing"}, expected ${worker.model}.`;
  if (result.status !== "completed") return result.escalation_reason || `Worker returned ${result.status}.`;
  const missing = expectedArtifacts.filter((artifact) => !fs.existsSync(artifact.absolute));
  if (missing.length) return `Missing expected artifact(s): ${missing.map((artifact) => artifact.relative).join(", ")}.`;
  if (requireVerification && (!Array.isArray(result.verification) || result.verification.length === 0 || result.verification.some((item) => item.status !== "passed"))) {
    return "Required verification was missing or not fully passing.";
  }
  return null;
}

export async function dispatchWorker(input, dependencies = {}) {
  const task = String(input?.task || "").trim();
  if (!task) throw new Error("task must be a non-empty string.");
  const cwd = path.resolve(input.cwd || process.cwd());
  if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`Working directory does not exist: ${cwd}`);
  const route = routeTask(input);
  const expectedArtifacts = resolveExpectedArtifacts(cwd, input.expected_artifacts || []);
  const requireVerification = input.require_verification === true || input.independent_verification === true;
  const timeoutMs = Math.max(30_000, Math.min(Number(input.timeout_seconds || 1_800) * 1_000, 7_200_000));
  const runId = crypto.randomUUID();
  const logFile = dependencies.auditFile || auditPath();
  const execute = dependencies.processRunner || runProcess;
  const codexBin = dependencies.codexBin || process.env.CODEX_WORKER_CODEX_BIN || "codex";
  const tierSequence = TIERS.slice(TIERS.indexOf(route.tier));
  const attempts = [];
  let previousFailure = null;

  appendAudit({
    event: "route",
    run_id: runId,
    task_sha256: taskDigest(task),
    task_preview: compactTaskPreview(task),
    cwd,
    selected_tier: route.tier,
    selected_model: route.model,
    reason: route.reason,
    sandbox: route.sandbox,
    git_access: route.git_access,
    escalation_order: tierSequence
  }, logFile);

  for (let index = 0; index < tierSequence.length; index += 1) {
    const tier = tierSequence[index];
    const baseWorker = WORKERS[tier];
    const worker = {
      ...baseWorker,
      sandbox: route.git_access ? GIT_SANDBOX : (route.intent === "read-only" ? "read-only" : baseWorker.sandbox),
      git_access: route.git_access
    };
    const temporary = fs.mkdtempSync(path.join(os.tmpdir(), `codex-worker-${runId.slice(0, 8)}-`));
    const outputFile = path.join(temporary, "result.json");
    const args = buildWorkerArgs({ model: worker.model, effort: worker.effort, sandbox: worker.sandbox, cwd, outputFile, gitAccess: worker.git_access });
    const safeCommand = [
      codexBin,
      "--model", worker.model,
      "--config", `model_reasoning_effort=${JSON.stringify(worker.effort)}`,
      "--config", "features.multi_agent=false",
      "--config", "mcp_servers.codex_worker_dispatcher.enabled=false",
      "--sandbox", worker.sandbox,
      "exec"
    ];
    appendAudit({
      event: "attempt_started",
      run_id: runId,
      attempt: index + 1,
      tier,
      model: worker.model,
      effort: worker.effort,
      sandbox: worker.sandbox,
      git_access: worker.git_access,
      pinned_command: safeCommand,
      native_multi_agent: false,
      recursive_dispatcher: false
    }, logFile);

    const prompt = workerPrompt({ task, worker, expectedArtifacts, requireVerification, previousFailure });
    const processResult = await execute(codexBin, args, { cwd, input: prompt, timeoutMs });
    let result = null;
    let parseError = null;
    try { result = parseWorkerResult(outputFile); }
    catch (error) { parseError = error.message; }
    const error = parseError || completionError({ processResult, result, worker, expectedArtifacts, requireVerification });
    const attempt = {
      tier,
      model: worker.model,
      effort: worker.effort,
      sandbox: worker.sandbox,
      git_access: worker.git_access,
      exit_code: processResult.code,
      elapsed_ms: processResult.elapsed_ms,
      status: error ? "failed" : "completed",
      error: error || null
    };
    attempts.push(attempt);
    appendAudit({ event: "attempt_finished", run_id: runId, attempt: index + 1, ...attempt }, logFile);
    try { fs.rmSync(temporary, { recursive: true, force: true }); } catch {}

    if (!error) {
      appendAudit({
        event: "run_completed",
        run_id: runId,
        final_tier: tier,
        final_model: worker.model,
        artifact_path_sha256: expectedArtifacts.map((artifact) => artifactPathDigest(artifact.relative)),
        result_summary: String(result.summary || "").slice(0, 400)
      }, logFile);
      return { status: "completed", run_id: runId, route, final_tier: tier, final_model: worker.model, attempts, result, audit_log: logFile };
    }

    previousFailure = error;
    if (index < tierSequence.length - 1) {
      appendAudit({
        event: "escalation",
        run_id: runId,
        from_tier: tier,
        from_model: worker.model,
        to_tier: tierSequence[index + 1],
        to_model: WORKERS[tierSequence[index + 1]].model,
        reason: error
      }, logFile);
    }
  }

  appendAudit({ event: "run_failed", run_id: runId, attempts }, logFile);
  return { status: "failed", run_id: runId, route, attempts, error: previousFailure || "All worker tiers failed.", audit_log: logFile };
}
