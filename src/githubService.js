import { posix } from "node:path";
import { Octokit } from "@octokit/rest";

const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN });

const MAX_LOG_LINES = 250; // tail of each failed job's log
const MAX_FILES = 5; // max files named in the logs that we look up
const MAX_TOTAL_FILES = 12; // hard cap on files sent to the LLM
const MAX_SIBLINGS_PER_DIR = 8; // source files pulled from each directory
const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|json|py|go|rb|java|rs|ya?ml)$/;
const IGNORED_FILES = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const MAX_FILE_CHARS = 20000; // per-file cap to keep the prompt small

/**
 * Returns the failed jobs of a workflow run, each with the tail of its log
 * and the names of the steps that failed.
 */
export async function fetchFailedJobLogs({ owner, repo, runId }) {
  const { data } = await octokit.rest.actions.listJobsForWorkflowRun({
    owner,
    repo,
    run_id: runId,
    per_page: 100,
  });

  const failedJobs = data.jobs.filter((j) => j.conclusion === "failure");
  const results = [];

  for (const job of failedJobs) {
    let logText = "";
    try {
      // Octokit follows the redirect to the log archive and returns the text
      const res = await octokit.rest.actions.downloadJobLogsForWorkflowRun({
        owner,
        repo,
        job_id: job.id,
      });
      logText = typeof res.data === "string" ? res.data : String(res.data);
    } catch (err) {
      logText = `(could not download logs: ${err.message})`;
    }

    const lines = logText.split("\n");
    results.push({
      jobName: job.name,
      failedSteps: (job.steps || [])
        .filter((s) => s.conclusion === "failure")
        .map((s) => s.name),
      logTail: lines.slice(-MAX_LOG_LINES).join("\n"),
    });
  }
  return results;
}

/**
 * Heuristically pulls file paths mentioned in the logs (stack traces, lint
 * errors, compiler output) and keeps only those that exist in the repo.
 */
export function extractCandidatePaths(logs) {
  const pathRegex = /(?:\.\/)?((?:[\w.-]+\/)*[\w.-]+\.(?:js|jsx|ts|tsx|mjs|cjs|json|py|go|rb|java|rs|yml|yaml))/g;
  // Logs show absolute runner paths like /home/runner/work/<repo>/<repo>/ci-demo/a.js
  // (often as file:///...). Strip that prefix so we get repo-relative paths.
  const runnerPrefix = /(?:file:\/\/)?\/home\/runner\/work\/[^/\s]+\/[^/\s]+\//g;
  const seen = new Set();
  for (const { logTail } of logs) {
    for (const m of logTail.replace(runnerPrefix, "").matchAll(pathRegex)) {
      const p = m[1];
      if (p.includes("node_modules/") || p.startsWith("/") || p.includes("..")) continue;
      seen.add(p);
    }
  }
  // Real paths (with a directory) first; bare names like "Node.js" last
  const all = [...seen];
  return [...all.filter((p) => p.includes("/")), ...all.filter((p) => !p.includes("/"))];
}

/** Lists source files sitting next to a file mentioned in the logs. */
async function listSiblingFiles({ owner, repo, dir, ref }) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path: dir, ref });
    if (!Array.isArray(data)) return [];
    return data
      .filter((e) => e.type === "file" && CODE_EXT.test(e.name) && !IGNORED_FILES.test(e.path))
      .map((e) => e.path)
      .slice(0, MAX_SIBLINGS_PER_DIR);
  } catch {
    return [];
  }
}

async function getFileAtRef({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data) || data.type !== "file") return null;
    const content = Buffer.from(data.content, "base64").toString("utf8");
    // truncated=true means the model only saw part of the file, so we must
    // never let it overwrite the whole thing with a "complete" new version
    return {
      path,
      sha: data.sha,
      content: content.slice(0, MAX_FILE_CHARS),
      truncated: content.length > MAX_FILE_CHARS,
    };
  } catch {
    return null; // path from logs didn't exist in the repo
  }
}

/**
 * Fetches the files most likely related to the failure, at the failing commit.
 * Always tries package.json as general context.
 */
export async function fetchRelevantFiles({ owner, repo, ref, logs }) {
  const candidates = extractCandidatePaths(logs).slice(0, MAX_FILES);

  // A failing test's stack trace usually names only the test file, not the
  // code under test, so also pull the other source files in the same folders.
  const dirs = [...new Set(candidates.map((p) => posix.dirname(p)).filter((d) => d !== "."))];
  const siblings = [];
  for (const dir of dirs) siblings.push(...(await listSiblingFiles({ owner, repo, dir, ref })));

  const paths = [
    ...new Set([...candidates, ...siblings, "package.json", ...dirs.map((d) => `${d}/package.json`)]),
  ].slice(0, MAX_TOTAL_FILES);

  const files = [];
  for (const path of paths) {
    const file = await getFileAtRef({ owner, repo, path, ref });
    if (file) files.push(file);
  }
  return files;
}

/**
 * Creates a branch at the failing commit, commits each patched file,
 * and opens a PR against baseBranch.
 */
export async function createFixPullRequest({
  owner,
  repo,
  baseBranch,
  headSha,
  runId,
  patches, // [{ path, newContent }]
  title,
  body,
  draft = false,
}) {
  const branchName = `triage-agent/fix-run-${runId}`;

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branchName}`,
    sha: headSha,
  });

  for (const { path, newContent } of patches) {
    // Need the file's current blob sha on the new branch to update it
    let sha;
    try {
      const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: branchName });
      if (!Array.isArray(data)) sha = data.sha;
    } catch {
      /* new file: no sha needed */
    }

    await octokit.rest.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      branch: branchName,
      message: `fix(ci): patch ${path} (triage-agent, run ${runId})`,
      content: Buffer.from(newContent, "utf8").toString("base64"),
      sha,
    });
  }

  const { data: pr } = await octokit.rest.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch,
    body,
    draft,
  });
  return pr;
}