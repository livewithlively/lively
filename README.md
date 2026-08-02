# Lively

**An AX solution for IT product organizations**

Lively is a **normalized store of work context that accumulates and maintains itself through AI**.
It injects the right context into every member's AI, so that everyone gets **the best of what AI can do — without the gap between people**.

*[한국어](README.ko.md) · [Architecture docs](docs/architecture.ko.md)*

---

## The problem

### AI knows everything in the world, except your company

Models are already smart enough. But your products and code, your decisions and progress, exist nowhere in their training data. What separates outcomes is not how intelligent the AI is — it is **whether the AI knows your company**.

1. **Models no longer create the gap.** Your competitors use the same ChatGPT and Claude you do. Model capability has levelled up across the board.
2. **The gap comes from the context you give the AI.** The moment the same model works while knowing your product, your code, your decisions, it stops being a generic tool and becomes part of your company's capability.
3. **That context is currently left unattended.** It is scattered across messengers, documents, code, and meetings, and it appears and disappears inside individual chat windows. Nobody collects it. Nobody owns it.

> **You can buy a model. You cannot buy context.**
> Your company's context exists only inside your company — and only the company that collects it and hands it to AI gets that advantage.

### Right now, nobody maintains your company's memory

It is not that search fails. It is that when you find something, you can't tell what's still true; what you organize goes stale; and what you did today isn't there tomorrow.

| | What actually happens |
|---|---|
| **It finds things, but you can't tell which is right** | A two-year-old document and last week's changed decision come back side by side. The AI reads the old one and confidently gives a wrong answer. |
| **What you organize goes stale fast** | So you build a wiki. But the business changes daily, and maintaining it is nobody's job. The wiki starts aging the day it's written. |
| **What you did with AI today is gone tomorrow** | Teammate A reaches a conclusion with AI today; tomorrow teammate B's AI knows none of it. When the conversation ends, nothing remains in the organization. |

All three share one cause: **no one owns the company's memory.**
Lively hands that ownership to AI rather than to a person.

---

## What Lively is

### 1. A store of work context that AI accumulates and maintains automatically

Messages and email, documents and issues, code and decisions, and the output of AI sessions themselves — all collected into one store, organized, and injected into AI at the moment it's needed. Members have exactly one job: **open Lively and ask Claude.**

```
Scattered sources                Lively                        Every member's AI session
messages · email
docs · drive        ─ collect ─▶  work context store  ─ inject only what's needed ─▶  Claude / Codex / …
code · commits                (distill · classify · link)
decisions · notes                     ▲
issues · tasks                        └────── session output becomes company knowledge again
```

- **Collect & store** — *distill* (drop the chatter, keep facts and decisions) · *classify* (file it in its place in your taxonomy) · *link & embed* (connect relationships, quantify meaning)
- **Accumulate & maintain** — *self-authoring* (AI creates projects and knowledge when needed) · *link & refresh* (new knowledge is connected, stale knowledge is updated) · *dedupe & review* (duplicates are filtered, humans can review)
- **Inject only what's needed** — *injection levels* (only what matters gets injected in full) · *keyword & semantic search* (AI finds and reads on its own) · *automatic injection* (knowledge relevant to the question or the code arrives on its own)

### 2. Standardized AI sessions — everyone inherits the same tooling, regardless of setup skill

**One person's setup becomes the organization's standard.** Custom skills, hooks, and MCP integrations built by your AI-fluent members are promoted into Lively so every member can use them immediately. The floor rises, and as everyone's improvements accumulate, so does the ceiling.

A tool an engineer built for themselves gets mounted automatically in a product manager's AI too. The release-check skill from a backend lead, the read-replica integration from a data engineer, the internal-search MCP from a platform engineer — whoever opens a session, those tools come along.

| Starting point | Reached by individual setup | Filled in by Lively |
|---|---|---|
| Product manager (Claude app/web) | 30 | +70 |
| Engineer (Claude Code) | 70 | +30 |
| Engineering lead (Claude Code + Skills) | 90 | +10 |

Wherever you start, Lively fills in the rest.

### 3. How Lively builds high-quality context

Lively separates company context into **projects** and **knowledge**, and stores both according to your taxonomy. Project to project, project to knowledge, knowledge to knowledge — everything accumulates with its links, and you view and manage that structure directly in Lively's project screens.

A project *requires* knowledge and *produces* knowledge. It leads to follow-up projects, and knowledge links to knowledge. Every project and every piece of knowledge is stored in its place in the taxonomy, together with its connections.

You manage projects, tasks, and the knowledge linked to them right in Lively — no separate PM tool required.

### 4. A context layer that stands apart from any AI model

Different teams — sometimes different people on the same team — use different models. Lively manages company context in **an independent layer above the AI**, so you are **never locked to a particular model**: keep what you have, or swap it whenever you want.

```
        Lively — the company context layer
                  ⇅  swap anytime
   Claude   Gemini   ChatGPT   others
   Swap the model; the context stays in this layer
```

