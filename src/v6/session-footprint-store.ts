// 세션 발자국(#1850 P2) — "이 세션이 조직에 남긴 것"을 좌표로 모으고, 고른 것만 실제로 지운다.
//
//  ── 왜 필요한가 ──
//   대화 기록만 지우는 것은 반쪽이다. 세션이 만든 지식·프로젝트·작업 기록은 그대로 남고, 사람은 그것들을
//   "필요하면 각각 따로 지우라"는 안내를 받았다(원준 2026-08-23: *"무슨 필요하면 각각 따로 지우라고 하냐"*).
//   게다가 그 '따로 지우는' 경로가 실제로 지워 주지도 않았다 — 지식 삭제는 활성 테이블에서만 빼고
//   **본문 전문을 org_content_audit.before 에 그대로 복사해 남긴다**(purge 경로 없음). 목록에서 안 보일 뿐이다.
//
//  ── 만든 것과 고친 것을 가르는 이유 ──
//   이 세션이 **만든** 지식은 지우면 세션 이전 상태로 돌아간다. 그런데 **고친** 지식은 세션 전에도 있었으므로
//   지우면 남의 것을 없애는 것이다. 그래서 고친 것은 삭제가 아니라 **세션 직전 판으로 되돌린다**.
//   판정은 추측하지 않는다 — ① `knowledge.created_at` 이 세션 활동 창 안이고 ② **첫 감사 행의 actor 가 세션
//   주인**일 때만 '만든 것'이다(#1850 P4). ①만 보던 종전 판정은 남이 그 시각에 만든 지식을 이 세션이 고친 경우
//   '만든 것'으로 오판해 **남의 문서를 통째로 지울 수 있었다** — 시간은 겹칠 수 있어도 만든 사람은 안 겹친다.
//   첫 감사 행이 없으면(감사 이전의 옛 지식) 만든 사람을 모른다 → 창 안이어도 '고친 것'으로 낮춰 잡는다(보수).
//
//  ── 세션 id 가 두 체계다 ──
//   대화 기록은 하네스 대화 uuid(`session.session_id`), 작업 기록은 tmux 세션 id(`activity.session_id`,
//   `box-<slug>-<8hex>`)를 쓴다. 둘을 잇는 다리가 `org_session_state.claude_session_id` 뿐이다.
//   다리가 없으면(그 매핑이 안 남은 옛 세션) 작업 기록을 못 찾는다 — 그때는 **빈 목록**을 돌려주고
//   화면이 "찾지 못했다"고 말하게 한다. 추측으로 남의 작업을 끌어오지 않는다.
import { itemsPool, withTx } from "../db/client.js";
import { auditOrgContent } from "./content-audit.js";

