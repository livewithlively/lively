// 앱 백그라운드 작업 판정(#4486 앱 v2-7) 단위 시험 — 사양 엣지 표 B(spec-4486.md) B1~B14(B8 부를 자리는 DB 쪽 고르기가 센다 — pg 시험 C5). 순수 함수만(DB · AWS 없음).
// 실행: npm run build && node --test dist/apps/app-jobs-plan.test.js
import test from "node:test";
import assert from "node:assert/strict";
import {
  JOB_DISPATCH_ATTEMPTS, JOB_DISPATCH_RETRY_SEC, JOB_RESULT_MAX, JOB_ROUTE_MAX, JOB_SILENT_SEC, JOB_TIMEOUT_GRACE_SEC,
  encodeJobBody, endOf, jobAdmissionError, jobCredential, jobInvokeEvent, jobRouteError, jobTimeoutOf, jobTypeError, jobView, looksLikeJobCredential,
  normalizeResultReport, parseJobCredential, resultViewOf, sweepVerdict, type JobResultReport, type SweepJobFacts,
} from "./app-jobs-plan.js";

const S = "a".repeat(43);

test("B1 작업 신원 — 만들고 읽으면 그대로(종류 · 번호 · 비밀) · 앞머리로 갈린다", () => {
  const c = jobCredential("call", 12, S);
  const r = jobCredential("run", 12, S);
  assert.equal(c, `lvjc1.12.${S}`);
  assert.equal(r, `lvjr1.12.${S}`);
  assert.deepEqual(parseJobCredential(c), { kind: "call", id: 12, secret: S });
  assert.deepEqual(parseJobCredential(r), { kind: "run", id: 12, secret: S });
  assert.deepEqual(parseJobCredential([c, "x"]), { kind: "call", id: 12, secret: S }, "배열은 첫 값");
  assert.deepEqual(parseJobCredential(`  ${r} `), { kind: "run", id: 12, secret: S }, "앞뒤 빈칸");
  assert.ok(looksLikeJobCredential(r) && looksLikeJobCredential(c));
  assert.ok(!looksLikeJobCredential("v1.k1.p.s") && !looksLikeJobCredential(undefined));
  assert.throws(() => jobCredential("call", 0, S));
  assert.throws(() => jobCredential("call", 1, "short"));
});

test("B2 작업 신원 모양이 틀리면 null — 번호 0 · 앞 0 · 2^53 넘음 · 비밀 31자/129자 · 다른 앞머리 · 사람 신원 · 조각 넷 · 빈 값", () => {
  const bad = [`lvjc1.0.${S}`, `lvjc1.012.${S}`, `lvjc1.-1.${S}`, `lvjc1.99999999999999999.${S}`, `lvjc1.1.${"a".repeat(31)}`, `lvjc1.1.${"a".repeat(129)}`,
    `lvjx1.1.${S}`, `lvjc2.1.${S}`, "v1.k1.payload.sig", `lvjc1.1.${S}.x`, `lvjc1.1.${S}=`, "", undefined, null, 12];
  for (const b of bad) assert.equal(parseJobCredential(b), null, String(b).slice(0, 30));
  assert.deepEqual(parseJobCredential(`lvjc1.1.${"a".repeat(32)}`)?.id, 1, "경계 32자");
  assert.deepEqual(parseJobCredential(`lvjc1.1.${"a".repeat(128)}`)?.id, 1, "경계 128자");
  assert.equal(parseJobCredential(`lvjc1.9007199254740991.${S}`)?.id, 9007199254740991, "2^53-1 받음");
});

