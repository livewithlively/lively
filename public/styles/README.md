# public/styles — per-screen stylesheets (split from the old single styles.css, #1313 R50)

*[한국어](README.ko.md)*

This is `public/styles.css` (8,600 lines · 537 commits in 6 months), once the file with the most churn in the repo, cut **exactly along the section-comment boundaries inside the file**
and split by screen. The split didn't change a single character — concatenating the 30 files from the time of the split (`01-`~`30-`) in the order below
was **byte-identical** to the pre-split `styles.css`. More files have been added since, as screens grew.

## ⚠ Order is the contract

The CSS cascade is "later overrides earlier". The files in this directory inherited their positions in the old single file
as-is, and in several places a later file actually overrides rules from an earlier one
(e.g. the "EOF self-contained block" in `17-projects-board-ext.css`, the media queries in `22-responsive.css`).

- The single source of load order is **the list of `<link>`s in `public/index.html`**.
- The numeric file-name prefixes (`01-` … `90-`) make that order visible, and are meant to make name order = cascade order
  (the concatenation in `scripts/check-css-drops.mjs` also joins files in name order).
- **Don't reorder.** Moving files or changing prefixes silently breaks screens.
- When several files share a number, **their order among themselves is set by the list in index.html** — it can differ from name order. The `49-v2-*`
  trio loads as ctx → taxonomy → projpane (name order is ctx·projpane·taxonomy); the taxonomy-app and task-pane tests lock that order.
  (#4501 — renaming them to 49a·49b·49c was reverted: a test on another branch pointed at the old name right away and broke. Renaming a
  file breaks every branch in flight, so pick a number nobody else uses when you create a new file.)

## Adding new rules

1. Put them in the file for the screen you're fixing, near the existing rules (that's the point of the split — keeping the blast radius local).
2. If a specificity fight means it has to be "at the very end", append it to the end of the last file.
3. If you create a new file, you **must** add it to the `<link>` list in `public/index.html` at the matching position.
   (Otherwise the file is never loaded at all — the server does scan the directory, but only to compute the cache version.)

## Serving / cache

