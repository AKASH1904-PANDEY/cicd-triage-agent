import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const MODEL = process.env.GEMINI_MODEL || "gemini-3.8-flash";

// Structured output: Gemini is forced to return JSON matching this schema,
// so we never have to parse free-form text.
const responseSchema = {
  type: Type.OBJECT,
  properties: {
    rootCause: { type: Type.STRING, description: "One-paragraph root cause of the failure" },
    explanation: { type: Type.STRING, description: "What the patch changes and why it fixes the failure" },
    confidence: { type: Type.STRING, enum: ["low", "medium", "high"] },
    fixable: {
      type: Type.BOOLEAN,
      description: "true only if the failure can be fixed by editing the provided files",
    },
    patches: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          path: { type: Type.STRING, description: "Path of a file that was provided" },
          newContent: { type: Type.STRING, description: "The COMPLETE new content of the file" },
        },
        required: ["path", "newContent"],
      },
    },
  },
  required: ["rootCause", "explanation", "confidence", "fixable", "patches"],
};

function buildPrompt({ repoFullName, branch, workflowName, logs, files, previousAttempt }) {
  // On retries, show Gemini what it tried before and why it still failed
  const retrySection = previousAttempt
    ? `## Your previous attempt FAILED validation
You proposed these patches:
${previousAttempt.patches.map((p) => `### ${p.path}\n\`\`\`\n${p.newContent}\n\`\`\``).join("\n\n")}

Running the project's tests with those patches applied produced:
\`\`\`
${previousAttempt.sandboxOutput}
\`\`\`
Analyze why it failed and return a corrected set of patches. Patches are always applied to the ORIGINAL files shown above, not to your previous attempt.

`
    : "";

  const logSection = logs
    .map(
      (l) =>
        `### Job: ${l.jobName}\nFailed steps: ${l.failedSteps.join(", ") || "unknown"}\n\`\`\`\n${l.logTail}\n\`\`\``
    )
    .join("\n\n");

  const fileSection = files
    .map((f) => `### File: ${f.path}${f.truncated ? " (TRUNCATED - do not patch)" : ""}\n\`\`\`\n${f.content}\n\`\`\``)
    .join("\n\n");

  return `You are a senior engineer triaging a failed GitHub Actions run.

Repository: ${repoFullName}
Branch: ${branch}
Workflow: ${workflowName}

## Failed job logs (tail)
${logSection}

## Repository files
${fileSection}

${retrySection}## Instructions
1. Identify the root cause of the failure from the logs.
2. If it can be fixed by editing the provided files, return the COMPLETE new content of each changed file in "patches". Change as little as possible.
3. Only patch files listed above that are not marked TRUNCATED. Never invent new file paths.
4. If the cause is outside these files (flaky test, infra, secrets, missing dependency not visible here), set fixable=false and return an empty patches array, but still explain the root cause.
5. Never weaken or delete tests just to make the build pass.`;
}

const FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || "";
const MAX_RETRIES = Number(process.env.GEMINI_MAX_RETRIES || 4);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 429 = rate limited, 5xx = Google-side overload/outage: all worth retrying
function isRetryable(err) {
  return [429, 500, 502, 503, 504].includes(Number(err?.status ?? err?.code));
}

/** Calls Gemini, retrying overload errors with exponential backoff (2s, 4s, 8s, 16s). */
async function generateWithRetry(model, prompt) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: 0.2, // low temperature: we want deterministic fixes, not creativity
        },
      });
    } catch (err) {
      if (!isRetryable(err) || attempt >= MAX_RETRIES) throw err;
      const delay = Math.min(2000 * 2 ** attempt, 30000) + Math.random() * 1000;
      console.warn(
        `Gemini ${model} returned ${err.status}, retry ${attempt + 1}/${MAX_RETRIES} in ${Math.round(delay / 1000)}s`
      );
      await sleep(delay);
    }
  }
}

/**
 * Sends logs + files to Gemini and returns the parsed analysis.
 */
export async function analyzeFailure(context) {
  const prompt = buildPrompt(context);

  let response;
  try {
    response = await generateWithRetry(MODEL, prompt);
  } catch (err) {
    // Primary model overloaded for too long: try the fallback model once (if configured)
    if (FALLBACK_MODEL && FALLBACK_MODEL !== MODEL && isRetryable(err)) {
      console.warn(`Gemini ${MODEL} still unavailable, falling back to ${FALLBACK_MODEL}`);
      response = await generateWithRetry(FALLBACK_MODEL, prompt);
    } else {
      throw err;
    }
  }

  try {
    return JSON.parse(response.text);
  } catch (err) {
    throw new Error(`Gemini returned invalid JSON: ${err.message}`);
  }
}