test("B3 라우트 — / 로 시작하는 앱 안 경로만 · /_lively 자리 · 빈칸 · 제어문자 · 역슬래시 · 인코딩 안 한 글자 · 2,048자 경계", () => {
  for (const ok of ["/", "/api/jobs/x", "/api/jobs/x?lang=ko&n=1", "/_livelyx", "/a/_lively/b", "/a?title=%ED%9A%8C%EC%9D%98", "/a~b", "/" + "a".repeat(JOB_ROUTE_MAX - 1)]) {
    assert.equal(jobRouteError(ok), null, ok.slice(0, 30));
  }
  for (const bad of [undefined, "", 5, "x", "//evil.example/x", "/a b", "/a\tb", "/a\u0000", "/a\\b", "/a\u007f", "/_lively", "/_lively/ai/runs", "/_LIVELY/x", "/_lively?x=1",
    "/" + "a".repeat(JOB_ROUTE_MAX)]) {
    assert.ok(jobRouteError(bad), `${String(bad).slice(0, 30)} 를 받았다`);
  }
  //  인코딩하지 않은 글자(한글 · 0x7e 너머) — 받기 전에 «인코딩하세요» 로 막는다(웹 어댑터 · 앱이 어떻게 읽을지 정해지지 않았다 · 격리 리뷰).
  for (const raw of ["/a?title=회의", "/회의", "/a\u00a0b", "/a\u0080"]) assert.match(jobRouteError(raw) ?? "", /인코딩/, raw);
});

test("B4 작업 종류 — 없음 · 빈 글 · function 만 받는다 · agent 는 AI 실행 입구로 안내 · 그 밖 거부", () => {
  for (const ok of [undefined, null, "", "function"]) assert.equal(jobTypeError(ok), null);
  assert.match(jobTypeError("agent")!, /\/_lively\/ai\/runs/);
  assert.match(jobTypeError("cron")!, /function/);
});

test("B5 시간 상한 — 없으면 함수 시간 · 같으면 받고 1초 넘으면 거부(나누기 · 에이전트 안내) · 0 · 음수 · 소수 · 글자 거부", () => {
  const p = { job_timeout_s: 900 };
  assert.deepEqual(jobTimeoutOf(undefined, p), { timeout: 900 });
  assert.deepEqual(jobTimeoutOf("", p), { timeout: 900 });
  assert.deepEqual(jobTimeoutOf(900, p), { timeout: 900 }, "경계");
  assert.deepEqual(jobTimeoutOf(1, p), { timeout: 1 });
  assert.deepEqual(jobTimeoutOf("120", p), { timeout: 120 });
  const over = jobTimeoutOf(901, p);
  assert.ok("error" in over && /15분/.test(over.error) && /에이전트 작업/.test(over.error) && /나누/.test(over.error), JSON.stringify(over));
  for (const bad of [0, -5, 1.5, "abc"]) assert.ok("error" in jobTimeoutOf(bad, p), String(bad));
});

test("B6 본문 — 없으면 {} · 정확히 상한 바이트는 받고 1바이트 넘으면 413(앱 폴더 안내) · JSON 못 만들면 400", () => {
  const p = { job_body_kb: 1 };
  assert.deepEqual(encodeJobBody(undefined, p), { json: "{}", bytes: 2 });
  const edge = "x".repeat(1024 - 2);                  // JSON 글자 "…" = 1,024바이트
  assert.deepEqual(encodeJobBody(edge, p), { json: JSON.stringify(edge), bytes: 1024 });
  const over = encodeJobBody(edge + "x", p);
  assert.ok("error" in over && over.status === 413 && /앱 폴더/.test(over.error));
  //  3바이트 글자 — 글자 수(343)가 아니라 바이트로 센다: 340자 = 1,020 + 따옴표 2 = 1,022 받음 · 341자 = 1,025 거부.
  assert.ok(!("error" in encodeJobBody("가".repeat(340), p)), "한글 1,022바이트");
  assert.ok("error" in encodeJobBody("가".repeat(341), p), "한글 1,025바이트(글자로는 343)");
  const cyc: Record<string, unknown> = {};
  cyc.self = cyc;
  const c = encodeJobBody(cyc, p);
  assert.ok("error" in c && c.status === 400);
  const fn = encodeJobBody(() => 1, p);
  assert.ok("error" in fn && fn.status === 400, "함수는 JSON 이 되지 않는다");
});

