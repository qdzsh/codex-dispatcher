import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.mjs";

test("MCP server lists decision-ready tools and routes without Sol", async () => {
  const server = createServer();
  const client = new Client({ name: "dispatcher-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name).sort(), ["audit_tail", "dispatch_worker", "route_task"]);
    assert.equal(listed.tools.some((tool) => /(?:prepare|execute)_git_operation/.test(tool.name)), false);
    const dispatch = listed.tools.find((tool) => tool.name === "dispatch_worker");
    assert.equal(dispatch.annotations.destructiveHint, true);
    assert.equal(dispatch.annotations.openWorldHint, true);
    assert.match(dispatch.description, /irreversible local and remote Git or GitHub operations with user credentials and no confirmation/i);
    const routed = await client.callTool({ name: "route_task", arguments: { task: "Read-only lookup: find one symbol.", intent: "read-only" } });
    assert.equal(routed.structuredContent.model, "gpt-5.3-codex-spark");
    assert.equal(routed.structuredContent.sol_worker_allowed, false);
    const gitRoute = await client.callTool({ name: "route_task", arguments: { task: "Commit a prepared change.", git_access: true } });
    assert.equal(gitRoute.structuredContent.git_access, true);
    assert.equal(gitRoute.structuredContent.sandbox, "danger-full-access");
    const rejected = await client.callTool({ name: "route_task", arguments: { task: "Inspect a commit.", intent: "read-only", git_access: true } });
    assert.equal(rejected.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP audit_tail strictly sanitizes poisoned legacy records", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "dispatcher-mcp-audit-"));
  const auditFile = path.join(directory, "audit.jsonl");
  const credential = "ghp_MCP_LEGACY_CREDENTIAL_123456";
  const taskText = "publish a private customer export";
  const artifactPath = "/private/keys/credential.pem";
  fs.writeFileSync(auditFile, [
    JSON.stringify({
      timestamp: "2026-07-14T00:00:00.000Z", event: "attempt_finished", run_id: "legacy-run", tier: "terra", model: "gpt-5.6-terra", status: "failed", elapsed_ms: 12,
      task: taskText, credential, artifact_paths: [artifactPath], nested: { credential, task: taskText }, error: `failed with ${credential}`
    }),
    `not-json credential=${credential}`
  ].join("\n"));
  const previousAuditFile = process.env.CODEX_WORKER_AUDIT_LOG;
  process.env.CODEX_WORKER_AUDIT_LOG = auditFile;
  const server = createServer();
  const client = new Client({ name: "dispatcher-audit-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  try {
    const result = await client.callTool({ name: "audit_tail", arguments: { limit: 2 } });
    const output = JSON.stringify(result.structuredContent);
    assert.doesNotMatch(output, new RegExp(`${credential}|${taskText}|${artifactPath}`));
    assert.deepEqual(result.structuredContent.records[1], { event: "invalid_audit_line" });
    const record = result.structuredContent.records[0];
    assert.equal(record.timestamp, "2026-07-14T00:00:00.000Z");
    assert.equal(record.run_id, "legacy-run");
    assert.equal(record.nested, undefined);
    assert.equal(record.artifact_paths, undefined);
    assert.deepEqual(record.artifact_path_sha256, [crypto.createHash("sha256").update(artifactPath).digest("hex")]);
    assert.equal(record.error_code, "worker_failed");
    assert.match(record.error_sha256, /^[a-f0-9]{64}$/);
  } finally {
    if (previousAuditFile === undefined) delete process.env.CODEX_WORKER_AUDIT_LOG;
    else process.env.CODEX_WORKER_AUDIT_LOG = previousAuditFile;
    await client.close();
    await server.close();
  }
});
