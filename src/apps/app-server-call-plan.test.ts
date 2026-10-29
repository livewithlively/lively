// 게이트웨이 → 앱 서버 동기 부르기 판정(#5053 앱 v2-42) 단위 시험 — 순수 함수만(DB · AWS 없음). 사양 엣지 표(spec-5053) A1~A3 · B1~B2 · C1~C8.
//  A 신원의 글 모양 · B 도구 라우트 · C 앱의 답 → 도구 결과(태스크 엣지 표 6 · 7 · 8 의 게이트웨이 쪽 판정). B3(선언 검사)은 app-mcp-server-executor.test.
// 실행: npm run build && node --test dist/apps/app-server-call-plan.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  CALL_GUARD_MIN, callCredential, callInvokeEvent, looksLikeCallCredential, parseCallCredential, serverToolRouteOf, toolReplyOf, type ServerCallReply,
} from "./app-server-call-plan.js";
import { looksLikeJobCredential, parseJobCredential, JOB_ROUTE_MAX } from "./app-jobs-plan.js";
import { GUARD_VERSION } from "./app-server-guard.js";

const S = "b".repeat(43);

test("A1 부르기 신원 — 만들고 읽으면 그대로(종류 · 번호 · 비밀) · 작업 신원과 앞머리로 갈린다(서로의 해석기가 받지 않는다)", () => {
  const c = callCredential("call", 12, S);
  const r = callCredential("run", 12, S);
  assert.equal(c, `lvsc1.12.${S}`);
  assert.equal(r, `lvsr1.12.${S}`);
  assert.deepEqual(parseCallCredential(c), { kind: "call", id: 12, secret: S });
  assert.deepEqual(parseCallCredential(r), { kind: "run", id: 12, secret: S });
  assert.deepEqual(parseCallCredential([` ${r} `, "x"]), { kind: "run", id: 12, secret: S }, "배열은 첫 값 · 앞뒤 빈칸");
  assert.ok(looksLikeCallCredential(c) && looksLikeCallCredential(r));
  //  작업 신원과 섞이지 않는다 — 검사 층 · 게이트웨이가 갈래를 앞머리로 고른다.
  assert.equal(parseJobCredential(c), null);
  assert.equal(parseJobCredential(r), null);
  assert.equal(parseCallCredential(`lvjc1.12.${S}`), null);
  assert.equal(parseCallCredential(`lvjr1.12.${S}`), null);
  assert.ok(!looksLikeJobCredential(c) && !looksLikeJobCredential(r));
  assert.ok(!looksLikeCallCredential(`lvjr1.12.${S}`) && !looksLikeCallCredential("v1.k1.p.s") && !looksLikeCallCredential(undefined));
  assert.throws(() => callCredential("call", 0, S));
  assert.throws(() => callCredential("run", 1, "short"));
});

test("A2 부르기 신원 모양이 틀리면 null — 번호 0 · 앞 0 · 2^53 넘음 · 비밀 31자/129자 · 다른 앞머리 · 사람 신원 · 조각 넷 · 빈 값 / 경계는 받음", () => {
  const bad = [`lvsc1.0.${S}`, `lvsc1.012.${S}`, `lvsc1.-1.${S}`, `lvsc1.99999999999999999.${S}`, `lvsc1.1.${"a".repeat(31)}`, `lvsc1.1.${"a".repeat(129)}`,
    `lvsx1.1.${S}`, `lvsc2.1.${S}`, "v1.k1.payload.sig", `lvsc1.1.${S}.x`, `lvsc1.1.${S}=`, "", undefined, null, 7];
  for (const b of bad) assert.equal(parseCallCredential(b), null, String(b).slice(0, 30));
  assert.equal(parseCallCredential(`lvsc1.1.${"a".repeat(32)}`)?.id, 1, "경계 32자");
  assert.equal(parseCallCredential(`lvsr1.9007199254740991.${"a".repeat(128)}`)?.id, 9007199254740991, "경계 128자 · 2^53-1");
});

