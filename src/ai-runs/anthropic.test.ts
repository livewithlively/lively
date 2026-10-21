// Anthropic 출구 — 엣지 표 H1~H5(#4488 · 사양 spec.md). 가짜 fetch 로. 실행: npm run build && node dist/ai-runs/anthropic.test.js
//  이게 틀리면: 앱이 보낸 자격 헤더가 위로 새거나(키 대신 앱의 x-api-key 가 감), 스트리밍 사용량이 0 으로 세어 하루 상한이 안 먹거나, 흘려 보낸 바이트가 바뀐다.
import assert from "node:assert/strict";
import { SseUsageCollector, forwardHeaders, forwardToAnthropic, singleShot, textOfMessage, usageOf } from "./anthropic.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── H1 헤더 — 자격은 버리고 키를 새로 · 버전 · 베타만 통과 ──
{
  const h = forwardHeaders({ "x-api-key": "sk-app", authorization: "Bearer lvai_x", "anthropic-version": "2024-01-01", "anthropic-beta": "foo", cookie: "c=1", host: "evil" }, "sk-ws");
  assert.equal(h["x-api-key"], "sk-ws");
  assert.equal(h["anthropic-version"], "2024-01-01");
  assert.equal(h["anthropic-beta"], "foo");
  assert.equal(h.authorization, undefined);
  assert.equal(h.cookie, undefined);
  assert.equal(h.host, undefined);
  assert.equal(forwardHeaders({}, "k")["anthropic-version"], "2023-06-01");
  ok("H1 헤더 — 자격 · 쿠키 · host 는 안 넘기고 워크스페이스 키만");
}

// ── H1b 워크스페이스에 묶이지 않은 키 — anthropic-workspace-id 는 자격 meta 에서만 · 앱이 보낸 건 버림 · 모양 틀리면 안 실음 ──
{
  const h = forwardHeaders({ "anthropic-workspace-id": "wrkspc_from_app" }, "sk-ws", "wrkspc_ours");
  assert.equal(h["anthropic-workspace-id"], "wrkspc_ours", "자격의 워크스페이스 id 가 이긴다");
  assert.equal(forwardHeaders({ "anthropic-workspace-id": "wrkspc_from_app" }, "sk-ws")["anthropic-workspace-id"], undefined, "자격에 없으면 앱이 보낸 것도 안 넘긴다");
  assert.equal(forwardHeaders({}, "sk-ws", null)["anthropic-workspace-id"], undefined);
  assert.equal(forwardHeaders({}, "sk-ws", "bad id\n")["anthropic-workspace-id"], undefined, "모양 틀린 값은 안 실음(헤더 주입 방지)");
  ok("H1b anthropic-workspace-id — 자격 meta 에서만 · 모양 검사");
}

// ── H2 SSE 사용량 — message_start(입력 · 캐시) + message_delta(출력 누계) · 줄이 조각으로 와도 ──
{
  const c = new SseUsageCollector();
  const sse = [
    "event: message_start", 'data: {"type":"message_start","message":{"model":"claude-opus-5-5","usage":{"input_tokens":100,"cache_read_input_tokens":40,"cache_creation_input_tokens":5,"output_tokens":1}}}', "",
    "event: content_block_delta", 'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hi"}}', "",
    "event: message_delta", 'data: {"type":"message_delta","usage":{"output_tokens":7}}', "",
    "event: message_delta", 'data: {"type":"message_delta","usage":{"output_tokens":12}}', "",
    "data: not json", "",
  ].join("\n") + "\n";
  for (let i = 0; i < sse.length; i += 17) c.feed(sse.slice(i, i + 17));
  assert.deepEqual(c.usage, { input_tokens: 100, output_tokens: 12, cache_read_tokens: 40, cache_write_tokens: 5 });
  assert.equal(c.model, "claude-opus-5-5");
  assert.deepEqual(usageOf({ input_tokens: "x", output_tokens: 3 }), { input_tokens: 0, output_tokens: 3, cache_read_tokens: 0, cache_write_tokens: 0 });
  ok("H2 SSE 사용량 — 조각으로 와도 · 마지막 출력 누계 · 잡 줄 무시");
}

// ── H3~H4 단발 — 성공(글 이어 붙임 · system · 키 헤더) · 오류 ──
{
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.model === "boom") return new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ model: "claude-opus-5-5", stop_reason: "end_turn", usage: { input_tokens: 11, output_tokens: 4 },
      content: [{ type: "text", text: "hel" }, { type: "tool_use", name: "x" }, { type: "text", text: "lo" }] }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  const r = await singleShot("sk-ws", { model: "claude-opus-5-5", prompt: "hi", system: "sys", maxTokens: 100 }, new AbortController().signal, fakeFetch);
  assert.equal(r.ok, true);
  assert.equal(r.text, "hello");
  assert.equal(r.usage.input_tokens, 11);
  assert.equal(r.stopReason, "end_turn");
  assert.equal(seen[0]!.url, "https://api.anthropic.com/v1/messages");
  const sent = JSON.parse(String(seen[0]!.init.body)) as Record<string, unknown>;
  assert.equal(sent.system, "sys");
  assert.equal(sent.max_tokens, 100);
  assert.deepEqual(sent.messages, [{ role: "user", content: "hi" }]);
  assert.equal((seen[0]!.init.headers as Record<string, string>)["x-api-key"], "sk-ws");
  const e = await singleShot("sk-ws", { model: "boom", prompt: "hi", system: null, maxTokens: 10 }, new AbortController().signal, fakeFetch);
  assert.equal(e.ok, false);
  assert.equal(e.status, 401);
  assert.match(e.error!, /authentication_error/);
  assert.equal(JSON.parse(String(seen[1]!.init.body)).system, undefined, "system 없으면 칸을 안 보낸다");
  assert.equal(textOfMessage({ content: "no" }), "");
  ok("H3~H4 단발 — 글 이어 붙임 · system · 오류는 ok:false(상태 · 문구)");
}

// ── H5 흘려 보내기 — 스트리밍 응답은 바이트 그대로 지나가고 사용량은 뒤에 셈한다 ──
{
  const sse = 'data: {"type":"message_start","message":{"model":"m","usage":{"input_tokens":3}}}\n\ndata: {"type":"message_delta","usage":{"output_tokens":2}}\n\n';
  const fakeFetch = (async () => new Response(sse, { status: 200, headers: { "content-type": "text/event-stream", "request-id": "req_1", "set-cookie": "no" } })) as typeof fetch;
  const r = await forwardToAnthropic({ path: "/v1/messages", headers: {}, body: Buffer.from('{"stream":true}'), stream: true, signal: new AbortController().signal }, fakeFetch);
  assert.equal(r.status, 200);
  assert.equal(r.headers["request-id"], "req_1");
  assert.equal(r.headers["set-cookie"], undefined, "위쪽 쿠키는 내리지 않는다");
  let got = "";
  for await (const chunk of r.body!) got += Buffer.from(chunk as Buffer).toString("utf8");
  assert.equal(got, sse, "바이트 그대로");
  const u = await r.usage;
  assert.deepEqual([u.usage.input_tokens, u.usage.output_tokens, u.model], [3, 2, "m"]);
  ok("H5 스트리밍 흘려 보내기 — 본문 그대로 · 사용량은 지나간 뒤");
}

console.log(`ai-runs anthropic.test: ${pass} passed`);