`listLocalAssets()` in `src/web-assets.ts` (#2643 — `src/web.ts` uses it for serving) scans the local assets, including `public/styles/*.css`, and builds one build version from the
content hash of all local assets (#1017). When `index.html` is served, `?v=<version>` is
injected into each `<link href>`, and requests whose `?v=` matches the current version are answered as `immutable`. So when you change CSS, a single F5 picks it up.

## Guard

`node scripts/check-css-drops.mjs` — checks, **against the concatenation**, that no top-level selector in HEAD has disappeared from the working tree
(prevents a repeat of #317). It runs as a non-blocking warning during deploys (`scripts/restart-gateway.sh`).

## Order (= index.html list)

| # | File | Screen/scope |
|---|------|-----------|
| 01 | `01-base.css` | §1 color tokens · §2 base typography · page overlay scrollbar · focus ring · skip link |
| 02 | `02-shell.css` | Top bar (wordmark · tabs · right-side utilities) · body shell |
| 03 | `03-components.css` | Shared components — cards · page header · grid · pills/badges · buttons · forms · list rows · markdown body · skeletons · login gate · toasts |
| 04 | `04-domain-curation.css` | Domain curation (absorbed from domainmap) — `.dm-*` · `.maprow` · seg-tabs |
| 05 | `05-admin.css` | Admin tab (#/system) — two-column master-detail · members/tokens · audit |
| 06 | `06-learn.css` | User guide (#/learn) — flywheel · install onboarding · session transcripts |
| 07 | `07-knowledge-map.css` | Knowledge map / explore / unit detail / review · knowledge (#/knowledge) chips · knowledge↔project links |
| 08 | `08-activity.css` | Work status (#/dash) — member summary + work timeline |
| 09 | `09-screens-batch.css` | The "new (8 screen improvements)" batch — edit split view · unit meta bar · hook overview · danger buttons |
| 10 | `10-terminal.css` | Terminal/AI sessions (#/terminal) — team folders · two-way work-location choice · session board (#745) |
| 11 | `11-domainmap.css` | Domain map (#/domainmap) — should/is two columns + gaps |
| 12 | `12-categories.css` | Taxonomy (#/categories) — category tree CRUD |
| 13 | `13-projects.css` | Projects (#/projects2) board · detail — tile badges · task tree · linked knowledge · detailed settings popup |
| 14 | `14-files-upload.css` | File preview (`.ft`) · upload progress/cancel bar (#797) — shared by projects and dashboard |
| 15 | `15-projects-task-modal.css` | Custom fields (+ add column) · task detail modal (`.pjv-tm`) · Activity · tag picker · subtasks |
| 16 | `16-projects-board.css` | Project list (ClickUp-style list) · session injection map · 'View' popover · area sidebar |
| 17 | `17-projects-board-ext.css` | #317 restored block · list groups (#280) · folder›list three levels (#475) · status icons (#499/#500) |
| 18 | `18-notion-mirror.css` | #551 lossless Notion mirror — rich body + page tree + ClickUp migration UI |
| 19 | `19-connectors.css` | #586 connector UX — status cards · guides · pickers · run logs · WIKI sidebar |
| 20 | `20-dashboard.css` | Dashboard (#/dashboard) — cockpit widgets · my to-dos · edit mode · team shared folders |
| 21 | `21-wiki-notion.css` | #657 Notion-style WIKI — block editor · ⌘K · icons/covers · redesign (#657r/t/w) |
| 22 | `22-responsive.css` | #701 full responsive overhaul (≤760 / ≤820) |
| 23 | `23-projects-editor-status.css` | #730 body block editor mount · #729 status scheme templates |
| 24 | `24-wiki-redesign.css` | #764 WIKI rebuild (v2 aurora · v3 briefing front page · v4 five projections · v6 front-page builder) |
| 25 | `25-projects-detail-modal.css` | Project detail popup (`.pjv-pm`) |
| 26 | `26-docs-guide.css` | User guide = docs site (#780) — sidebar · guide cards · switchable tabs |
| 27 | `27-start-onboarding.css` | Sidebar scrollbar (shared) · storage · logs (#813) · getting started (#/start) checklist |
| 28 | `28-guide-diagrams.css` | Guide diagram primitives — `:::axes` · `:::fig` · `:::wire` · `:::shot` · #1000 getting started |
| 29 | `29-projects-board-header.css` | Project board three-layer top header (#1067) — breadcrumbs · view tabs · toolbar · popovers |
| 30 | `30-projects-views.css` | #1067 views — table · timeline (Gantt) · hierarchy (#1305) · dependency lines (#1308) |
| 31 | `31-context-pipeline.css` | [Context management] tab (#1419 T6) — pipeline overview + per-stage management screens · left sidebar layout (#1584) |
| 32 | `32-file-share.css` | Share links (#1436) — full-page landing (#/f) · copy-link fallback box |
| 33 | `33-distiller-page.css` | Distiller settings page (#1564, `#/context/distill/<key>`) — three full-width columns |
| 34 | `34-service-logins.css` | [Settings ▸ External services] service logins (#1597) — two sections, connected / available · service tiles |
| 35 | `35-liv.css` | Liv (#/liv) — action cards + conversation (#1631) |
| 36 | `36-chat.css` | Shared chat view additions (web/chat-view.ts) + session conversation screen + desktop variant (#1719) |
| 37 | `37-projects-hub.css` | Project detail = tool widget hub (#3916) — three-column widget grid · resizing (#4164) · layout editing |
| 40 | `40-v2.css` | New single-tab shell (#1719) + classic embed (?embed=1) — reclaims classic rules after the classic files (`01`~`37`) |
| 41 | `41-onboarding.css` | First-time setup (#/welcome, #1813) — all classes use the `ob-` prefix |
| 42 | `42-v2-panes.css` | New shell project = docked screen — splitting/collapsing panes (session · sources · knowledge · timeline) |
| 42 | `42-v2-dock.css` | Side-pane dock (#4443, `web/v2/pane-dock.ts`) — seam pill on the session/side-pane boundary (default) or a pill at the bottom of the side pane that scales with its width; magnification, labels, context menus, the More panel |
| 43 | `43-v2-topbar-search.css` | Desktop window top line (tab row) · sidebar back/forward · unified search spotlight |
| 44 | `44-desktop-update.css` | Notice bar for updates the desktop app has downloaded (#1838) |
| 45 | `45-v2-side-swap.css` | When the side pane passes half the width, the main pane moves to the center (#1819) — paired with `web/v2/side-swap.ts` |
| 46 | `46-v2-me.css` | New shell [My profile · Preferences] window (#1843) — a two-column overlay opened by the bottom-left [Me] row |
| 47 | `47-v2-rail.css` | New shell **far-left rail** (#2016) — workspace nameplate · four areas · recent apps · [Apps]/[Me] + per-area sidebar parts |
| 48 | `48-v2-sources.css` | Sources app (#2423) reading room — list + original in two panes · app-owned sidebar |
| 49 | `49-v2-ctx.css` | Context menu (#3784) — only what the engine (`web/v2/ctx-menu.ts`) adds (the skeleton is in `42-v2-panes.css`) |
| 49 | `49-v2-taxonomy.css` | "Taxonomy" app (#4233) · full map · things to fix · category detail (link diagram) · group cleanup window. In name order, after `49-v2-ctx.css` and before `50-mobile.css` |
| 49 | `49-v2-projpane.css` | Side-pane "Project" app (#4135, `web/v2/panes-tasks.ts`) — layered on top of `.pn-tk-*` in `42-v2-panes.css` |
| 50 | `50-mobile.css` | Full phone (≤640px) overhaul (#4088) — bottom tab bar · lists take one full screen · side-pane drawer · tables show only the title column · vertical track for the flow map · ClickUp-mobile-style project board (#4231). Reclaims the narrow-width rules scattered across screen files near the end of the cascade (before 52-guide · 90-dark) |
| 52 | `52-guide.css` | "User guide" app (#4179, `web/guide/*.ts`) — three panes: doc list · body · on this page · width decided by container query |
| 90 | `90-dark.css` | Dark theme (#1683) — full dark redefinition of the light tokens in `01-base.css` (two paths: `data-theme="dark"` · `prefers-color-scheme: dark`) + the '§보정' (fixes) section at the bottom. The very end of the cascade |
