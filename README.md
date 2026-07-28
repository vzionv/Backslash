# Backslash

A self-hosted, browser-based LaTeX workspace with live PDF preview, project collaboration, and a REST API. This edition runs directly against the host's TeX Live installation, stores application data in a local SQLite database, and does not require Docker.

## Features

- Project and template management, file trees, uploads, renaming, deletion, and ZIP export.
- Native TeX Live compilation using `auto`, `pdflatex`, `xelatex`, or `latex`.
- Bounded, cancelable in-process compilation queue with structured logs and build history.
- Lazy PDF page rendering, range requests, and streamed file/PDF downloads.
- API-key-based one-shot TeX compilation and project REST APIs under `/api/v1`.
- Socket.IO collaboration for presence, cursors, chat, file events, and build updates.
- Session authentication, project sharing, public share links, labels, and optional AI-assisted build repair and LaTeX writing.
- Native SQLite persistence through `better-sqlite3` 13.x and Drizzle, with WAL mode and transactional schema upgrades.
- Resource limits for request bodies, uploads, project storage, compilation queues, logs, output files, sessions, and projects.

## Architecture

```text
Browser
  ├─ HTTP       → apps/web (Next.js, SQLite, storage, compilation scheduling)
  └─ Socket.IO  → apps/ws  (presence, cursors, chat, collaboration events)

apps/ws  ── POST 127.0.0.1:WEB_INTERNAL_PORT/authorize ──→ apps/web
apps/web ── POST 127.0.0.1:WS_INTERNAL_PORT/events ──────→ apps/ws
```

`apps/web` is the only process allowed to read and write `backslash.db`. `apps/ws` does not open the database or modify project files. The services communicate through two loopback-only HTTP endpoints protected by `BACKSLASH_INTERNAL_SERVICE_KEY`.

If the WebSocket service is unavailable, the HTTP APIs continue to operate and the editor falls back to polling for build-state convergence.

### Deployment model

The current persistence, locking, rate-limiting, upload-slot, and compilation-queue design assumes **one writable Web process**. Do not run multiple Next.js writers, PM2 cluster workers, or multiple hosts against the same SQLite database and storage directory.

No production capacity claim is made by this repository. The default configuration runs at most two TeX processes concurrently and queues additional work within a fixed limit. Measure the Web process, SQLite/WAL activity, TeX child-process memory, queue latency, and disk I/O on the target host before changing the defaults.

## Requirements

- Node.js `>=22.5.0` (Node.js 24 LTS recommended)
- pnpm 10.x (the CI baseline)
- A recent TeX Live installation with `latexmk`
- `pdfLaTeX` and/or `XeLaTeX`
- Biber if your documents use Biber-based bibliographies
- Bash for the included startup and validation scripts

LuaLaTeX is intentionally not exposed by this native-host edition. Without an operating-system sandbox, LuaTeX file access cannot be isolated as reliably as the supported engines. Use XeLaTeX for Unicode and system-font workflows.

## Quick Start

### 1. Create the environment file

For a general host:

```bash
cp .env.example .env
```

For a Windows host using the Windows-specific example:

```bash
cp .env.windows.example .env
```

At minimum, configure two independent high-entropy secrets:

```env
BACKSLASH_INTERNAL_SERVICE_KEY=<independent random value>
SESSION_SECRET=<different independent random value>

APP_URL=http://localhost:3000
CORS_ORIGIN=http://localhost:3000
STORAGE_PATH=./data

# Leave empty when latexmk is already available on PATH.
LATEXMK_PATH=
```

Generate each secret separately:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

For LAN deployment, set `APP_URL` and `CORS_ORIGIN` to the browser-visible origin, for example `http://192.168.1.20:3000`.

### 2. Install dependencies

```bash
corepack enable
pnpm install --frozen-lockfile
```

### 3. Build and start

Production mode:

```bash
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash scripts/start.sh
```

Development mode:

```bash
BACKSLASH_MODE=development bash scripts/start.sh
```

The startup script validates the runtime, shared service key, and ports; starts the Web service; waits for the internal authorization endpoint; and then starts the WebSocket service.

LAN clients must be able to reach `WEB_PORT` (default `3000`) and `WS_PORT` (default `3001`). `WEB_INTERNAL_PORT` and `WS_INTERNAL_PORT` must remain bound to loopback and must not be exposed publicly.

## Configuration

The complete configuration reference is available in `.env.example` and `.env.windows.example`. Common settings include:

