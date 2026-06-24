// 작업(Activity) capability (P3) — activity_log(기록) + activity_list(조회). scope='memory'(공유 조직 작업,
//  memory_*/ctx_* 와 동일). 핸들러는 thin — 입력 파싱 후 domainmap/core/activity 의 store 호출.
//  author_person=ctx.actor(토큰 신원=누가), author_agent='어떤 AI'(호출자가 명시 — 모델/하네스 id). 사람×AI 집계의 축.
import { z } from "zod";
import { logActivity, listActivities, dashPeople, listDashMembers, getWatch, setWatch } from "../domainmap/core/activity.js";
import type { Capability } from "./types.js";

const activityLog: Capability = {
  name: "activity_log",
  title: "작업(activity) 기록",
  description:
    "프로젝트(task)를 진척시킨 작업(activity)을 기록한다 — type=commit/comment/decision/status_change/review. " +
    "commit 유형은 commit_sha+touches(건드린 code_unit/data_entity)로 is(코드구조) 갱신 근거가 되고, 모든 유형은 " +
    "should(도메인 의도) 점검 대상이다(점검했으나 변화 없으면 should_review='checked_no_change'로 명시). " +
    "실질 지식(의사결정·산출물)은 knowledge_save 로 따로 쓰고 ku_refs(produced/decided/references)로 연결한다 — 작업은 진척만 얇게. " +
    "진척시킨 프로젝트/태스크는 project_id(task_create_v6 의 id)로 연결한다. " +
    "author_agent='어떤 AI'(모델/하네스 id), session_id=세션 — 사람×AI 작업현황 집계의 축. " +
    "external(system+id) 지정 시 멱등 upsert(PM 코멘트 라운드트립 재호출 안전). " +
    "title 은 기술 상세 제목(펼쳤을 때 표시), summary 는 작업현황 피드 겉에 보이는 짧은 라벨 '중분류 - 내용'(예: '웹 페이지 수정 - 작업현황 UI 개선') — 둘 다 채워라(summary 없으면 title 로 폴백).",
  scope: "memory",
  input: {
    type: z.enum(["commit", "comment", "decision", "status_change", "review"]).describe("작업 유형"),
    title: z.string().min(1).max(500).describe("기술 상세 제목(펼침에 표시 — 정확한 기술 용어 OK). 얇게 — 실질 내용은 ku_refs 로 참조"),
    summary: z.string().max(120).optional().describe("작업현황 겉(접힘)에 보일 짧은 라벨 '중분류 - 내용' 형식(예: '웹 페이지 수정 - 작업현황 UI 개선', '배포 - 도메인 맵 탭'). 한 문장 설명이 아니라 라벨처럼 짧게(기술용어·약어 지양). 상세 설명은 title/body 에. 생략 시 title 로 폴백"),
    body: z.string().max(20000).optional().describe("짧은 메모(선택)"),
    project_id: z.number().int().positive().optional().describe("이 작업이 진척시킨 프로젝트(task/subtask) id(project_list_v6/task_create_v6). 미존재 id 면 무시"),
    ku_refs: z.array(z.object({
      name: z.string(),
      relation: z.enum(["produced", "references", "decided"]),
    })).optional().describe("산출/참조/결정한 지식(knowledge) name 연결 — v6 knowledge 에 있어야 함(없으면 skippedKnowledge)"),
    touches: z.array(z.object({
      target_kind: z.enum(["code_unit", "data_entity"]),
      target_id: z.number().int(),
    })).optional().describe("commit 이 건드린 코드/엔티티(is 갱신 근거)"),
    commit_sha: z.string().max(64).optional(),
    repo: z.string().max(100).optional().describe("repo 이름(commit 유형)"),
    committed_at: z.string().max(40).optional().describe("ISO 시각"),
    author_agent: z.string().max(120).optional().describe("어떤 AI(모델/하네스 id). 사람 단독이면 생략"),
    session_id: z.string().max(200).optional(),
    external_system: z.string().max(60).optional().describe("PM 미러 시스템(예: clickup)"),
    external_id: z.string().max(200).optional(),
    external_url: z.string().max(500).optional(),
    external_instance: z.string().max(200).optional(),
    should_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
    is_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
  },
  expose: { mcp: true, rest: false },
  handler: async (input: any, user, ctx) => {
    const authorPerson = ctx?.actor ?? user?.userId ?? null;
    const res = await logActivity({
      type: input.type, title: input.title, summary: input.summary ?? null, body: input.body ?? null,
      projectId: input.project_id ?? null, kuRefs: input.ku_refs, touches: input.touches,
      commit_sha: input.commit_sha ?? null, repo: input.repo ?? null, committed_at: input.committed_at ?? null,
      author_agent: input.author_agent ?? null, session_id: input.session_id ?? null,
      external_system: input.external_system ?? null, external_id: input.external_id ?? null,
      external_url: input.external_url ?? null, external_instance: input.external_instance,
      should_review: input.should_review, is_review: input.is_review,
    }, authorPerson);
    return { ok: true, ...res };
  },
};

