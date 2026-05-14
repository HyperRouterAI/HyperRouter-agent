# @hyperrouter/agent — Changelog

## [0.1.3] — 2026-05-14

### Fixed

- **🚨 P0: tool argument schemas silently empty when `zod-to-json-schema` not installed** — `schema.ts:zodToJsonSchema` lazy-imported `zod-to-json-schema` and fell back to `{ type: "object", properties: {}, additionalProperties: true }` on import failure. Since `zod-to-json-schema` was NOT listed as a dependency / peerDependency, fresh installs (`npm install @hyperrouter/agent zod`) would consistently fall into this branch — every tool's input schema became an empty placeholder, the model received no argument hints, returned `{}` for arguments, and downstream Zod validation failed with confusing "expected string, received undefined" errors. Tool calls appeared to work (they were dispatched) but always with no args.
  Fix: (1) added `zod-to-json-schema` to `dependencies` (auto-installed with the SDK), (2) the fallback path now logs a loud one-time `console.error` warning so future install failures aren't silent, (3) `doctor` command now explicitly checks `zod-to-json-schema` resolvability and fails the health check if missing.

- **P0b: `model: string[]` → 400 from HR backend** — `CallModelInput.model` was typed as `string | string[]` but Hyper Router's `/v1/chat/completions` Fastify schema only accepts `model: { type: "string" }`. Real fallback-chain calls were returning `400 body/model must be string`. Split the single overloaded field into two:
  - `model: string` — the primary slug (required, always string)
  - `fallbackModels?: string[]` — ordered fallback chain
  Internally these map to the backend's `model` + `models[]` shape (HR backend uses `models[0]` as primary when present). Type signatures, README examples, and the streaming loop request body all updated. Also removed the now-dead `Array.isArray(input.model)` defensive fallback in `streaming-loop.ts` since `input.model` is statically `string` now.

### Changed

- **Version**: 0.1.2 → 0.1.3.

## [0.1.2] — 2026-05-13

### Fixed

- README polish, error-flow misclaim correction, abortController + idempotency scope, cost SSE comment parsing, routedModel fallback, Zod v3 pin.

## [0.1.1] — 2026-05-12

### Fixed

- Align response headers with HR backend; implement `budgetExhausted`.

### Added

- Type-inference utilities + tool best-practices.

## [0.1.0] — 2026-05-08

### Added

- Initial release: callModel agent loop, tools, stop conditions (stepCountIs / maxCost / stopOnFallback / budgetExhausted), streaming, observability.
