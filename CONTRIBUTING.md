# Contributing to Backslash

Thank you for helping improve this native TeX Live edition of Backslash. Contributions are welcome for correctness, security, performance, accessibility, documentation, tests, and platform support.

By submitting a contribution, you agree that it may be distributed under the repository's [MIT License](LICENSE). Do not submit code, assets, fonts, templates, or documentation that you do not have the right to redistribute.

## Code of Conduct

Be respectful and constructive. Discuss technical decisions, not people. Harassment, discrimination, personal attacks, or deliberate disruption are not acceptable.

## Project Structure

This repository is a `pnpm` monorepo:

- `apps/web`: Next.js UI, HTTP APIs, authentication, the only SQLite writer, project storage, compilation scheduling, and artifact retention.
- `apps/ws`: Independent Socket.IO collaboration service.
- `packages/shared`: Types, constants, validation contracts, and cross-service event definitions.
- `templates`: Bundled LaTeX project templates.
- `tests`: Unit, integration, runtime, storage, database, security, compiler, and browser-oriented tests.
- `docs`: Architecture, deployment, security, performance, and validation documentation.

`apps/web` is the only process allowed to open and write `backslash.db`. The WebSocket service must not access the database file or project-storage directory directly. It authorizes users through the Web loopback endpoint and receives file/build events through the WS loopback endpoint.

## Supported Architecture and Non-Negotiable Boundaries

Before changing core infrastructure, preserve these constraints unless the pull request explicitly redesigns and documents them:

1. **Single writable Web process.** Project locks, rate limits, upload slots, and compilation queues are process-local. Multiple Web writers are unsupported with the current SQLite/storage model.
2. **Native host TeX Live.** Compilation must go through the shared compiler modules and must not silently reintroduce Docker-only assumptions.
3. **No LuaLaTeX exposure without a real sandbox.** The supported request engines are `auto`, `pdflatex`, `xelatex`, and `latex`.
4. **No direct user-path concatenation.** Resolve and validate project-relative paths through the storage security helpers.
5. **Disk and database changes must remain consistent.** Use project mutation locks, staged path mutations, and SQLite transactions for multi-step writes.
6. **Public responses must not expose server paths, secrets, internal service keys, or unnecessary internal identifiers.**
7. **Large inputs and outputs must be bounded.** Avoid unbounded `request.json()`, `formData()`, file reads, logs, arrays, queues, or response buffering.
8. **TeX execution is not an OS sandbox.** Do not weaken `latexmk -norc`, shell-escape policy, Kpathsea restrictions, process-tree termination, timeouts, or resource limits without a documented threat analysis and tests.

## Local Development Setup

### Requirements

- Node.js `>=22.5.0` (Node.js 24 LTS recommended)
- pnpm 10 or newer
- A recent TeX Live installation with `latexmk`
- `pdfLaTeX` and/or `XeLaTeX`
- Biber for Biber bibliography fixtures
- Bash for the included scripts

### Configure the environment

Create a root `.env` file from one of the examples:

```bash
cp .env.example .env
# or
cp .env.windows.example .env
```

Generate independent values for the two required secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Set at least:

```env
BACKSLASH_INTERNAL_SERVICE_KEY=<first random value>
SESSION_SECRET=<different random value>
APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
```

Do not use production secrets, personal API keys, or real user data in development fixtures.

### Install and run

```bash
corepack enable
pnpm install --frozen-lockfile
BACKSLASH_MODE=development bash scripts/start.sh
```

To run the services separately, both processes must receive the same root environment configuration:

```bash
pnpm --filter @backslash/web dev -- --port 3000
pnpm --filter @backslash/ws dev
```

## Development Workflow

1. Create a focused branch from the current default branch.
2. Add or update tests that reproduce the bug or define the new behavior.
3. Make the smallest coherent change that solves the problem without weakening existing boundaries.
4. Run the checks relevant to the modified area.
5. Update documentation, environment examples, API docs, and changelog entries when behavior or configuration changes.
6. Review the final diff for generated files, secrets, absolute paths, database files, and unrelated formatting churn.

## Coding Conventions

- Use strict TypeScript.
- Use two-space indentation, semicolons, and double quotes.
- Prefer explicit, typed error classes for domain errors that map to HTTP status codes.
- Keep HTTP response semantics stable unless the change intentionally versions or documents the API.
- Keep Socket.IO event names and payload contracts synchronized across Web, WS, hooks, and shared definitions.
- Place reusable cross-service contracts in `packages/shared` when runtime packaging permits it.
- Avoid hidden fire-and-forget failures. Background cleanup may log and continue, but data-integrity failures must be surfaced.
- Prefer streaming for PDFs, ZIP archives, and large files.
- Keep in-memory collections, logs, task histories, request bodies, and queues bounded.
- Do not add dependencies for functionality already provided by the platform or existing project utilities without explaining the trade-off.

## Database Changes

The Web application uses `better-sqlite3` 13.x with Drizzle and WAL mode. Schema initialization and upgrades are managed by the idempotent migration registry in `apps/web/src/lib/db/sqlite-schema.ts`.

When changing the database schema:

1. Update `apps/web/src/lib/db/schema.ts`.
2. Add a new, forward-only migration version in `apps/web/src/lib/db/sqlite-schema.ts`.
3. Keep migrations transactional and idempotent where practical.
4. Test both a new empty database and an upgrade from an existing database.
5. Add indexes for new query patterns and keep result sets bounded.
6. Do not generate or apply PostgreSQL migrations to the SQLite runtime.
7. Do not open the database from `apps/ws` or another writable process.

