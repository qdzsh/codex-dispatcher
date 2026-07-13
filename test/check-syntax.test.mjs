import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const checker = path.join(projectRoot, "scripts", "check-syntax.mjs");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-check-syntax-"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(checker, path.join(root, "scripts", "check-syntax.mjs"));
  return root;
}

test("syntax checker recursively checks .mjs files and rejects an empty source directory", () => {
  const root = fixture();
  try {
    const source = path.join(root, "src");
    fs.mkdirSync(path.join(source, "nested"), { recursive: true });
    fs.writeFileSync(path.join(source, "valid.mjs"), "export const valid = true;\n");
    fs.writeFileSync(path.join(source, "nested", "also-valid.mjs"), "export default 1;\n");
    fs.writeFileSync(path.join(source, "ignored.js"), "not valid JavaScript");
    execFileSync(process.execPath, [path.join(root, "scripts", "check-syntax.mjs")], { stdio: "pipe" });

    fs.rmSync(source, { recursive: true, force: true });
    const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-syntax.mjs")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No \.mjs source files found/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
