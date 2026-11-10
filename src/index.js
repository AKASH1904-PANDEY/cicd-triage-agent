import crypto from "node:crypto";
import express from "express";
import { fetchFailedJobLogs, fetchRelevantFiles, createFixPullRequest } from "./githubService.js";
import { analyzeFailure } from "./geminiService.js";
import { runInSandbox } from "./sandbox.js";

// ---- Config & startup validation -------------------------------------------
const { PORT = 3000, WEBHOOK_SECRET, GITHUB_TOKEN, GEMINI_API_KEY } = process.env;
const DRY_RUN = (process.env.DRY_RUN ?? "true").toLowerCase() === "true";
const SANDBOX_ENABLED = (process.env.SANDBOX_ENABLED ?? "false").toLowerCase() === "true";
const MAX_FIX_ATTEMPTS = Math.max(1, Number(process.env.MAX_FIX_ATTEMPTS || 2));
const ALLOWED_REPOS = (process.env.ALLOWED_REPOS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

for (const [name, value] of Object.entries({ WEBHOOK_SECRET, GITHUB_TOKEN, GEMINI_API_KEY })) {
  if (!value) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
}

const AGENT_BRANCH_PREFIX = "triage-agent/";
const inFlight = new Set(); // run ids currently being processed (dedupe redeliveries)

const app = express();

// Keep the raw bytes: the HMAC signature is computed over the exact body GitHub sent
app.use(
  express.json({
    limit: "5mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);

// ---- Signature verification --------------------------------------------------
function isValidSignature(req) {
  const header = req.get("x-hub-signature-256");
  if (!header || !req.rawBody) return false;
  const expected =
    "sha256=" + crypto.createHmac("sha256", WEBHOOK_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(header);
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b); // constant-time compare
}

// ---- Core pipeline -------------------------------------------------------------
async function handleFailedRun(payload) {
  const run = payload.workflow_run;
  const [owner, repo] = payload.repository.full_name.split("/");
  const tag = `[${payload.repository.full_name} run ${run.id}]`;

  console.log(`${tag} fetching logs`);
  const logs = await fetchFailedJobLogs({ owner, repo, runId: run.id });
  if (logs.length === 0) {
    console.log(`${tag} no failed jobs found, skipping`);
    return;
  }

  console.log(`${tag} fetching relevant files`);
  const files = await fetchRelevantFiles({ owner, repo, ref: run.head_sha, logs });

  // Safety: only accept patches to files we showed the model in full
  const patchable = new Map(files.filter((f) => !f.truncated).map((f) => [f.path, f]));

  let analysis;
  let patches = [];
  let sandboxResult = null;
  let previousAttempt = null;

  // Analyze -> (optionally) validate in sandbox -> retry with feedback
  for (let attempt = 1; attempt <= MAX_FIX_ATTEMPTS; attempt++) {
    console.log(
      `${tag} attempt ${attempt}/${MAX_FIX_ATTEMPTS}: asking Gemini (${process.env.GEMINI_MODEL || "gemini-2.5-flash"})`
    );
    analysis = await analyzeFailure({
      repoFullName: payload.repository.full_name,
      branch: run.head_branch,
      workflowName: run.name,
      logs,
      files,
      previousAttempt,
    });

    console.log(`${tag} root cause: ${analysis.rootCause}`);
    console.log(`${tag} fixable=${analysis.fixable} confidence=${analysis.confidence}`);

    if (!analysis.fixable || analysis.patches.length === 0) {
      console.log(`${tag} no patch generated, stopping`);
      return;
    }

    patches = analysis.patches.filter(
      (p) => patchable.has(p.path) && p.newContent !== patchable.get(p.path).content
    );
    if (patches.length === 0) {
      console.log(`${tag} patches were invalid or no-ops, stopping`);
      return;
    }

    if (!SANDBOX_ENABLED) break;

    console.log(`${tag} validating patch in sandbox`);
    sandboxResult = await runInSandbox({ owner, repo, sha: run.head_sha, patches });
    if (sandboxResult.passed) {
      console.log(`${tag} sandbox passed`);
      break;
    }
    console.log(`${tag} sandbox failed:\n${sandboxResult.output.slice(-1500)}`);
    previousAttempt = { patches, sandboxOutput: sandboxResult.output };
  }

  const verified = sandboxResult?.passed === true;
  const unverified = SANDBOX_ENABLED && !verified; // sandbox ran but never passed

  if (DRY_RUN) {
    console.log(`${tag} DRY_RUN=true, would patch: ${patches.map((p) => p.path).join(", ")}`);
    for (const p of patches) console.log(`\n--- ${p.path} ---\n${p.newContent}\n`);
    return;
  }

  const body = [
    "## 🤖 Automated CI fix",
    `Triggered by failed run [#${run.id}](${run.html_url}) on \`${run.head_branch}\`.`,
    "",
    "### Root cause",
    analysis.rootCause,
    "",
    "### What this changes",
    analysis.explanation,
    "",
    `**Files changed:** ${patches.map((p) => `\`${p.path}\``).join(", ")}`,
    `**Model confidence:** ${analysis.confidence}`,
    `**Sandbox validation:** ${
      !SANDBOX_ENABLED ? "not run" : verified ? "✅ tests passed with this patch" : "❌ tests still failing (opened as draft)"
    }`,
    "",
    "> Generated automatically by cicd-triage-agent. Review carefully before merging.",
  ].join("\n");

  const pr = await createFixPullRequest({
    owner,
    repo,
    baseBranch: run.head_branch,
    headSha: run.head_sha,
    runId: run.id,
    patches,
    title: `fix(ci): ${analysis.rootCause.slice(0, 60).replace(/\s+/g, " ")}`,
    body,
    draft: unverified,
  });
  console.log(`${tag} opened PR: ${pr.html_url}`);
}

// ---- Routes ----------------------------------------------------------------------
app.get("/health", (_req, res) => res.json({ ok: true, dryRun: DRY_RUN }));

app.post("/webhook", (req, res) => {
  if (!isValidSignature(req)) {
    console.warn("Rejected webhook: bad signature");
    return res.status(401).send("Invalid signature");
  }

  const event = req.get("x-github-event");
  if (event === "ping") return res.status(200).send("pong");
  if (event !== "workflow_run") return res.status(204).end();

  const payload = req.body;
  const run = payload.workflow_run;
  const repoName = payload.repository?.full_name;

  // Filters: only completed+failed runs, allowed repos, no self-triggered loops, no forks
  const skip =
    payload.action !== "completed" ||
    run?.conclusion !== "failure" ||
    (ALLOWED_REPOS.length > 0 && !ALLOWED_REPOS.includes(repoName)) ||
    run.head_branch?.startsWith(AGENT_BRANCH_PREFIX) ||
    run.head_repository?.full_name !== repoName ||
    inFlight.has(run.id);

  if (skip) return res.status(204).end();

  // Acknowledge immediately (GitHub times out webhooks after 10s); work continues async
  res.status(202).send("Accepted");

  inFlight.add(run.id);
  handleFailedRun(payload)
    .catch((err) => console.error(`[${repoName} run ${run.id}] pipeline failed:`, err))
    .finally(() => inFlight.delete(run.id));
});

app.listen(PORT, () => {
  console.log(`cicd-triage-agent listening on :${PORT} (DRY_RUN=${DRY_RUN})`);
});
