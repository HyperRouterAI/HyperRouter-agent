/**
 * Coding agent — reads files, edits them, applies changes to disk.
 *
 * Run inside a project directory:
 *   export HYPERROUTER_API_KEY=hr-...
 *   npx tsx examples/coding-agent.ts
 *
 * SAFETY: this example writes to your filesystem. Run it in a sandbox or
 * a git-clean directory so you can `git diff` to review changes.
 */

import { callModel, tool, stepCountIs, maxCost } from "@hyperrouter/agent";
import { z } from "zod";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const listDir = await tool({
  name: "list_dir",
  description: "List files and directories at a path.",
  inputSchema: z.object({ path: z.string().default(".") }),
  execute: async ({ path }) => {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
  },
});

const readFileTool = await tool({
  name: "read_file",
  description: "Read the contents of a file as UTF-8 text.",
  inputSchema: z.object({ path: z.string() }),
  execute: async ({ path }) => {
    return { path, content: await readFile(path, "utf-8") };
  },
});

const writeFileTool = await tool({
  name: "write_file",
  description: "Overwrite a file with the given content. Returns nothing on success.",
  inputSchema: z.object({ path: z.string(), content: z.string() }),
  execute: async ({ path, content }) => {
    await writeFile(path, content, "utf-8");
    return { ok: true, path, bytes: Buffer.byteLength(content) };
  },
  // Human-in-the-loop guard: in a real agent, prompt the user here before writing.
  onToolCalled: async ({ path }) => {
    // Refuse writes outside the current working directory.
    const cwd = process.cwd();
    const abs = join(cwd, path);
    if (!abs.startsWith(cwd)) {
      return { approved: false, reason: `refusing to write outside cwd: ${path}` };
    }
    return { approved: true };
  },
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    {
      role: "system",
      content:
        "You are a coding agent. Use list_dir / read_file / write_file to inspect and modify the project. Only make minimal, targeted edits.",
    },
    {
      role: "user",
      content:
        "Look at README.md and add a sentence to the bottom that says 'Last updated by an agent.'",
    },
  ],
  tools: [listDir, readFileTool, writeFileTool],
  stopWhen: [stepCountIs(15), maxCost(1.0)],
});

console.log(await result.getText());
console.log("\n---");
console.log(`Loop ran ${(await result.getSteps()).length} steps.`);
console.log("Usage:", await result.getUsage());
