# Security Policy

## Reporting a vulnerability

If you find a security vulnerability, do NOT open a public issue.

Email the maintainer or open a private GitHub security advisory at:
https://github.com/rynald0cst0ltziam/Warden-AI/security/advisories/new

Include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact

You will receive a response within 48 hours.

## Scope

- The Warden MCP server codebase
- The install scripts (install.sh, postinstall.cjs)
- The dashboard HTTP server

## Out of scope

- Vulnerabilities in dependencies (report to the dependency maintainer)
- Social engineering attacks
- Issues requiring physical access to a machine

## Security measures in Warden

- Trust guard verifies every pruned line is verbatim — no silent rewrites
- Dashboard bound to localhost (127.0.0.1) only
- CSP headers on dashboard responses
- SQL identifier validation on all dynamic queries
- CSV injection prevention in audit export
- No telemetry, no phone-home, no external network calls