| Variable | Default | Purpose |
|---|---:|---|
| `WEB_PORT` | `3000` | Next.js HTTP port |
| `WS_PORT` | `3001` | Public Socket.IO port |
| `WS_HOST` | `0.0.0.0` | Socket.IO listen address |
| `WEB_INTERNAL_PORT` | `3010` | Loopback Web authorization port |
| `WS_INTERNAL_PORT` | `3011` | Loopback WS event-delivery port |
| `WS_INTERNAL_MAX_BODY_BYTES` | `4194304` | Maximum authenticated internal realtime-event payload |
| `WS_ACCESS_REVALIDATE_INTERVAL_MS` | `60000` | Interval for rechecking connected clients against current project access |
| `APP_URL` | `http://localhost:3000` | Browser-visible application origin |
| `CORS_ORIGIN` | `http://localhost:3000` | Allowed Socket.IO origin or comma-separated origins |
| `CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK` | `false` | Explicit opt-in required for `CORS_ORIGIN=*` |
| `BACKSLASH_INTERNAL_SERVICE_KEY` | — | Required shared key for internal service calls |
| `SESSION_SECRET` | — | Required session-signing and saved-AI-secret key |
| `SESSION_EXPIRY_DAYS` | `7` | Browser session lifetime in days |
| `MAX_SESSIONS_PER_USER` | `10` | Maximum active sessions retained per user |
| `BCRYPT_ROUNDS` | `12` | Password hashing work factor |
| `STORAGE_PATH` | `./data` | Root for SQLite, projects, and generated artifacts |
| `SQLITE_PATH` | `<STORAGE_PATH>/backslash.db` | Optional explicit SQLite file path |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | SQLite lock-wait timeout |
| `SQLITE_WAL_AUTOCHECKPOINT_PAGES` | `1000` | WAL auto-checkpoint threshold |
| `DEFAULT_LATEX_ENGINE` | `xelatex` | Default concrete engine |
| `COMPILE_TIMEOUT_MS` | `120000` | Per-compilation timeout in milliseconds |
| `MAX_CONCURRENT_COMPILATIONS` | `2` | Maximum simultaneously running TeX processes |
| `MAX_QUEUED_COMPILATIONS` | `200` | Maximum waiting compilation tasks |
| `MAX_CONCURRENT_CLEAN_TASKS` | `2` | Maximum simultaneous `latexmk` clean tasks |
| `COMPILE_LOG_MAX_BYTES` | `10485760` | In-memory compiler output limit |
| `BUILD_LOG_DB_MAX_BYTES` | `1048576` | Persisted build-log limit |
| `MAX_CONCURRENT_UPLOADS` | `2` | Maximum simultaneous multipart parsing tasks |
| `MAX_UPLOAD_FILE_COUNT` | `100` | Maximum files in one multipart upload |
| `MAX_UPLOAD_BATCH_BYTES` | `104857600` | Maximum total file bytes buffered in one multipart upload |
| `MAX_PROJECTS_PER_USER` | `100` | Maximum projects owned by one user |
| `ASYNC_COMPILE_BASE64_PDF_MAX_BYTES` | `10485760` | Maximum PDF size eligible for base64 API output |
| `MAX_TEXT_CONTENT_BYTES` | `5242880` | Maximum editable text-file size |
| `LATEX_ALLOW_SHELL_ESCAPE` | `false` | Enables TeX shell escape; unsafe for untrusted sources |
| `LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK` | `false` | Required explicit acknowledgement when shell escape is enabled |
| `LATEX_MAX_PROJECT_SIZE_MB` | `200` | Maximum project size accepted for compilation |
| `LATEX_MAX_OUTPUT_SIZE_MB` | `200` | Maximum generated PDF size |
| `ASYNC_COMPILE_RESULT_TTL_MINUTES` | `60` | One-shot API result retention period |
| `BUILD_RETENTION_DAYS` | `30` | Maximum age of terminal project builds |
| `BUILD_RETENTION_MAX_PER_PROJECT` | `50` | Maximum retained terminal builds per project |
| `NEXT_PUBLIC_WS_ENABLED` | `true` | Enables browser Socket.IO connections |
| `TRUST_PROXY_HEADERS` | `false` | Trusts proxy-supplied client/protocol headers when explicitly enabled |
| `HEALTH_DETAILS_ENABLED` | `false` | Includes detailed health diagnostics; use only on trusted networks |
| `AI_ALLOW_PRIVATE_ENDPOINTS` | `false` | Allows private/LAN AI endpoints and weakens the default SSRF boundary |
| `SECURE_COOKIES` | `false` | Uses secure session cookies; enable behind HTTPS |

## REST API

Create an API key in **Dashboard → Developer Settings**, then call `/api/v1` with Bearer authentication.

```bash
# Submit a one-shot compilation.
curl -X POST https://your-instance.example/api/v1/compile \
  -H "Authorization: Bearer bs_YOUR_API_KEY" \
  -F "file=@document.tex"

# Poll the job.
curl https://your-instance.example/api/v1/compile/JOB_ID \
  -H "Authorization: Bearer bs_YOUR_API_KEY"

# Stream the generated PDF.
curl "https://your-instance.example/api/v1/compile/JOB_ID/output?format=pdf" \
  -H "Authorization: Bearer bs_YOUR_API_KEY" \
  --output output.pdf
```

