import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dispatchWorker, buildWorkerArgs } from "../src/runner.mjs";

function outputPath(args) {
  return args[args.indexOf("-o") + 1];
}

function modelFrom(args) {
  return args[args.indexOf("-m") + 1];
}

function successfulResult(model, artifacts = []) {
  return {
    status: "completed",
    worker_model: model,
    summary: "Completed by test worker.",
    artifacts: artifacts.map((artifact) => ({ path: artifact, description: "Test artifact" })),
    verification: [{ command: "test", status: "passed", evidence: "ok" }],
    escalation_reason: null
  };
}

test("worker argv pins model and disables native multi-agent", () => {
  const args = buildWorkerArgs({ model: "gpt-5.6-luna", effort: "medium", sandbox: "workspace-write", cwd: "/tmp", outputFile: "/tmp/result.json" });
  assert.equal(modelFrom(args), "gpt-5.6-luna");
  assert.ok(args.includes("features.multi_agent=false"));
  assert.ok(args.includes("mcp_servers.codex_worker_dispatcher.enabled=false"));
  assert.equal(args.includes("gpt-5.6-sol"), false);
  assert.throws(() => buildWorkerArgs({ model: "gpt-5.6-luna", effort: "medium", sandbox: "danger-full-access", cwd: "/tmp", outputFile: "/tmp/result.json" }), /Invalid worker sandbox/i);
  assert.throws(() => buildWorkerArgs({ model: "gpt-5.6-luna", effort: "medium", sandbox: "workspace-write", cwd: "/tmp", outputFile: "/tmp/result.json", gitAccess: true }), /Invalid worker sandbox/i);
});

test("worker prompts permit direct Git and gh repository operations without release authorization", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-git-permission-"));
  let prompt = "";
  const result = await dispatchWorker(
    { task: "Run git commit, git push --force, create a tag, delete a branch, and gh repo operations.", cwd: directory, intent: "write", git_access: true },
    {
      processRunner: async (_command, args, options) => {
        prompt = options.input;
        fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(modelFrom(args))));
        return { code: 0, stderr: "", stdout: "", elapsed_ms: 1 };
      },
      auditFile: path.join(directory, "audit.jsonl"),
      codexBin: "fake-codex"
    }
  );
  assert.equal(result.status, "completed");
  assert.equal(result.route.sandbox, "danger-full-access");
  assert.equal(result.attempts[0].sandbox, "danger-full-access");
  for (const phrase of ["Git commands", "GitHub CLI repository operations", "No authorization fields", "force-push", "tags", "branch deletion"]) assert.match(prompt, new RegExp(phrase, "i"));
  assert.doesNotMatch(prompt, /Do not commit, push/i);
});

test("ordinary write tasks retain workspace-write while Git tasks receive danger-full-access", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-worker-sandbox-test-"));
  const seen = [];
  const result = await dispatchWorker(
    { task: "Implement one ordinary helper.", cwd: directory, intent: "write" },
    {
      processRunner: async (_command, args) => {
        seen.push(args[args.indexOf("-s") + 1]);
        fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(modelFrom(args))));
        return { code: 0, stderr: "", stdout: "", elapsed_ms: 1 };
      },
      auditFile: path.join(directory, "audit.jsonl"),
      codexBin: "fake-codex"
    }
  );
  assert.equal(result.status, "completed");
  assert.deepEqual(seen, ["workspace-write"]);
});

test("automatic escalation proceeds Spark to Luna and records exact models", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-runner-test-"));
  const audit = path.join(directory, "audit.jsonl");
  const models = [];
  const processRunner = async (_command, args) => {
    const model = modelFrom(args);
    models.push(model);
    if (model === "gpt-5.3-codex-spark") return { code: 1, stderr: "Spark requested escalation", stdout: "", elapsed_ms: 1 };
    fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(model)));
    return { code: 0, stderr: "", stdout: "", elapsed_ms: 2 };
  };
  const result = await dispatchWorker({ task: "Read-only lookup: locate one symbol.", cwd: directory, intent: "read-only" }, { processRunner, auditFile: audit, codexBin: "fake-codex" });
  assert.equal(result.status, "completed");
  assert.deepEqual(models, ["gpt-5.3-codex-spark", "gpt-5.6-luna"]);
  assert.equal(models.includes("gpt-5.6-sol"), false);
  const records = fs.readFileSync(audit, "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(records.filter((record) => record.event === "escalation").length, 1);
  assert.equal(records.find((record) => record.event === "attempt_started" && record.model === "gpt-5.6-luna").native_multi_agent, false);
});