test("B7 받기 — 하루 수 · 대기 수가 상한에 닿으면 429 · 하나 밑이면 받는다", () => {
  const p = { job_timeout_s: 900, jobs_running_workspace: 10, jobs_running_app: 5, jobs_queued_app: 3, jobs_daily_app: 10, job_wait_s: 60, job_body_kb: 1 };
  assert.equal(jobAdmissionError(p, { queuedApp: 2, dailyApp: 9 }), null);
  assert.equal(jobAdmissionError(p, { queuedApp: 3, dailyApp: 0 })?.status, 429);
  assert.match(jobAdmissionError(p, { queuedApp: 0, dailyApp: 10 })!.error, /하루/);
});

test("B9 결과 보고 다듬기 — 모르는 끝은 guard_error · 상태 범위 · base64 아님 · 64KB 넘는 본문은 자르고 truncated · content-type 제어문자", () => {
  assert.equal(normalizeResultReport({ outcome: "evil" }).outcome, "guard_error");
  assert.equal(normalizeResultReport(null).outcome, "guard_error");
  assert.equal(normalizeResultReport({ outcome: "response", status_code: 99 }).status_code, null);
  assert.equal(normalizeResultReport({ outcome: "response", status_code: 600 }).status_code, null);
  assert.equal(normalizeResultReport({ outcome: "response", status_code: 100 }).status_code, 100);
  assert.equal(normalizeResultReport({ outcome: "response", status_code: 599 }).status_code, 599);
  assert.equal(normalizeResultReport({ outcome: "response", body_b64: "not base64!!" }).body_b64, null);
  const big = normalizeResultReport({ outcome: "response", body_b64: Buffer.alloc(JOB_RESULT_MAX + 10, 65).toString("base64"), truncated: false });
  assert.equal(Buffer.from(big.body_b64!, "base64").length, JOB_RESULT_MAX);
  assert.equal(big.truncated, true);
  const edge = normalizeResultReport({ outcome: "response", body_b64: Buffer.alloc(JOB_RESULT_MAX, 65).toString("base64") });
  assert.equal(edge.truncated, false, "경계 — 정확히 64KB");
  assert.equal(normalizeResultReport({ outcome: "response", content_type: "text/plain\r\nx: y" }).content_type, "text/plainx: y");
  assert.equal(normalizeResultReport({ outcome: "response", duration_ms: -1 }).duration_ms, null);
});

const rep = (o: Partial<JobResultReport>): JobResultReport => ({ outcome: "response", status_code: 200, content_type: null, body_b64: null, truncated: false, bytes: 0, duration_ms: 1, ...o });

test("B10 끝 상태 — 2xx 만 done(199 · 300 · 500 은 failed · 응답 앞부분) · canceled · timeout(취소 표시면 canceled) · 못 닿음 · 잘못된 응답 · 문 오류", () => {
  const ctx = { timeoutSec: 900, cancelRequested: false };
  assert.deepEqual(endOf(rep({ status_code: 200 }), ctx), { status: "done", error: null });
  assert.equal(endOf(rep({ status_code: 299 }), ctx).status, "done");
  for (const c of [199, 300, 404, 500]) assert.equal(endOf(rep({ status_code: c }), ctx).status, "failed", String(c));
  const f = endOf(rep({ status_code: 500, body_b64: Buffer.from("boom\n\n detail " + "z".repeat(500)).toString("base64") }), ctx);
  assert.match(f.error!, /500 로 답했습니다 — boom detail/);
  assert.ok(f.error!.length < 300, "앞 200자만");
  assert.deepEqual(endOf(rep({ outcome: "canceled", status_code: null }), ctx), { status: "canceled", error: "취소했습니다" });
  assert.equal(endOf(rep({ outcome: "timeout", status_code: null }), ctx).status, "failed");
  assert.match(endOf(rep({ outcome: "timeout", status_code: null }), ctx).error!, /900초/);
  assert.equal(endOf(rep({ outcome: "timeout", status_code: null }), { ...ctx, cancelRequested: true }).status, "canceled");
  for (const o of ["app_unreachable", "app_bad_response", "guard_error"] as const) assert.equal(endOf(rep({ outcome: o, status_code: null }), ctx).status, "failed", o);
});