For completed one-shot jobs, the default `format=json` response returns metadata, logs, errors, and a PDF URL. Use `format=pdf` for streamed binary output. `format=base64` is available only for PDFs within the configured base64 size limit.

Common endpoints:

| Method | Endpoint | Purpose |
|---|---|---|
| `POST` | `/api/v1/compile` | Submit a one-shot compilation |
| `GET` | `/api/v1/compile/:jobId` | Read one-shot compilation status |
| `GET` | `/api/v1/compile/:jobId/output` | Read JSON metadata, base64, or streamed PDF output |
| `POST` | `/api/v1/compile/:jobId/cancel` | Cancel a one-shot compilation |
| `GET` / `POST` | `/api/v1/projects` | List or create projects |
| `GET` / `PUT` / `DELETE` | `/api/v1/projects/:id` | Read, update, or delete a project |
| `POST` | `/api/v1/projects/:id/files/upload` | Upload project files |
| `POST` | `/api/v1/projects/:id/compile` | Queue a project compilation |
| `GET` | `/api/v1/projects/:id/pdf` | Stream the latest project PDF |

Interactive API documentation is also available from the developer section of the running application.

## Development and Validation

```bash
pnpm test
pnpm --filter @backslash/web typecheck
pnpm --filter @backslash/ws typecheck
pnpm --filter @backslash/web build
pnpm --filter @backslash/ws build
bash scripts/validate.sh
```

Relevant documentation:

- [Windows TeX Live setup](docs/windows-latex-setup.md)
- [Compilation and realtime architecture](docs/compile-architecture.md)
- [Security boundary](docs/security-boundary.md)
- [Performance and capacity](docs/performance-and-capacity.md)
- [Test matrix](docs/test-matrix.md)
- [Contributing guide](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Security Notes

This project executes TeX binaries directly on the host. The application disables shell escape by default, invokes `latexmk` with `-norc`, validates project paths, applies Kpathsea restrictions, limits resources, and terminates process trees on cancellation or timeout. These controls reduce risk but are **not an operating-system sandbox**.

For deployments that accept untrusted source files:

- Run the services under a dedicated low-privilege operating-system account.
- Ensure that account cannot read unrelated secrets or private directories.
- Apply CPU, memory, process-count, file-count, disk, and outbound-network restrictions.
- Keep `LATEX_ALLOW_SHELL_ESCAPE=false` unless every author and source file is trusted. Enabling it also requires `LATEX_SHELL_ESCAPE_ACKNOWLEDGE_RISK=true`.
- Do not use `CORS_ORIGIN=*`. If an exceptional trusted deployment requires it, the server also requires `CORS_ALLOW_ANY_ORIGIN_ACKNOWLEDGE_RISK=true`.
- Use an HTTPS reverse proxy, configure the exact `APP_URL` and `CORS_ORIGIN`, and set `SECURE_COOKIES=true`.
- Keep the internal Web and WS ports on loopback only.
- Connected realtime clients are revalidated after share changes and periodically; keep `WS_ACCESS_REVALIDATE_INTERVAL_MS` at a suitably short value for the deployment.
- Configure request-body and timeout limits at the reverse proxy as well as in the application.
- Back up both the SQLite database and project-storage directory, and test restoration.

Please report exploitable vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Repository Hygiene

Before creating a public repository, confirm that the commit contains none of the following: `.env`, `.git/` from another repository, PID files, SQLite databases or WAL/SHM sidecars, project storage, compiler output, `.next`, `dist`, or `node_modules`. The supplied `.gitignore` excludes these paths, but it cannot remove files that were already committed. Rotate any secret that has ever appeared in an archive, issue, log, or commit.

## Project Origin and Acknowledgements

This project is a substantially modified derivative of [Manan-Santoki/Backslash](https://github.com/Manan-Santoki/Backslash), originally created by Manan Santoki and released under the MIT License.

This edition has been extensively reworked for direct host deployment, native TeX Live compilation, local SQLite persistence, LAN access, bounded resource usage, transactional file operations, and hardened authentication and compilation workflows.

The original copyright and MIT License notice are preserved in this repository. This project is independently maintained and is not affiliated with, sponsored by, or endorsed by the original author.

Special thanks to Manan Santoki and all contributors to the original Backslash project for making their work available to the community.

## License

This project is distributed under the [MIT License](LICENSE).

The repository contains substantial portions derived from the original Backslash project. The upstream copyright and license notice must remain in the distributed source and in copies containing substantial portions of that code. See the `LICENSE` file for the complete notices and terms, and [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) for attribution details.
