// 초안 프로젝트가 풀리는 길(#5522) — «무언가를 남긴 첫 순간» 에 초안에서 나온다.
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
//  초안(#4170)은 종전에 **제목·본문을 고치거나 · 완료하거나 · «목록에 올리기» 를 누를 때만** 풀렸다. 그런데 세션은
//  일을 하고도 본문을 안 고치는 경우가 흔하다(매니지드 실측 2026-11-11: 초안 99건 중 24건이 지식·작업기록·파일을
//  남기고도 초안이었다). 초안이 «만든 사람과 팀원만 본다» 가 된 지금(v6/visibility.ts)은 그 24건이 동료 화면에서
//  사라진다 — 그래서 풀리는 조건을 «남긴 것이 있다» 로 넓힌다.
//
// ── 무엇이 «남긴 것» 인가 ───────────────────────────────────────────────────
//   · 산출지식 연결(project_knowledge.relation='produced')
//   · 작업기록(activity — 수집해 온 것 말고 직접 남긴 것)
//   · 코멘트(task_comment — 프로젝트 · 그 태스크 어디든)
//   · 리스트(영역) 지정
//   · 세션이 프로젝트 폴더에 만든 파일(source.fields.entry='generated')
//   · 세션 태스크가 아닌 태스크(task_create_v6 로 일부러 만든 것)
//  **아닌 것** — 첫 턴에 저절로 일어나는 일: 세션 이름 승계 · 세션 태스크 자동 생성 · 첫 지시 첨부를 폴더로 옮기기 ·
//   AGENTS.md 생성 · 세션 초대. 이걸 세면 초안이 생기자마자 전부 풀린다.
//
// ── 두 갈래 ─────────────────────────────────────────────────────────────────
//  ① 쓰는 자리가 releaseProjectDraft 를 부른다(그 자리는 방금 한 일이 «남긴 것» 임을 안다 — 다시 따지지 않는다).
//  ② sweepDraftReleases 가 같은 조건을 SQL 한 벌로 훑어 놓친 것을 줍는다(부팅 때 · 이 기능 이전에 쌓인 초안).
//   둘의 조건이 갈리지 않게 «남긴 것» 의 목록은 이 파일 머리말이 정본이다 — 한쪽을 고치면 다른 쪽도 고친다.
//  한 번 풀린 초안은 다시 초안이 되지 않는다(되돌리는 길이 없다 — project-store.updateProject).
import { itemsPool, q } from "../db/client.js";
import { auditOrgContent, type WriteCtx } from "./content-audit.js";
import { invalidateVisibilityCache } from "./visibility.js";
import { ENTRY_GENERATED } from "./source-group.js";
import { logger } from "../log.js";

/** 풀린 까닭 — 감사 기록에 남는다. */
export type DraftReleaseReason = "produced_knowledge" | "activity" | "comment" | "list" | "file" | "task" | "sweep";

/**
 * 이 행(프로젝트 · 태스크 · 서브태스크)의 **뿌리 프로젝트**가 초안이면 푼다. 풀었으면 그 프로젝트 id, 아니면 null.
 *  초안이 아니면 아무 일도 없다(UPDATE 의 WHERE 가 못 잡는다) — 쓰는 자리는 조건 없이 불러도 된다.
 *  ⚠ 실패를 던지지 않는다. 부르는 자리의 본 작업(지식 연결 · 작업기록 …)은 이미 끝났고, 초안 표시는 그 결과가 아니다.
 */
export async function releaseProjectDraft(rowId: number, reason: DraftReleaseReason, ctx?: WriteCtx): Promise<number | null> {
  const id = Number(rowId);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const rows = await q(itemsPool, `
      UPDATE project r SET draft = false, updated_at = now()
       WHERE r.level = 'project' AND r.draft
         AND r.id = (SELECT CASE WHEN p.level = 'project' THEN p.id
                                 WHEN p.level = 'task'    THEN p.parent_id
                                 ELSE par.parent_id END
                       FROM project p LEFT JOIN project par ON par.id = p.parent_id
                      WHERE p.id = $1)
      RETURNING r.id`, [id]);
    if (!rows.length) return null;
    const released = Number(rows[0].id);
    invalidateVisibilityCache();   // 남의 «숨은 프로젝트» 캐시에서 곧바로 빠지게
    await auditOrgContent("project", String(released), "release_draft", { draft: true }, { draft: false, reason }, ctx)
      .catch(() => { /* 감사 실패가 풀림을 되돌리지 않는다 */ });
    return released;
  } catch (e) {
    logger.warn({ rowId: id, reason, err: (e as Error)?.message }, "[draft] 초안 풀기 실패(본 작업은 끝났다)");
    return null;
  }
}