test("A3 검사 층 판 — 동기 부르기를 받는 판(CALL_GUARD_MIN)은 5 이상이고, 지금 올리는 검사 층 판이 그보다 낮지 않다(새로 올린 함수는 받는다)", () => {
  assert.ok(CALL_GUARD_MIN >= 5, "5 판부터 — 그 전 판의 함수(작업까지만 아는 문)는 부르기 신원을 모른다");
  assert.ok(GUARD_VERSION >= CALL_GUARD_MIN, `지금 문 판 ${GUARD_VERSION} 이 ${CALL_GUARD_MIN} 보다 낮으면 새로 올린 함수도 «다시 올리세요» 가 된다`);
});

test("B1 도구 라우트 — «/경로» · «POST /경로»(대소문자 · 빈칸 무관) · 쿼리 그대로 · 경계 2,048자", () => {
  assert.deepEqual(serverToolRouteOf("/api/tools/ask"), { route: "/api/tools/ask" });
  assert.deepEqual(serverToolRouteOf("POST /api/tools/ask"), { route: "/api/tools/ask" });
  assert.deepEqual(serverToolRouteOf("  post \t /api/tools/ask?v=1&q=%ED%9A%8C  "), { route: "/api/tools/ask?v=1&q=%ED%9A%8C" });
  assert.deepEqual(serverToolRouteOf("/a/_lively/b"), { route: "/a/_lively/b" }, "_lively 가 첫 칸이 아니면 앱 경로");
  assert.deepEqual(serverToolRouteOf("/_livelyx"), { route: "/_livelyx" });
  assert.deepEqual(serverToolRouteOf("/" + "a".repeat(JOB_ROUTE_MAX - 1)), { route: "/" + "a".repeat(JOB_ROUTE_MAX - 1) });
});

test("B2 도구 라우트 — POST 밖의 방법 · 비었거나 글이 아님 · 앱 밖 경로 · /_lively 자리 · ASCII 밖 · 빈칸 · 역슬래시 · 2,049자 는 까닭과 함께 거절", () => {
  const cases: Array<[unknown, RegExp]> = [
    ["GET /api/tools/ask", /POST 로만/], ["get /x", /POST 로만/], ["DELETE /x", /POST 로만/], ["", /필요합니다/], ["   ", /필요합니다/], [undefined, /필요합니다/], [42, /필요합니다/],
    ["api/tools/ask", /\/ 로 시작/], ["//evil.example/x", /\/ 로 시작/], ["POST //x", /\/ 로 시작/], ["POST", /\/ 로 시작/],
    ["/_lively/guard/ready", /라이블리 자리/], ["/_LIVELY/x", /라이블리 자리/], ["/_lively", /라이블리 자리/], ["POST /_lively/x?y", /라이블리 자리/],
    ["/도구", /ASCII/], ["/a b", /ASCII/], ["POST /a b", /ASCII/], ["/a\\b", /역슬래시/], ["/a\u0007", /ASCII/],
    ["/" + "a".repeat(JOB_ROUTE_MAX), /너무 깁니다/],
  ];
  for (const [raw, re] of cases) {
    const r = serverToolRouteOf(raw);
    assert.ok("error" in r && re.test(r.error), `${JSON.stringify(raw)?.slice(0, 40)} → ${JSON.stringify(r)}`);
  }
});

test("A4 함수 이벤트 — POST · 경로/쿼리 나눔 · 본문 = 인자 JSON(base64) · 우리 머리글은 부르기 신원 하나 · 쿠키 없음 · 요청 번호", () => {
  const ev = callInvokeEvent({ id: 9, route: "/api/tools/ask?lang=ko", body: '{"q":"휴가 규정"}' }, callCredential("call", 9, S), "wiki-ws.lvly.app", 1_700_000_000_000) as Record<string, any>;
  assert.equal(ev.rawPath, "/api/tools/ask");
  assert.equal(ev.rawQueryString, "lang=ko");
  assert.equal(ev.requestContext.http.method, "POST");
  assert.equal(ev.isBase64Encoded, true);
  assert.equal(Buffer.from(ev.body, "base64").toString("utf8"), '{"q":"휴가 규정"}');
  assert.equal(ev.headers["x-lively-identity"], `lvsc1.9.${S}`);
  assert.equal(ev.headers["content-type"], "application/json");
  assert.equal(ev.headers.host, "wiki-ws.lvly.app");
  assert.equal(ev.headers["user-agent"], "lively-mcp-tool/1");
  assert.equal(ev.requestContext.requestId, "call-9");
  assert.equal(ev.cookies, undefined);
  assert.equal(Object.keys(ev.headers).filter((k) => k.startsWith("x-lively-")).join(","), "x-lively-identity");
});

