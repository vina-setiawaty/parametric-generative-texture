// Runs every offline suite, even after one fails, and exits non-zero if any did:
//   node tests/run-all.mjs        (or: npm test)
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SUITES = ["golden-brushes", "compile-fixtures", "prompt-assembly", "pipeline", "session-file"];
const failed = [];
for (const s of SUITES) {
  console.log(`\n=== ${s} ===`);
  const r = spawnSync(process.execPath, [join(here, `${s}.mjs`)], { stdio: "inherit" });
  if (r.status !== 0) failed.push(s);
}
console.log(failed.length ? `\nfailed: ${failed.join(", ")}` : "\nall suites passed");
process.exitCode = failed.length ? 1 : 0;
