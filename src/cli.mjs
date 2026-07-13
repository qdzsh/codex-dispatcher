#!/usr/bin/env node

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { readAuditTail } from "./audit.mjs";
import { SOL_MODEL, WORKERS } from "./constants.mjs";
import { routeTask } from "./policy.mjs";
import { dispatchWorker } from "./runner.mjs";
import { install, platformPaths, publicInstallResult, uninstall, verifyCapabilities } from "./install.mjs";

function usage() {
  return `codex-dispatcher - portable Codex worker dispatcher\n\nUsage:\n  codex-dispatcher install [--user-only|--managed] [--codex-home DIR] [--skip-preflight]\n  codex-dispatcher uninstall [--codex-home DIR]\n  codex-dispatcher route --task TEXT [--intent auto|read-only|write] [--git] [--file PATH ...] [--expect PATH ...]\n  codex-dispatcher dispatch --task TEXT --cwd DIR [--intent auto|read-only|write] [--git] [--file PATH ...] [--expect PATH ...] [--verify] [--independent-verification] [--timeout SECONDS]\n  codex-dispatcher audit [--last N]\n  codex-dispatcher doctor\n  codex-dispatcher --version | help\n\nRoute, dispatch, audit and doctor emit JSON.\n`;
}

function parseArgs(argv) {
  const command = argv.shift();
  const options = { files: [], expected_artifacts: [] };
  while (argv.length) {
    const token = argv.shift();
    if (token === "--task") options.task = argv.shift();
    else if (token === "--cwd") options.cwd = argv.shift();
    else if (token === "--intent") options.intent = argv.shift();
    else if (token === "--file") options.files.push(argv.shift());
    else if (token === "--expect") options.expected_artifacts.push(argv.shift());
    else if (token === "--minimum-tier") options.minimum_tier = argv.shift();
    else if (token === "--verify") options.require_verification = true;
    else if (token === "--independent-verification") options.independent_verification = true;
    else if (token === "--git") {
      if (options.git_access !== undefined) throw new Error("--git may be specified only once.");
      options.git_access = true;
    }
    else if (token === "--timeout") options.timeout_seconds = Number(argv.shift());
    else if (token === "--last") options.last = Number(argv.shift());
    else if (token === "--codex-home") options.codexHome = argv.shift();
    else if (token === "--home") options.home = argv.shift();
    else if (token === "--user-only") options.managed = false;
    else if (token === "--managed") options.managed = true;
    else if (token === "--skip-preflight") options.skipPreflight = true;
    else if (token === "--no-sudo") options.noSudo = true;
    else if (token === "--model-sol") (options.models ||= {}).sol = argv.shift();
    else if (token === "--model-spark") (options.models ||= {}).spark = argv.shift();
    else if (token === "--model-luna") (options.models ||= {}).luna = argv.shift();
    else if (token === "--model-terra") (options.models ||= {}).terra = argv.shift();
    else if (token === "--help" || token === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${token}`);
  }
  return { command, options };
}

function readTask(options) {
  if (options.task && options.task !== "-") return options.task;
  if (process.stdin.isTTY) throw new Error("--task is required when stdin is a terminal.");
  return fs.readFileSync(0, "utf8").trim();
}

async function doctor() {
  const forbidden = Object.values(WORKERS).filter((worker) => worker.model === SOL_MODEL);
  let preflight;
  try { preflight = verifyCapabilities(); } catch (error) { preflight = { error: error.message }; }
  return {
    status: forbidden.length ? "failed" : "ok",
    workers: WORKERS,
    sol_worker_present: forbidden.length > 0,
    native_multi_agent_for_workers: false,
    paths: platformPaths(),
    preflight
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { command, options } = parseArgs([...argv]);
  if (options.help || !command || command === "help") {
    process.stdout.write(usage());
    return 0;
  }
  let result;
  if (command === "--version" || command === "version") { process.stdout.write("2.0.0\n"); return 0; }
  if (options.git_access && !["route", "dispatch"].includes(command)) throw new Error("--git is supported only by route and dispatch.");
  if (command === "install") result = publicInstallResult(install(options));
  else if (command === "uninstall") result = uninstall(options);
  else if (command === "route") result = routeTask({ ...options, task: readTask(options) });
  else if (command === "dispatch") result = await dispatchWorker({ ...options, task: readTask(options) });
  else if (command === "audit") result = { records: readAuditTail(options.last || 20) };
  else if (command === "doctor") result = await doctor();
  else throw new Error(`Unknown command: ${command}`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return ["failed", "partially_uninstalled"].includes(result.status) ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1])) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
