// 작업(Activity) capability (P3) — activity_log(기록) + activity_list(조회). scope='memory'(공유 조직 작업,
//  memory_*/ctx_* 와 동일). 핸들러는 thin — 입력 파싱 후 activity/store 의 store 호출.
//  author_person=ctx.actor(토큰 신원=누가), author_agent='어떤 AI'(호출자가 명시 — 모델/하네스 id). 사람×AI 집계의 축.
import { z } from "zod";
import { logActivity, listActivities, dashPeople, listDashMembers, getWatch, setWatch } from "../activity/store.js";
import type { Capability } from "./types.js";
import { HttpError } from "./rest-util.js";
import { canAttach, sessionWriteCap } from "../terminal/terminal-sessions.js"; // #852 세션 귀속 검증 — 그 세션에 들어갈 수 있는 사람만 그 세션으로 기록
import { canSeeProjectRow, hiddenProjects } from "../v6/visibility.js"; // #1291 프로젝트 공개범위
import { PUBLIC_VIEWER } from "../v6/knowledge-store.js";

// activity_log REST(#533) parse 가 검증하는 type 화이트리스트 — zod input enum 과 동일(MCP/REST 파리티).
//  REST 는 zod 를 안 타므로 parse 에서 필수·enum 을 직접 게이트한다(knowledge_save 파스와 동형).
const ACTIVITY_TYPES = ["feature", "fix", "decision", "docs", "research", "review", "chore", "other"];
const REVIEW_STATES = ["na", "checked_no_change", "changed"];