- **Keep your current setup** — We don't ask you to change tools. Connect Lively to the AI your team already uses, and from that day they work with the same company context. *(zero tool migration, zero retraining)*
- **Keep the best combination** — Model capability and pricing flip within months. Swap per team or per person and maintain the best mix at any given time. *(zero context migration when you switch)*
- **Doesn't stop at an outage** — If one vendor has an outage or changes policy, move to another AI and continue with the same context. *(instant failover, continuity of work)*
- **A store without lock-in** — Your company's context is never trapped in an AI vendor's account. Managed or self-hosted, **the store belongs to you**. *(your asset survives vendor shutdowns and price hikes)*

### 5. Managed for convenience, self-hosted for data sovereignty

| | **Managed** (operational ease) | **Self-hosted** (data sovereignty) |
|---|---|---|
| Where | Your workspace in the Lively cloud | Your infrastructure, inside your network perimeter |
| Install, ops, updates | We handle them. Fastest start, nothing to prepare | Installed whole, inside your perimeter |
| Data | Only your members can access it; every access is logged | The original of your company's memory exists only inside your perimeter |
| Egress | — | Only the fragments your policy gate allows leave. The store is never shipped out wholesale |
| Air-gapped | — | Connect a local model for a fully air-gapped setup with zero external traffic |
| Recommended for | The default for most organizations | Security- and compliance-driven organizations |

If your security requirements grow, you can move from managed to self-hosted.
**Change AI tools, keep your knowledge** — the store isn't tied to any vendor, so swapping harnesses carries your organization's knowledge with it.

---

## Why Lively

### Four weeks in, in members' own words

We deployed Lively to the product organization of an AI company. Below are their week-four survey responses and what actually happened.

> "Even in domains I'd never reviewed, pointing it at knowledge my teammates had distilled cut down the trial and error before a good answer."
> — from a member who noted that with local Claude Code, even with a maintained `CLAUDE.md`, an unfamiliar domain still had to be explained by prompt every time

> "I could give instructions in natural language instead of going through the dev team to write queries. This past week I've moved most of my requirements writing into Lively too."
> — from a PO who pulled conversion funnel data directly in an AI session

> "The efficiency and speed exceeded what I'd been getting from local Claude Code, and it had real impact on actual work, so I can recommend it."
> — the reason given by a PO who was already fluent with local Claude Code, alongside a recommendation score of 9

**Case 1 — The AI surfaced review criteria the PO didn't know about**
While planning a revision to a review feature, context about criteria that had been changed in discussion with another department was injected automatically, and the AI proactively suggested those criteria be reflected in the plan. The project concluded successfully with context the PO had not been aware of.

**Case 2 — A cross-department request, from intake to conclusion in one day**
An anomaly investigation in a data domain with no assigned engineer was triple-verified by AI — measuring 6,096 source records and checking the code — and concluded the same day.

> "A solution that uses our company's context and data so that every member can use AI effectively."
> — one member's one-line definition of Lively, from the survey

### Why Lively rather than AI training, consulting, or a SaaS add-on

| | What it does well | What still remains |
|---|---|---|
| **General AI training** | Tool usage and prompting technique. Individual skill genuinely improves | When training ends, everyone returns to their own habits, and the organizational process and context gaps remain |
| **General AX consulting** | Diagnosis through implementation. A good partner will actually build you a system | What you're left with is a bespoke build from that moment. Operating and improving it after the consultant leaves is back on you, and it doesn't keep updating like a product |
| **General AI collaboration tools** | Search and summarization inside each tool are already excellent | Context stays trapped inside each tool, and what it finds doesn't accumulate as organizational knowledge |

**Lively is different.**

- **Organizational knowledge that accumulates through judgment** — even AI-authored knowledge passes duplicate checks, review, and refresh. It doesn't degrade with use; it gets more accurate with use.
- **Even AI's work is attributed to projects** — who, which AI, in which project, produced what, recorded automatically. Organizations become able to manage AI's work.
- **A finished product, self-hosting included** — when you need sovereignty, it installs whole into your infrastructure. You're installing a finished product, not assembling parts.
- **Harness-neutral** — Claude Code or Codex, the same context is injected. Switch AI tools and your organization's knowledge stays.

### The combinations you've likely already evaluated leave the same gap

| Combination | What it does well | The gap that remains |
|---|---|---|
| **All-in-one AI subscription** | Search, memory, and policy management under one subscription with no extra vendor. The cheapest, fastest start | Memory is a flat file at the individual or repo level, and search re-scans the sources each time rather than accumulating. No project axis, no self-hosting |
| **AI harness + document SaaS** | Best-in-class collaborative editing, plus search across many sources under one subscription | AI-generated pages pile up without review or dedupe. The better you use it, the more polluted search gets — and code, databases, and data sovereignty live outside it |
| **AI harness + enterprise search** | 100+ connectors and permission-aware search. The right answer for the search axis at large enterprises | A read-only index gives AI output no home to accumulate in. Seat minimums and tens of thousands per year make it excessive for mid-sized organizations and below |
| **Assemble it yourself** (memory SDKs, OSS stack) | Maximum sovereignty and freedom of component choice, with zero license cost | Search, memory, and projects are three to five systems that don't know about each other. Your organization builds the integration, operations, and UI over 6–12 months — and then maintains it |

