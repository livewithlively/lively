# seed-knowledge — the source of truth for knowledge bodies seeded into new gateways

*[한국어](README.ko.md)*

The `<name>.md` files here (+ `manifest.json` metadata) are **the original (SoT) of the adapted bodies** used when seeding
**the runbooks the code assumes by name** (#713) into a new customer gateway. `seed-content.ts` seeds them idempotently at
startup (new = inserted, untouched seed = updated, operator edits = preserved permanently).

## Why they come from here and not from the WIKI DB (#846)
`capture-default-content.mjs` used to **snapshot the knowledge bodies from the Lively dev WIKI DB as-is**. But
our WIKI bodies mix in internal incident stories, `[[internal links]]`, internal issue numbers, and **other customers' names**, and those
leaked into customer boxes (leak observed in v0.1.148–150: a closeout metablock and another customer's domain structure). → The SoT for
seeded bodies was split out into this directory so that a DB capture can't overwrite it.

## Editing rules
1. **Adapt to the customer's context.** Remove our internal incident narratives, `[[wiki links]]`, internal issue numbers (the #nnn of internal projects),
   names of our own people, and **other customers' names**. References to product features (e.g., explanations of MCP arguments) can stay.
2. After editing a body, regenerate `src/org/delivery/default-content.ts` (the baked runtime seed) with
   **`node scripts/sync-seed-knowledge.mjs`** and check it with `git diff`. (Full regeneration, which needs a DB, is `capture-default-content.mjs`.)
3. `npm test` (seed-content.test) enforces a byte-for-byte match between default-content.ts and these files, plus the absence of internal traces.
   If you skip the sync or the adaptation, the test breaks and tells you.
4. To add a new piece of knowledge to the seed set: create a `manifest.json` entry + `<name>.md`, and
   also add it to `KNOWLEDGE_NAMES` in `capture-default-content.mjs` (the evidence that the code calls knowledge_get on that name).

> ⚠ **Don't edit the knowledge bodies in `src/org/delivery/default-content.ts` directly** — the next regeneration overwrites them
> (that is how #846 got re-contaminated). This directory is always the original for knowledge bodies.
