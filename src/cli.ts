/**
 * @hyperrouter/agent CLI. (shebang added by tsup banner config)
 *
 *   npx @hyperrouter/agent init [dir]    Scaffold a new agent project.
 *   npx @hyperrouter/agent run <file>    Run a TS agent file via tsx.
 *   npx @hyperrouter/agent doctor        Check env, connectivity, key.
 *   npx @hyperrouter/agent --help        Show this.
 *   npx @hyperrouter/agent --version     Print version.
 */

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { HYPERROUTER_BASE_URL } from "./http-client.js";

const argv = process.argv.slice(2);
const cmd = argv[0];

const c = {
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
};

function printHelp() {
  console.log(`${c.bold("@hyperrouter/agent")} — agent loop framework for Hyper Router

${c.bold("Commands")}
  init [dir]      Scaffold a new agent project
  run <file>      Run a TypeScript agent file (uses tsx)
  doctor          Check environment and connectivity

${c.bold("Options")}
  --help          Show this help
  --version       Print version

${c.bold("Examples")}
  npx @hyperrouter/agent init my-agent
  npx @hyperrouter/agent run agent.ts
  npx @hyperrouter/agent doctor

Docs: https://hyperrouter.ai/docs/agent`);
}

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    // dist/cli.js → dist/.. → package.json
    const pkgPath = resolve(here, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

/* ───────────── init ───────────── */

const INIT_AGENT_TS = `import { callModel, tool, stepCountIs, maxCost } from "@hyperrouter/agent";
import { z } from "zod";

const echo = await tool({
  name: "echo",
  description: "Echo back whatever the user says.",
  inputSchema: z.object({ text: z.string() }),
  execute: async ({ text }) => ({ echoed: text }),
});

const result = callModel({
  model: "anthropic/claude-sonnet-4.6",
  messages: [
    { role: "system", content: "You are a friendly agent. Try the echo tool once." },
    { role: "user", content: "Say hello." },
  ],
  tools: [echo],
  stopWhen: [stepCountIs(5), maxCost(0.10)],
});

for await (const chunk of result.getTextStream()) process.stdout.write(chunk);
console.log("\\n---");
console.log("Usage:", await result.getUsage());
`;

const INIT_PACKAGE_JSON = (name: string) => ({
  name,
  version: "0.1.0",
  private: true,
  type: "module",
  scripts: {
    start: "tsx agent.ts",
  },
  dependencies: {
    "@hyperrouter/agent": "^0.1.0",
    zod: "^3.23.0",
  },
  devDependencies: {
    tsx: "^4.0.0",
    typescript: "^5.5.0",
  },
});

const INIT_TSCONFIG = {
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "bundler",
    strict: true,
    esModuleInterop: true,
    skipLibCheck: true,
  },
};

const INIT_README = `# Agent project

Run:

\`\`\`bash
export HYPERROUTER_API_KEY=hr-...
npm install
npm start
\`\`\`

Edit \`agent.ts\` to customize.
`;

function runInit(dir: string): void {
  const target = resolve(process.cwd(), dir);
  const name = dir.split("/").pop() || "my-agent";
  if (existsSync(target)) {
    console.log(c.red(`Directory ${target} already exists. Aborting.`));
    process.exit(1);
  }
  mkdirSync(target, { recursive: true });
  writeFileSync(join(target, "agent.ts"), INIT_AGENT_TS);
  writeFileSync(join(target, "package.json"), JSON.stringify(INIT_PACKAGE_JSON(name), null, 2) + "\n");
  writeFileSync(join(target, "tsconfig.json"), JSON.stringify(INIT_TSCONFIG, null, 2) + "\n");
  writeFileSync(join(target, "README.md"), INIT_README);
  console.log(c.green(`✓ Created ${target}`));
  console.log("\nNext steps:");
  console.log(`  cd ${dir}`);
  console.log("  export HYPERROUTER_API_KEY=hr-...");
  console.log("  npm install");
  console.log("  npm start");
}

/* ───────────── run ───────────── */

function runFile(file: string): void {
  const target = resolve(process.cwd(), file);
  if (!existsSync(target)) {
    console.log(c.red(`File not found: ${target}`));
    process.exit(1);
  }
  if (!process.env.HYPERROUTER_API_KEY) {
    console.log(c.yellow("⚠ HYPERROUTER_API_KEY is not set. The agent will fail to authenticate."));
    console.log("  export HYPERROUTER_API_KEY=hr-...");
    console.log("");
  }
  // Use tsx to run the file. tsx must be installed (we list it as devDep in
  // the init template; for ad-hoc use, `npx tsx` is also fine).
  const child = spawn("npx", ["--yes", "tsx", target], {
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code) => process.exit(code ?? 0));
}

/* ───────────── doctor ───────────── */