Lively fills that gap as a finished product. It sits on top of the harnesses and tools you already use, leaving them as they are.

### "Our engineering team is building this ourselves"

That's an excellent start — the more forward-leaning the organization, the earlier its engineers move. But that path runs into three **structural** limits.

1. **The builders aren't the users.** Engineers publish skills and wire up internal tools over MCP. But faced with terminals and config-file syntax, **the PMs, POs, and planners who need a UI** are left outside. Those who can't use it go back to the browser chat.
2. **The busiest people's "later."** Company-wide horizontal work always loses to **roadmap items with hard deadlines**. It slips a rank every sprint, and most often stops half-built.
3. **The inefficiency of a system for one company.** The engineers who can build this are **your most expensive people**. Pouring their time into a system only one company will ever use is less efficient than using a shared system whose development and maintenance costs are spread across many organizations.

Your engineering team's time belongs on **your product**. The context infrastructure already exists.

---

## Lively is a fit if you are

- **A team fixing the product × engineering collaboration structure** — round trips to re-confirm specs, lost decisions, late rework. Companies trying to cut the invisible cost between planning and engineering.
- **A team using AI without organization-level impact** — already using AI tools, but the results stay with the few individuals who are good at it.
- **An organization whose context is scattered across tools** — decisions in chat, specs in docs, tasks in a tracker, and nobody who sees the whole picture in one place.
- **A CPO or CTO who wants AI transformation validated in real use** — leaders who want to confirm impact in an actual in-flight project, not in a report or a demo.

## How adoption works

There are only two things to prepare on your side.

1. **Claude Code (or Codex) plans for your product team** — Lively doesn't resell AI; it makes your AI know your company. The execution layer should run on your own plans and API keys. If you already use them, there's nothing more to prepare.
2. **Read access to your work tools, code, and databases** — for AI to know your company, it needs to reach where that memory lives, **read-only**. We agree the collection scope and permission policy up front, and we never connect a channel you haven't approved.

| | | Cost |
|---|---|---|
| **Week 0** | 30-minute consultation and demo — assessment of your collaboration structure and tooling, plus a product walkthrough | Free |
| **Week 1** | Installation and data migration — our engineers install it and migrate your existing context as initial knowledge | Free |
| **Weeks 2–4** | Real usage — every role uses it on an actual in-flight project, with 1:1 onboarding per role | ~1 month free |
| **Week 5 —** | Decision — decide against the usage record. Continue on a monthly subscription, or we'll clean up the environment | Monthly subscription |

No penalties, no lingering obligations.

Contact: **lively@lvly.io**

---

## Installing it yourself (self-hosted)

Requires Node.js 20+ and PostgreSQL.

```bash
git clone https://github.com/livewithlively/lively.git
cd lively
cp .env.example .env      # set tokens and database URLs
npm ci
npm run build
npm start
curl localhost:8080/healthz
```

Point an MCP client at `http://localhost:8080/mcp` with a bearer token from `AUTH_TOKENS_JSON`.
Docker Compose and installation scripts for a dedicated box live in [`deploy/`](deploy/).

- [`docs/architecture.ko.md`](docs/architecture.ko.md) — architecture, code conventions, subsystem map (Korean)
- [`deploy/README.md`](deploy/README.md) — installing on a server
- [`kit/README.md`](kit/README.md) — the member kit: CLI, harness adapters, hooks

## Licensing

Three licenses apply, decided entirely by directory.

| Path | License |
|---|---|
| `kit/` | Apache-2.0 |
| `src/ee/` | Lively Enterprise License (production use requires a subscription) |
| Everything else | AGPL-3.0-only |

`src/ee/` is **optional**. The core never imports it statically, so you can delete `src/ee/` and the project still builds and runs. The **basic safety mechanisms live in the core (AGPL)** — the SQL firewall, table policy, secret redaction, channel guards — because the free edition should not be the dangerous one.

We've published our commitments: `kit/` stays Apache-2.0 permanently, we will not move the core to SSPL or BUSL, and we will not move functionality that is AGPL today into `src/ee/` — **[LICENSING.md](LICENSING.md)**.

The name follows a trademark policy, not the code license: [TRADEMARK.md](TRADEMARK.md). Fork freely; just rename your fork.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Contributions require signing a short [CLA](CLA.md); a bot will walk you through it on your first pull request.

Please report security vulnerabilities through the private channel in [SECURITY.md](SECURITY.md) rather than a public issue.

---

Copyright (c) 2026 윤상민 (Sangmin Yoon), 장원준 (Wonjun Jang)