test("B11 결과 보기 — 온전한 JSON → json · 잘린 JSON → text · 글 → text · 이진 → base64 · response 가 아니면 null", () => {
  const b = (s: string | Buffer): string => Buffer.from(s).toString("base64");
  assert.deepEqual(resultViewOf(rep({ content_type: "application/json; charset=utf-8", body_b64: b('{"a":[1,"한"]}') }))?.json, { a: [1, "한"] });
  assert.equal(resultViewOf(rep({ content_type: "application/json", body_b64: b('{"a":'), truncated: true }))?.text, '{"a":');
  const cut = resultViewOf(rep({ content_type: "application/json", body_b64: b('{"a":1}'), truncated: true }));
  assert.equal(cut?.json, undefined, "잘린 본문은 우연히 JSON 으로 읽혀도 json 으로 내지 않는다(뒤가 빠졌다)");
  assert.equal(cut?.text, '{"a":1}');
  assert.equal(resultViewOf(rep({ content_type: "application/json", body_b64: b("not json") }))?.text, "not json");
  assert.equal(resultViewOf(rep({ content_type: "text/plain", body_b64: b("전사 끝") }))?.text, "전사 끝");
  assert.equal(resultViewOf(rep({ content_type: null, body_b64: b("plain") }))?.text, "plain", "content-type 없는 글");
  const bin = Buffer.from([0xff, 0xfe, 0x00, 0x81]);
  assert.equal(resultViewOf(rep({ content_type: "application/octet-stream", body_b64: b(bin) }))?.base64, b(bin));
  assert.equal(resultViewOf(rep({ content_type: "text/plain", body_b64: b(bin) }))?.base64, b(bin), "글이라 했어도 UTF-8 이 아니면 base64");
  assert.equal(resultViewOf(rep({ outcome: "timeout" })), null);
  assert.deepEqual(resultViewOf(rep({ body_b64: null, status_code: 204 })), { status_code: 204, content_type: null, truncated: false, bytes: 0 });
});

test("B11b 결과 보기 — NUL(U+0000)이 든 응답은 글 · JSON 으로 두지 않는다(Postgres 가 jsonb 의 \\u0000 을 받지 않아 결과 기록이 통째로 실패한다)", () => {
  const b = (s: string | Buffer): string => Buffer.from(s).toString("base64");
  const raw = resultViewOf(rep({ content_type: "text/plain", body_b64: b("a\u0000b") }));
  assert.equal(raw?.text, undefined, "날 NUL 이 든 글");
  assert.equal(raw?.base64, b("a\u0000b"));
  const esc = resultViewOf(rep({ content_type: "application/json", body_b64: b('{"v":"a\\u0000b"}') }));
  assert.equal(esc?.json, undefined, "JSON 이스케이프로 들어온 NUL — 풀면 NUL 이 생긴다");
  assert.equal(esc?.text, '{"v":"a\\u0000b"}', "글로는 남긴다(역슬래시 글자라 저장된다)");
  const lit = resultViewOf(rep({ content_type: "application/json", body_b64: b('{"v":"a\\\\u0000b"}') }));
  assert.deepEqual(lit?.json, { v: "a\\u0000b" }, "역슬래시 글자 + u0000 은 NUL 이 아니다 — json 그대로");
  //  짝 없는 서로게이트(이모지 가운데를 자른 글)도 jsonb 가 받지 않는다 — json 으로 두지 않는다. 짝 맞는 이스케이프는 그대로 json.
  const lone = resultViewOf(rep({ content_type: "application/json", body_b64: b('{"t":"x\\ud83d","n":1}') }));
  assert.equal(lone?.json, undefined, "짝 없는 서로게이트");
  assert.equal(lone?.text, '{"t":"x\\ud83d","n":1}');
  const pair = resultViewOf(rep({ content_type: "application/json", body_b64: b('{"e":"\\ud83d\\ude00"}') }));
  assert.deepEqual(pair?.json, { e: "😀" }, "짝 맞는 서로게이트는 json 그대로");
  //  저장되는 꼴(jsonb 로 갈 JSON 글)에 NUL · 짝 없는 서로게이트 이스케이프가 없어야 한다 — 모든 경우.
  for (const v of [raw, esc, lit, lone, pair]) assert.doesNotMatch(JSON.stringify(v), /(?:^|[^\\])(?:\\\\)*\\u(?:0000|d[89a-f][0-9a-f]{2})/, JSON.stringify(v));
  //  실패 오류 글(응답 앞부분)에도 NUL · 제어문자가 없다.
  const f = endOf(rep({ status_code: 500, body_b64: b("bad\u0000thing\u0007here") }), { timeoutSec: 900, cancelRequested: false });
  assert.match(f.error!, /500 로 답했습니다 — bad thing here/);
  assert.ok(!f.error!.includes("\u0000"));
});

