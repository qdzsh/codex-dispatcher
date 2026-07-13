import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const TIERS = ["spark", "luna", "terra"];

const defaultModels = Object.freeze({ sol: "gpt-5.6-sol", spark: "gpt-5.3-codex-spark", luna: "gpt-5.6-luna", terra: "gpt-5.6-terra" });
function installedModels() {
  try {
    const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "models.json");
    const value = JSON.parse(fs.readFileSync(file, "utf8"));
    return value && typeof value === "object" ? value : {};
  } catch { return {}; }
}
const modelSettings = { ...defaultModels, ...installedModels() };

export const WORKERS = Object.freeze({
  spark: Object.freeze({
    tier: "spark",
    model: modelSettings.spark,
    effort: "low",
    sandbox: "read-only",
    purpose: "narrow read-only lookup"
  }),
  luna: Object.freeze({
    tier: "luna",
    model: modelSettings.luna,
    effort: "medium",
    sandbox: "workspace-write",
    purpose: "ordinary code, tests, and documentation"
  }),
  terra: Object.freeze({
    tier: "terra",
    model: modelSettings.terra,
    effort: "high",
    sandbox: "workspace-write",
    purpose: "multi-file, hard debugging, security, protocol/data, and independent verification"
  })
});

export const SOL_MODEL = modelSettings.sol;
export const SOL_EFFORT = "ultra";

export const DEFAULT_HOME = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "dispatcher");
export const DEFAULT_AUDIT_LOG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "logs", "dispatcher.jsonl");
export const DEFAULT_HOOK_AUDIT_LOG = path.join(process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), "logs", "dispatcher-enforcement.jsonl");

export const WORKER_DEVELOPER_INSTRUCTIONS = [
  "You are a leaf Codex worker launched by the global worker dispatcher.",
  "Complete only the assigned task in the supplied working directory.",
  "Never spawn, delegate to, resume, or message another agent. Never call the worker dispatcher.",
  "Use Git commands and GitHub CLI repository operations only when the assigned task explicitly enables the Git execution capability; then use the user's existing credentials and require no grant, allowlist, release plan, acknowledgement digest, or second confirmation.",
  "Do not deploy, publish packages, or broaden scope.",
  "Respect the selected sandbox. Spark must remain strictly read-only.",
  "If the task cannot be completed safely at this tier, return needs_escalation with a precise reason.",
  "Your final response must be the JSON object required by the provided output schema."
].join("\n");

export const GLOBAL_DEVELOPER_POLICY = `Token-efficient global orchestration policy (mandatory):
- The active default model is ${SOL_MODEL} at ${SOL_EFFORT}. Sol is an orchestrator only: understand requests, plan, assess risk, select a worker, review worker evidence, and answer the user.
- Sol must not edit or create files, run build/test/mutation/deploy commands, run Git or GitHub mutations, or use native multi-agent fan-out. Sol may perform read-only inspection and call mcp__codex_worker_dispatcher__route_task, mcp__codex_worker_dispatcher__dispatch_worker, or mcp__codex_worker_dispatcher__audit_tail. If MCP is unavailable, use only the installer-manifest-verified codex-worker CLI fallback.
- Route the cheapest capable worker: Spark (${WORKERS.spark.model}) only for narrow read-only lookup; Luna (${WORKERS.luna.model}) for ordinary code, tests, and documentation; Terra (${WORKERS.terra.model}) for multi-file work, difficult debugging, security, protocol/data work, and independent verification.
- Escalation is one-way only: Spark -> Luna -> Terra. Never use Sol as a worker.
- Every worker must be launched through the dispatcher, with an explicit pinned --model and native multi-agent disabled. Review artifacts and verification before reporting completion.
- A non-Sol model launched by the dispatcher is a leaf worker. It must not delegate or call the dispatcher recursively. Only a task with the explicit Git execution capability may use Git and GitHub CLI repository operations directly within its bounded scope and with the user's existing credentials; workers must not deploy or publish packages.`;

export function agentsPolicyBlock(models = {}) {
  const sol = models.sol || SOL_MODEL;
  const spark = models.spark || WORKERS.spark.model;
  const luna = models.luna || WORKERS.luna.model;
  const terra = models.terra || WORKERS.terra.model;
  return `<!-- BEGIN CODEX DISPATCHER POLICY -->
## Token-Efficient Model Orchestration

- ${sol} at ultra is the orchestrator only. It may understand, plan, route, assess risk, review evidence, and produce the final user response.
- The orchestrator must not edit files, create artifacts, run builds or tests, mutate local or external state, deploy, run Git or GitHub mutations, or use native agent fan-out. It may inspect read-only state and call the global worker dispatcher.
- Use the cheapest capable worker: Spark (${spark}) for narrow read-only lookup; Luna (${luna}) for ordinary code, tests, and documentation; Terra (${terra}) for multi-file work, difficult debugging, security, protocol/data work, and independent verification.
- Escalate in one direction only: Spark -> Luna -> Terra. The orchestrator is never a worker.
- Call \`mcp__codex_worker_dispatcher__dispatch_worker\` for work. Use \`route_task\` when routing is ambiguous and \`audit_tail\` to inspect provenance. If MCP is unavailable, use only the installer-manifest-verified \`codex-worker\` CLI fallback.
- Dispatcher-launched workers are leaf workers. They must not spawn or delegate to other agents, call the dispatcher recursively, deploy, publish packages, or broaden scope. A task with the explicit Git execution capability may use Git and GitHub CLI repository operations directly within its bounded scope using the user's existing credentials.
- Review worker artifacts, model provenance, and verification evidence before claiming completion.
<!-- END CODEX DISPATCHER POLICY -->`;
}

export const AGENTS_POLICY_BLOCK = agentsPolicyBlock();
