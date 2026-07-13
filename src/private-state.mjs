import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const isWindows = process.platform === "win32";

function owned(stat) {
  return isWindows || typeof process.getuid !== "function" || stat.uid === process.getuid();
}

function assertMode(file, mode) {
  if (!isWindows && (fs.statSync(file).mode & 0o777) !== mode) throw new Error(`Private state permissions are unsafe: ${file}`);
}

/**
 * Read a pre-existing owner-only regular file without repairing its metadata.
 * Policy enforcement is read-only: chmod-ing an attacker-controlled path while
 * deciding whether to trust it would itself be an unsafe side effect.
 */
export function readOwnerOnlyRegularFile(file) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch { throw new Error(`Cannot validate owner-only file: ${file}`); }
  if (!stat.isFile() || stat.isSymbolicLink() || !owned(stat) || (!isWindows && (stat.mode & 0o077) !== 0)) {
    throw new Error(`Owner-only file is unsafe: ${file}`);
  }
  return fs.readFileSync(file);
}

/** Fail closed for pre-existing private state.  Windows intentionally has no POSIX mode check. */
export function assertPrivatePath(file, type = "file", { create = false } = {}) {
  try {
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink() || (type === "directory" ? !stat.isDirectory() : !stat.isFile()) || !owned(stat)) throw new Error(`Unsafe private ${type}: ${file}`);
    try { fs.chmodSync(file, type === "directory" ? 0o700 : 0o600); } catch {}
    assertMode(file, type === "directory" ? 0o700 : 0o600);
    return true;
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) {
      if (/Unsafe private|permissions are unsafe/.test(error?.message || "")) throw error;
      throw new Error(`Cannot validate private ${type}: ${file}`);
    }
    if (type === "directory") {
      fs.mkdirSync(file, { recursive: true, mode: 0o700 });
      return assertPrivatePath(file, type);
    }
    return false;
  }
}

export function ensurePrivateDirectory(directory) {
  return assertPrivatePath(directory, "directory", { create: true });
}

export function readPrivateFile(file) {
  assertPrivatePath(file, "file");
  return fs.readFileSync(file);
}

export function writePrivateAtomic(file, content) {
  ensurePrivateDirectory(path.dirname(file));
  // A pre-existing destination must be trustworthy before rename replaces it.
  if (fs.existsSync(file)) assertPrivatePath(file, "file");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
  assertPrivatePath(temporary, "file");
  fs.renameSync(temporary, file);
  assertPrivatePath(file, "file");
}

export function removePrivateFile(file) {
  if (!fs.existsSync(file)) return false;
  assertPrivatePath(file, "file");
  fs.rmSync(file);
  return true;
}

export function makePrivateTempDirectory(parent, prefix) {
  ensurePrivateDirectory(parent);
  const directory = fs.mkdtempSync(path.join(parent, prefix));
  assertPrivatePath(directory, "directory");
  return directory;
}

export function removePrivateDirectory(directory) {
  if (!fs.existsSync(directory)) return;
  assertPrivatePath(directory, "directory");
  fs.rmSync(directory, { recursive: true, force: true });
}