const activityList: Capability = {
  name: "activity_list",
  title: "작업(activity) 목록",
  description:
    "작업(activity)을 최신순으로 조회한다(commit/comment/decision 등). 필터: author_person(누가)·author_agent(어떤 AI)·" +
    "type·project_id(진척시킨 프로젝트/태스크)·repo. 사람×AI 작업현황의 원천.",
  scope: "memory",
  input: {
    author_person: z.string().optional().describe("작성자(사람) 식별자로 필터"),
    author_agent: z.string().optional().describe("어떤 AI(모델/하네스)로 필터"),
    type: z.string().optional(),
    project_id: z.number().int().positive().optional().describe("이 프로젝트(task) id 를 진척시킨 작업만"),
    repo: z.string().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  },
  expose: {
    mcp: true,
    rest: [{
      method: "GET",
      paths: ["/api/ui/activity/list"],
      parse: (req) => ({
        author_person: req.query.author_person ? String(req.query.author_person) : undefined,
        author_agent: req.query.author_agent ? String(req.query.author_agent) : undefined,
        type: req.query.type ? String(req.query.type) : undefined,
        project_id: req.query.project_id ? Number(req.query.project_id) : undefined,
        repo: req.query.repo ? String(req.query.repo) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
      }),
    }],
  },
  handler: async (input: any) => listActivities({
    author_person: input.author_person, author_agent: input.author_agent, type: input.type,
    project_id: input.project_id, repo: input.repo, limit: input.limit,
  }),
};

// 사람×AI 작업현황 대시보드 — REST 전용(mcp:false 라 MCP/parity 표면 불변). 통합 DB 단일 SQL 집계를
//  그대로 반환. author_person 별로 묶이고 그 안에 author_agent 별 {유형분포·과업수·마지막활동}.
const dashPeopleCap: Capability = {
  name: "dash_people",
  title: "작업 현황(사람×AI)",
  description: "사람(author_person)별로 묶고 그 안에서 어떤 AI(author_agent)별로 작업(activity)을 집계한 현황. 웹 대시보드 전용.",
  scope: "memory",
  input: {},
  expose: {
    mcp: false,
    rest: [{
      method: "GET",
      paths: ["/api/ui/dash/people"],
      parse: () => ({}),
    }],
  },
  // viewer=토큰 신원(ctx.actor) — 그의 '내 목록'(dash_watch)+나 자신만 집계(개인화). 명부 전체 나열 안 함.
  handler: async (_input: any, user: any, ctx: any) => ({ people: await dashPeople(ctx?.actor ?? user?.userId ?? null) }),
};

// 편집 팝업용 — 전체 활성 '사람' 구성원(검색·체크는 프론트). REST 전용.
const dashMembersCap: Capability = {
  name: "dash_members",
  title: "작업 현황 — 구성원 후보",
  description: "내 목록 편집 팝업에서 고를 수 있는 활성 '사람' 구성원 전체. 웹 대시보드 전용.",
  scope: "memory",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/dash/members"], parse: () => ({}) }] },
  handler: async () => ({ members: await listDashMembers() }),
};

// 내 목록 읽기 — 뷰어(ctx.actor)의 watch member_id 목록(나 자신 제외 — 항상 표시되므로).
const dashWatchGetCap: Capability = {
  name: "dash_watch_get",
  title: "작업 현황 — 내 목록 조회",
  description: "현재 사용자의 작업현황 '내 목록'(구성원 워치리스트) member_id 배열. 웹 대시보드 전용.",
  scope: "memory",
  input: {},
  expose: { mcp: false, rest: [{ method: "GET", paths: ["/api/ui/dash/watch"], parse: () => ({}) }] },
  handler: async (_input: any, user: any, ctx: any) => ({
    me: ctx?.actor ?? user?.userId ?? null,
    member_ids: await getWatch(ctx?.actor ?? user?.userId ?? null),
  }),
};

// 내 목록 저장(통째 교체) — 뷰어 본인 것만. body.member_ids 배열.
const dashWatchSetCap: Capability = {
  name: "dash_watch_set",
  title: "작업 현황 — 내 목록 저장",
  description: "현재 사용자의 작업현황 '내 목록'을 member_ids 배열로 통째 교체(set). 본인 것만. 웹 대시보드 전용.",
  scope: "memory",
  input: { member_ids: z.array(z.string()).describe("내 목록에 둘 구성원 id 배열(통째 교체)") },
  expose: { mcp: false, rest: [{ method: "POST", paths: ["/api/ui/dash/watch"], parse: (req: any) => ({ member_ids: req.body?.member_ids ?? [] }) }] },
  handler: async (input: any, user: any, ctx: any) =>
    setWatch(ctx?.actor ?? user?.userId ?? null, Array.isArray(input.member_ids) ? input.member_ids : []),
};

export const activityCapabilities: Capability[] = [
  activityLog, activityList, dashPeopleCap, dashMembersCap, dashWatchGetCap, dashWatchSetCap,
];
