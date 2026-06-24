// 구조 리프레시 = git diff 적용 (deterministic; NO LLM here) — store-core.mjs 이식.
// 웹훅(전달자, webhook.ts)과 분리: refresh 는 '무엇을 바꾸나', webhook 은 '어떻게 호출되나'.
//
// Update the store from a git diff (name-status) WITHOUT ever silently corrupting
// confirmed mappings. The LLM judgment pass handles the flagged residue separately.
//
// payload = { base?, head?, changes: [ {status, from?, to?, path?, score?} ] }
//   status 'R' rename from->to (score = git similarity 0-100)
//   status 'A' add   path
//   status 'D' delete path
//   status 'M' modify path  (structural no-op; content re-eval is the LLM pass)
//
// HARD INVARIANT (enforced in code below; do not weaken):
//   refresh() NEVER changes any mapping.category_id (구 domain_id) and NEVER re-derives
//   a confirmed mapping from a path. The only mapping/project_touch "preservation" mechanism is
//   ROW IDENTITY: a rename UPDATEs the SAME code_unit row (same id), so every mapping
//   and project_touch that references that id survives untouched — refresh issues no
//   write whatsoever against the `mapping` table. Deletes are SOFT (state='removed')
//   and flagged; adds land unmapped in the inbox. Silence on uncertainty is
//   forbidden: low-confidence renames, orphaned confirmed deletes, and unmapped adds
//   are all surfaced (debt_finding 'structural_drift' / left-unmapped).
//
// All writes run inside ONE transaction on a single client and are audited via
// changelog.logChange. A mid-payload failure rolls the whole refresh back.
import { one, q, withTx } from "../db.js";
import { httpErr, type Actor, type RefreshResult } from "./types.js";
import { logChange } from "./changelog.js";
import { flagStructuralDrift } from "./debts.js";
import { setLastRefreshedSha } from "./repos.js";
import { aggregateFileChanges } from "./aggregate.js";

const now = () => new Date().toISOString();

// Best-effort code_unit kind from a path (deterministic; falls back to 'file').
function kindFromPath(path: string): string {
  const ext = (path.match(/\.([a-z0-9]+)$/i)?.[1] ?? "").toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return "module";
  if (["py", "rb", "go", "rs", "java", "kt", "swift", "php", "c", "cc", "cpp", "h", "hpp", "cs", "scala", "ex", "exs"].includes(ext)) return "module";
  if (["sql", "prisma"].includes(ext)) return "schema";
  if (["json", "yaml", "yml", "toml", "ini", "env"].includes(ext)) return "config";
  if (["md", "mdx", "txt", "rst"].includes(ext)) return "doc";
  return "file";
}

// (file-diff → code_unit 집계 aggregateFileChanges 는 core/aggregate.ts 로 분리 — PURE/no-DB.
//  granularity:'file' 분기에서 import 해 쓴다. 엔진/불변식은 이 파일이 그대로 소유.)

// Normalize a code_unit row's state (pre-migration rows may have NULL).
function COALESCE_state(row: any): string { return row.state ?? "active"; }

