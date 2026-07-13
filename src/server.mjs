#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { readAuditTail } from "./audit.mjs";
import { dispatchWorker } from "./runner.mjs";
import { routeTask } from "./policy.mjs";

const Tier = z.enum(["spark", "luna", "terra"]);
const Intent = z.enum(["auto", "read-only", "write"]);
const commonShape = {
  task: z.string().min(1).describe("A complete, bounded task for one leaf worker."),
  intent: Intent.optional().describe("Use read-only when no local mutation is allowed; write when artifacts or code changes are required."),
  files: z.array(z.string()).optional().describe("Known affected files. More than one forces Terra."),
  expected_artifacts: z.array(z.string()).optional().describe("Expected paths relative to cwd. Declaring artifacts implies write intent and enables existence checks."),
  git_access: z.boolean().optional().describe("Enable repository Git and GitHub CLI execution for this bounded write-capable task. A dispatched Git task uses danger-full-access; it cannot be combined with read-only intent."),
  independent_verification: z.boolean().optional().describe("Force Terra for a verification pass independent of the implementation worker."),
  minimum_tier: Tier.optional().describe("Only raises the deterministic route; it can never lower it.")
};

function toolResult(value, isError = false) {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    ...(isError ? { isError: true } : {})
  };
}

export function createServer() {
  const server = new McpServer({ name: "codex-dispatcher", version: "2.0.0" });

  server.registerTool("route_task", {
    title: "Route a Codex worker task",
    description: "Choose the cheapest safe worker without executing it. Use git_access only for a bounded Git or GitHub task; it requires a write-capable route and plans danger-full-access for that task. Spark is limited to narrow read-only work, Luna handles ordinary changes, and Terra handles high-risk or complex work. This tool never selects Sol.",
    inputSchema: commonShape,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async (input) => {
    try { return toolResult(routeTask(input)); }
    catch (error) { return toolResult({ status: "error", error: error.message, action: "Provide one bounded task and valid routing hints." }, true); }
  });

  server.registerTool("dispatch_worker", {
    title: "Run a pinned Codex leaf worker",
    description: "Route and execute one bounded task with an explicitly pinned Codex model. It disables native multi-agent tools, records model provenance, validates declared artifacts, and automatically escalates only Spark to Luna to Terra. Set git_access only for a bounded repository Git or GitHub task: it requires a write-capable route and uses danger-full-access for that dispatched task only. Such workers may perform irreversible local and remote Git or GitHub operations with user credentials and no confirmation, authorization fields, grants, allowlists, or acknowledgements. Ordinary write tasks remain workspace-write. Sol is never launched as a worker.",
    inputSchema: {
      ...commonShape,
      cwd: z.string().min(1).describe("Absolute working directory for the leaf worker."),
      require_verification: z.boolean().optional().describe("Require at least one fully passing verification entry before accepting completion."),
      timeout_seconds: z.number().int().min(30).max(7200).optional().describe("Per-tier timeout in seconds; defaults to 1800.")
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }, async (input) => {
    try {
      const result = await dispatchWorker(input);
      return toolResult(result, result.status !== "completed");
    } catch (error) {
      return toolResult({ status: "error", error: error.message, action: "Correct the task, cwd, or artifact paths and retry." }, true);
    }
  });

  server.registerTool("audit_tail", {
    title: "Read worker dispatcher provenance",
    description: "Read recent routing, pinned-model, escalation, and completion records from the append-only local audit log. Use it to verify which model actually received a task and whether escalation occurred. This tool does not execute workers or mutate project files.",
    inputSchema: { limit: z.number().int().min(1).max(200).optional().describe("Number of recent records to return; defaults to 20.") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
  }, async ({ limit }) => toolResult({ records: readAuditTail(limit || 20) }));

  return server;
}

export async function main() {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`codex-dispatcher failed: ${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}
