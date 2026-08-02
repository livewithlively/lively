# Lively

**One governed source of organizational context for every AI agent your team runs.**

Lively is a self-hosted [MCP](https://modelcontextprotocol.io) gateway. Local AI coding
agents — Claude Code, Codex, openclaw, and anything else that speaks the Model Context
Protocol — connect to a single endpoint and see the same organizational knowledge, project
state, domain map, and read-only database access, under per-user authentication and scopes.

```
Claude Code ┐
Codex       ├─ Streamable HTTP /mcp, Bearer ─▶  Lively gateway  ─▶  knowledge · projects · domain map · DB (read-only)
openclaw    ┘                                   └ the single boundary for auth, scope, and audit
```

## The problem

Every agent your team runs builds its own private context and throws it away. Decisions made in
one session are invisible to the next one, to the person sitting next to you, and to the agent
they are running. Meanwhile the actual context lives scattered across Slack, Notion, ClickUp,
your issue tracker, and people's heads.

Lively makes that context a first-class, shared, governed resource: written once, recalled by
anyone, with a boundary you control.

## What you get

- **Knowledge store** — the durable record: decisions, designs, runbooks. Full text, searchable
  lexically and semantically (pgvector hybrid search, optional).
- **Classification axes and domain maps** — how your organization is actually cut up, including
  the gap between what a domain *should* be and what the code *is*.
- **Projects and tasks** — project ▸ task ▸ subtask, with activity tracking that ties commits to
  the domains they touched.
- **Connectors** — Slack, Notion, ClickUp, Gmail, Google Drive, Discord. Mirror external sources
  in, distill them into knowledge.
- **Database access** — `db_query` / `db_schema` over your read replicas, behind a SQL firewall
  (single SELECT only, dangerous functions and sensitive tables denied) and row-level isolation.
- **Per-user auth and scopes** — every tool call resolves a user first. Tokens are revocable
  without a restart.
- **A web UI** — administration, knowledge browsing and editing, project boards, terminals.

Everything runs on your own box. Nothing phones home.

## Quick start

Requires Node.js 20+ and PostgreSQL.

```bash
git clone <repository-url> lively
cd lively
cp .env.example .env      # set tokens and database URLs
npm ci
npm run build
npm start
curl localhost:8080/healthz
```

Then point an MCP client at `http://localhost:8080/mcp` with a bearer token from
`AUTH_TOKENS_JSON`. Docker Compose and installation scripts for a dedicated box live in
[`deploy/`](deploy/).

## Documentation

- [`README.ko.md`](README.ko.md) — architecture, code conventions, and subsystem map (Korean)
- [`deploy/README.md`](deploy/README.md) — installing on a server
- [`kit/README.md`](kit/README.md) — the member kit: CLI, harness adapters, hooks

## Licensing

This repository contains code under three licenses, decided **entirely by directory**:

| Path | License |
|---|---|
| `kit/` | Apache-2.0 |
| `src/ee/` | Lively Enterprise License (production use requires a subscription) |
| everything else | AGPL-3.0-only |

`src/ee/` holds enterprise compliance features — column masking, JIT unmask grants, hash-chained
access audit, PII scrubbing, the ingest policy gate. **It is optional.** The core does not
statically import it; delete `src/ee/` and the project still compiles and runs. Basic safety —
the SQL firewall, table policy, secret redaction, per-channel guards — is core AGPL code, because
the free edition should not be the dangerous one.

We have published commitments about what we will and will not do with these licenses, including
that `kit/` stays Apache-2.0 permanently and that we will not move existing core functionality
into `src/ee/`. See **[LICENSING.md](LICENSING.md)**.

The name is not covered by those licenses — see [TRADEMARK.md](TRADEMARK.md). Fork freely; rename
your fork.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require a short
[CLA](CLA.md) — a bot will prompt you on your first pull request.

Please report security vulnerabilities privately to the maintainers rather than in a public issue.

---

Copyright (c) 2026 윤상민 (Sangmin Yoon), 장원준 (Wonjun Jang)