const activityLog: Capability = {
  name: "activity_log",
  title: "작업(activity) 기록",
  description:
    "프로젝트(task)를 진척시킨 작업(activity)을 기록한다. type = 이 작업이 '무엇'인가(성격): " +
    "feature(기능개발)·fix(오류수정)·decision(의사결정)·docs(문서작성)·research(리서치·조사)·review(검토·리뷰)·chore(운영·잡무: 배포·리팩토링·의존성)·other(기타). " +
    "커밋은 유형이 아니다 — 커밋을 했으면 그 일의 성격(예 feature/fix)을 type 으로 두고 commit_sha+repo+touches 를 함께 넘겨라(commit_sha 존재가 곧 '커밋 발생'). " +
    "commit_sha+touches(건드린 code_unit/data_entity)는 is(코드구조) 갱신 근거가 되고, 모든 유형은 should(도메인 의도) 점검 대상이다(점검했으나 변화 없으면 should_review='checked_no_change'로 명시). " +
    "실질 지식(의사결정·산출물)은 knowledge_save 로 따로 쓰고 ku_refs(produced/decided/references)로 연결한다 — 작업은 진척만 얇게. " +
    "진척시킨 프로젝트/태스크는 project_id(task_create_v6 의 id)로 연결한다. " +
    "author_agent(어떤 AI)와 session_id(어느 터미널 세션)는 게이트웨이가 접속 신원으로 자동 식별하므로 **넘기지 마라**(자기보고는 게이트웨이가 식별 못 했을 때만 폴백). 사람×AI 작업현황 집계의 축. " +
    "external(system+id) 지정 시 멱등 upsert(PM 코멘트 라운드트립 재호출 안전). " +
    "title 은 기술 상세 제목(펼쳤을 때 표시), summary 는 작업현황 피드 겉에 보이는 짧은 라벨 '중분류 - 내용'(예: '웹 페이지 수정 - 작업현황 UI 개선') — 둘 다 채워라(summary 없으면 title 로 폴백).",
  scope: "memory",
  input: {
    type: z.enum(["feature", "fix", "decision", "docs", "research", "review", "chore", "other"]).describe("작업 유형(성격): feature·fix·decision·docs·research·review·chore·other. 커밋 여부는 유형이 아니라 commit_sha 로 표현"),
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
    author_agent: z.string().max(120).optional().describe("어떤 AI(모델/하네스 id) — 보통 생략한다. 게이트웨이가 접속 신원으로 자동 식별(권위)하고, 이 값은 게이트웨이가 식별 못 했을 때만 폴백으로 쓰인다(프로젝트 #182)"),
    session_id: z.string().max(200).optional().describe("보통 생략한다 — 게이트웨이가 접속 헤더(x-lively-session)로 자동 식별(권위). 식별 못 했을 때만 폴백으로 쓰이며, 그 세션에 입장 권한이 없으면 무시된다(#852)"),
    external_system: z.string().max(60).optional().describe("PM 미러 시스템(예: clickup)"),
    external_id: z.string().max(200).optional(),
    external_url: z.string().max(500).optional(),
    external_instance: z.string().max(200).optional(),
    should_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
    is_review: z.enum(["na", "checked_no_change", "changed"]).optional(),
  },
  expose: {
    mcp: true,
    // #533: 기계적/대량 마이그레이션을 스크립트가 HTTP 로 처리할 때 작업로그도 HTTP 로 남기게 — 유일하던 쓰기 파리티 갭 해소.
    //  같은 bearer 토큰·같은 scope(memory). REST 는 zod 미적용이라 parse 에서 필수·enum 을 게이트(handler 는 파싱값 신뢰).
    //  ctx.agent 는 MCP 경로만 채우므로 REST 는 body.author_agent(있으면)로 폴백 — 스크립트가 명시 가능.
    rest: [{ method: "POST", paths: ["/api/ui/activity"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, any>;
        const type = b.type != null ? String(b.type) : "";
        if (!ACTIVITY_TYPES.includes(type)) throw new HttpError(400, `type 은(는) ${ACTIVITY_TYPES.join("|")} 중 하나여야 합니다`);
        const title = String(b.title ?? "").trim();
        if (!title) throw new HttpError(400, "title 이(가) 필요합니다");
        const review = (v: unknown, name: string): string | undefined => {
          if (v == null) return undefined;
          const s = String(v);
          if (!REVIEW_STATES.includes(s)) throw new HttpError(400, `${name} 은(는) ${REVIEW_STATES.join("|")} 중 하나여야 합니다`);
          return s;
        };
        return {
          type, title,
          summary: b.summary != null ? String(b.summary) : undefined,
          body: b.body != null ? String(b.body) : undefined,
          project_id: b.project_id != null ? Number(b.project_id) : undefined,
          ku_refs: Array.isArray(b.ku_refs) ? b.ku_refs : undefined,
          touches: Array.isArray(b.touches) ? b.touches : undefined,
          commit_sha: b.commit_sha != null ? String(b.commit_sha) : undefined,
          repo: b.repo != null ? String(b.repo) : undefined,
          committed_at: b.committed_at != null ? String(b.committed_at) : undefined,
          author_agent: b.author_agent != null ? String(b.author_agent) : undefined,
          session_id: b.session_id != null ? String(b.session_id) : undefined,
          external_system: b.external_system != null ? String(b.external_system) : undefined,
          external_id: b.external_id != null ? String(b.external_id) : undefined,
          external_url: b.external_url != null ? String(b.external_url) : undefined,
          external_instance: b.external_instance != null ? String(b.external_instance) : undefined,
          should_review: review(b.should_review, "should_review"),
          is_review: review(b.is_review, "is_review"),
        };
      } }],
  },
  handler: async (input: any, user, ctx) => {
    const authorPerson = ctx?.actor ?? user?.userId ?? null;
    // 작업자(AI) — 게이트웨이가 접속 신원(User-Agent)으로 식별한 값이 권위(프로젝트 #182). 자기보고(input.author_agent)는
    //  게이트웨이가 식별 못 했을 때만 폴백(예: UA 없는 경로). 게이트웨이 값이 있으면 그게 이긴다.
    const authorAgent = ctx?.agent ?? input.author_agent ?? null;
    // 세션(#852) — author_agent 와 동형: 게이트웨이가 접속 헤더(x-lively-session)로 본 세션이 권위, 자기보고는 폴백.
    //  ⚠ 다만 author_agent 와 달리 **위조가 무해하지 않다** — session_id 는 프로젝트 타임라인의 세션 추론
    //   (org/store.ts: session_project 조인)을 타고 '이 작업이 어느 프로젝트 것인가'를 바꾼다. 헤더는 클라이언트
    //   자기주장이므로, **그 세션에 들어갈 수 있는 사람인지**(canAttach)를 확인하고서야 기록한다.
    //   canAttach = 소유자·초대된 멤버, 그리고 프로젝트 폴더 세션이면 로그인한 누구나(#452 공동 세션).
    //   자격이 없거나 이미 끝난 세션이면 조용히 미기록(null) — 기록 자체를 막지는 않는다(작업 기록이 더 중요).
    const claimedSession = ctx?.session ?? input.session_id ?? null;
    const sessionId = claimedSession && authorPerson && await canAttach(String(claimedSession), authorPerson)
      ? String(claimedSession) : null;
    // 프로젝트 귀속도 자기주장이다(#1291) — 세션은 canAttach 로 검증하면서 project_id 는 '존재하나'만 봤다.
    //  안 보이는 프로젝트에 기록을 밀어 넣으면 그 타임라인을 오염시키고, 반대로 잠긴 작업을 공개 프로젝트에
    //  붙여 내보낼 수도 있다. 세션 검증과 나란히 둔다 — 없는 것과 같은 404 로 답해 존재를 숨긴다.
    if (input.project_id != null && ctx?.viewer != null
        && !(await canSeeProjectRow(Number(input.project_id), ctx.viewer))) {
      throw new HttpError(404, `프로젝트 #${input.project_id} 없음`);
    }
    // 기록 범위(#1291 v2) — 이 세션이 승인 없이 쓸 수 있는 최대 가시성보다 넓게 기록하려는 걸 막는다.
    //  작업기록은 프로젝트에 붙는 순간 그 프로젝트 대상에게 보이므로, **잠긴 세션이 공개 프로젝트에 다는 것**이
    //  범위 초과다(반대 방향은 좁히는 것이라 문제없다). 차단은 400 + 무엇을 어떻게 바꿔야 하는지 안내.
    if (sessionId && input.project_id != null) {
      const cap = await sessionWriteCap(sessionId);
      if (cap !== "open") {
        const hidden = await hiddenProjects(PUBLIC_VIEWER).catch(() => null);
        const targetIsOpen = hidden ? !hidden.ids.has(Number(input.project_id)) : false;
        if (targetIsOpen) {
          throw new HttpError(400,
            `이 세션의 기록 범위는 '${cap}' 입니다 — 전체 공개 프로젝트에는 기록할 수 없습니다. `
            + "넓히려면 세션 설정에서 기록 범위를 바꾸세요(그 자체가 명시 승인입니다).");
        }
      }
    }
    const res = await logActivity({
      type: input.type, title: input.title, summary: input.summary ?? null, body: input.body ?? null,
      projectId: input.project_id ?? null, kuRefs: input.ku_refs, touches: input.touches,
      commit_sha: input.commit_sha ?? null, repo: input.repo ?? null, committed_at: input.committed_at ?? null,
      author_agent: authorAgent, session_id: sessionId,
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
    "작업(activity)을 최신순으로 조회한다(feature/fix/decision 등). 필터: author_person(누가)·author_agent(어떤 AI)·" +
    "type·project_id(진척시킨 프로젝트/태스크)·repo·session_id(어느 터미널 세션에서 — #852 역방향). 사람×AI 작업현황의 원천.",
  scope: "memory",
  input: {
    author_person: z.string().optional().describe("작성자(사람) 식별자로 필터"),
    author_agent: z.string().optional().describe("어떤 AI(모델/하네스)로 필터"),
    type: z.string().optional(),
    project_id: z.number().int().positive().optional().describe("이 프로젝트(task) id 를 진척시킨 작업만"),
    repo: z.string().optional(),
    session_id: z.string().max(200).optional().describe("이 터미널 세션(box-…)에서 한 작업만 — #852 의 역방향 조회"),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().min(0).optional().describe("페이지 오프셋(기본 0) — 최신 N건 너머 과거 작업 이력 순회(#709)"),
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
        session_id: req.query.session_id ? String(req.query.session_id) : undefined,
        limit: req.query.limit ? Number(req.query.limit) : undefined,
        offset: req.query.offset ? Number(req.query.offset) : undefined,
      }),
    }],
  },
  handler: async (input: any, _user: any, ctx: any) => listActivities({
    viewer: ctx?.viewer ?? null,
    author_person: input.author_person, author_agent: input.author_agent, type: input.type,
    project_id: input.project_id, repo: input.repo, session_id: input.session_id,
    limit: input.limit, offset: input.offset,
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
