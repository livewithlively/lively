// 작업(Activity) 코어 — 통합 DB 신설(P3). domainmap 구조(is)와 ku(should/맥락)를 잇는 이벤트 레이어의 쓰기·읽기.
//  과업(Task)=knowledge_unit(kind='W'), '작업'=과업을 향해 한 행위(이벤트). commit 은 작업의 한 유형.
//  단일 풀(dmPool=itemsPool, P1)이라 activity + activity_task(과업 n:n) + activity_ku_ref(지식 참조) +
//  activity_touch(코드 footprint)를 한 트랜잭션(withTx)으로 원자 기록한다 — 통합의 산물.
//  author_person=토큰 신원(누가), author_agent='어떤 AI'(모델/하네스 — 호출자가 명시 전달). 사람×AI 집계의 축.
import { withTx, q, one, dmPool } from "../db.js";
import { saneLimit } from "./types.js";
import { conflictKey } from "../../org/external-identity.js";

const now = () => new Date().toISOString();

export interface ActivityRef { name: string; relation: string }
export interface ActivityTouch { target_kind: string; target_id: number }
export interface LogActivityInput {
  type: string;
  title: string;
  summary?: string | null;
  body?: string | null;
  taskKuNames?: string[];
  kuRefs?: ActivityRef[];
  touches?: ActivityTouch[];
  commit_sha?: string | null;
  repo?: string | null;
  committed_at?: string | null;
  author_agent?: string | null;
  session_id?: string | null;
  external_system?: string | null;
  external_id?: string | null;
  external_url?: string | null;
  external_instance?: unknown;
  should_review?: string;
  is_review?: string;
}
export interface LogActivityResult {
  id: number;
  action: "insert" | "update";
  tasks: number;
  refs: number;
  touches: number;
  skippedKu: string[]; // FK 없는 ku 이름(존재 안 함 → 침묵 skip, txn abort 방지)
}