const at = (sec: number): Date => new Date(1_000_000_000_000 - sec * 1000);
const NOW = 1_000_000_000_000;
const facts = (o: Partial<SweepJobFacts>): SweepJobFacts => ({ status: "queued", created_at: at(1), dispatched_at: null, claimed_at: null, last_tick_at: null, attempts: 0, timeout_s: 900, cancel_requested: false, ...o });

test("B12 감시 — 대기(상한 경계 · 취소) · 부름(240초 경계 · 다시 부름 · 3번 뒤 실패 · 취소) · 돎(박동 90초 경계 · 시간+60초 경계 · 취소) · 끝난 것", () => {
  const p = { job_wait_s: 1800 };
  assert.deepEqual(sweepVerdict(facts({ created_at: at(1800) }), NOW, p), { kind: "none" }, "대기 경계 — 정확히 상한");
  assert.equal(sweepVerdict(facts({ created_at: at(1801) }), NOW, p).kind, "end");
  assert.deepEqual(sweepVerdict(facts({ cancel_requested: true }), NOW, p), { kind: "end", status: "canceled", error: "취소했습니다" });
  const d = (o: Partial<SweepJobFacts>): SweepJobFacts => facts({ status: "dispatched", dispatched_at: at(JOB_DISPATCH_RETRY_SEC), attempts: 1, ...o });
  assert.deepEqual(sweepVerdict(d({}), NOW, p), { kind: "none" }, "부름 경계 — 정확히 240초");
  assert.deepEqual(sweepVerdict(d({ dispatched_at: at(JOB_DISPATCH_RETRY_SEC + 1) }), NOW, p), { kind: "requeue" });
  assert.deepEqual(sweepVerdict(d({ dispatched_at: at(JOB_DISPATCH_RETRY_SEC + 1), attempts: JOB_DISPATCH_ATTEMPTS - 1 }), NOW, p), { kind: "requeue" });
  const gaveUp = sweepVerdict(d({ dispatched_at: at(JOB_DISPATCH_RETRY_SEC + 1), attempts: JOB_DISPATCH_ATTEMPTS }), NOW, p);
  assert.ok(gaveUp.kind === "end" && gaveUp.status === "failed" && /시작하지 못했습니다/.test(gaveUp.error));
  assert.equal((sweepVerdict(d({ cancel_requested: true, dispatched_at: at(1) }), NOW, p) as { status?: string }).status, "canceled", "부른 작업의 취소는 곧바로");
  assert.deepEqual(sweepVerdict(d({ dispatched_at: null }), NOW, p), { kind: "requeue" }, "부른 때 기록이 없으면 오래된 것으로 본다");
  const r = (o: Partial<SweepJobFacts>): SweepJobFacts => facts({ status: "running", claimed_at: at(100), last_tick_at: at(JOB_SILENT_SEC), ...o });
  assert.deepEqual(sweepVerdict(r({}), NOW, p), { kind: "none" }, "박동 경계 — 정확히 90초");
  const silent = sweepVerdict(r({ last_tick_at: at(JOB_SILENT_SEC + 1) }), NOW, p);
  assert.ok(silent.kind === "end" && silent.status === "failed" && /응답을 멈췄습니다/.test(silent.error));
  assert.deepEqual(sweepVerdict(r({ claimed_at: at(900 + JOB_TIMEOUT_GRACE_SEC), last_tick_at: at(1) }), NOW, p), { kind: "none" }, "시간 경계 — 정확히 상한+60초");
  const over = sweepVerdict(r({ claimed_at: at(900 + JOB_TIMEOUT_GRACE_SEC + 1), last_tick_at: at(1) }), NOW, p);
  assert.ok(over.kind === "end" && /시간 상한/.test(over.error));
  assert.equal((sweepVerdict(r({ last_tick_at: at(JOB_SILENT_SEC + 1), cancel_requested: true }), NOW, p) as { status?: string }).status, "canceled");
  assert.equal(sweepVerdict(r({ last_tick_at: null, claimed_at: at(JOB_SILENT_SEC + 1) }), NOW, p).kind, "end", "박동 기록이 없으면 시작 때부터 센다");
  for (const s of ["done", "failed", "canceled"] as const) assert.deepEqual(sweepVerdict(facts({ status: s, created_at: at(99999) }), NOW, p), { kind: "none" });
});