test("ordinary artifact work starts at Luna and validates the artifact", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-artifact-test-"));
  const audit = path.join(directory, "audit.jsonl");
  const models = [];
  const processRunner = async (_command, args) => {
    const model = modelFrom(args);
    models.push(model);
    fs.writeFileSync(path.join(directory, "proof.txt"), "created\n");
    fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(model, ["proof.txt"])));
    return { code: 0, stderr: "", stdout: "", elapsed_ms: 2 };
  };
  const result = await dispatchWorker({ task: "Create proof.txt with one line.", cwd: directory, expected_artifacts: ["proof.txt"], require_verification: true }, { processRunner, auditFile: audit, codexBin: "fake-codex" });
  assert.equal(result.status, "completed");
  assert.deepEqual(models, ["gpt-5.6-luna"]);
  assert.equal(fs.readFileSync(path.join(directory, "proof.txt"), "utf8"), "created\n");
});

test("Luna failure escalates to Terra but never to Sol", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-terra-test-"));
  const audit = path.join(directory, "audit.jsonl");
  const models = [];
  const processRunner = async (_command, args) => {
    const model = modelFrom(args);
    models.push(model);
    if (model === "gpt-5.6-luna") return { code: 2, stderr: "verification failed", stdout: "", elapsed_ms: 1 };
    fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(model)));
    return { code: 0, stderr: "", stdout: "", elapsed_ms: 2 };
  };
  const result = await dispatchWorker({ task: "Implement one ordinary helper.", cwd: directory, intent: "write" }, { processRunner, auditFile: audit, codexBin: "fake-codex" });
  assert.equal(result.status, "completed");
  assert.deepEqual(models, ["gpt-5.6-luna", "gpt-5.6-terra"]);
});

test("successful route records omit errors while failed attempts retain sanitized error metadata", async () => {
  const successDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audit-success-test-"));
  const successAudit = path.join(successDirectory, "audit.jsonl");
  const successRunner = async (_command, args) => {
    fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(modelFrom(args))));
    return { code: 0, stderr: "", stdout: "", elapsed_ms: 1 };
  };

  const success = await dispatchWorker(
    { task: "Read-only lookup: locate one symbol.", cwd: successDirectory, intent: "read-only" },
    { processRunner: successRunner, auditFile: successAudit, codexBin: "fake-codex" }
  );
  assert.equal(success.status, "completed");
  const successRecords = fs.readFileSync(successAudit, "utf8").trim().split("\n").map(JSON.parse);
  for (const record of successRecords) {
    assert.equal("error_code" in record, false, `${record.event} unexpectedly contained error_code`);
    assert.equal("error_sha256" in record, false, `${record.event} unexpectedly contained error_sha256`);
  }

  const failureDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "codex-audit-failure-test-"));
  const failureAudit = path.join(failureDirectory, "audit.jsonl");
  const secret = "UNIQUE_WORKER_FAILURE_SECRET";
  const failed = await dispatchWorker(
    { task: "Implement one ordinary helper.", cwd: failureDirectory, intent: "write" },
    {
      processRunner: async (_command, args) => {
        fs.writeFileSync(outputPath(args), JSON.stringify(successfulResult(modelFrom(args))));
        return { code: 1, stderr: `Worker exited with ${secret}`, stdout: "", elapsed_ms: 1 };
      },
      auditFile: failureAudit,
      codexBin: "fake-codex"
    }
  );
  assert.equal(failed.status, "failed");
  const rawFailureAudit = fs.readFileSync(failureAudit, "utf8");
  assert.doesNotMatch(rawFailureAudit, new RegExp(secret));
  const failedAttempts = rawFailureAudit.trim().split("\n").map(JSON.parse).filter((record) => record.event === "attempt_finished");
  assert.equal(failedAttempts.length, 2);
  for (const record of failedAttempts) {
    assert.equal(record.status, "failed");
    assert.equal(record.error_code, "worker_exit_failed");
    assert.match(record.error_sha256, /^[a-f0-9]{64}$/);
  }
});