//  ── 규칙 B(원준 결정 2026-08-24): 그 뒤에 남이 손댄 것은 건드리지 않는다 ──
//   세션 하나를 버리며 남의 작업을 날릴 수는 없다. 세션 활동 창이 끝난 **뒤**에 그 지식·프로젝트에 감사 행이
//   하나라도 더 붙었으면(누가 됐든 — 같은 사람의 다른 세션도 '그 뒤'다) touched_after=true 로 표시하고,
//   화면은 그것을 고를 수 없게 "남는 것"으로 보여 주며, 서버는 골라 보내도 걸러 낸다(아래 purge 라우트).
//   ── 그리고 창 **안**도 본다(#1850 P4): 세션이 도는 동안 다른 사람이 같은 지식에 감사 행을 남겼으면
//   (others_during=true) 되돌리기가 그 사람의 수정을 덮으므로 역시 건드리지 않는다. 종전 규칙 B 는 "끝난 뒤"만
//   봐서 이 자리를 놓쳤다.
export interface FootprintKnowledge { name: string; title: string | null; created_at: string; touched_after: boolean; others_during?: boolean }
export interface FootprintProject { id: number; name: string; created_here: boolean; touched_after: boolean; other_sessions: number }
//  자료(source)는 세션 좌표를 안 가진다(표에 session_id 가 없다). 그래서 둘을 이 세션의 것으로 본다:
//   ① **이 세션이 만든 지식에만 붙은 자료**(다른 지식이 인용하면 남의 근거이므로 뺀다 — linked=true)
//   ② 세션 창 안에 세션 주인이 만들었고(provenance=authored) **어느 지식에도 안 붙은 자료**(#1850 P4 — 올려만 두고
//      안 쓴 원본. 종전엔 목록에도 안 잡혀 영영 남았다 — linked=false).
export interface FootprintSource { id: number; title: string | null; kind: string | null; linked: boolean }
//  태스크(#1850 P4) — 세션이 **살아남는 프로젝트 안에** 만든 작업. 프로젝트째 지워지는 것은 CASCADE 가 맡지만,
//  프로젝트가 남으면 그 안의 태스크는 종전 발자국에 안 잡혀 영영 남았다. 좌표는 project.created_by + created_at 창.
//  ⚠ 외부 미러(external_id 있는 것)는 빼고, 창이 끝난 뒤 감사 행이 붙은 것도 뺀다(규칙 B).
export interface FootprintTask { id: number; name: string; project_id: number | null; project_name: string | null }
//  카테고리(#1850 P4) — 세션 창 안에 세션 주인이 만든 분류(감사 첫 행 기준). 분류는 조직의 뼈대라 **purge 대상이
//  아닌 지식이 하나라도 물려 있으면 지우지 않는다**(규칙 B 와 같은 뜻).
export interface FootprintCategory { id: number; key: string; name: string | null }
export interface SessionFootprint {
  tmux_session_id: string | null;
  window: { from: string; to: string } | null;
  knowledge_created: FootprintKnowledge[];
  knowledge_edited: FootprintKnowledge[];
  projects: FootprintProject[];
  sources: FootprintSource[];
  tasks: FootprintTask[];
  categories: FootprintCategory[];
  activities: number;
}