Never rewrite or renumber a migration that may already have been released.

## File and Storage Changes

All user-controlled paths must pass through the project path-normalization and symlink checks. Filesystem and database operations that represent one user action must not be implemented as unrelated best-effort writes.

Use the existing abstractions for:

- project-level mutation locking;
- staged file replacement, move, and removal;
- transactional metadata updates;
- project quota validation;
- upload-batch validation and rollback;
- streamed file responses and range requests;
- snapshot-based ZIP export.

Tests for storage changes should include failure injection or rollback coverage, not only successful paths.

## Compiler Changes

Project and one-shot compilation share the compiler queue and process-execution infrastructure. Compiler changes must preserve:

- `spawn(..., { shell: false })`;
- `latexmk -norc`;
- shell escape disabled by default;
- supported-engine policy;
- validated main-file paths;
- project and output size limits;
- bounded logs and persisted logs;
- timeout and cancellation behavior;
- complete process-tree termination;
- cleanup of temporary work directories;
- terminal build states when enqueueing, replacement, cancellation, or shutdown fails.

New engine support requires a written security analysis, real malicious-input tests, documentation updates, and a deployment story that addresses filesystem and process isolation.

## Authentication and Security Changes

For changes involving authentication, authorization, sharing, API keys, AI endpoints, file access, or internal HTTP services:

- validate request media types and body sizes before parsing;
- use uniform error responses where account or token enumeration is possible;
- keep session cookies HttpOnly and do not return session tokens in normal JSON responses;
- verify resource ownership in the same query or transaction as the mutation;
- avoid trusting proxy headers unless `TRUST_PROXY_HEADERS=true` and the deployment proxy overwrites them;
- preserve SSRF protections and redirect restrictions for configurable outbound endpoints;
- add rate limits or concurrency limits to expensive public operations;
- remove secrets, email addresses, source contents, absolute paths, and tokens from logs and fixtures.

Report suspected exploitable vulnerabilities privately according to [SECURITY.md](SECURITY.md), rather than opening a public issue with a working exploit.

## Realtime Changes

Realtime changes must be tested with at least two independent browser sessions or clients. Verify:

- authorization for owner, editor, viewer, public-share, and unauthenticated cases as applicable;
- presence behavior with multiple tabs for the same user;
- cursor and document-change payload validation;
- reconnect and leave behavior;
- file create, save, rename, and delete events;
- build status delivery;
- event size and frequency limits;
- continued HTTP API operation when the WS service is stopped.

Do not make the WS service a second database or storage writer.

## Testing and Validation

Run the tests affected by your change. Before opening a pull request, run the full available suite whenever the environment supports it:

```bash
pnpm test
pnpm --filter @backslash/web typecheck
pnpm --filter @backslash/ws typecheck
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash validate.sh
```

For compiler or TeX-security changes, also run the native TeX fixtures under `tests/compile` and `tests/security`.

For user-interface changes, test the affected workflow in current Chromium and Firefox releases. Include error paths such as duplicate clicks, failed saves, permission denial, oversized inputs, network interruption, refresh, and reconnect—not only the happy path.

If a required check cannot be run, state exactly why in the pull request and list the unverified behavior. Do not describe an unexecuted test as passing.

## Documentation

Update all relevant documentation when changing:

- environment variables or defaults;
- supported platforms or TeX engines;
- API request/response formats;
- resource limits or retention behavior;
- security boundaries;
- database schema or migration behavior;
- startup, reset, backup, or recovery procedures.

At minimum, keep `.env.example`, `.env.windows.example`, `README.md`, developer API documentation, and the related file under `docs/` consistent.

## Commits

Use Conventional Commits. Examples:

```text
fix(storage): roll back uploaded files when metadata insertion fails
feat(api): add streamed project artifact endpoint
test(compiler): cover process-tree cancellation on timeout
docs(security): clarify native TeX trust boundary
```

Keep commits focused and reviewable. Do not combine large formatting changes with behavioral changes unless formatting is the explicit purpose of the commit.

## Pull Requests

A pull request should include:

- the problem being solved and why the change is needed;
- the implementation approach and important trade-offs;
- commands actually run and their results;
- screenshots or recordings for visible UI changes;
- migration, configuration, compatibility, and retention implications;
- security and performance considerations for sensitive paths;
- known limitations or checks that could not be executed.

Reviewers may request smaller commits, additional failure-path tests, updated threat analysis, or capacity evidence for changes affecting compilation, storage, authentication, or concurrency.

## Files That Must Not Be Committed

Do not commit:

- `.env` files containing real values;
- SQLite database, WAL, or shared-memory files;
- project data or user documents;
- compilation outputs and temporary work directories;
- PID or runtime-state files;
- API keys, tokens, passwords, private endpoints, or SMTP credentials;
- dependency directories or platform-specific generated artifacts unless explicitly tracked by the project;
- test logs containing secrets, personal data, or absolute private paths.

## Project Origin

This repository is an substantially modified derivative of [Manan-Santoki/Backslash](https://github.com/Manan-Santoki/Backslash). Preserve the upstream copyright and MIT License notice when redistributing substantial portions of the original code.
