# Licensing

This repository contains code under **three different licenses**. Which one applies is
determined **solely by the directory a file lives in**.

| Path | License | What it is |
|---|---|---|
| `kit/` | **Apache-2.0** (`kit/LICENSE`) | The member kit — CLI, harness adapters, hooks, templates. Everything that runs on a member's own machine. |
| `src/ee/` | **Lively Enterprise License** (`src/ee/LICENSE`) | Enterprise features. Source-available: you may read, modify and test it, but **production use requires a valid subscription**. |
| Everything else | **AGPL-3.0-only** (`LICENSE`) | The gateway server, web UI, connectors, domain map, deployment tooling. |

If a file is not inside `kit/` or `src/ee/`, it is AGPL-3.0-only.

## The Enterprise directory is optional

`src/ee/` is **not required to build or run this software**. The core does not statically
import it: at boot, `src/enterprise/load.ts` looks for the Enterprise module and registers
it if present. Delete `src/ee/` and the project still compiles and runs — you simply do not
have the Enterprise features.

This is a deliberate design choice. It means the AGPL portion of this repository is a
complete, self-contained, working product, not a crippled shell that needs proprietary code
to function.

What lives in `src/ee/` today:

- Column masking and the masking policy engine
- Just-in-time raw-PII unmask grants (role-based, expiring, maker-checker)
- Hash-chained data access audit log
- Unstructured PII scrubbing for proxied responses
- The organisation-wide ingest policy gate
- External IdP login (SSO / OIDC), including account linking and domain-allowlist provisioning
- Audit-log CSV export (the on-screen audit views themselves stay core)
- Break-glass: time-boxed, reasoned, audited access beyond the visibility rules
- Connector-level source visibility policy and its retroactive backfill (enforcement stays core)

Everything else — including the SQL firewall, table allow/deny policy, secret redaction, and
per-channel read/write guards — is core AGPL code, because **basic safety belongs in the free
edition**. We sell compliance, not safety.

Some things look like compliance and are not. Audit-log retention and pruning stay core: their
job is to stop personal usage records piling up forever, so moving them would make the free
edition the one that hoards data. Session history and resume stay core too: that is the web
terminal, which is the product.

Visibility is worth stating precisely, because it is the one place where the free edition is
genuinely narrower. Enforcement is core: a box that drops `src/ee/` keeps honouring every
visibility policy it already has, and nothing silently opens up. Scoping knowledge and projects
is core as well — project lists, project members, teams and shared-folder ACLs are how that is
done, and all of them stay AGPL. What is Enterprise is **authoring connector-level source
policy** ("material from this Slack channel is for this team only") and backfilling it over
existing material. Since that is currently the only way source-level visibility gets set, a
free-edition box can enforce source policies but cannot start using them. Keeping connector
material out in the first place is a separate mechanism, and it is core: the channel guards
decide what is ingested at all.

If a compliance policy is configured in the database but the Enterprise module is absent, the
core **refuses the request** rather than silently ignoring the policy. A missing feature and an
unenforced policy are not the same thing.

That rule protects data; it is not a lock on the door. Where the Enterprise feature *is* the
door — SSO — its absence simply removes a login option: the SSO button does not appear, and
local password login, which is core and always enabled, still works. The free edition always
lets you in. Where SSO is configured but the Enterprise module is missing, the admin screen
says so plainly, because failing silently is worse than failing.

## Our commitments

These are promises we intend to keep, published here so you can hold us to them:

1. **`kit/` stays Apache-2.0, permanently.** The code that runs on your own machines will never
   be relicensed to something more restrictive.
2. **We will not move the core to SSPL, BUSL, or any other non-open-source license.** Loosening
   (for example, AGPL → Apache) remains possible; tightening does not.
3. **The free edition stays a complete, working product.** Basic safety and the core value of
   the product stay AGPL. Enterprise governance and compliance features may live in `src/ee/`.

## Contributing

Contributions require signing a lightweight Contributor License Agreement — see
[CONTRIBUTING.md](CONTRIBUTING.md) and [CLA.md](CLA.md). This is what allows us to offer the
Enterprise Terms alongside the AGPL, and to relicense more permissively in the future.

## Trademarks

The license above covers **code**, not names. "Lively" and associated logos are trademarks and
are governed separately — see [TRADEMARK.md](TRADEMARK.md). You may fork this software freely;
you may not present your fork as the official product.

## Frequently asked

**We run this internally, unmodified. What do we owe?**
Nothing. The AGPL's source-provision obligation is triggered by conveying modified versions or
by offering modified versions to users over a network. Running an unmodified copy inside your
organisation creates no obligation to us or anyone else.

**We modified it and use it internally only.**
Still nothing owed to us. Your own users — if you offer the modified version to them over a
network — are entitled to the corresponding source under AGPL §13.

**Our legal team prohibits AGPL entirely.**
Commercial licensing of the core is available; a subscription agreement can supersede the AGPL
for your organisation. This is the standard arrangement for regulated customers.

**Can we use `src/ee/` code for evaluation?**
Yes. Reading, modifying and testing are permitted without a subscription. Production use is not.

---

*This document explains our licensing intent in plain language. The license files themselves are
what legally binds — where this summary and a license text disagree, the license text governs.*