const reply = (o: Partial<ServerCallReply> & { text?: string }): ServerCallReply => {
  const body = o.body ?? Buffer.from(o.text ?? "", "utf8");
  return { status: o.status ?? 200, headers: o.headers ?? {}, body, bytes: o.bytes ?? body.length };
};

test("C1 ★ 검사 층이 끊었다(504 · x-lively-guard: timeout) → 도구 오류 app_server_timeout(504) — 시간을 말한다(엣지 표 6)", () => {
  const t = toolReplyOf(reply({ status: 504, headers: { "x-lively-guard": "timeout", "content-type": "application/json" }, text: '{"error":"app_timeout"}' }), 30);
  assert.ok(!t.ok && t.status === 504 && t.code === "app_server_timeout" && /30초/.test(t.message), JSON.stringify(t));
});

test("C2 검사 층이 직접 낸 다른 답 — 신원 거부(까닭 실음) · 앱에 못 닿음 · 앱의 잘못된 답 · 문 안 오류 · 모르는 표지는 모두 도구 오류(앱 응답처럼 내보내지 않는다)", () => {
  const denied = toolReplyOf(reply({ status: 409, headers: { "x-lively-guard": "denied" }, text: '{"error":"call_replayed","reason":"claimed"}' }), 30);
  assert.ok(!denied.ok && denied.code === "app_server_identity" && /claimed/.test(denied.message), JSON.stringify(denied));
  const noReason = toolReplyOf(reply({ status: 401, headers: { "x-lively-guard": "denied" }, text: "not json" }), 30);
  assert.ok(!noReason.ok && noReason.code === "app_server_identity", JSON.stringify(noReason));
  const un = toolReplyOf(reply({ status: 502, headers: { "x-lively-guard": "app-unreachable" }, text: "{}" }), 30);
  assert.ok(!un.ok && un.code === "app_server_unavailable", JSON.stringify(un));
  for (const g of ["app-bad-response", "error", "job-done", "ready", "something-new"]) {
    const x = toolReplyOf(reply({ status: 200, headers: { "x-lively-guard": g, "content-type": "application/json" }, text: '{"ok":true}' }), 30);
    assert.ok(!x.ok && x.code === "app_server_error", `${g} → ${JSON.stringify(x)}`);
  }
});

test("C3 앱의 2xx JSON → 값 · 깨진 JSON → 글 · 빈 본문 → 빈 글 · +json 종류도 JSON", () => {
  const j = toolReplyOf(reply({ headers: { "content-type": "application/json; charset=utf-8" }, text: '{\n  "answer": "연차는 15일",\n  "refs": [1, 2]\n}' }), 30);
  assert.deepEqual(j, { ok: true, data: { answer: "연차는 15일", refs: [1, 2] } });
  assert.deepEqual(toolReplyOf(reply({ headers: { "content-type": "application/vnd.api+json" }, text: '{"a":1}' }), 30), { ok: true, data: { a: 1 } });
  assert.deepEqual(toolReplyOf(reply({ headers: { "content-type": "application/json" }, text: "{not json" }), 30), { ok: true, data: "{not json" });
  assert.deepEqual(toolReplyOf(reply({ status: 204, headers: { "content-type": "application/json" }, text: "" }), 30), { ok: true, data: "" });
});

test("C4 앱의 2xx 글(text/*) · 종류 없음 → 글 그대로", () => {
  assert.deepEqual(toolReplyOf(reply({ headers: { "content-type": "text/plain; charset=utf-8" }, text: "답: 15일" }), 30), { ok: true, data: "답: 15일" });
  assert.deepEqual(toolReplyOf(reply({ headers: { "content-type": "text/markdown" }, text: "# 제목" }), 30), { ok: true, data: "# 제목" });
  assert.deepEqual(toolReplyOf(reply({ headers: {}, text: "그냥 글" }), 30), { ok: true, data: "그냥 글" });
});

