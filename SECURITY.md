# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Use GitHub's private vulnerability reporting instead:
**Security → Report a vulnerability** on this repository. That channel is private between you
and the maintainers until a fix is published.

If private reporting is unavailable to you, contact the maintainers directly rather than filing
a public issue.

### What to include

- What the vulnerability allows an attacker to do, in plain language
- Steps to reproduce, or a proof of concept
- Affected version or commit
- Any suggested fix, if you have one

### What to expect

- We aim to acknowledge a report within a few business days.
- We will tell you whether we consider it a vulnerability and, if so, our intended fix and
  timeline.
- We will credit you in the advisory unless you prefer otherwise.

We are a small team. We would rather receive a report that turns out to be a non-issue than miss
a real one — please err on the side of reporting.

## Supported versions

This project is pre-1.0 and moves quickly. Security fixes land on `main` and in the next release;
we do not currently backport to older tags.

## Scope

This repository is a self-hosted gateway. Its security model assumes:

- **Per-user authentication and scopes.** Every tool call resolves a user before doing anything;
  see `src/context.ts`. A path that reaches data without that resolution is a vulnerability.
- **The database is read-only and firewalled.** `db_query` allows a single `SELECT`, blocks
  dangerous functions, and denies sensitive tables (`src/db/firewall.ts`). A bypass — including
  one via renaming, expressions, or a second statement — is a vulnerability.
- **Secrets never enter content.** Tokens and keys are redacted from logs, proxied responses, and
  stored records (`src/org/ingest/redact.ts`). A path that persists or echoes a plaintext
  credential is a vulnerability.
- **Channel guards are fail-closed.** Private channels and DMs are denied by default until a
  human enables them (`src/org/channels/channel-guard.ts`). A path that reads or writes a
  conversation the operator has not allowed is a vulnerability.

Reports about the Enterprise directory (`src/ee/`) are equally welcome — the source is public
even though production use requires a subscription.

### Out of scope

- Findings that require the operator to have already configured the gateway insecurely (for
  example, granting a read-write database role, or issuing a token with scopes beyond intent).
- Denial of service through resource exhaustion on a self-hosted instance you control.
- Missing hardening headers on a deployment you operate, where the deployment is under your
  control to fix.
