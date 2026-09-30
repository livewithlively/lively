# ORG-CONTENT-GUIDE — Writing organization content

*[한국어](ORG-CONTENT-GUIDE.ko.md)*

Organization content (`<org>-org`) is the **input** to the product (the kit, `kit/`, formerly named `workflow-std`) on the file-based distribution path.
This document explains what each file is and what goes in it, and how to bootstrap a new organization.
> ※ A Lively instance keeps organization content in the **gateway DB (wiki)** and distributes it through `/install` (the `lively-org` file repo was retired on 2026-06-24). This guide is for the `--init`/`--publish` file-based path (other organizations, portability).
For the overall structure and lifecycle, see the wiki: `knowledge_grep "architecture"`.

> **Core model:** Organization content is an independent repo created by running a **one-time init** of the product's `template-org`.
> After that you never pull template-org again (separate repo → zero git-pull conflicts). Evolution happens through `--check` + CHANGELOG opt-in.

---

## 1. Files

| File | What | Required? | Where it is composed |
|---|---|---|---|
| `org/org-defaults.md` | Company context, agent persona, ways of working | **Required** | Body of CLAUDE.md (@import) and AGENTS.md (inline) |
| `org/managed-policy.md` | Enforced (intended to be non-overridable), short rules | Optional | **Top** of the composed output (highest priority) |
| `memory/knowledge-index.md` | Canonical memory index (+ `memory/*.md` bodies) | Optional | End of the composed output (linked md files are published along with it, 1 level deep) |
| `members/<id>.md` | One profile + identity frontmatter per person | Recommended | Only the `_template.md` sample is copied into the artifact (personal files never leak) |
| `members/_template.md` | Sample a new person copies from (underscore = not a member) | Recommended | Copied into the artifact as is |
| `members/_bindings.md` | Identity bindings for non-human principals (bots, systems) | Optional | Not published (source only; read by the gateway's load-bindings) |
| `members/local.md` | Personal layer (each person copies `_template.md`) | Optional | gitignored — never committed or published |
| `gateway-url` | Internal MCP gateway address | Optional | The file itself isn't published (on member machines, `~/.lively/gateway-url` is written by the one-line installer or `lively login --gateway`) |

### Writing rules
- **`org/org-defaults.md`** is the only hard requirement (the core of the composition). If anything else is missing, the generator **skips** it (not an error).
- The memory index file name is **`memory/knowledge-index.md`** (the name the generator composes). The `template-org` skeleton creates it under this name from VERSION 2 (#4501). Orgs initialised from VERSION 1 should rename `memory/MEMORY.md` to this name — if you leave it as is, it isn't composed (`--check` reports it as a missing optional layer).
- **`org/managed-policy.md`** is always loaded at the top of the composed output, so keep **only short, absolute rules** (5–7 or fewer recommended). Recommendations go in org-defaults.
  - Real "non-overridable" enforcement comes not from the text but from deploying Claude managed-settings / Codex `requirements.toml` (see `adapters/claude/managed-settings.example.json`). Left alone, these are composed as recommended rules.
- **The composed AGENTS.md must be 32KiB or less** (the Codex global instructions limit). `--check` checks and blocks it.
- **The `email` in `members/` frontmatter is the join key across sources** (it automatically matches the same person across discord/slack/PM tools/notion). If a human member has no email, `--check` warns.
- Don't write `@import` lines in member/org files — the generator handles composition itself.

---

## 2. Bootstrap checklist for a new organization

```
init → fill → set gateway-url → check → publish → distribute
```

1. **init** — copy the skeleton into an empty directory:
   ```bash
   node kit/generator/build-context.mjs --init ../acme-org
   ```
   (Refuses if the directory isn't empty — `--force` overwrites, and `.git` is preserved. `.template-version` is stamped.)
2. **fill** — replace the `<placeholder>`s in `org/org-defaults.md`, `org/managed-policy.md`, and `members/<id>.md` with real content.
3. **set gateway-url** — put the internal MCP gateway address on one line in the `gateway-url` file (leave it empty if there is none → context only, no live data).
   - `~/.lively/gateway-url` on member machines is written not from this file but by the one-line installer (`curl -fsSL <gateway>/cli | sh` — the gateway bakes its own address into the script) or by `lively login --gateway <url>`.
4. **check (doctor)** — check for missing items, placeholders, and lint (read-only):
   ```bash
   node kit/generator/build-context.mjs --check ../acme-org
   ```
5. **publish** — assemble the member distribution (install artifact):
   ```bash
   node kit/generator/build-context.mjs --org ../acme-org --publish ../acme-context-setup --harness claude
   # Multiple harnesses:  --harness claude,codex
   ```
6. **distribute** — each member runs the one-line installer (`curl -fsSL <gateway>/cli | sh`) once → gets context + reflexes whichever folder they start in. Login defaults to browser approval (device code) and falls back to masked input — the token never appears on the command line.

> The generator doesn't run git init/remote/commit — the operator creates the organization content and the published artifact as separate, independent repos.

---

## 3. Evolution (when the product starts expecting new fields)

Organization content doesn't track template-org, so there are **no git merge conflicts**. Instead:

1. The generator is **tolerant** of missing files/fields (missing → default/skip, never a crash). Organization content initialized from an older version keeps building.
2. `--check <org-dir>` compares `.template-version` (stamped at init) with the current `template-org/VERSION` and
   reports **"optional fields added since init"**.
3. Read `template-org/CHANGELOG.md` to see what was added, and **opt in to only what you want** (not mandatory).

What `--check` reports:
- Missing required (`org/org-defaults.md`) · missing recommended (managed-policy, knowledge-index, _template)
- `.template-version` missing/mismatched (notes on new options)
- Lint: human member without email · managed-policy too long · composed AGENTS over 32KiB (blocking error)
- Unfilled placeholders · missing gateway-url · no registered members

---

## 4. Memory curation

```
auto-memory during a session (local, personal) → review (PR) → approve/dedupe/scope
                                          → promote to canonical → commit to memory/ → republish → everyone reruns setup
```
Only canonical entries go in the `memory/knowledge-index.md` index, one line per item. Bodies go in `memory/<name>.md`.
