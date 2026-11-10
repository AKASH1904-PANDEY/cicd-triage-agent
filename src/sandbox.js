import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const exec = promisify(execFile);

const SANDBOX_COMMAND = process.env.SANDBOX_COMMAND || "npm ci && npm test";
const TIMEOUT_MS = Number(process.env.SANDBOX_TIMEOUT_MS || 600000); // 10 min
const OUTPUT_TAIL_CHARS = 6000; // what we keep to show Gemini / log

// Secrets must never be visible to code from the repo under test
const SECRET_ENV_KEYS = ["GITHUB_TOKEN", "GEMINI_API_KEY", "WEBHOOK_SECRET"];
function scrubbedEnv() {
  const env = { ...process.env };
  for (const k of SECRET_ENV_KEYS) delete env[k];
  return env;
}

/**
 * Clones the repo at the failing commit into a temp dir, applies the patches,
 * runs SANDBOX_COMMAND and reports whether it passed.
 *
 * NOTE: this executes the repo's own scripts on this machine. Fine for your own
 * repos; for anything untrusted, run it inside Docker instead.
 *
 * @returns {Promise<{ passed: boolean, output: string }>}
 */
export async function runInSandbox({ owner, repo, sha, patches }) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "triage-"));

  try {
    // Pass the token as a header so it is never written to .git/config
    const auth = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString("base64");
    const git = (args) =>
      exec("git", ["-c", `http.extraHeader=Authorization: Basic ${auth}`, ...args], {
        cwd: dir,
        timeout: 120000,
      });

    await git(["init", "-q"]);
    await git(["fetch", "--depth", "1", `https://github.com/${owner}/${repo}.git`, sha]);
    await git(["checkout", "-q", "FETCH_HEAD"]);

    for (const { path: filePath, newContent } of patches) {
      const target = path.resolve(dir, filePath);
      if (!target.startsWith(dir + path.sep)) throw new Error(`Patch path escapes sandbox: ${filePath}`);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, newContent, "utf8");
    }

    try {
      const { stdout, stderr } = await exec("bash", ["-c", SANDBOX_COMMAND], {
        cwd: dir,
        timeout: TIMEOUT_MS,
        maxBuffer: 20 * 1024 * 1024,
        env: scrubbedEnv(),
      });
      return { passed: true, output: (stdout + stderr).slice(-OUTPUT_TAIL_CHARS) };
    } catch (err) {
      const out = `${err.stdout || ""}${err.stderr || ""}${err.killed ? "\n(sandbox command timed out)" : ""}`;
      return { passed: false, output: out.slice(-OUTPUT_TAIL_CHARS) };
    }
  } catch (err) {
    // git errors echo the command line, which contains the auth header: redact it
    const safe = String(err.message).replace(/Authorization: Basic \S+/g, "Authorization: Basic ***");
    return { passed: false, output: `sandbox setup failed: ${safe}` };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
