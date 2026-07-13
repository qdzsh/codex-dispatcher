#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { appendAudit } from "./audit.mjs";
import { DEFAULT_HOOK_AUDIT_LOG } from "./constants.mjs";
import { evaluateSolTool, isSolModel } from "./policy.mjs";

function deny(reason) {
  process.stdout.write(`${JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  })}\n`);
}

function commandPreview(input) {
  const value = input?.tool_input?.command;
  const text = Array.isArray(value) ? value.join(" ") : typeof value === "string" ? value : JSON.stringify(input?.tool_input || {});
  return String(text || "").replace(/\s+/g, " ").slice(0, 180);
}

export function handleHook(input, auditFile = process.env.CODEX_WORKER_HOOK_AUDIT_LOG || DEFAULT_HOOK_AUDIT_LOG) {
  if (input?.hook_event_name !== "PreToolUse" || !isSolModel(input?.model)) return { output: null, decision: null };
  const decision = evaluateSolTool(input);
  const preview = commandPreview(input);
  appendAudit({
    event: decision.allowed ? "sol_tool_allowed" : "sol_tool_denied",
    session_id: input.session_id || null,
    turn_id: input.turn_id || null,
    model: input.model,
    tool_name: input.tool_name,
    input_sha256: crypto.createHash("sha256").update(preview).digest("hex"),
    input_preview: preview,
    reason: decision.reason
  }, auditFile);
  return { output: decision.allowed ? null : decision.reason, decision };
}

export function main() {
  let input;
  try { input = JSON.parse(fs.readFileSync(0, "utf8")); }
  catch (error) {
    process.stderr.write(`Invalid PreToolUse input: ${error.message}\n`);
    process.exitCode = 1;
    return;
  }
  const result = handleHook(input);
  if (result.output) deny(result.output);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) main();
