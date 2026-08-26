// 세션이 자기 이름을 짓는 표면 — `session_rename` (#1979).
//
//  session_set_project(session-project.ts)와 **같은 규약**이다: session_id 기본값 = 이 요청을 보낸 세션 자신
//  (게이트웨이가 접속 헤더 x-lively-session 으로 식별). 세션이 자기 이름을 짓는 게 유일한 정상 용법이라
//  id 를 몰라도 부를 수 있어야 한다.
//
//  ⚠ **실패를 거의 만들지 않는다**(윤상민 2026-08-25: "실패응답 되도록 발생시키지말고. 글자수 초과 이런건 걍 trim").
//   이 툴은 사용자 턴 **안에서** 불린다 — 여기서 4xx 를 내면 모델이 그걸 문제로 보고 고쳐 다시 부르느라
//   사람이 기다리는 시간만 늘어난다. 그건 이 설계의 전제("응답시간을 늘리지 않는다")를 정면으로 깬다.
//   그래서 길이 초과·따옴표·마침표는 다듬고, 이미 이름이 지어진 경우도 에러가 아니라 `applied:false` 로 돌린다.
//   막는 건 남의 세션뿐이다(403).
import { z } from "zod";
import type { Capability, CapabilityCtx } from "./types.js";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http/rest-util.js";
import { relabelSession } from "../terminal/session-relabel.js";

const sessionRenameInput = {
  name: z.string().max(200).describe("세션 이름 — 한국어 명사구 한 줄, 공백 포함 10자 이내. 길거나 따옴표·마침표가 붙어도 서버가 다듬는다(거절하지 않는다)"),
  session_id: z.string().max(128).optional().describe("대상 터미널 세션 id — 보통 생략한다(기본 = 이 요청을 보낸 세션 자신). 남의 세션은 바꿀 수 없다"),
};
type SessionRenameInput = z.infer<z.ZodObject<typeof sessionRenameInput>>;

const sessionRename: Capability = {
  name: "session_rename",
  title: "세션 이름 짓기",
  description:
    "이 터미널 세션의 이름을 짓는다. session_id 생략 시 **이 요청을 보낸 세션 자신** — 첫 지시 턴에 훅이 " +
    "안내하면 그 자리에서 한 번 부르는 게 표준 경로다(#1979). **세션당 한 번만 적용된다**: 사람이 지은 이름은 " +
    "덮지 않고, 이미 에이전트가 지었으면 `applied:false` 로 조용히 무시된다(에러가 아니다 — 다시 부르지 마세요). " +
    "이름이 길거나 따옴표·마침표가 붙어도 서버가 다듬으므로 형식을 맞추려 재시도할 필요가 없다. " +
    "REST 등가: POST /api/ui/terminal/sessions/:id/rename {name}.",
  scope: null,
  input: sessionRenameInput,
  expose: {
    mcp: true,
    rest: [{ method: "POST", paths: ["/api/ui/terminal/sessions/:id/rename"],
      parse: (req) => {
        const b = (req.body ?? {}) as Record<string, unknown>;
        return { session_id: String(req.params?.id ?? ""), name: String(b.name ?? "") };
      } }],
  },
  handler: async (input: SessionRenameInput, user: LivelyUser, ctx?: CapabilityCtx) => {
    const sid = (input.session_id ?? "").trim() || (ctx?.session ?? "").trim();
    if (!sid) throw new HttpError(400, "세션을 특정할 수 없습니다 — 라이블리 세션 안에서 호출하거나 session_id 를 넘기세요");
    // 출처는 **항상 agent** 다. 사람이 고치는 길은 웹 편집(editSession → human)이고, 그건 이 툴이 못 덮는다.
    return await relabelSession(user, sid, input.name, "agent");
  },
};

export const sessionRenameCapabilities: Capability[] = [sessionRename];