// 작업 한 건을 원자 기록. external(system,instance,external_id) 보유 시 멱등 upsert(PM 코멘트 라운드트립 재호출
//  안전 — conflictKey 정규화). taskKuNames/kuRefs 는 knowledge_unit FK 라, 존재 안 하는 ku 는 침묵 skip(전체
//  트랜잭션이 FK 위반으로 abort 되는 것 방지 — 부분 성공 대신 알려진 ku 만 연결하고 결과에 skippedKu 로 보고).
export async function logActivity(input: LogActivityInput, authorPerson: string | null): Promise<LogActivityResult> {
  return withTx(async (client) => {
    let repoId: number | null = null;
    if (input.repo) {
      const r = await one(client, "SELECT id FROM repo WHERE name=$1", [input.repo]);
      repoId = r?.id ?? null;
    }
    const hasExt = typeof input.external_id === "string" && input.external_id.length > 0;
    const ck = hasExt
      ? conflictKey({ externalSystem: input.external_system ?? "", externalInstance: input.external_instance, externalId: input.external_id as string })
      : null;
    const sr = input.should_review ?? "na";
    const ir = input.is_review ?? "na";

    let id: number;
    let action: "insert" | "update";
    // external 멱등 — 부분유니크(external_id 보유) 행을 SELECT 후 UPDATE/INSERT. NULLS NOT DISTINCT 와 정합되게
    //  IS NOT DISTINCT FROM 으로 instance=NULL/'' 일관 비교.
    const existing = ck
      ? await one(client,
          `SELECT id FROM activity WHERE external_system IS NOT DISTINCT FROM $1
             AND external_instance IS NOT DISTINCT FROM $2 AND external_id=$3`,
          [ck.externalSystem, ck.externalInstance, ck.externalId])
      : null;
    if (existing) {
      action = "update";
      id = existing.id;
      await client.query(
        `UPDATE activity SET type=$1,title=$2,body=$3,summary=COALESCE($14,summary),
           author_person=COALESCE($4,author_person),author_agent=COALESCE($5,author_agent),
           session_id=COALESCE($6,session_id),repo_id=COALESCE($7,repo_id),commit_sha=COALESCE($8,commit_sha),
           committed_at=COALESCE($9,committed_at),external_url=COALESCE($10,external_url),
           should_review=$11,is_review=$12 WHERE id=$13`,
        [input.type, input.title, input.body ?? null, authorPerson, input.author_agent ?? null, input.session_id ?? null,
         repoId, input.commit_sha ?? null, input.committed_at ?? null, input.external_url ?? null, sr, ir, id, input.summary ?? null]);
    } else {
      action = "insert";
      const r = await one(client,
        `INSERT INTO activity(type,title,summary,body,author_person,author_agent,session_id,repo_id,commit_sha,committed_at,
           external_system,external_instance,external_id,external_url,should_review,is_review,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id`,
        [input.type, input.title, input.summary ?? null, input.body ?? null, authorPerson, input.author_agent ?? null, input.session_id ?? null,
         repoId, input.commit_sha ?? null, input.committed_at ?? null,
         ck?.externalSystem ?? null, ck ? ck.externalInstance : null, ck?.externalId ?? null, input.external_url ?? null,
         sr, ir, now()]);
      id = r.id;
    }

    const skippedKu: string[] = [];
    let tasks = 0;
    for (const ku of input.taskKuNames ?? []) {
      const ok = await one(client, "SELECT 1 FROM knowledge_unit WHERE name=$1", [ku]);
      if (!ok) { skippedKu.push(ku); continue; }
      await client.query("INSERT INTO activity_task(activity_id,ku_name,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [id, ku, now()]);
      tasks++;
    }
    let refs = 0;
    for (const ref of input.kuRefs ?? []) {
      const ok = await one(client, "SELECT 1 FROM knowledge_unit WHERE name=$1", [ref.name]);
      if (!ok) { skippedKu.push(ref.name); continue; }
      await client.query("INSERT INTO activity_ku_ref(activity_id,ku_name,relation,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, ref.name, ref.relation, now()]);
      refs++;
    }
    let touches = 0;
    for (const t of input.touches ?? []) {
      await client.query("INSERT INTO activity_touch(activity_id,target_kind,target_id,created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING", [id, t.target_kind, t.target_id, now()]);
      touches++;
    }
    return { id, action, tasks, refs, touches, skippedKu };
  });
}

export interface ListActivitiesFilter {
  author_person?: string;
  author_agent?: string;
  type?: string;
  task_ku?: string;
  repo?: string;
  limit?: number;
}

// 사람×AI 작업현황(대시보드) — author_person(누가) × author_agent(어떤 AI) 2단 집계.
//  통합 DB 네이티브: activity ⨝ activity_task(과업 distinct 수)를 (person,agent) grain 으로 GROUP BY 한
//  방에 집계한다(메모리 조인 금지). 유형 분포는 FILTER 집계, 과업수는 COUNT(DISTINCT ku_name).
//  반환행은 (person,agent) 평면 → capability/핸들러가 person 으로 묶어 nested 로 shape(결과 row 정형만; 조인 아님).
//  author_person/author_agent 가 NULL 인 행도 GROUP BY 가 한 버킷으로 모은다(NULL 의미는 표현 계층에서 '미상'/'직접').
export interface DashAgentRow {
  author_agent: string | null;
  count: number;
  byType: Record<string, number>;
  tasks: number;
  lastActiveAt: string | null;
}
export interface DashPersonRow { author_person: string | null; display_name: string | null; total: number; agents: DashAgentRow[] }
export async function dashPeople(viewer: string | null): Promise<DashPersonRow[]> {
  // 개인화 — 뷰어의 '내 목록'(dash_watch) + 나 자신만 보인다(30명 전원 나열 방지). watch 비면 = 나만.
  //  뷰어가 명부에 없고 watch 도 없으면(관리/외부 토큰) 빈 화면 방지로 전체 활성 멤버 폴백.
  const members = await q(dmPool(), "SELECT id, display_name FROM org_member WHERE state='active' AND kind='human' ORDER BY sort, id");
  const memberById = new Map<string, any>(members.map((m: any) => [String(m.id), m]));
  const watch = await q(dmPool(), "SELECT member_id FROM dash_watch WHERE owner=$1", [viewer ?? ""]);
  const targetIds = new Set<string>();
  if (viewer && memberById.has(viewer)) targetIds.add(viewer);
  for (const r of watch) if (memberById.has(String(r.member_id))) targetIds.add(String(r.member_id));
  if (targetIds.size === 0) for (const id of memberById.keys()) targetIds.add(id);
  const ids = [...targetIds];

  // 유형은 스키마 CHECK(activity_type_chk)와 동일 — commit/comment/decision/status_change/review. 내 목록 작성자만 집계.
  const rows = ids.length ? await q(dmPool(), `
    SELECT a.author_person, a.author_agent,
           COUNT(*)::int AS count,
           COUNT(*) FILTER (WHERE a.type='commit')::int        AS t_commit,
           COUNT(*) FILTER (WHERE a.type='comment')::int       AS t_comment,
           COUNT(*) FILTER (WHERE a.type='decision')::int      AS t_decision,
           COUNT(*) FILTER (WHERE a.type='status_change')::int AS t_status_change,
           COUNT(*) FILTER (WHERE a.type='review')::int        AS t_review,
           COUNT(DISTINCT atk.ku_name)::int AS tasks,
           MAX(COALESCE(a.committed_at, a.created_at)) AS last_active_at
    FROM activity a
    LEFT JOIN activity_task atk ON atk.activity_id = a.id
    WHERE a.author_person = ANY($1)
    GROUP BY a.author_person, a.author_agent`, [ids]) : [];
  // (person,agent) 평면행 → person 으로 묶고 그 안에 agent 행 배열. 정형(shape)일 뿐 조인 아님.
  const byPerson = new Map<string, DashPersonRow>();
  for (const r of rows) {
    const personKey = String(r.author_person);
    let bucket = byPerson.get(personKey);
    if (!bucket) { bucket = { author_person: r.author_person, display_name: null, total: 0, agents: [] }; byPerson.set(personKey, bucket); }
    const lastActiveAt = r.last_active_at ? new Date(r.last_active_at).toISOString() : null;
    bucket.total += r.count;
    bucket.agents.push({
      author_agent: r.author_agent ?? null,
      count: r.count,
      byType: { commit: r.t_commit, comment: r.t_comment, decision: r.t_decision, status_change: r.t_status_change, review: r.t_review },
      tasks: r.tasks,
      lastActiveAt,
    });
  }
  // 명부 합류 — 활동이 0건이어도 팀 전원이 보이도록 활성 '사람' 구성원(org_member)을 끌어온다(PM/PO 가 전원을 본다).
  //  작성자(사람) 축은 human 만(agent/system 제외) — AI 는 author_agent 축(카드 내 AI 칩)으로 따로 표현되므로 사람 축
  //  중복 방지. 활동 버킷이 이미 있으면 표시명만 채우고, 없으면 빈 버킷(활동 0)으로 새로 만든다. org_member 는 같은 풀(dmPool).
  for (const id of ids) {
    const m = memberById.get(id);
    const bucket = byPerson.get(id);
    if (!bucket) byPerson.set(id, { author_person: id, display_name: m?.display_name ?? null, total: 0, agents: [] });
    else if (!bucket.display_name) bucket.display_name = m?.display_name ?? null;
  }
  // 각 사람의 AI 행은 최근활동 desc. 사람 카드는 최근활동 desc(가장 최근 활동한 사람부터), 무활동 구성원은 표시명순으로 뒤에.
  const personLast = (p: { agents: DashAgentRow[] }) =>
    p.agents.reduce((mx, ag) => (ag.lastActiveAt && (!mx || ag.lastActiveAt > mx) ? ag.lastActiveAt : mx), null as string | null);
  const people = [...byPerson.values()];
  for (const p of people) p.agents.sort((x, y) => (y.lastActiveAt || "").localeCompare(x.lastActiveAt || ""));
  people.sort((a, b) => {
    const la = personLast(a) || "", lb = personLast(b) || "";
    if (la !== lb) return lb.localeCompare(la);
    return (a.display_name || a.author_person || "").localeCompare(b.display_name || b.author_person || "");
  });
  return people;
}

// '내 목록'(dash_watch) — 작업현황 구성원 섹션을 뷰어별로 추리는 개인 워치리스트. owner=뷰어 토큰 신원(ctx.actor).
//  피커(편집 팝업)용 활성 '사람' 구성원 전체. 검색·체크는 프론트에서.
export async function listDashMembers(): Promise<{ id: string; display_name: string | null }[]> {
  const rows = await q(dmPool(), "SELECT id, display_name FROM org_member WHERE state='active' AND kind='human' ORDER BY sort, id");
  return rows.map((m: any) => ({ id: String(m.id), display_name: m.display_name ?? null }));
}
export async function getWatch(owner: string | null): Promise<string[]> {
  if (!owner) return [];
  const rows = await q(dmPool(), "SELECT member_id FROM dash_watch WHERE owner=$1 ORDER BY sort, member_id", [owner]);
  return rows.map((r: any) => String(r.member_id));
}
// 내 목록 통째 교체(set semantics). 유효 활성 멤버만, 자기 자신 제외(뷰어는 항상 보이므로 dashPeople 가 합류).
export async function setWatch(owner: string | null, memberIds: string[]): Promise<{ count: number }> {
  if (!owner) throw new Error("내 목록을 저장할 사용자 신원이 없습니다");
  const valid = new Set((await listDashMembers()).map((m) => m.id));
  const clean = [...new Set((memberIds ?? []).map(String))].filter((id) => valid.has(id) && id !== owner);
  return withTx(async (client) => {
    await client.query("DELETE FROM dash_watch WHERE owner=$1", [owner]);
    let i = 0;
    for (const id of clean) {
      await client.query(
        "INSERT INTO dash_watch(owner, member_id, sort, created_at) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [owner, id, i++, now()]);
    }
    return { count: clean.length };
  });
}

// 작업 목록(최신순 — committed_at 우선, 없으면 created_at). 필터: 작성자·AI·유형·과업(ku)·repo.
//  웹 작업현황 피드의 원천 — 행마다 연결(과업/산출·참조 지식/코드 touch)을 곁들여 드릴인(상세 펼침)이 N+1 없이
//  맥락을 보이게 한다. body 는 그대로 반환(펼침 본문). repo 는 id→name 으로 표시화.
export async function listActivities(f: ListActivitiesFilter): Promise<any[]> {
  const lim = saneLimit(f.limit, 50, 200);
  const where: string[] = [];
  const args: unknown[] = [];
  if (f.author_person) { args.push(f.author_person); where.push(`a.author_person=$${args.length}`); }
  if (f.author_agent) { args.push(f.author_agent); where.push(`a.author_agent=$${args.length}`); }
  if (f.type) { args.push(f.type); where.push(`a.type=$${args.length}`); }
  if (f.repo) { args.push(f.repo); where.push(`a.repo_id=(SELECT id FROM repo WHERE name=$${args.length})`); }
  let join = "";
  if (f.task_ku) { args.push(f.task_ku); join = `JOIN activity_task atk ON atk.activity_id=a.id AND atk.ku_name=$${args.length}`; }
  args.push(lim);
  const rows = await q(dmPool(), `
    SELECT a.id, a.type, a.title, a.summary, a.body, a.author_person, a.author_agent, a.session_id,
           a.commit_sha, a.committed_at, a.should_review, a.is_review, a.created_at,
           a.external_system, a.external_url, r.name AS repo
    FROM activity a ${join}
    LEFT JOIN repo r ON r.id = a.repo_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(a.committed_at, a.created_at) DESC LIMIT $${args.length}`, args);
  if (!rows.length) return rows;
  // 연결을 한 방에 곁들인다(id IN ANY) — knowledge_unit JOIN 으로 과업/지식 제목까지(같은 풀이라 조인 가능).
  const ids = rows.map((r: any) => r.id);
  const [taskRows, refRows, touchRows] = await Promise.all([
    q(dmPool(), `SELECT atk.activity_id, atk.ku_name AS name, ku.title, ku.lifecycle
                   FROM activity_task atk LEFT JOIN knowledge_unit ku ON ku.name = atk.ku_name
                  WHERE atk.activity_id = ANY($1) ORDER BY atk.created_at`, [ids]),
    q(dmPool(), `SELECT akr.activity_id, akr.ku_name AS name, akr.relation, ku.title
                   FROM activity_ku_ref akr LEFT JOIN knowledge_unit ku ON ku.name = akr.ku_name
                  WHERE akr.activity_id = ANY($1) ORDER BY akr.created_at`, [ids]),
    q(dmPool(), `SELECT activity_id, COUNT(*)::int AS n FROM activity_touch
                  WHERE activity_id = ANY($1) GROUP BY activity_id`, [ids]),
  ]);
  const byId = new Map<number, any>();
  for (const r of rows) { r.tasks = []; r.refs = []; r.touchCount = 0; byId.set(r.id, r); }
  for (const t of taskRows) byId.get(t.activity_id)?.tasks.push({ name: t.name, title: t.title, lifecycle: t.lifecycle });
  for (const rf of refRows) byId.get(rf.activity_id)?.refs.push({ name: rf.name, title: rf.title, relation: rf.relation });
  for (const t of touchRows) { const row = byId.get(t.activity_id); if (row) row.touchCount = t.n; }
  return rows;
}
