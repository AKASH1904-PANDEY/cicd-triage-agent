# cicd-triage-agent

Autonomous CI/CD failure triage agent. When a GitHub Actions run fails, it fetches the failing logs and relevant files, asks Gemini for a root cause and patch, and opens a Pull Request with the fix.

```
GitHub Actions fails -> Express /webhook -> Octokit (logs + files) -> Gemini (analysis + patch) -> branch + PR
```

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev
```

Requires Node 20.6+ (uses `--env-file`).

### Environment variables

| Variable | Purpose |
|---|---|
| `PORT` | Server port (default 3000) |
| `GEMINI_API_KEY` | Key from Google AI Studio |
| `GITHUB_TOKEN` | PAT with `repo` scope (classic) or fine-grained with Contents, Pull requests, Actions (read) |
| `WEBHOOK_SECRET` | Same string you enter in the GitHub webhook settings |
| `GEMINI_MODEL` | `gemini-2.5-flash` (default) or `gemini-2.5-pro` |
| `DRY_RUN` | `true` = log the patch only, no PR (default) |
| `ALLOWED_REPOS` | Optional comma-separated `owner/repo` allowlist |

### Sandbox validation (optional)

Set `SANDBOX_ENABLED=true` and the agent will, before opening a PR: clone the repo at the failing commit into a temp dir, apply Gemini's patch, and run `SANDBOX_COMMAND` (default `npm ci && npm test`). If it fails, the output is fed back to Gemini for another attempt (up to `MAX_FIX_ATTEMPTS`). If it never passes, the PR is opened as a **draft** marked as unverified. Secrets are stripped from the sandbox environment.

This runs the repo's own scripts on your machine, so use it on your own repos only (use Docker for anything untrusted).

## Connect GitHub

1. `ngrok http 3000`
2. In your repo: Settings -> Webhooks -> Add webhook
   - Payload URL: `https://<ngrok-id>.ngrok-free.app/webhook`
   - Content type: `application/json`
   - Secret: your `WEBHOOK_SECRET`
   - Events: select **Workflow runs** only
3. Push a commit that breaks a workflow and watch the server logs.

Start with `DRY_RUN=true`. Once the logged patches look good, set it to `false`.

## Safeguards built in

- HMAC signature verification on every webhook
- Ignores runs on `triage-agent/*` branches (prevents fix-the-fix loops)
- Ignores runs from forks
- Only patches files the model was shown in full; truncated files are never overwritten
- Dedupes redelivered webhooks for the same run
