# Security Policy

## Supported version

Security fixes are applied to the current release branch. Deployments should use the exact lockfile and a supported Node.js LTS release.

## Reporting a vulnerability

Do not open a public issue for an exploitable vulnerability. Use the repository’s private vulnerability-reporting channel when available, or contact the maintainer privately. Include:

- affected commit and deployment mode;
- reproduction steps and minimal proof of concept;
- expected impact;
- logs with secrets, tokens, email addresses, project contents and absolute paths removed.

Allow the maintainer reasonable time to reproduce and publish a fix before public disclosure.

## Trust boundary

This project executes TeX binaries on the host. `-no-shell-escape`, `latexmk -norc`, path checks, quotas, timeouts and process-tree termination reduce risk but are not an operating-system sandbox. Public or untrusted deployments should run the Web/TeX process as a dedicated low-privilege account with filesystem, CPU, memory, process-count and outbound-network restrictions.

Custom AI endpoints are server-side outbound requests. Private and reserved addresses are denied by default. Administrators should prefer an explicit hostname allowlist and network egress policy.

See [`docs/security-boundary.md`](docs/security-boundary.md) and [`AUDIT_REPORT.md`](AUDIT_REPORT.md) for deployment requirements and residual risks.
