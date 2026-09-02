import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** Git merge-conflict markers that must never ship in docs (Glama / npm README). */
const CONFLICT_START = /^<<<<<<< /;
const CONFLICT_END = /^>>>>>>> /;
const CONFLICT_SEP = /^=======$/;

function listDocFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...listDocFiles(full));
      continue;
    }
    if (/\.(md|mdx|txt)$/i.test(name) || name === "glama.json") {
      out.push(full);
    }
  }
  return out;
}

describe("docs hygiene", () => {
  it("has no leftover git merge-conflict markers in markdown/docs", () => {
    const files = listDocFiles(ROOT);
    assert.ok(files.some((f) => f.endsWith("README.md")), "expected root README.md");

    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (CONFLICT_START.test(line) || CONFLICT_END.test(line) || CONFLICT_SEP.test(line)) {
          offenders.push(`${relative(ROOT, file)}:${i + 1}: ${line}`);
        }
      }
    }

    assert.deepEqual(offenders, [], `conflict markers found:\n${offenders.join("\n")}`);
  });
});
