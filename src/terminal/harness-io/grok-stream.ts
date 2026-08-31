// grok ACP → SessionEvent 번역기 (#2439). **순수** — 프로세스·IO 없음.
//
//  ── 근거 ────────────────────────────────────────────────────────────────────────
//  grok 1.0.13 의 `grok agent stdio` 와 **실제 핸드셰이크를 주고받아** 재봤다(2026-08-31, 로그인 없이).
//  ACP(Agent Client Protocol, JSON-RPC 2.0 over stdio)를 말한다:
//
//    → {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,…}}
//    ← {"id":1,"result":{"protocolVersion":1,
//         "agentCapabilities":{"loadSession":true,"sessionCapabilities":{"list":{},"resume":{},"close":{}},…},
//         "authMethods":[{"id":"grok.com","name":"Grok"}],
//         "_meta":{"modelState":{"currentModelId":"grok-4.6","availableModels":[…]},"agentVersion":"1.0.13"}}}
//    ← {"method":"_x.ai/mcp/servers_updated","params":{"mcpServers":[]}}
//    → session/new … ← {"error":{"code":-32000,"message":"Authentication required"}}
//
//  ── ★ 무엇을 옮기고 무엇을 안 옮기나 ───────────────────────────────────────────
//  **옮긴다**: `initialize` 응답의 모델·MCP 목록 → `facts`. 이건 실측했다.
//  **안 옮긴다**: 턴 이벤트(`session/update` 의 ContentChunk·ToolCallUpdate)와 승인
//   (`session/request_permission`). **로그인이 있어야 그 페이로드를 볼 수 있고, 못 본 형식으로
//   번역기를 쓰면 그 세션은 빈 화면이 된다.** 그래서 스펙을 보고 짐작해 채우지 않는다 —
//   ACP 스펙에 이름은 있지만 «grok 이 실제로 그 모양으로 보내는가» 는 다른 질문이다.
//   그 대신 **`raw` 로 올려 관측한다**(session-event.ts ★2): 로그인한 세션이 한 번 돌면
//   그 raw 가 우리에게 형식을 알려주고, 그때 이 파일을 채운다.
import type { SessionEvent, SessionFacts } from "./session-event.js";

const rec = (v: unknown): Record<string, unknown> | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** ACP 한 줄(JSON-RPC) → 세션 이벤트. 모르는 것은 `raw`(버리지 않는다). */
export function grokAcpEvent(line: unknown): SessionEvent | null {
  const o = rec(line);
  if (!o) return null;

  //  ── initialize 응답 — 이 세션이 무엇을 할 수 있나 ──
  const result = rec(o.result);
  if (result && rec(result.agentCapabilities)) {
    const meta = rec(result._meta) ?? {};
    const modelState = rec(meta.modelState) ?? {};
    const facts: SessionFacts = { model: str(modelState.currentModelId) };
    //  ⚠ authMethods 가 남아 있다 = **아직 로그인 안 됐다**. 화면이 «로그인하세요» 를 말할 근거다 —
    //   그걸 모르면 사람은 답이 안 오는 이유를 알 수 없다(빈 화면이 가장 나쁜 결말이다).
    const auth = Array.isArray(result.authMethods) ? result.authMethods : [];
    if (auth.length) facts.permissionMode = "needs-auth";
    return { t: "facts", facts };
  }

  //  ── MCP 서버 목록(x.ai 확장) ──
  if (String(o.method ?? "") === "_x.ai/mcp/servers_updated") {
    const p = rec(o.params) ?? {};
    const servers = Array.isArray(p.mcpServers) ? p.mcpServers : [];
    return { t: "facts", facts: {
      mcpServers: servers.map((m) => ({ name: String(rec(m)?.name ?? ""), status: String(rec(m)?.status ?? "connected") })),
    } };
  }

  //  ── 인증 오류 — 조용히 삼키지 않는다. 사람이 왜 답이 없는지 알아야 한다. ──
  const err = rec(o.error);
  if (err && /auth/i.test(String(err.message ?? ""))) {
    return { t: "facts", facts: { permissionMode: "needs-auth" } };
  }

  //  ★ 턴 이벤트·승인은 **아직 안 옮긴다**(머리말). raw 로 올려 형식을 관측한다.
  return o.method || o.result || o.error ? { t: "raw", source: "grok", payload: o } : null;
}
