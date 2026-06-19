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
        `UPDATE activity SET type=$1,title=$2,body=$3,
           author_person=COALESCE($4,author_person),author_agent=COALESCE($5,author_agent),
           session_id=COALESCE($6,session_id),repo_id=COALESCE($7,repo_id),commit_sha=COALESCE($8,commit_sha),
           committed_at=COALESCE($9,committed_at),external_url=COALESCE($10,external_url),
           should_review=$11,is_review=$12 WHERE id=$13`,
        [input.type, input.title, input.body ?? null, authorPerson, input.author_agent ?? null, input.session_id ?? null,
         repoId, input.commit_sha ?? null, input.committed_at ?? null, input.external_url ?? null, sr, ir, id]);
    } else {
      action = "insert";
      const r = await one(client,
        `INSERT INTO activity(type,title,body,author_person,author_agent,session_id,repo_id,commit_sha,committed_at,
           external_system,external_instance,external_id,external_url,should_review,is_review,created_at)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING id`,
        [input.type, input.title, input.body ?? null, authorPerson, input.author_agent ?? null, input.session_id ?? null,
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
export async function dashPeople(): Promise<{ author_person: string | null; total: number; agents: DashAgentRow[] }[]> {
  // 유형은 스키마 CHECK(activity_type_chk)와 동일 — commit/comment/decision/status_change/review.
  const rows = await q(dmPool(), `
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
    GROUP BY a.author_person, a.author_agent`);
  // (person,agent) 평면행 → person 으로 묶고 그 안에 agent 행 배열. 정형(shape)일 뿐 조인 아님.
  const byPerson = new Map<string, { author_person: string | null; total: number; agents: DashAgentRow[] }>();
  for (const r of rows) {
    const personKey = r.author_person === null ? " __null__" : String(r.author_person);
    let bucket = byPerson.get(personKey);
    if (!bucket) { bucket = { author_person: r.author_person ?? null, total: 0, agents: [] }; byPerson.set(personKey, bucket); }
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
  // 각 사람의 AI 행은 최근활동 desc. 사람 카드도 최근활동 desc(가장 최근 활동한 사람부터).
  const personLast = (p: { agents: DashAgentRow[] }) =>
    p.agents.reduce((mx, ag) => (ag.lastActiveAt && (!mx || ag.lastActiveAt > mx) ? ag.lastActiveAt : mx), null as string | null);
  const people = [...byPerson.values()];
  for (const p of people) p.agents.sort((x, y) => (y.lastActiveAt || "").localeCompare(x.lastActiveAt || ""));
  people.sort((a, b) => (personLast(b) || "").localeCompare(personLast(a) || ""));
  return people;
}

// 작업 목록(최신순 — committed_at 우선, 없으면 created_at). 필터: 작성자·AI·유형·과업(ku)·repo.
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
  return q(dmPool(), `
    SELECT a.id, a.type, a.title, a.body, a.author_person, a.author_agent, a.session_id,
           a.commit_sha, a.committed_at, a.should_review, a.is_review, a.created_at,
           a.external_system, a.external_url
    FROM activity a ${join}
    ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY COALESCE(a.committed_at, a.created_at) DESC LIMIT $${args.length}`, args);
}
