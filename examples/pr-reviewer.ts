/**
 * GitHub PR reviewer — uses the `gh` CLI to fetch a PR diff and writes a
 * focused review summary to stdout.
 *
 * Prereqs:
 *   gh auth login          (install + auth GitHub CLI)
 *
 * Run:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/pr-reviewer.ts <owner>/<repo>#<pr-number>
 *
 * Example:
 *   npx tsx examples/pr-reviewer.ts vercel/ai#1234
 */

import { callModel, tool, stepCountIs } from "@hyperrouter/agent";
import { z } from "zod";
import { execSync } from "node:child_process";

const target = process.argv[2];
if (!target || !/^[\w.-]+\/[\w.-]+#\d+$/.test(target)) {
  console.error("Usage: tsx examples/pr-reviewer.ts <owner>/<repo>#<pr-number>");
  process.exit(1);
}
const [repo, prNumberStr] = target.split("#");
const prNumber = Number(prNumberStr);

const ghPrView = await tool({
  name: "gh_pr_view",
  description: "Get a GitHub PR's title, description, and changed-files summary.",
  inputSchema: z.object({}),
  execute: async () => {
    const out = execSync(`gh pr view ${prNumber} --repo ${repo} --json title,body,files,additions,deletions`, {
      encoding: "utf-8",
    });
    return JSON.parse(out);
  },
});

const ghPrDiff = await tool({
  name: "gh_pr_diff",
  description: "Get the full diff of a GitHub PR.",
  inputSchema: z.object({}),
  execute: async () => {
    const diff = execSync(`gh pr diff ${prNumber} --repo ${repo}`, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
    return { diff: diff.slice(0, 50_000) }; // cap to fit in context
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    {
      role: "system",
      content:
        "You are a senior code reviewer. Fetch the PR details and diff, then write a review with: 1) summary of what changed, 2) up to 3 concrete suggestions or risks, 3) overall verdict (approve / request-changes / comment).",
    },
    { role: "user", content: `Review ${repo}#${prNumber}.` },
  ],
  tools: [ghPrView, ghPrDiff],
  stopWhen: stepCountIs(6),
});

for await (const chunk of result.getTextStream()) {
  process.stdout.write(chunk);
}
console.log("\n---");
console.log("Usage:", await result.getUsage());
