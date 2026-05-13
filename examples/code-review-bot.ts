/**
 * Local code review bot — runs `git diff` in the current repo and flags risks.
 *
 * Run from inside a git repo with uncommitted changes:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/code-review-bot.ts
 *
 * Optional: pass a base ref:
 *   npx tsx examples/code-review-bot.ts main
 */

import { callModel, tool, stepCountIs } from "@hyperrouter/agent";
import { z } from "zod";
import { execSync } from "node:child_process";

const baseRef = process.argv[2]; // optional; if omitted, diff against worktree

const gitDiff = await tool({
  name: "git_diff",
  description:
    "Get the diff of uncommitted changes (or against a base ref if provided). Returns up to 50 KB of diff text.",
  inputSchema: z.object({}),
  execute: async () => {
    const cmd = baseRef ? `git diff ${baseRef}...HEAD` : "git diff HEAD";
    try {
      const diff = execSync(cmd, { encoding: "utf-8", maxBuffer: 10 * 1024 * 1024 });
      return { diff: diff.slice(0, 50_000), truncated: diff.length > 50_000 };
    } catch (e) {
      return { error: (e as Error).message };
    }
  },
});

const gitFiles = await tool({
  name: "git_changed_files",
  description: "List which files changed.",
  inputSchema: z.object({}),
  execute: async () => {
    const cmd = baseRef ? `git diff --name-status ${baseRef}...HEAD` : "git diff --name-status HEAD";
    const out = execSync(cmd, { encoding: "utf-8" });
    return { files: out.trim().split("\n") };
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    {
      role: "system",
      content:
        "You are a code review bot. Look at the diff and flag concrete risks: missing tests, hardcoded secrets, error handling gaps, breaking changes, sloppy types. Be specific (file + line context). If the diff is small / safe, say so plainly.",
    },
    { role: "user", content: "Review my changes." },
  ],
  tools: [gitDiff, gitFiles],
  stopWhen: stepCountIs(4),
});

for await (const chunk of result.getTextStream()) {
  process.stdout.write(chunk);
}
console.log("\n");
