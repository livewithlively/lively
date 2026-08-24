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
//   판정은 추측하지 않는다 — `knowledge.created_at` 이 세션 활동 창 안에 있으면 '만든 것'이다.
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
export interface FootprintKnowledge { name: string; title: string | null; created_at: string; touched_after: boolean }
export interface FootprintProject { id: number; name: string; created_here: boolean; touched_after: boolean; other_sessions: number }
//  자료(source)는 세션 좌표를 안 가진다(표에 session_id 가 없다). 그래서 **이 세션이 만든 지식에만 붙은 자료**를
//  이 세션의 것으로 본다 — 다른 지식이 그 자료를 인용하면 남의 근거이므로 뺀다(touched_after 와 같은 뜻).
export interface FootprintSource { id: number; title: string | null; kind: string | null }
export interface SessionFootprint {
  tmux_session_id: string | null;
  window: { from: string; to: string } | null;
  knowledge_created: FootprintKnowledge[];
  knowledge_edited: FootprintKnowledge[];
  projects: FootprintProject[];
  sources: FootprintSource[];
  activities: number;
}

// 대화 uuid → tmux 세션 id. 없으면 null(그 세션의 작업 기록은 추적 불가 — 위 주석).
export async function tmuxSessionIdFor(sessionId: string): Promise<string | null> {
  // ⚠ 이 표의 세션 키 컬럼은 `id` 다(`session_id` 아님 — 실측으로 밟았다). 값은 tmux 세션 id(box-<slug>-<8hex>).
  const r = await itemsPool.query(
    `SELECT id FROM org_session_state WHERE claude_session_id = $1 LIMIT 1`, [sessionId]);
  return (r.rows[0]?.id as string | undefined) ?? null;
}

export async function sessionFootprint(nodeId: string, sessionId: string): Promise<SessionFootprint> {
  const empty: SessionFootprint = {
    tmux_session_id: null, window: null,
    knowledge_created: [], knowledge_edited: [], projects: [], sources: [], activities: 0,
  };

  // 활동 창 — 이 세션이 살아 있던 구간. '만든 것' 판정의 기준자다.
  const s = await itemsPool.query(
    `SELECT first_seen, last_seen FROM session WHERE node_id=$1 AND session_id=$2`, [nodeId, sessionId]);
  if (!s.rows.length) return empty;
  const from = s.rows[0].first_seen as string;
  const to = s.rows[0].last_seen as string;
  const tmux = await tmuxSessionIdFor(sessionId);

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

  // 이 세션의 작업이 **산출(produced)** 로 연결한 지식만 본다. references/decided 는 '읽은 것·근거로 삼은 것'이라
  //  지우거나 되돌릴 대상이 아니다.
  const kn = await itemsPool.query(
    `SELECT DISTINCT k.name, k.title, k.created_at,
            EXISTS (SELECT 1 FROM org_content_audit a2 WHERE a2.entity='knowledge' AND a2.entity_key = k.name AND a2.at > $2) AS touched_after
       FROM activity a
       JOIN activity_knowledge ak ON ak.activity_id = a.id AND ak.relation = 'produced'
       JOIN knowledge k ON k.name = ak.name
      WHERE a.session_id = $1
      ORDER BY k.created_at`,
    [tmux, to]);

  const created: FootprintKnowledge[] = [];
  const edited: FootprintKnowledge[] = [];
  for (const r of kn.rows) {
    const row: FootprintKnowledge = { name: String(r.name), title: (r.title as string) ?? null, created_at: String(r.created_at), touched_after: !!r.touched_after };
    // 창 안에서 태어났으면 이 세션이 만든 것, 아니면 원래 있던 것을 이 세션이 고친 것.
    (r.created_at >= from && r.created_at <= to ? created : edited).push(row);
  }

  // 자료 — 이 세션이 만든 지식에만 붙은 것(다른 지식이 같이 인용하면 뺀다). 만든 지식이 없으면 자료도 없다.
  let sources: FootprintSource[] = [];
  if (created.length) {
    const src = await itemsPool.query(
      `SELECT s.id, s.title, s.kind
         FROM source s
        WHERE EXISTS (SELECT 1 FROM knowledge_source ks WHERE ks.source_id = s.id AND ks.name = ANY($1))
          AND NOT EXISTS (SELECT 1 FROM knowledge_source ks2 WHERE ks2.source_id = s.id AND NOT (ks2.name = ANY($1)))
        ORDER BY s.id`,
      [created.map((k) => k.name)]);
    sources = src.rows.map((r) => ({ id: Number(r.id), title: (r.title as string) ?? null, kind: (r.kind as string) ?? null }));
  }

  return {
    tmux_session_id: tmux,
    window: { from, to },
    knowledge_created: created,
    knowledge_edited: edited,
    projects: projRows(),
    sources,
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
  sources?: number[];      // 완전 삭제할 자료 id (이 세션이 만든 지식에만 붙은 것)
  activities?: boolean;    // 이 세션의 작업 기록을 지운다
}
export interface PurgeFootprintResult {
  knowledge_deleted: number; knowledge_reverted: number; knowledge_revert_failed: string[];
  projects_deleted: number; project_folders: string[]; sources_deleted: number; activities_deleted: number;
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
  return withTx(async (client) => {
    const out: PurgeFootprintResult = {
      knowledge_deleted: 0, knowledge_reverted: 0, knowledge_revert_failed: [],
      projects_deleted: 0, project_folders: [], sources_deleted: 0, activities_deleted: 0,
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

    // ④ 작업 기록 — activity_knowledge·activity_touch 는 FK CASCADE 로 함께 정리된다.
    if (sel.activities && tmuxSessionId) {
      const r = await client.query(`DELETE FROM activity WHERE session_id = $1`, [tmuxSessionId]);
      out.activities_deleted = r.rowCount ?? 0;
    }
    return out;
  });
}
