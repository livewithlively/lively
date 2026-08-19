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
import { setSessionProject } from "../terminal/session-project-routes.js";

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
    "미연결 세션이 project_create_v6 로 만든 프로젝트에 스스로 붙는 표준 경로다(#1798). 세션 폴더의 AGENTS.md·project 링크가 즉시 다시 쓰인다. " +
    "⚠ 붙인 직후 AGENTS.md 와 project/AGENTS.md 를 직접 읽어라 — 실행 중 하네스는 CLAUDE.md 를 다시 읽지 않는다. " +
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
    return await setSessionProject(user, sid, input.project_id);
  },
};

export const sessionProjectCapabilities: Capability[] = [sessionSetProject];
