import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    target: "es2022",
    external: ["zod"],
  },
  {
    entry: ["src/cli.ts"],
    format: ["esm"],
    splitting: false,
    sourcemap: false,
    clean: false,
    target: "es2022",
    external: ["zod"],
    banner: { js: "#!/usr/bin/env node" },
  },
]);
