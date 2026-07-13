import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AUDIT_LOG } from "./constants.mjs";

export function taskDigest(task) {
  return crypto.createHash("sha256").update(String(task)).digest("hex");
}

export function artifactPathDigest(artifactPath) {
  return crypto.createHash("sha256").update(String(artifactPath)).digest("hex");
}

export function auditPath() {
  return process.env.CODEX_WORKER_AUDIT_LOG || DEFAULT_AUDIT_LOG;
}

const SAFE_EVENTS = new Set(["route", "attempt_started", "attempt_finished", "run_completed", "escalation", "run_failed", "sol_tool_allowed", "sol_tool_denied"]);
const SAFE_TIERS = new Set(["spark", "luna", "terra"]);
const SAFE_EFFORTS = new Set(["low", "medium", "high", "ultra"]);
const SAFE_SANDBOXES = new Set(["read-only", "workspace-write"]);
const GIT_SANDBOX = "danger-full-access";
const SAFE_STATUSES = new Set(["completed", "failed", "needs_escalation"]);
const SAFE_ERROR_CODES = new Set(["timeout", "invalid_result", "missing_result", "missing_artifact", "verification_failed", "worker_exit_failed", "worker_failed"]);
const SHA256 = /^[a-f0-9]{64}$/;
const SAFE_RUN_ID = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_MODEL = /^[A-Za-z0-9._:-]{1,128}$/;
const SAFE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function textHash(value) { return crypto.createHash("sha256").update(String(value)).digest("hex"); }
function errorCode(value) {
  const text = String(value || "").toLowerCase();
  if (text.includes("timed out")) return "timeout";
  if (text.includes("non-empty") || text.includes("invalid json") || text.includes("json object")) return "invalid_result";
  if (text.includes("did not produce")) return "missing_result";
  if (text.includes("expected artifact")) return "missing_artifact";
  if (text.includes("verification")) return "verification_failed";
  if (text.includes("exited with") || text.includes("stderr")) return "worker_exit_failed";
  return "worker_failed";
}

function canonicalTimestamp(value) {
  if (typeof value !== "string" || !SAFE_TIMESTAMP.test(value)) return undefined;
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) || timestamp.toISOString() !== value ? undefined : value;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : undefined;
}

function safeModel(value) {
  return typeof value === "string" && SAFE_MODEL.test(value) ? value : undefined;
}

function safeTier(value) {
  return typeof value === "string" && SAFE_TIERS.has(value) ? value : undefined;
}

function safeHash(value) {
  return typeof value === "string" && SHA256.test(value) ? value : undefined;
}

function addArtifactPathHashes(record, source) {
  const hashes = [];
  if (Array.isArray(source.artifact_path_sha256)) {
    for (const value of source.artifact_path_sha256) {
      const hash = safeHash(value);
      if (hash) hashes.push(hash);
    }
  }
  // Older records stored raw paths. Convert them only while sanitizing so they
  // can never be persisted or returned by a current reader.
  if (Array.isArray(source.artifact_paths)) {
    for (const value of source.artifact_paths) {
      if (typeof value === "string") hashes.push(artifactPathDigest(value));
    }
  }
  if (hashes.length) record.artifact_path_sha256 = [...new Set(hashes)].slice(0, 200);
}

// Audit records are an allowlist, not a redaction list.  In particular, nested
// objects are never copied through, so a future caller cannot accidentally add
// worker output, prompts, or exception text below an otherwise safe field.
export function sanitizeAuditEntry(entry) {
  const source = entry && typeof entry === "object" && !Array.isArray(entry) ? entry : {};
  const record = {};
  const timestamp = canonicalTimestamp(source.timestamp);
  if (timestamp) record.timestamp = timestamp;
  if (typeof source.event === "string" && SAFE_EVENTS.has(source.event)) record.event = source.event;
  if (typeof source.run_id === "string" && SAFE_RUN_ID.test(source.run_id)) record.run_id = source.run_id;
  for (const key of ["tier", "selected_tier", "final_tier", "from_tier", "to_tier"]) {
    const value = safeTier(source[key]);
    if (value) record[key] = value;
  }
  for (const key of ["model", "selected_model", "final_model", "from_model", "to_model"]) {
    const value = safeModel(source[key]);
    if (value) record[key] = value;
  }
  if (typeof source.effort === "string" && SAFE_EFFORTS.has(source.effort)) record.effort = source.effort;
  const gitAccess = source.git_access === true;
  if (typeof source.sandbox === "string" && (SAFE_SANDBOXES.has(source.sandbox) || (source.sandbox === GIT_SANDBOX && gitAccess))) record.sandbox = source.sandbox;
  if (gitAccess) record.git_access = true;
  if (typeof source.status === "string" && SAFE_STATUSES.has(source.status)) record.status = source.status;
  for (const [key, minimum, maximum] of [["attempt", 1, 10_000], ["exit_code", -1, 1_000_000], ["elapsed_ms", 0, 7_200_000]]) {
    const value = boundedInteger(source[key], minimum, maximum);
    if (value !== undefined) record[key] = value;
  }
  for (const key of ["native_multi_agent", "recursive_dispatcher"]) {
    if (typeof source[key] === "boolean") record[key] = source[key];
  }
  const taskHash = safeHash(source.task_sha256);
  if (taskHash) record.task_sha256 = taskHash;
  if (Array.isArray(source.escalation_order)) {
    const tiers = source.escalation_order.filter((value) => typeof value === "string" && SAFE_TIERS.has(value));
    if (tiers.length === source.escalation_order.length && tiers.length <= 3) record.escalation_order = tiers;
  }
  addArtifactPathHashes(record, source);
  if (typeof source.error_code === "string" && SAFE_ERROR_CODES.has(source.error_code)) record.error_code = source.error_code;
  const suppliedErrorHash = safeHash(source.error_sha256);
  if (suppliedErrorHash) record.error_sha256 = suppliedErrorHash;
  if (source.error !== undefined && source.error !== null && source.error !== "") {
    record.error_code ||= errorCode(source.error);
    record.error_sha256 ||= textHash(source.error);
  }
  return record;
}

export function appendAudit(entry, file = auditPath()) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const record = { timestamp: new Date().toISOString(), ...sanitizeAuditEntry(entry) };
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
  return record;
}

export function readAuditTail(limit = 20, file = auditPath()) {
  if (!fs.existsSync(file)) return [];
  const count = Math.max(1, Math.min(Number(limit) || 20, 200));
  const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
  return lines.slice(-count).map((line) => {
    try { return sanitizeAuditEntry(JSON.parse(line)); }
    catch { return { event: "invalid_audit_line" }; }
  });
}
