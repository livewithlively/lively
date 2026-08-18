import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerDbTools } from "./tools/db.js";
import { registerMcpCapabilities } from "./capabilities/index.js";
import { resolveUser } from "./context.js";
import { logToolCall, toolResultFailure } from "./org/policies/tool-log.js";

// memory_* 폐기(2026-06-24) — knowledge_*(v6)로 통일(ctx_* 가 간 길). org_memory 웹 표면('WIKI 인덱스')은 delivery REST(/api/ui/org/memory) 유지.
// code_*: 보류 (개발자는 레포 내 네이티브 툴; 필요시 공식 GitHub MCP 래핑)

type ToolHandler = (args: Record<string, unknown>, extra: unknown) => Promise<unknown>;

// 호출 계측(프로젝트 #318) — 핸들러를 감싸 한 건의 tools/call 을 mcp_call_log 에 적재한다.
//  · 측정: 핸들러 실행 전후로 소요시간(ms)·성공/실패·에러 메시지를 잡는다.
//    성공/실패는 **두 축**이다(#1653) — 예외를 던졌는가(아래 catch) + 결과가 isError:true 인가(toolResultFailure).
//    프록시 계열은 상류 실패를 예외가 아니라 isError:true **정상 반환**으로 돌려주므로, throw 여부만 보면
//    커넥터가 전부 죽어 있어도 오류 수가 0 으로 적재된다(실측: 구글 3종 403 이 전부 ok=true).
//  · 신원: harness=이 요청의 접속 신원(buildServer 인자, agentFromHeaders 파생), actor=토큰 principal(resolveUser).
//  · 비침습: 적재는 fire-and-forget(logToolCall 내부에서 await 안 함) — 응답 지연 0, 적재 실패는 무시(fail-open).
//   계측이 핸들러 결과/예외를 바꾸지 않는다(성공값 그대로 반환, 예외 그대로 재던짐).
function instrument(name: string, handler: ToolHandler, harness?: string | null): ToolHandler {
  return async (args, extra) => {
    const started = Date.now();
    let actor: string | null = null;
    try {
      actor = resolveUser(extra)?.userId ?? null;
    } catch {
      // 인증 컨텍스트 해석 실패 → actor 미상으로 기록(/mcp 는 bearer 필수라 보통 도달 안 함)
    }
    try {
      const out = await handler(args, extra);
      const failure = toolResultFailure(out); // 정상 반환이어도 isError:true 면 실패로 적재(#1653)
      logToolCall({
        tool: name, harness: harness ?? null, actor, args,
        ok: failure === null, error: failure, durationMs: Date.now() - started,
      });
      return out;
    } catch (err) {
      logToolCall({
        tool: name,
        harness: harness ?? null,
        actor,
        args,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - started,
      });
      throw err;
    }
  };
}

// overrides: 빌트인 노출 재정의 — org_tool(kind='builtin') 의 name→enabled. expose.mcp(코드 기본값)를 양방향으로 덮어쓴다.
//  · false 인 이름은 server.registerTool 래핑이 등록을 건너뛴다(db 직접등록 끄기 + 방어).
//  · capability 끄기/켜기 판정은 registerMcpCapabilities 가 일원화(expose.mcp:false 여도 override true 면 등록 → 래핑 통과).
//  alwaysLoadOverrides: 빌트인 주입모드 재정의 — org_tool(kind='builtin') 의 name→always_load(true/false). 코드기본(cap.meta)을 덮어쓴다.
//  harness: 이 요청의 하네스 신원(agentFromHeaders). _meta(anthropic/alwaysLoad)를 하네스별로 emit/생략하는 데 쓴다(#187),
//   그리고 호출 로그(#318)의 harness 귀속에 쓴다.
export function buildServer(
  overrides?: ReadonlyMap<string, boolean>,
  alwaysLoadOverrides?: ReadonlyMap<string, boolean>,
  harness?: string | null,
  readOnly?: boolean, // 읽기전용 세션(#1007) — true 면 registerMcpCapabilities 가 쓰기 capability 를 등록 스킵(tools/list 소거).
  incognito?: boolean, // 인코그니토 세션(#1007+) — true 면 capability·db 툴 전부 스킵(빈 표면 = 사실상 연결없음).
): McpServer {
  const server = new McpServer({ name: "context-ontology", version: "0.1.0" });
  // registerTool 단일 wrap — 두 일을 한 경로에서 한다(capability·db·dynamic 모든 등록이 여길 지난다):
  //  (1) override=false 인 빌트인은 등록 자체를 건너뛴다(웹 도구탭 OFF 토글).
  //  (2) 핸들러를 instrument 로 감싸 호출을 로깅한다(#318) — 함수가 아닌 핸들러는 건드리지 않는다(방어).
  const orig = server.registerTool.bind(server);
  server.registerTool = ((name: string, config: unknown, handler: ToolHandler) => {
    if (overrides?.get(name) === false) return undefined;
    const cb = typeof handler === "function" ? instrument(name, handler, harness) : handler;
    return (orig as (...a: unknown[]) => unknown)(name, config, cb);
  }) as typeof server.registerTool;
  if (!incognito) registerDbTools(server, harness); // 제품 DB (읽기전용 — SELECT-only). 읽기전용 세션엔 유지, 인코그니토엔 스킵(읽기도 차단 = 클린룸).
  registerMcpCapabilities(server, overrides, alwaysLoadOverrides, harness, readOnly, incognito); // 읽기전용 쓰기 스킵 / 인코그니토 전체 스킵(#1007)
  return server;
}