export async function refresh(repoName: string, payload: unknown, actor: Actor | null | undefined): Promise<RefreshResult> {
  const p: any = typeof payload === "string" ? JSON.parse(payload) : payload;
  const rawChanges: any[] = Array.isArray(p.changes) ? p.changes : [];
  const act: Actor = actor ?? { type: "agent", id: "agent" };
  const result = await withTx(async (client) => {
    // Resolve repo inside the txn so a bad name rolls back cleanly with a 404.
    const repo = await one(client, "SELECT * FROM repo WHERE name=$1", [repoName]);
    if (!repo) throw httpErr(404, "no such repo: " + repoName);
    const repo_id = repo.id;
    // Record this refresh as a scan_run for provenance (mirrors ingest()).
    const sr = await one(client, "INSERT INTO scan_run(repo_id,runbook,harness,actor_type,actor_id,started_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id",
      [repo_id, "refresh-structure", p.harness ?? null, act.type, act.id, now()]);
    const run_id = sr.id;

    // --- Granularity front-end. Default 'unit' = current behavior (callers pass
    // changes already at code_unit granularity; CLI/synthetic unit-level callers
    // unchanged). granularity:'file' = git speaks FILE paths but our code_units are
    // module-level, so first NORMALIZE the file changes onto the existing code_unit
    // granularity (longest-prefix ownership; dir-move = file-rename cluster → one
    // module rename; new dir = candidate unit; file add/modify/delete inside an
    // existing module = no-op). The RESULTING unit-level changes then go through the
    // EXISTING apply loop below — engine/invariant untouched.
    const granularity = (p.granularity ?? "unit") === "file" ? "file" : "unit";
    let changes = rawChanges;
    let aggregation = null;
    if (granularity === "file") {
      const unitRows = await q(client,
        `SELECT path FROM code_unit WHERE repo_id=$1 AND COALESCE(state,'active')='active'`, [repo_id]);
      const agg = aggregateFileChanges(rawChanges, unitRows.map((r) => r.path));
      changes = agg.unitChanges;
      aggregation = agg.summary;
    }

    const tally: any = { renamed: 0, renamed_lowconf: 0, added: 0, revived: 0, deleted: 0, orphaned: 0, modified: 0, skipped: 0 };

    // active-only lookup (COALESCE covers pre-migration rows with NULL state).
    const findActive = (path: string) => one(client,
      `SELECT * FROM code_unit WHERE repo_id=$1 AND path=$2 AND COALESCE(state,'active')='active'`, [repo_id, path]);

    // --- ADD path: revive a soft-removed row, else INSERT a fresh unmapped unit.
    // NO domain auto-mapping: an add lands unmapped (the human/LLM inbox). NEVER
    // touches any existing mapping.
    const addPath = async (path: string) => {
      const ex = await one(client, "SELECT * FROM code_unit WHERE repo_id=$1 AND path=$2", [repo_id, path]);
      if (ex && COALESCE_state(ex) === "removed") {
        await client.query("UPDATE code_unit SET state='active',updated_at=$1 WHERE id=$2", [now(), ex.id]);
        await logChange(client, {
          repoId: repo_id, entityType: "code_unit", entityId: ex.id, op: "revive", actor: act, runId: run_id,
          before: { state: "removed", path }, after: { state: "active", path }, note: "revived previously-removed code_unit",
        });
        tally.revived++;
        return;
      }
      if (ex) { tally.skipped++; return; } // already active — nothing to do (idempotent re-run)
      const r = await one(client, "INSERT INTO code_unit(repo_id,kind,path,label,state,created_at,updated_at) VALUES($1,$2,$3,$4,$5,$6,$6) RETURNING id",
        [repo_id, kindFromPath(path), path, path, "active", now()]);
      await logChange(client, {
        repoId: repo_id, entityType: "code_unit", entityId: r.id, op: "insert", actor: act, runId: run_id,
        before: null, after: { path, state: "active" }, note: "added (unmapped inbox)",
      });
      tally.added++;
    };

    for (const c of changes) {
      if (!c || typeof c !== "object") { tally.skipped++; continue; }
      const status = (c.status ?? "").toUpperCase();

      if (status === "R") {
        const from = c.from, to = c.to;
        if (!from || !to) { tally.skipped++; continue; }
        const ex = await findActive(from);
        if (!ex) { await addPath(to); continue; } // 'from' not found → fall through to A(to)
        // Destination-path collision guard (UNIQUE(repo_id,path)) — never abort the whole refresh.
        const dest = await one(client, "SELECT id, COALESCE(state,$2) state FROM code_unit WHERE repo_id=$1 AND path=$3", [repo_id, "active", to]);
        if (dest && dest.id !== ex.id) {
          if (dest.state === "removed") {
            // free the path: re-park the dead row under a tombstone path (audited), then rename.
            const tomb = `${to}__removed#${dest.id}`;
            await client.query("UPDATE code_unit SET path=$1,updated_at=$2 WHERE id=$3", [tomb, now(), dest.id]);
            await logChange(client, {
              repoId: repo_id, entityType: "code_unit", entityId: dest.id, op: "retomb", actor: act, runId: run_id,
              before: { path: to }, after: { path: tomb }, note: "freed path for incoming rename",
            });
          } else {
            // active collision: surface (never silence) and skip the rename rather than crashing the txn.
            await flagStructuralDrift(client, repo_id, run_id, act, {
              title: `리네임 경로 충돌: ${from} → ${to}`,
              detail: `rename 대상 경로 ${to} 에 이미 활성 code_unit(#${dest.id})이 존재 — 충돌로 rename을 건너뜀. 사람/LLM 확인 필요.`,
              cited_refs: [from, to],
              note: `rename target collides with active code_unit #${dest.id}`,
            });
            tally.skipped++; continue;
          }
        }
        // SAME ROW UPDATE → all mappings + project_touch referencing ex.id survive
        // untouched. We write ZERO rows in the mapping table. (Invariant.)
        const score = c.score == null ? null : Number(c.score);
        await client.query("UPDATE code_unit SET path=$1,prev_path=$2,updated_at=$3 WHERE id=$4", [to, from, now(), ex.id]);
        await logChange(client, {
          repoId: repo_id, entityType: "code_unit", entityId: ex.id, op: "rename", actor: act, runId: run_id,
          before: { path: from }, after: { path: to, score }, note: null,
        });
        tally.renamed++;
        if (score != null && score < 60) {
          // Low-confidence rename: surface for human/LLM double-check (never silent).
          await flagStructuralDrift(client, repo_id, run_id, act, {
            title: `저신뢰 리네임 검토 필요: ${from} → ${to}`,
            detail: `git rename detection similarity ${score} (<60). 동일 code_unit 행으로 처리되어 매핑은 보존됐으나, 실제로는 별개 파일일 수 있으니 사람/LLM이 재확인 필요.`,
            cited_refs: [to, from],
            note: `low-confidence rename score=${score}`,
          });
          tally.renamed_lowconf++;
        }
        continue;
      }

      if (status === "A") {
        const path = c.path ?? c.to;
        if (!path) { tally.skipped++; continue; }
        await addPath(path);
        continue;
      }

      if (status === "D") {
        const path = c.path ?? c.from;
        if (!path) { tally.skipped++; continue; }
        const ex = await findActive(path);
        if (!ex) { tally.skipped++; continue; }
        // SOFT delete only — keep the row (and its mappings/history) for restore.
        await client.query("UPDATE code_unit SET state='removed',updated_at=$1 WHERE id=$2", [now(), ex.id]);
        await logChange(client, {
          repoId: repo_id, entityType: "code_unit", entityId: ex.id, op: "remove", actor: act, runId: run_id,
          before: { state: "active", path }, after: { state: "removed", path }, note: "soft-removed (deleted in git diff)",
        });
        tally.deleted++;
        // If a CONFIRMED mapping pointed here, flag an orphan (do NOT delete the mapping).
        //  V6: mapping.domain_id→category_id, domain→category(space='product'). 매핑은 타깃(code_unit.id)으로
        //  스코프(repo_id 잉여) — 그 code_unit 의 confirmed 매핑이 닿는 category 라벨을 부채 문구에 쓴다.
        const conf = await q(client, `SELECT m.id, c.key domain_key, c.name domain_name
          FROM mapping m JOIN category c ON c.id=m.category_id
          WHERE m.target_kind='code_unit' AND m.target_id=$1 AND m.status='confirmed'`, [ex.id]);
        if (conf.length) {
          const domLabel = conf.map((c2) => `${c2.domain_name} (${c2.domain_key})`).join(", ");
          await flagStructuralDrift(client, repo_id, run_id, act, {
            title: `삭제된 확정-매핑 코드: ${path}`,
            detail: `git diff에서 삭제된 code_unit이 확정(confirmed) 매핑을 가지고 있었음 — 도메인: ${domLabel}. 매핑은 이력/복구 위해 보존됨. 도메인 경계 재검토 필요(orphan).`,
            cited_refs: [path],
            note: `orphaned confirmed mapping(s): ${conf.map((c2) => "#" + c2.id).join(",")}`,
          });
          tally.orphaned++;
        }
        continue;
      }

      if (status === "M") {
        // Structural no-op: content re-evaluation is the LLM pass, not this one.
        tally.modified++;
        continue;
      }

      tally.skipped++; // unknown status
    }

    if (p.head != null) {
      await setLastRefreshedSha(client, repo_id, String(p.head));
    }
    // Include the file→unit aggregation summary (only present for granularity:'file')
    // in the persisted summary + the returned tally so the aggregation is auditable
    // and visible to the caller. Unit-granularity callers see no extra field.
    if (aggregation) tally.aggregation = aggregation;
    await client.query("UPDATE scan_run SET finished_at=$1, summary=$2 WHERE id=$3", [now(), JSON.stringify(tally), run_id]);
    return { repo: repoName, run_id, base: p.base ?? repo.last_refreshed_sha ?? null, head: p.head ?? null, tally };
  });
  // P4 옵션ii — is-reconcile 백스톱: 하네스 밖 변경이 refresh 로 들어온 뒤 should↔is debt 를 재평가한다
  //  (stop훅이 1차 경로, 이건 온디맨드 보정 — 깃헙액션 트리거 아님). best-effort(읽기 + debt upsert 만,
  //  refresh 의 '매핑 무변경' 불변식과 무관). domain-debt 가 should_no_is/active_commits(통합 DB join)까지 본다.
  try {
    const { evaluateDomainStructureDebt } = await import("./domain-debt.js");
    await evaluateDomainStructureDebt(repoName, act);
  } catch { /* 백스톱 실패는 refresh 결과를 막지 않는다 */ }
  return result;
}
