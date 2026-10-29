// 앱이 선언한 MCP 도구의 server 실행기(#5053 앱 v2-42) — `run: { kind: "server", route }` 인 도구를 부르면 그 앱 서버의 라우트를 부른 사람 대리 신원으로 동기로 부른다.
//
//  선언: { name, description, input, level, run: { kind: "server", route: "POST /api/tools/<이름>", background?: true } } — 라우트는 «/경로» 또는 «POST /경로»
//   (늘 POST · 인자가 JSON 본문). 설치 · 판 저장 때(validate) 라우트 꼴 · background 꼴과 그 판의 서버 선언(web.server)을 본다. run 의 다른 칸은 받지 않는다.
//  ★ 30초 넘는 도구(결정 상민 2026-10-29) — background:true 면 그 라우트를 부른 사람의 백그라운드 작업(#4486 · 최대 15분)으로 돌리고 게이트웨이가 200초까지
//   대신 기다린다(진행 알림). 끝나면 작업의 결과(라우트 답의 앞 64KB)가 도구 결과, 못 끝나면 작업 번호와 «app_job_get 으로 결과 받기» 안내(app-server-call runServerToolJob).
//  L0(조회)은 막지 않는다(결정 상민 2026-10-29 «앱이 적은 대로 믿기») — level 은 앱 작성자의 자기 신고이고 readOnlyHint 는 안내다.
//  부르기: 틀(mcp/app-declared-tools)이 동의 · 구성원 · 인자를 확인한 뒤 → 게이트웨이가 함수를 흘려 받기로 부르고(app-server-call callAppServerRoute — 사람 요청과
//   같은 별칭 · 30초 · 처리 중 상한 · 호출 셈) → 함수 안 검사 층(5 판)이 claim 을 받은 뒤 앱에 x-lively-member · x-lively-member-name · x-lively-variant ·
//   x-lively-identity(돌기 신원 — SDK 가 라이블리를 다시 부를 때 싣는다)를 넘긴다 → 앱의 답(2xx 의 JSON · 글)이 도구 결과가 된다(app-server-call-plan toolReplyOf).
//  오류 → 도구 오류(코드 = lively/code): app_server_off · app_server_not_deployed · app_server_outdated · app_server_stopped · app_server_busy · app_server_timeout ·
//   app_server_unavailable · app_server_error · app_server_identity · app_error(앱이 4xx · 5xx 로 답함) · app_bad_result(글이 아닌 답).
//  흐름 모듈(app-server-call — 함수 실행면 · 작업 모듈을 끌어온다)은 부를 때 처음 읽는다 — 부팅 · 설치 검사는 이 파일과 판정 모듈만 읽는다.
import { HttpError } from "../http-error.js";
import { APP_MCP_RESULT_MAX_BYTES } from "./app-mcp-decl.js";
import { registerAppMcpExecutor, type AppMcpExecutor } from "./app-mcp-executors.js";
import { serverDeclOf } from "./app-server-config.js";
import { pendingJobText, serverToolRouteOf, toolReplyOf, type ToolReply } from "./app-server-call-plan.js";

/** server 도구의 run 에 쓰는 칸. */
const RUN_KEYS = new Set(["kind", "route", "background"]);
/** 답 본문을 이만큼 모은다 — 틀의 결과 상한(256KiB)을 UTF-8 경계에서 자를 여유(한 글자 4바이트)까지. 그 너머는 크기만 센다. */
const REPLY_KEEP_BYTES = APP_MCP_RESULT_MAX_BYTES + 4;

export const serverExecutor: AppMcpExecutor = {
  kind: "server",
  validate(tool, manifest) {
    const extra = Object.keys(tool.run).filter((k) => !RUN_KEYS.has(k));
    if (extra.length) throw new HttpError(400, `run 의 모르는 칸입니다(${extra.join(", ")}) — server 도구의 run 은 kind · route · background 만 씁니다`);
    const r = serverToolRouteOf(tool.run.route);
    if ("error" in r) throw new HttpError(400, r.error);
    if (tool.run.background !== undefined && typeof tool.run.background !== "boolean") {
      throw new HttpError(400, "run.background 는 true 또는 false 입니다(30초 넘게 걸리는 도구면 true — 백그라운드 작업으로 돌리고 게이트웨이가 대신 기다린다)");
    }
    if (!serverDeclOf(manifest)) throw new HttpError(400, "server 도구는 앱 서버(web.server)를 선언한 앱만 쓸 수 있습니다 — 매니페스트에 web.server 를 더하거나 run.kind 를 바꾸세요");
  },
  async call(c) {
    //  저장된 선언은 설치 때 검사를 지났다 — 그래도 꼴이 틀리면(검사가 더 엄격해진 코어로 올림) 앱 서버를 부르지 않는다.
    const r = serverToolRouteOf(c.tool.run.route);
    if ("error" in r) throw new HttpError(400, `이 도구의 선언이 이 게이트웨이와 맞지 않습니다 — ${r.error}`, { body: { code: "tool_invalid" } });
    const flow = await import("./app-server-call.js");
    const app = { id: c.app.id, view: c.app.view, variant: c.app.variant };
    if (c.tool.run.background === true) {
      const out = await flow.runServerToolJob({
        app, tool: c.tool.name, route: r.route, args: c.args,
        caller: { userId: c.caller.userId, scopes: c.caller.scopes, tokenScopes: c.caller.tokenScopes, ...(c.caller.tokenHashPrefix ? { tokenHashPrefix: c.caller.tokenHashPrefix } : {}) },
        ...(c.signal ? { signal: c.signal } : {}), ...(c.progress ? { progress: c.progress } : {}),
      });
      if (!out.done) return { data: pendingJobText(out.jobId, out.waitedSec), meta: { "lively/job_id": out.jobId, "lively/pending": true } };
      return resultOf(out.reply);
    }
    const { reply, timeoutS } = await flow.callAppServerRoute({
      app, purpose: "mcp_tool", tool: c.tool.name, route: r.route, level: c.tool.level,
      body: JSON.stringify(c.args), caller: { userId: c.caller.userId, name: c.caller.name, scopes: c.caller.scopes }, maxBytes: REPLY_KEEP_BYTES,
    });
    return resultOf(toolReplyOf(reply, timeoutS));
  },
};

/** 판정한 도구 결과 → 실행기 결과(오류는 HttpError — 그 글과 코드가 도구 오류로 그대로 간다). */
function resultOf(t: ToolReply): { data: unknown; truncatedFrom?: number } {
  if (!t.ok) throw new HttpError(t.status, t.message, { body: { code: t.code } });
  return t.truncatedFrom ? { data: t.data, truncatedFrom: t.truncatedFrom } : { data: t.data };
}

/** 부팅 때 한 번(index.ts) — 돌려준 함수를 부르면 걷는다(시험). */
export function registerServerExecutor(): () => void {
  return registerAppMcpExecutor(serverExecutor);
}
