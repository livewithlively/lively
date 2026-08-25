// 세션↔프로젝트 소속 변경 capability (#1798 후속) — 종전 순수 라우트(terminal/session-project-routes.ts 의
//  registerSessionProjectRoutes)를 capability 로 접어 MCP+REST co-exposed 로 만든다. 종전엔 REST 전용이라 미연결
//  세션 훅(project-bind-nudge)이 curl 명령을 안내했다 — #1077(me_git_credential MCP 미노출 → 셸 우회 유도)과 같은 갭.
//  에이전트가 자기 세션을 붙일 때 session_id 를 몰라도 되도록 기본값 = 이 요청의 세션(ctx.session — 게이트웨이가
//  접속 헤더 x-lively-session 으로 식별, #852 activity_log 와 같은 축). REST 경로·페이로드는 종전 그대로
//  (POST /api/ui/terminal/sessions/:id/project {projectId}) — 웹(홈·상단바 #1749) 클라이언트 무변경.
//  scope=null(bearer 인증만, 종전 라우트와 동일 게이트). 소유권(@box_owner)·공개범위(#1291)는 setSessionProject 안에서 집행.
//  POST 마운트라 capMutates 자동 파생 → 읽기전용 세션에선 차단(세션 소속 변경은 쓰기가 맞다).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { acknowledgeSessionProjectContext, sessionProjectContext, setSessionProject } from "../terminal/session-project-routes.js";
import { isExternalExecutionSessionId } from "../org/auth/agent-identity.js";

const sessionSetProjectInput = {
  project_id: z.number().int().min(0).nullable().describe("붙일 프로젝트 id(project_list_v6/project_create_v6). null·0 = 소속 해제. 공개범위 밖 프로젝트는 403"),
  session_id: z.string().max(128).optional().describe("대상 터미널 세션 id — 보통 생략한다(기본 = 이 요청을 보낸 세션, 게이트웨이가 접속 신원으로 식별). 남의 세션은 소유자만 바꿀 수 있다"),
};
type SessionSetProjectInput = z.infer<z.ZodObject<typeof sessionSetProjectInput>>;

const sessionSetProject: Capability = {
  name: "session_set_project",
  title: "세션 프로젝트 소속 변경",
  description:
    "터미널 세션을 프로젝트에 붙이거나(project_id) 뗀다(null·0). session_id 생략 시 **이 요청을 보낸 세션 자신** — " +
    "미연결 세션이 project_create_v6 로 만든 프로젝트에 스스로 붙는 표준 경로다(#1798). 현재 소속은 DB에 기록되고 " +
    "다음 UserPromptSubmit에서 해당 프로젝트 AGENTS.md가 cwd와 무관하게 동적으로 주입된다. " +
    "REST 등가: POST /api/ui/terminal/sessions/:id/project {projectId}.",
  scope: null,
  input: sessionSetProjectInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/sessions/:id/project"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        // REST 필드명은 종전 계약(projectId) 그대로 — null·""·미전송 = 뗌. 수치 검증은 setSessionProject 가 한다.
        return { session_id: String(req.params?.id ?? ""), project_id: b.projectId == null || b.projectId === "" ? null : Number(b.projectId) };
      } }],
  },
  handler: async (input: SessionSetProjectInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = (input.session_id ?? "").trim() || (ctx?.session ?? "").trim();
    if (!sid) throw new HttpError(400, "세션을 특정할 수 없습니다 — 라이블리 세션 안에서 호출하거나 session_id 를 넘기세요");
    return await setSessionProject(user, sid, input.project_id, {
      externalSelf: !!ctx?.session && ctx.session === sid && isExternalExecutionSessionId(sid),
      harness: ctx?.agent ?? null,
    });
  },
};

const sessionProjectContextInput = {
  session_id: z.string().min(1).max(128).describe("실행 세션 id"),
  known_revision: z.number().int().min(-1).optional().describe("클라이언트가 마지막으로 적용한 revision. 같으면 본문을 생략한다"),
};
type SessionProjectContextInput = z.infer<z.ZodObject<typeof sessionProjectContextInput>>;

const sessionProjectContextCap: Capability = {
  name: "session_project_context",
  title: "실행 세션 프로젝트 문맥",
  description: "cwd와 무관하게 DB의 실행 세션 소속과 해당 프로젝트 AGENTS.md를 돌려준다. 동적 주입 훅 전용 REST 표면.",
  scope: null,
  input: sessionProjectContextInput,
  mutates: false,
  expose: {
    mcp: false,
    rest: [{ method: "GET", paths: ["/api/ui/execution-sessions/:id/project-context"], parse: (req) => ({
      session_id: String(req.params?.id ?? ""),
      known_revision: req.query?.knownRevision == null ? undefined : Number(req.query.knownRevision),
    }) }],
  },
  handler: async (input: SessionProjectContextInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = input.session_id.trim();
    // 외부 실행 id는 그 id를 x-lively-session으로 보낸 자기 요청만 조회할 수 있다. 관리형/web은 아래 owner gate가 한 번 더 막는다.
    if (isExternalExecutionSessionId(sid) && ctx?.session !== sid) throw new HttpError(403, "외부 실행 세션은 자기 문맥만 조회할 수 있습니다");
    return await sessionProjectContext(user, sid, input.known_revision);
  },
};

const sessionProjectContextAppliedInput = {
  session_id: z.string().min(1).max(128).describe("실행 세션 id"),
  revision: z.number().int().min(0).describe("stdout 전달을 마친 프로젝트 문맥 revision"),
};
type SessionProjectContextAppliedInput = z.infer<z.ZodObject<typeof sessionProjectContextAppliedInput>>;

const sessionProjectContextAppliedCap: Capability = {
  name: "session_project_context_applied",
  title: "실행 세션 프로젝트 문맥 전달 확인",
  description: "동적 주입 훅이 프로젝트 문맥 또는 소속 해제 무효화를 stdout에 전달한 뒤 applied_revision을 확인한다. 훅 전용 REST 표면.",
  scope: null,
  input: sessionProjectContextAppliedInput,
  // 사용자 데이터 변경이 아니라 전달 진단 ACK다. 읽기전용 세션에도 문맥 주입은 일어나므로 ACK도 허용한다.
  mutates: false,
  expose: {
    mcp: false,
    rest: [{ method: "POST", paths: ["/api/ui/execution-sessions/:id/project-context/applied"], parse: (req) => ({
      session_id: String(req.params?.id ?? ""),
      revision: Number((req.body as Record<string, unknown> | undefined)?.revision),
    }) }],
  },
  handler: async (input: SessionProjectContextAppliedInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = input.session_id.trim();
    if (isExternalExecutionSessionId(sid) && ctx?.session !== sid) throw new HttpError(403, "외부 실행 세션은 자기 문맥만 확인할 수 있습니다");
    return await acknowledgeSessionProjectContext(user, sid, input.revision);
  },
};

export const sessionProjectCapabilities: Capability[] = [sessionSetProject, sessionProjectContextCap, sessionProjectContextAppliedCap];