async function runDoctor(): Promise<void> {
  let ok = true;
  console.log(c.bold("@hyperrouter/agent doctor\n"));

  // Node version
  const nodeVer = process.versions.node;
  const [major] = nodeVer.split(".").map((n) => Number(n));
  if (major !== undefined && major >= 18) {
    console.log(`${c.green("✓")} Node.js ${nodeVer} (>=18 required)`);
  } else {
    console.log(`${c.red("✗")} Node.js ${nodeVer} — version 18+ required`);
    ok = false;
  }

  // API key
  const apiKey = process.env.HYPERROUTER_API_KEY;
  if (!apiKey) {
    console.log(`${c.red("✗")} HYPERROUTER_API_KEY not set`);
    console.log(`  ${c.dim("Create one at https://hyperrouter.ai/dashboard/api-keys and export it.")}`);
    ok = false;
  } else if (!apiKey.startsWith("hr-")) {
    console.log(`${c.yellow("?")} HYPERROUTER_API_KEY does not start with 'hr-' — is this a Hyper Router key?`);
  } else {
    console.log(`${c.green("✓")} HYPERROUTER_API_KEY set (${apiKey.slice(0, 8)}…)`);
  }

  // Zod version check — Zod v4 with our default JSON-Schema bridge produces
  // empty schemas, so tools get called with no arguments. Warn loudly.
  // Use createRequire instead of `import "zod/package.json" with { type: "json" }`
  // because the import-attribute syntax isn't supported across all Node 18+
  // build pipelines (TS without proper assertions support, older tsx, etc.).
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const zodPkg = req("zod/package.json") as { version: string };
    const ver = zodPkg.version;
    const [major] = (ver ?? "0").split(".").map(Number);
    if (major === undefined) {
      console.log(`${c.yellow("?")} zod installed but version unreadable`);
    } else if (major >= 4) {
      console.log(`${c.red("✗")} zod ${ver} — version 4 is not yet supported, please install zod@^3.22.0`);
      ok = false;
    } else if (major < 3) {
      console.log(`${c.red("✗")} zod ${ver} — too old, please install zod@^3.22.0`);
      ok = false;
    } else {
      console.log(`${c.green("✓")} zod ${ver}`);
    }
  } catch {
    console.log(`${c.yellow("?")} zod not installed — tools with typed inputs will fail. Run: npm install zod@^3`);
  }

  // zod-to-json-schema check — direct dep since 0.1.3. Without it, tools'
  // Zod input schemas are converted to empty placeholders, models get no
  // argument hints, and tool calls return empty args (Zod validation then
  // fails with confusing "expected string, received undefined" errors).
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const z2jPkg = req("zod-to-json-schema/package.json") as { version: string };
    console.log(`${c.green("✓")} zod-to-json-schema ${z2jPkg.version}`);
  } catch {
    console.log(`${c.red("✗")} zod-to-json-schema not resolvable — tool argument schemas will be empty, tool calls will fail. Run: npm install zod-to-json-schema@^3`);
    ok = false;
  }

  // Connectivity
  const baseUrl = process.env.HYPERROUTER_BASE_URL ?? HYPERROUTER_BASE_URL;
  try {
    const res = await fetch(`${baseUrl}/models`, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      console.log(`${c.green("✓")} ${baseUrl} reachable (HTTP ${res.status})`);
    } else if (res.status === 401) {
      console.log(`${c.red("✗")} ${baseUrl} returned 401 — API key invalid or revoked`);
      ok = false;
    } else {
      console.log(`${c.yellow("?")} ${baseUrl} returned HTTP ${res.status}`);
    }
  } catch (e) {
    console.log(`${c.red("✗")} Could not reach ${baseUrl}: ${(e as Error).message}`);
    ok = false;
  }

  console.log("");
  if (ok) {
    console.log(c.green("All checks passed."));
  } else {
    console.log(c.red("Some checks failed. Fix the issues above before running an agent."));
    process.exit(1);
  }
}

/* ───────────── dispatch ───────────── */

async function main(): Promise<void> {
  if (cmd === "--version" || cmd === "-v") {
    console.log(readPackageVersion());
    return;
  }
  if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") {
    printHelp();
    return;
  }
  if (cmd === "init") {
    runInit(argv[1] ?? "my-agent");
    return;
  }
  if (cmd === "run") {
    if (!argv[1]) {
      console.log(c.red("Usage: npx @hyperrouter/agent run <file>"));
      process.exit(1);
    }
    runFile(argv[1]);
    return;
  }
  if (cmd === "doctor") {
    await runDoctor();
    return;
  }
  console.log(c.red(`Unknown command: ${cmd}`));
  printHelp();
  process.exit(1);
}

main().catch((e) => {
  console.error(c.red(`Error: ${(e as Error).message}`));
  process.exit(1);
});