test("B13 함수 이벤트 — 라우트 → 경로 · 쿼리 · POST · 본문 base64(바이트 그대로) · 부르기 신원 머리 · host · 요청 번호에 시도 수", () => {
  const ev = jobInvokeEvent({ id: 9, route: "/api/jobs/t?lang=ko&x=%20", body: '{"file":"회의.mp3"}', attempts: 2 }, jobCredential("call", 9, S), "notes-ws.lvly.app", 1_700_000_000_000) as Record<string, any>;
  assert.equal(ev.rawPath, "/api/jobs/t");
  assert.equal(ev.rawQueryString, "lang=ko&x=%20");
  assert.equal(ev.requestContext.http.method, "POST");
  assert.equal(ev.isBase64Encoded, true);
  assert.equal(Buffer.from(ev.body, "base64").toString("utf8"), '{"file":"회의.mp3"}');
  assert.equal(ev.headers["x-lively-identity"], `lvjc1.9.${S}`);
  assert.equal(ev.headers.host, "notes-ws.lvly.app");
  assert.equal(ev.headers["content-type"], "application/json");
  assert.equal(ev.requestContext.requestId, "job-9-2");
  assert.equal(ev.cookies, undefined, "쿠키를 싣지 않는다");
  assert.equal(Object.keys(ev.headers).filter((k) => k.startsWith("x-lively-")).join(","), "x-lively-identity", "우리 머리글은 부르기 신원 하나");
  const plain = jobInvokeEvent({ id: 1, route: "/x", body: "{}", attempts: 1 }, jobCredential("call", 1, S), "h", 0) as Record<string, any>;
  assert.equal(plain.rawQueryString, "");
  //  본문을 읽지 않은 가벼운 줄(body «»)을 잘못 넘기면 조용히 빈 본문으로 부르지 않고 던진다.
  assert.throws(() => jobInvokeEvent({ id: 2, route: "/x", body: "", attempts: 1 }, jobCredential("call", 2, S), "h", 0), /본문이 없습니다/);
});

test("B14 보기 — 시작한 사람은 결과까지 · 남(관리자)은 상태 · 오류만 · 요청 본문은 크기만", () => {
  const row = {
    id: 3, app_id: "a1", status: "done" as const, requester: "m1", variant: "pub" as const, alias: "cur" as const, route: "/r", label: "전사", body_bytes: 42, timeout_s: 900,
    parent_id: null, depth: 0, attempts: 1, status_code: 200, result: { status_code: 200, content_type: "text/plain", text: "비밀 결과", truncated: false, bytes: 13 },
    error: null, cancel_requested: false, duration_ms: 5, created_at: new Date(0), dispatched_at: null, claimed_at: new Date(1000), ended_at: new Date(6000),
  };
  const full = jobView(row, true);
  assert.equal((full.result as { text: string }).text, "비밀 결과");
  assert.equal(full.body_bytes, 42);
  assert.equal(full.started_at, new Date(1000).toISOString());
  assert.equal("body" in full, false);
  const summary = jobView(row, false);
  for (const k of ["result", "route", "status_code", "body_bytes", "variant"]) assert.equal(k in summary, false, k);
  assert.equal(summary.status, "done");
});
