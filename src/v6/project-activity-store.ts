// 프로젝트 타임라인 — v6 테이블(activity·session_project·activity_knowledge·activity_touch·repo)만 조인하는
//  프로젝트 축 조회. (#1313 R18) 구 org/store.ts 말미의 이질 구간을 v6 로 이동(org 도메인 아님) — 소비자 직결.
import { itemsPool } from "../db/client.js";

// ── 프로젝트 타임라인 — 이 프로젝트 팀원들이 한 작업(activity). authorPerson 지정 시 그 사람만. ──
//  activity 는 itemsPool 동일 DB(지식참조=activity_knowledge→knowledge FK). project_member.member_id ↔ activity.author_person 조인.
export interface ProjectActivity {
  id: number; type: string; title: string | null; summary: string | null; body: string | null;
  author_person: string | null; author_agent: string | null;
  commit_sha: string | null; committed_at: string | null; created_at: string | null;
  should_review: string | null; is_review: string | null; repo: string | null;
  external_system: string | null; external_url: string | null;
  refs: { name: string; title: string | null; relation: string }[];
  touchCount: number;
}
export async function listProjectActivities(
  projectId: number, authorPerson?: string, limit = 100, offset = 0,
): Promise<ProjectActivity[]> {
  const params: unknown[] = [projectId];
  let personFilter = "";
  if (authorPerson) { params.push(authorPerson); personFilter = ` AND a.author_person = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 200)); const limP = `$${params.length}`;
  params.push(Math.min(Math.max(Number(offset) || 0, 0), 1_000_000)); const offP = `$${params.length}`;   // #709 offset — 최신 N건 너머 과거 타임라인
  // 이 프로젝트에 연결된 작업 — 둘 중 하나면 포함:
  //  ① activity.project_id 가 이 프로젝트(명시적 링크 — activity_log 가 직접 박는 가장 권위 있는 신호), 또는
  //  ② activity.session_id 가 이 프로젝트의 세션 **구간**에 드는 것(세션 추론, 시간구간): 작업 발생시각이 이 프로젝트
  //     구간 [valid_from, 다음 구간) 안이면 귀속. 세션이 나중에 재바인딩돼도 과거 작업은 옛 프로젝트 구간에 남는다(#905 C1).
  //     단 **명시 project_id 가 있는 작업은 세션추론에서 제외**(명시가 권위) — 안 그러면 A 세션에서 B 로 명시 기록한
  //     작업이 A·B 양쪽에 이중 귀속된다. 세션추론은 project_id 가 비어 귀속처가 없는 작업의 폴백일 뿐.
  //  (예전엔 author_person 조인으로 팀원이 한 모든 작업을 보여줘서 프로젝트 밖 작업까지 섞였음 → 그 폭넓은 조인은 유지하지 않는다.
  //   project_id=이 프로젝트는 정의상 이 프로젝트 작업이라 session_id 가 없어도 표시되어야 한다 — MCP activity_log 로 직접 기록한 작업 포함.)
  const r = await itemsPool.query(
    `SELECT a.id, a.type, a.title, a.summary, a.body, a.author_person, a.author_agent,
            a.commit_sha, a.committed_at, a.created_at, a.should_review, a.is_review,
            a.external_system, a.external_url, rp.name AS repo
       FROM activity a
       LEFT JOIN repo rp ON rp.id = a.repo_id
      WHERE (a.project_id = $1
             OR (a.project_id IS NULL AND EXISTS (
                  SELECT 1 FROM session_project sp
                   WHERE sp.session_id = a.session_id
                     AND sp.project_id = $1
                     AND sp.valid_from <= COALESCE(a.committed_at, a.created_at, now())
                     AND COALESCE(a.committed_at, a.created_at, now()) < COALESCE(
                           (SELECT MIN(sp2.valid_from) FROM session_project sp2
                             WHERE sp2.session_id = sp.session_id AND sp2.valid_from > sp.valid_from),
                           'infinity'::timestamptz))))
      ${personFilter}
      ORDER BY COALESCE(a.committed_at, a.created_at) DESC
      LIMIT ${limP} OFFSET ${offP}`,
    params,
  );
  const rows = r.rows as ProjectActivity[];
  if (!rows.length) return rows;
  // 펼침 연결(산출/참조 지식 + 코드 touch 수)을 곁들인다 — 회사 타임라인(listActivities)과 같은 프로젝션이어야
  // 공용 렌더러(web activityTimelineRow)가 프로젝트 상세에서도 본문·참조를 그린다. tasks 는 이 프로젝트 자신이라 생략.
  const ids = rows.map((row) => row.id);
  const [refRes, touchRes] = await Promise.all([
    itemsPool.query(
      `SELECT ak.activity_id, ak.name, ak.relation, k.title
         FROM activity_knowledge ak LEFT JOIN knowledge k ON k.name = ak.name
        WHERE ak.activity_id = ANY($1) ORDER BY ak.created_at`, [ids]),
    itemsPool.query(
      `SELECT activity_id, COUNT(*)::int AS n FROM activity_touch
        WHERE activity_id = ANY($1) GROUP BY activity_id`, [ids]),
  ]);
  const byId = new Map<number, ProjectActivity>();
  for (const row of rows) { row.refs = []; row.touchCount = 0; byId.set(row.id, row); }
  for (const rf of refRes.rows) byId.get(rf.activity_id)?.refs.push({ name: rf.name, title: rf.title, relation: rf.relation });
  for (const t of touchRes.rows) { const row = byId.get(t.activity_id); if (row) row.touchCount = t.n; }
  return rows;
}