// 대화 uuid → tmux 세션 id. 없으면 null(그 세션의 작업 기록은 추적 불가 — 위 주석).
export async function tmuxSessionIdFor(sessionId: string): Promise<string | null> {
  // ⚠ 이 표의 세션 키 컬럼은 `id` 다(`session_id` 아님 — 실측으로 밟았다). 값은 tmux 세션 id(box-<slug>-<8hex>).
  const r = await itemsPool.query(
    `SELECT id FROM org_session_state WHERE claude_session_id = $1 LIMIT 1`, [sessionId]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

// tmux 세션 id → 중앙 기록이 있는 대화 uuid 들(#1850 P4 — 프로젝트 완전 삭제가 묶음 세션의 발자국을 서버에서
//  스스로 지울 때 쓴다). 다리는 최신 uuid 하나만 담지만, 값이 있으면 그 uuid 의 중앙 기록 위치(node_id)까지 찾아 준다.
export async function claudeSessionIdsFor(tmuxSessionId: string): Promise<Array<{ nodeId: string; sessionId: string }>> {
  const out: Array<{ nodeId: string; sessionId: string }> = [];
  const st = await itemsPool.query(
    `SELECT claude_session_id FROM org_session_state WHERE id = $1 AND claude_session_id IS NOT NULL`, [tmuxSessionId]);
  for (const r of st.rows) {
    const sid = String(r.claude_session_id ?? "");
    if (!sid) continue;
    const s = await itemsPool.query(`SELECT node_id FROM session WHERE session_id = $1 ORDER BY node_id LIMIT 1`, [sid]);
    if (s.rows.length) out.push({ nodeId: String(s.rows[0].node_id ?? ""), sessionId: sid });
  }
  return out;
}

export async function sessionFootprint(nodeId: string, sessionId: string, owner?: string | null): Promise<SessionFootprint> {
  const empty: SessionFootprint = {
    tmux_session_id: null, window: null,
    knowledge_created: [], knowledge_edited: [], projects: [], sources: [], tasks: [], categories: [], activities: 0,
  };

  // 활동 창 — 이 세션이 살아 있던 구간. '만든 것' 판정의 기준자다.
  const s = await itemsPool.query(
    `SELECT first_seen, last_seen FROM session WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  if (!s.rows.length) return empty;
  const from = s.rows[0].first_seen as string;
  const to = s.rows[0].last_seen as string;
  const tmux = await tmuxSessionIdFor(sessionId);
  const who = (owner ?? "").trim() || null;   // 세션 주인 — '만든 사람' 판정의 기준. 없으면(옛 호출) 보수 판정.

  // 프로젝트 귀속은 두 id 어느 쪽으로도 기록될 수 있다(캡처 훅은 대화 uuid, 세션 바인딩은 tmux id).
  const ids = [sessionId, ...(tmux ? [tmux] : [])];
  const proj = await itemsPool.query(
    `SELECT DISTINCT p.id, p.name, (p.created_at >= $2 AND p.created_at <= $3) AS created_here,
            EXISTS (SELECT 1 FROM org_content_audit a WHERE a.entity='project' AND a.entity_key = p.id::text AND a.at > $3) AS touched_after,
            (SELECT count(DISTINCT sp2.session_id)::int FROM session_project sp2
              WHERE sp2.project_id = p.id AND NOT (sp2.session_id = ANY($1))) AS other_sessions
       FROM session_project sp JOIN project p ON p.id = sp.project_id
      WHERE sp.session_id = ANY($1)
      ORDER BY p.id`,
    [ids, from, to]);
  const projRows = (): FootprintProject[] => proj.rows.map((r) => ({
    id: Number(r.id), name: String(r.name), created_here: !!r.created_here,
    touched_after: !!r.touched_after, other_sessions: Number(r.other_sessions ?? 0),
  }));

  if (!tmux) return { ...empty, window: { from, to }, projects: projRows() };

  const act = await itemsPool.query(`SELECT count(*)::int AS n FROM activity WHERE session_id = $1`, [tmux]);

  // 이 세션의 작업이 **산출(produced)** 로 연결한 지식 + (주인을 알면) 창 안에서 주인이 만들었지만 작업 기록을
  //  안 남긴 지식(#1850 P4 — knowledge_save 만 부르고 activity_log 를 안 부른 세션의 지식이 종전엔 안 잡혔다).
  //  references/decided 는 '읽은 것·근거로 삼은 것'이라 지우거나 되돌릴 대상이 아니다.
  //  creator = 그 지식의 **첫 감사 행 actor**(op 이름 규약에 기대지 않는다). others_during = 창 안에 다른 사람의
  //  감사 행이 있는가(규칙 B 의 '창 안' 반쪽).
  const kn = await itemsPool.query(
    `SELECT DISTINCT k.name, k.title, k.created_at,
            (SELECT a1.actor FROM org_content_audit a1
              WHERE a1.entity='knowledge' AND a1.entity_key = k.name ORDER BY a1.at ASC, a1.id ASC LIMIT 1) AS creator,
            EXISTS (SELECT 1 FROM org_content_audit a2 WHERE a2.entity='knowledge' AND a2.entity_key = k.name AND a2.at > $3) AS touched_after,
            EXISTS (SELECT 1 FROM org_content_audit a3 WHERE a3.entity='knowledge' AND a3.entity_key = k.name
                       AND a3.at >= $2 AND a3.at <= $3 AND a3.actor IS DISTINCT FROM $4) AS others_during
       FROM knowledge k
      WHERE EXISTS (SELECT 1 FROM activity a JOIN activity_knowledge ak ON ak.activity_id = a.id AND ak.relation = 'produced'
                     WHERE a.session_id = $1 AND ak.name = k.name)
         OR ($4::text IS NOT NULL AND k.created_at >= $2 AND k.created_at <= $3
             AND (SELECT a1.actor FROM org_content_audit a1
                   WHERE a1.entity='knowledge' AND a1.entity_key = k.name ORDER BY a1.at ASC, a1.id ASC LIMIT 1) = $4)
      ORDER BY k.created_at`,
    [tmux, from, to, who]);

  const created: FootprintKnowledge[] = [];
  const edited: FootprintKnowledge[] = [];
  for (const r of kn.rows) {
    const row: FootprintKnowledge = {
      name: String(r.name), title: (r.title as string) ?? null, created_at: String(r.created_at),
      touched_after: !!r.touched_after, others_during: !!r.others_during,
    };
    // 창 안에서 태어났고 **첫 감사 행이 세션 주인**이면 이 세션이 만든 것. 만든 사람을 모르거나(감사 없음·주인 미상)
    //  다른 사람이면, 창 안이어도 '고친 것'으로 낮춰 잡는다 — 남의 문서를 지우는 쪽보다 되돌리는 쪽이 싸다.
    const bornHere = r.created_at >= from && r.created_at <= to;
    const mine = who != null && String(r.creator ?? "") === who;
    (bornHere && mine ? created : edited).push(row);
  }

  // 자료 — ① 이 세션이 만든 지식에만 붙은 것(다른 지식이 같이 인용하면 뺀다)
  const sources: FootprintSource[] = [];
  if (created.length) {
    const src = await itemsPool.query(
      `SELECT s.id, s.title, s.kind
         FROM source s
        WHERE EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id AND ks.name = ANY($1))
          AND NOT EXISTS (SELECT 1 FROM knowledge_source ks2 WHERE ks2.source_id = s.id AND NOT (ks2.name = ANY($1)))
        ORDER BY s.id`,
      [created.map((k) => k.name)]);
    for (const r of src.rows) sources.push({ id: Number(r.id), title: (r.title as string) ?? null, kind: (r.kind as string) ?? null, linked: true });
  }
  // ② 창 안에 주인이 만들었고 어느 지식에도 안 붙은 자료(#1850 P4)
  if (who) {
    const src2 = await itemsPool.query(
      `SELECT s.id, s.title, s.kind
         FROM source s
        WHERE s.provenance = 'authored' AND s.created_at >= $1 AND s.created_at <= $2
          AND (s.author = $3 OR s.updated_by = $3)
          AND NOT EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id)
        ORDER BY s.id LIMIT 100`,
      [from, to, who]);
    const seen = new Set(sources.map((x) => x.id));
    for (const r of src2.rows) if (!seen.has(Number(r.id))) sources.push({ id: Number(r.id), title: (r.title as string) ?? null, kind: (r.kind as string) ?? null, linked: false });
  }

  // 태스크 — 살아남는 프로젝트 안에 창 안에서 주인이 만든 작업(#1850 P4). 이 세션이 만든 프로젝트(created_here)
  //  안의 것은 프로젝트째 CASCADE 로 지워지므로 뺀다(이중 표시 방지). 외부 미러·규칙 B 위반도 뺀다.
  let tasks: FootprintTask[] = [];
  if (who) {
    const createdProjIds = new Set(proj.rows.filter((r) => !!r.created_here).map((r) => Number(r.id)));
    const tk = await itemsPool.query(
      `WITH RECURSIVE cand AS (
          SELECT t.id FROM project t
           WHERE t.level <> 'project' AND t.created_by = $1
             AND t.created_at >= $2 AND t.created_at <= $3
             AND t.external_id IS NULL
             AND NOT EXISTS (SELECT 1 FROM org_content_audit a WHERE a.entity='project' AND a.entity_key = t.id::text AND a.at > $3)
        ), up AS (
          SELECT c.id AS task_id, p.id AS cur, p.parent_id, p.level FROM cand c JOIN project p ON p.id = c.id
          UNION ALL
          SELECT up.task_id, p.id, p.parent_id, p.level FROM up JOIN project p ON p.id = up.parent_id
        )
        SELECT t.id, t.name, root.cur AS project_id, rp.name AS project_name
          FROM cand c JOIN project t ON t.id = c.id
          LEFT JOIN LATERAL (SELECT u.cur FROM up u WHERE u.task_id = c.id AND u.level = 'project' LIMIT 1) root ON true
          LEFT JOIN project rp ON rp.id = root.cur
         ORDER BY t.id LIMIT 100`,
      [who, from, to]);
    tasks = tk.rows
      .filter((r) => r.project_id == null || !createdProjIds.has(Number(r.project_id)))
      .map((r) => ({
        id: Number(r.id), name: String(r.name ?? ""),
        project_id: r.project_id == null ? null : Number(r.project_id),
        project_name: (r.project_name as string) ?? null,
      }));
  }

  // 카테고리 — 창 안에 주인이 만든 분류(첫 감사 행 기준. entity_key 는 `space/key`(category-store) — 옛 행은 id 일 수 있어 둘 다 본다).
  //  **purge 대상이 아닌 지식이 하나라도 물려 있으면 뺀다.**
  let categories: FootprintCategory[] = [];
  if (who) {
    const createdNames = created.map((k) => k.name);
    const cat = await itemsPool.query(
      `SELECT c.id, c.key, c.name
         FROM category c
        WHERE c.created_at >= $1 AND c.created_at <= $2
          AND (SELECT a1.actor FROM org_content_audit a1
                WHERE a1.entity='category' AND (a1.entity_key = c.space || '/' || c.key OR a1.entity_key = c.id::text)
                ORDER BY a1.at ASC, a1.id ASC LIMIT 1) = $3
          AND NOT EXISTS (SELECT 1 FROM knowledge_category kc
                           WHERE kc.category_id = c.id AND NOT (kc.name = ANY($4)))
        ORDER BY c.id LIMIT 50`,
      [from, to, who, createdNames]);
    categories = cat.rows.map((r) => ({ id: Number(r.id), key: String(r.key), name: (r.name as string) ?? null }));
  }

  return {
    tmux_session_id: tmux,
    window: { from, to },
    knowledge_created: created,
    knowledge_edited: edited,
    projects: projRows(),
    sources,
    tasks,
    categories,
    activities: Number(act.rows[0]?.n ?? 0),
  };
}

// ── 실제 삭제 ───────────────────────────────────────────────────────────────

// 감사 스냅샷 비우기 — **행은 남기고 내용만 비운다**(원준 결정 2026-08-23).
//  행까지 지우면 '누가 언제 지웠나'라는 감사 자체가 사라져 운영이 눈을 잃는다. 반대로 내용을 남기면
//  "지웠는데 본문이 감사 테이블에 그대로"가 되어 파기 요구의 답이 못 된다 — 그 사이가 이것이다.
async function blankAuditSnapshots(client: { query: (sql: string, p: unknown[]) => Promise<unknown> }, entity: string, keys: string[]): Promise<void> {
  if (!keys.length) return;
  await client.query(
    `UPDATE org_content_audit SET before = NULL, after = NULL
      WHERE entity = $1 AND entity_key = ANY($2) AND (before IS NOT NULL OR after IS NOT NULL)`,
    [entity, keys]);
}

export interface PurgeSelection {
  knowledge?: string[];    // 완전 삭제할 지식 name (이 세션이 만든 것)
  revert?: string[];       // 세션 직전 판으로 되돌릴 지식 name (이 세션이 고친 것)
  projects?: number[];     // 완전 삭제할 프로젝트 id
  sources?: number[];      // 완전 삭제할 자료 id
  tasks?: number[];        // 완전 삭제할 태스크 id (#1850 P4 — 살아남는 프로젝트 안에 만든 것)
  categories?: number[];   // 완전 삭제할 카테고리 id (#1850 P4 — 빈 분류만, 지우기 직전에 서버가 다시 확인)
  activities?: boolean;    // 이 세션의 작업 기록을 지운다
}
export interface PurgeFootprintResult {
  knowledge_deleted: number; knowledge_reverted: number; knowledge_revert_failed: string[];
  projects_deleted: number; project_folders: string[]; sources_deleted: number;
  tasks_deleted: number; categories_deleted: number; activities_deleted: number;
}

// 고른 것만 지운다. **전부 한 트랜잭션** — 절반만 지워진 상태(지식은 사라졌는데 감사엔 본문이 남는 등)를 만들지 않는다.
export async function purgeFootprint(
  sel: PurgeSelection, tmuxSessionId: string | null, windowFrom: string | null, actor?: string,
): Promise<PurgeFootprintResult> {
  const ctx = { actor: actor ?? null, source: "web" };
  const kNames = sel.knowledge ?? [];
  const rNames = sel.revert ?? [];
  const pIds = sel.projects ?? [];
  const sIds = sel.sources ?? [];
  const tIds = sel.tasks ?? [];
  const cIds = sel.categories ?? [];
  return withTx(async (client) => {
    const out: PurgeFootprintResult = {
      knowledge_deleted: 0, knowledge_reverted: 0, knowledge_revert_failed: [],
      projects_deleted: 0, project_folders: [], sources_deleted: 0,
      tasks_deleted: 0, categories_deleted: 0, activities_deleted: 0,
    };

    // ① 되돌리기 — 세션이 손대기 **직전**의 스냅샷을 감사에서 찾아 그 본문으로 되돌린다.
    //   기준 시각은 세션 활동 창의 시작(windowFrom). 그 이전 마지막 감사 행의 after 가 '그때의 그 지식'이다.
    //   ⚠ 되돌린 뒤 그 지식의 감사는 **비우지 않는다** — 지우는 게 아니라 되돌리는 것이고, 남의 이력이다.
    for (const name of rNames) {
      if (!windowFrom) { out.knowledge_revert_failed.push(name); continue; }
      // ⚠ `after IS NOT NULL` 만으로는 안 된다 — 같은 지식에 **본문이 없는 감사 행**이 섞여 있다
      //  (link_category 는 after 가 `{state, category_id}` 뿐이다). 그게 최신이면 그걸 집어 되돌리기가
      //  통째로 실패한다(실측으로 밟았다). **본문을 실제로 담은 행**만 후보로 본다.
      const prev = await client.query(
        `SELECT after FROM org_content_audit
          WHERE entity='knowledge' AND entity_key=$1 AND at < $2 AND after->>'body_md' IS NOT NULL
          ORDER BY at DESC LIMIT 1`,
        [name, windowFrom]);
      const snap = prev.rows[0]?.after as Record<string, unknown> | undefined;
      // 되돌릴 판을 못 찾으면 **아무것도 하지 않는다**. 추측으로 본문을 갈아엎지 않는다(호출자가 사람에게 알린다).
      if (!snap || typeof snap !== "object" || typeof snap.body_md !== "string") { out.knowledge_revert_failed.push(name); continue; }
      const r = await client.query(
        `UPDATE knowledge SET body_md = $2, title = COALESCE($3, title), updated_at = now() WHERE name = $1`,
        [name, snap.body_md, (snap.title as string) ?? null]);
      if (r.rowCount) out.knowledge_reverted++;
      else out.knowledge_revert_failed.push(name);
    }

    // ② 지식 완전 삭제 — 활성 행 + 과거 감사 스냅샷(본문)까지.
    //   ⚠ 스냅샷을 비우는 것과 **삭제 사실을 남기는 것은 다른 일**이다. 둘을 같이 하지 않으면 둘 중 하나가
    //    깨진다: 스냅샷만 비우면 '누가 언제 지웠나'가 사라져 운영이 눈을 잃고, 사실만 남기면 본문이 그대로다.
    //    그래서 **과거 행의 내용은 비우고, 내용 없는 delete 행을 새로 한 줄 남긴다**(원준 결정 2026-08-23).
    if (kNames.length) {
      const r = await client.query(`DELETE FROM knowledge WHERE name = ANY($1)`, [kNames]);
      out.knowledge_deleted = r.rowCount ?? 0;
      await blankAuditSnapshots(client, "knowledge", kNames);
      for (const name of kNames) await auditOrgContent("knowledge", name, "delete", null, null, ctx);
    }

    // ③ 프로젝트 완전 삭제 — 같은 원칙(활성 행 + 감사 스냅샷 + 내용 없는 삭제 기록).
    //   폴더(첨부·자료 파일이 사는 곳)는 여기서 지우지 않고 **경로만 돌려준다** — 트랜잭션 밖에서 라우트가 지운다
    //   (DB 롤백은 되지만 디스크 삭제는 되돌릴 수 없으니, DB 가 확정된 뒤에만 손댄다). 원준 결정: 프로젝트를 완전히
    //   지우면 그 안의 자료도 함께.
    if (pIds.length) {
      const f = await client.query(`SELECT folder FROM project WHERE id = ANY($1) AND folder IS NOT NULL`, [pIds]);
      out.project_folders = f.rows.map((r) => String(r.folder)).filter(Boolean);
      const r = await client.query(`DELETE FROM project WHERE id = ANY($1)`, [pIds]);
      out.projects_deleted = r.rowCount ?? 0;
      await blankAuditSnapshots(client, "project", pIds.map((n) => String(n)));
      for (const id of pIds) await auditOrgContent("project", String(id), "delete", null, null, ctx);
    }

    // ③-b 자료 완전 삭제 — 같은 원칙. knowledge_source 는 FK CASCADE.
    if (sIds.length) {
      const r = await client.query(`DELETE FROM source WHERE id = ANY($1)`, [sIds]);
      out.sources_deleted = r.rowCount ?? 0;
      await blankAuditSnapshots(client, "source", sIds.map((n) => String(n)));
      for (const id of sIds) await auditOrgContent("source", String(id), "delete", null, null, ctx);
    }

    // ③-c 태스크 완전 삭제(#1850 P4) — 살아남는 프로젝트 안의 것만 온다(발자국이 그렇게 모은다).
    //   ⚠ level='project' 는 여기로 절대 안 지운다 — 프로젝트는 ③ 의 자리다. 하위(subtask)는 FK CASCADE.
    if (tIds.length) {
      const r = await client.query(`DELETE FROM project WHERE id = ANY($1) AND level <> 'project'`, [tIds]);
      out.tasks_deleted = r.rowCount ?? 0;
      await blankAuditSnapshots(client, "project", tIds.map((n) => String(n)));
      for (const id of tIds) await auditOrgContent("project", String(id), "delete", null, null, ctx);
    }

    // ③-d 카테고리 완전 삭제(#1850 P4) — 지우기 직전에 **빈 분류인지 다시 확인**한다(발자국 조회와 지금 사이에
    //   누가 지식을 물렸을 수 있다). 물려 있으면 그 카테고리는 건너뛴다 — 분류는 조직의 뼈대다.
    if (cIds.length) {
      const keysRow = await client.query(`SELECT space || '/' || key AS k FROM category WHERE id = ANY($1)`, [cIds]);
      const r = await client.query(
        `DELETE FROM category c WHERE c.id = ANY($1)
           AND NOT EXISTS (SELECT 1 FROM knowledge_category kc WHERE kc.category_id = c.id)`, [cIds]);
      out.categories_deleted = r.rowCount ?? 0;
      const ck = (keysRow.rows as Array<{ k: string }>).map((x) => x.k);
      await blankAuditSnapshots(client, "category", [...ck, ...cIds.map((n) => String(n))]);
      for (const k of ck) await auditOrgContent("category", k, "delete", null, null, ctx);
    }

    // ④ 작업 기록 — activity_knowledge·activity_touch 는 FK CASCADE 로 함께 정리된다.
    //   tmux 세션 id 로 전부 지운다 — 이 id 는 박스 세션 하나에 고정이고, 같은 박스에서 이어진 옛 대화의 기록도
    //   '이 세션의 기록'이다(#1850 P4 검토 후 유지).
    if (sel.activities && tmuxSessionId) {
      const r = await client.query(`DELETE FROM activity WHERE session_id = $1`, [tmuxSessionId]);
      out.activities_deleted = r.rowCount ?? 0;
    }
    return out;
  });
}