// «남긴 것» 이 있는 초안의 id — 머리말의 목록을 그대로 옮긴 SQL. sweepDraftReleases 만 쓴다.
//  ⚠ 파일은 source 를 **한 번** 훑어 프로젝트 번호를 뽑는다(초안마다 LIKE 를 돌리면 초안 수 × 자료 수가 된다).
//  ⚠ 작업기록 · 코멘트 · 태스크는 프로젝트 행뿐 아니라 그 태스크 · 서브태스크에 달린 것도 본다(node = 뿌리와 그 후손).
const SUBSTANTIVE_DRAFTS_SQL = `
  WITH d AS (SELECT id FROM project WHERE level = 'project' AND draft),
  node AS (
    SELECT d.id AS root, d.id AS node FROM d
    UNION ALL
    SELECT t.parent_id, t.id FROM project t JOIN d ON d.id = t.parent_id WHERE t.level = 'task'
    UNION ALL
    SELECT t.parent_id, s.id FROM project s JOIN project t ON t.id = s.parent_id AND t.level = 'task'
      JOIN d ON d.id = t.parent_id WHERE s.level = 'subtask'
  ),
  files AS (
    SELECT DISTINCT split_part(split_part(external_id, '/', 1), ':', 2) AS pid
      FROM source
     WHERE external_system = 'local' AND external_id LIKE 'project:%/%'
       AND fields->>'entry' = '${ENTRY_GENERATED}'
  )
  SELECT p.id AS root FROM project p JOIN d ON d.id = p.id WHERE p.list_id IS NOT NULL
  UNION SELECT pk.project_id FROM project_knowledge pk JOIN d ON d.id = pk.project_id WHERE pk.relation = 'produced'
  UNION SELECT n.root FROM activity a JOIN node n ON n.node = a.project_id WHERE a.external_id IS NULL
  UNION SELECT n.root FROM task_comment c JOIN node n ON n.node = c.task_id
  UNION SELECT n.root FROM project t JOIN node n ON n.node = t.id
         WHERE t.level IN ('task', 'subtask') AND t.name_source IS NULL
  UNION SELECT d.id FROM d JOIN files f ON f.pid = d.id::text`;

/**
 * 남긴 것이 있는데 아직 초안인 프로젝트를 한꺼번에 푼다. 풀린 수를 돌려준다. 멱등 — 몇 번 돌려도 결과가 같다.
 *  쓰는 자리의 releaseProjectDraft 가 놓친 것(그 호출이 실패했거나 · 이 기능 이전에 쌓인 초안)을 줍는다.
 *  ⚠ updated_at 은 건드리지 않는다 — 한꺼번에 푸는 길이 목록의 «최근 수정» 순서를 뒤섞으면 안 된다.
 *  ⚠ 세션 태스크 판정 = name_source 가 비어 있지 않다. 세션이 스스로 만든 태스크는 'session' 으로 태어나고(session-task.ts),
 *   task_create_v6 로 일부러 만든 태스크는 비어서 태어난다(createTask). 사람이 세션 태스크의 이름을 고쳐 'human' 이 된 것은
 *   여기서 세지 않는다 — 이름 고치기는 «남긴 것» 이 아니다.
 */
export async function sweepDraftReleases(db: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> } = itemsPool): Promise<number> {
  const r = await db.query(`
    UPDATE project p SET draft = false
      FROM (${SUBSTANTIVE_DRAFTS_SQL}) hit
     WHERE p.id = hit.root AND p.level = 'project' AND p.draft
    RETURNING p.id`);
  const n = r.rows.length;
  if (n) {
    invalidateVisibilityCache();
    logger.info({ released: n, ids: r.rows.slice(0, 50).map((x) => Number(x.id)) }, "[draft] 남긴 것이 있는 초안을 풀었다");
  }
  return n;
}
