import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sourceDirectory = join(projectRoot, "src");

async function findSourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await findSourceFiles(file));
    else if (entry.isFile() && extname(entry.name) === ".mjs") files.push(file);
  }
  return files;
}

let sourceFiles = [];
try {
  sourceFiles = (await findSourceFiles(sourceDirectory)).sort();
} catch (error) {
  if (error?.code !== "ENOENT") throw error;
}
if (sourceFiles.length === 0) {
  console.error(`No .mjs source files found in ${sourceDirectory}.`);
  process.exitCode = 1;
} else {
  for (const sourceFile of sourceFiles) {
    const result = spawnSync(process.execPath, ["--check", sourceFile], { shell: false, stdio: "inherit" });
    if (result.error) {
      console.error(`Unable to syntax-check ${sourceFile}: ${result.error.message}`);
      process.exitCode = 1;
      break;
    }
    if (result.signal) {
      console.error(`Syntax check for ${sourceFile} was terminated by signal ${result.signal}.`);
      process.exitCode = 1;
      break;
    }
    if (result.status !== 0) {
      process.exitCode = result.status;
      break;
    }
  }
}