test("C5 앱의 2xx 가 글이 아닌 종류(그림 · 내려받기 · PDF · 소리) → 도구 오류 app_bad_result(종류를 말한다)", () => {
  for (const ct of ["image/png", "application/octet-stream", "application/pdf; x=1", "audio/mpeg"]) {
    const t = toolReplyOf(reply({ headers: { "content-type": ct }, body: Buffer.from([0x89, 0x50]) }), 30);
    assert.ok(!t.ok && t.code === "app_bad_result" && t.message.includes(ct.split(";")[0]!), `${ct} → ${JSON.stringify(t)}`);
  }
});

test("C6 ★ 응답 상한 넘김(본문은 앞부분만 · bytes 가 더 큼) → 글로 넘기고 원래 크기(truncatedFrom) — JSON 이어도 반쪽은 풀지 않는다 · 종류 검사가 먼저(엣지 표 7)", () => {
  const cut = toolReplyOf(reply({ headers: { "content-type": "application/json" }, text: '{"rows":[1,2,', bytes: 300_000 }), 30);
  assert.deepEqual(cut, { ok: true, data: '{"rows":[1,2,', truncatedFrom: 300_000 });
  const txt = toolReplyOf(reply({ headers: { "content-type": "text/plain" }, text: "가나", bytes: 999_999 }), 30);
  assert.deepEqual(txt, { ok: true, data: "가나", truncatedFrom: 999_999 });
  const exact = toolReplyOf(reply({ headers: { "content-type": "application/json" }, text: '{"a":1}' }), 30);
  assert.deepEqual(exact, { ok: true, data: { a: 1 } }, "bytes == 본문 길이면 잘린 것이 아니다(경계)");
  const bin = toolReplyOf(reply({ headers: { "content-type": "image/png" }, text: "x", bytes: 999_999 }), 30);
  assert.ok(!bin.ok && bin.code === "app_bad_result", "잘렸어도 종류 검사가 먼저");
});

test("C7 앱의 4xx · 5xx → 도구 오류 app_error(앱의 상태 그대로) — JSON 의 message · error 를 먼저, 아니면 본문 앞부분(1,000자) · 빈 본문", () => {
  const nf = toolReplyOf(reply({ status: 404, headers: { "content-type": "application/json" }, text: '{"message":"그런 정책은 없습니다","code":"nf"}' }), 30);
  assert.ok(!nf.ok && nf.status === 404 && nf.code === "app_error" && /HTTP 404/.test(nf.message) && /그런 정책은 없습니다/.test(nf.message), JSON.stringify(nf));
  const er = toolReplyOf(reply({ status: 422, headers: { "content-type": "application/json" }, text: '{"error":"q 가 비었습니다"}' }), 30);
  assert.ok(!er.ok && er.status === 422 && /q 가 비었습니다/.test(er.message), JSON.stringify(er));
  const big = toolReplyOf(reply({ status: 500, headers: { "content-type": "text/plain" }, text: "가".repeat(1500) }), 30);
  assert.ok(!big.ok && big.status === 500 && big.message.endsWith(": " + "가".repeat(1000)), `len ${!big.ok && big.message.length}`);
  const empty = toolReplyOf(reply({ status: 503, headers: {}, text: "" }), 30);
  assert.ok(!empty.ok && empty.message === "앱 서버가 오류로 답했습니다(HTTP 503)", JSON.stringify(empty));
  const boundary = toolReplyOf(reply({ status: 400, headers: { "content-type": "text/plain" }, text: "bad" }), 30);
  assert.ok(!boundary.ok && boundary.code === "app_error", "400 은 오류(경계)");
  const ok299 = toolReplyOf(reply({ status: 299, headers: { "content-type": "text/plain" }, text: "fine" }), 30);
  assert.deepEqual(ok299, { ok: true, data: "fine" }, "299 는 결과(경계)");
});

test("C8 앱의 3xx(다른 곳으로 보냄) → 도구 오류 app_error — 도구 라우트는 직접 답해야 한다", () => {
  const t = toolReplyOf(reply({ status: 302, headers: { location: "/login" }, text: "" }), 30);
  assert.ok(!t.ok && t.code === "app_error" && /HTTP 302/.test(t.message), JSON.stringify(t));
});
