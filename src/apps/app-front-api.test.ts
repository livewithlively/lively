// 앱 주소의 같은 주소 API `/_lively/*`(#4482 앱 v2-3) — 사양 표 A-코어 C1~C20. 가짜 배관으로. 실행: npm run build && node dist/apps/app-front-api.test.js
//  이게 틀리면: 앱 화면이 남의 앱 id 로 표를 쓰거나(app_id 를 본문에서 받음), 없는 경로가 아무 도구로 새거나, 꺼진 앱 · 남의 초안 주소 · 출입 못 하는
//   사람이 도구를 부르거나, 동의가 필요한 사람에게 동의 자리를 못 알려 새 탭의 앱이 막다른 길이 되거나, 내부 오류 글이 앱 코드로 샌다.
import assert from "node:assert/strict";
import { HttpError } from "../http-error.js";
import type { LivelyUser } from "../context.js";
import type { OrgApp } from "../org/store/apps.js";
import type { OrgMember } from "../org/store/members.js";
import { apiErrorReply, apiPathOf, consentUrlFor, handleAppFrontApi, memberPrincipal, routeAppFrontApi, type AppFrontApiDeps } from "./app-front-api.js";
import type { AppFrontAct } from "./app-front-auth.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

const ENV = { LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
const T = { id: "11111111-1111-1111-1111-111111111111", slug: "lively-46e3" };
const act = (o: Partial<AppFrontAct> = {}): AppFrontAct => ({ op: "act", t: T.id, ws: T.slug, app: "talk", var: "pub", mid: "alice", iat: 1, ...o });
const member = (id: string, o: Partial<OrgMember> = {}): OrgMember => ({
  id, kind: "human", display_name: id, nickname: null, use_nickname: false, email: `${id}@x.io`, identities: [], body_md: "",
  avatar: null, avatar_char: null, avatar_color: null, state: "active", scopes: ["memory", "items", "bogus-scope"], sort: 0, version: 1, updated_at: null, updated_by: null, ...o,
} as OrgMember);
const app = (o: Partial<OrgApp> & Record<string, unknown> = {}): OrgApp => ({
  id: "talk", title: "톡", version: "1", manifest: {}, source: {}, content_hash: "h", status: "active", enabled: true,
  visibility: "all", owner_member: "alice", draft_by: null, published_version_no: null, installed_by: "alice", installed_at: "", updated_at: "", updated_by: null, ...o,
} as unknown as OrgApp);

interface Call { name: string; args: Record<string, unknown>; who: LivelyUser; address: string; appId: string }
function deps(o: Partial<AppFrontApiDeps> & { tool?: (c: Call) => unknown } = {}) {
  const calls: Call[] = [];
  const prefs: Array<{ op: string; patch?: unknown; who: LivelyUser }> = [];
  const d: AppFrontApiDeps = {
    workspaceAccess: async () => true,
    runTool: async (who, appId, name, args, address) => { const c = { name, args, who, address, appId }; calls.push(c); return o.tool ? o.tool(c) : { ran: name }; },
    prefsGet: async (who) => { prefs.push({ op: "get", who }); return { prefs: { a: 1 } }; },
    prefsSet: async (who, _app, patch) => { prefs.push({ op: "set", patch, who }); return { prefs: patch }; },
    gatewayBase: async () => "https://lively-46e3.app.lvly.io",
    ...o,
  };
  return { d, calls, prefs };
}
const run = (d: AppFrontApiDeps, method: string, path: unknown, body?: unknown, o: { a?: AppFrontAct; m?: OrgMember; app?: OrgApp } = {}) =>
  handleAppFrontApi({ act: o.a ?? act(), tenant: T as never, member: o.m ?? member("alice"), app: o.app ?? app(), method, rawPath: path, body, env: ENV }, d);

// ── C1~C6 경로 → 도구 · 인자(그 도구의 칸만 — 본문의 app_id 는 버린다) ──
{
  const { d, calls, prefs } = deps();
  const cases: Array<[string, string, unknown, string, Record<string, unknown>]> = [
    ["GET", "/store/tables", undefined, "store_tables", {}],
    ["HEAD", "/store/tables", undefined, "store_tables", {}],
    ["POST", "/store/notes/query", { match: { done: false }, limit: 5, app_id: "남의앱", extra: 1 }, "store_query", { table: "notes", match: { done: false }, limit: 5 }],
    ["POST", "/store/notes/insert", { row: { text: "a" }, app_id: "x", match: { id: 1 } }, "store_insert", { table: "notes", row: { text: "a" } }],
    ["POST", "/store/notes/update", { match: { id: 1 }, set: { done: true }, row: {} }, "store_update", { table: "notes", match: { id: 1 }, set: { done: true } }],
    ["POST", "/store/notes/delete", { match: { id: 1 }, set: {} }, "store_delete", { table: "notes", match: { id: 1 } }],
    ["POST", "/store/sql", { sql: "select 1", params: [1], format: "wire", strict: true, app_id: "x" }, "store_sql", { sql: "select 1", params: [1], format: "wire", strict: true }],
    ["POST", "/store/sql/batch", { statements: [{ sql: "select 1" }], app_id: "x" }, "store_sql_batch", { statements: [{ sql: "select 1" }] }],
    ["POST", "/tools/file_url", { address: "apps/talk/a", method: "PUT" }, "file_url", { address: "apps/talk/a", method: "PUT" }],
    ["POST", "/tools/whoami", undefined, "whoami", {}],
    ["POST", "/store/notes/query?x=1", { limit: 1 }, "store_query", { table: "notes", limit: 1 }],
    ["POST", "/store/notes/query/", {}, "store_query", { table: "notes" }],
    //  #4488 AI 실행(F1) — 입구 하나 + 둘레. 본문의 app_id 는 버리고 목록은 쿼리(status · limit)로 좁힌다.
    ["GET", "/ai/targets", undefined, "app_ai_targets", {}],
    ["POST", "/ai/runs", { prompt: "요약", schema: { type: "object" }, job: "summarize", wait: 5, app_id: "남의앱", bogus: 1 }, "app_ai_run", { prompt: "요약", schema: { type: "object" }, job: "summarize", wait: 5 }],
    //  #5101 이어받기 — 앱 서버가 검사해 되돌릴 때 앞 실행 번호와 까닭을 싣는다(두 칸이 그대로 넘어간다 · 남의 앱 칸은 여전히 걸러진다).
    ["POST", "/ai/runs", { prompt: "근거 id 를 다시 확인해", resume_run_id: 17, reason: "인용한 근거 id 3 이 조회 결과에 없다", app_id: "남의앱" }, "app_ai_run", { prompt: "근거 id 를 다시 확인해", resume_run_id: 17, reason: "인용한 근거 id 3 이 조회 결과에 없다" }],
    ["GET", "/ai/runs?status=done&limit=5&app_id=x", undefined, "app_ai_runs", { status: "done", limit: 5 }],
    ["GET", "/ai/runs", undefined, "app_ai_runs", {}],
    ["GET", "/ai/runs/42", undefined, "app_ai_run_get", { id: 42 }],
    ["POST", "/ai/runs/42/cancel", {}, "app_ai_run_cancel", { id: 42 }],
    //  #4486 백그라운드 작업 — 시작(그 칸만 · 본문의 app_id 는 버림) · 목록(쿼리로 좁힘) · 보기(wait 는 쿼리) · 취소.
    ["POST", "/jobs", { route: "/api/jobs/t", body: { f: 1 }, label: "전사", timeout_s: 300, type: "function", wait: 3, app_id: "남의앱", bogus: 1 }, "app_job_start",
      { route: "/api/jobs/t", body: { f: 1 }, label: "전사", timeout_s: 300, type: "function", wait: 3 }],
    ["GET", "/jobs?status=running&limit=3&app_id=x", undefined, "app_jobs", { status: "running", limit: 3 }],
    ["GET", "/jobs", undefined, "app_jobs", {}],
    ["GET", "/jobs/77?wait=20", undefined, "app_job_get", { id: 77, wait: 20 }],
    ["GET", "/jobs/77", undefined, "app_job_get", { id: 77 }],
    ["POST", "/jobs/77/cancel", {}, "app_job_cancel", { id: 77 }],
  ];
  for (const [m, p, b, name, args] of cases) {
    const r = await run(d, m, p, b);
    assert.equal(r.status, 200, `${m} ${p}`);
    assert.deepEqual(calls.at(-1)!.name, name, `${m} ${p} → ${name}`);
    assert.deepEqual(calls.at(-1)!.args, args, `${m} ${p} 인자`);
    assert.equal(calls.at(-1)!.appId, "talk", "앱 id 는 주소의 것");
  }
  assert.deepEqual((await run(d, "GET", "/prefs")).json, { prefs: { a: 1 } });
  await run(d, "POST", "/prefs", { patch: { w: 2 } });
  await run(d, "PATCH", "/prefs", { patch: { w: 3 } });
  assert.deepEqual(prefs.map((x) => [x.op, x.patch]), [["get", undefined], ["set", { w: 2 }], ["set", { w: 3 }]]);
  ok("C1~C6 경로 → 도구 · 그 도구의 칸만 · 본문의 app_id 는 버림 · prefs get/set");
}

// ── C7~C11 없는 경로 404 · 메서드 405 · 꼴 밖 400 · 표 · 도구 이름 꼴 밖은 없는 API ──
{
  const { d, calls } = deps();
  for (const [m, p] of [["GET", "/nope"], ["POST", "/store/notes/drop"], ["POST", "/store/a-b/query"], ["POST", `/store/${"a".repeat(64)}/query`],
    ["POST", "/tools/Whoami"], ["POST", "/tools/a.b"], ["POST", "/tools/"], ["GET", "/"], ["POST", "/me"], ["GET", "/ai/runs/0"], ["GET", "/ai/runs/abc"], ["GET", "/ai"],
    ["GET", "/jobs/0"], ["GET", "/jobs/abc"], ["GET", "/jobs/1/2"], ["POST", "/job"]] as const) {
    const r = await run(d, m, p, {});
    assert.equal(r.status, 404, `${m} ${p}`);
    assert.equal((r.json as { code?: string }).code, "not_found");
  }
  for (const [m, p] of [["GET", "/store/sql"], ["POST", "/store/tables"], ["GET", "/tools/whoami"], ["DELETE", "/prefs"], ["PUT", "/store/notes/query"], ["GET", "/store/sql/batch"],
    ["PUT", "/ai/runs"], ["POST", "/ai/targets"], ["POST", "/ai/runs/42"], ["GET", "/ai/runs/42/cancel"],
    ["PUT", "/jobs"], ["DELETE", "/jobs/1"], ["POST", "/jobs/1"], ["GET", "/jobs/1/cancel"]] as const) {
    assert.equal((await run(d, m, p, {})).status, 405, `${m} ${p}`);
  }
  for (const p of ["//evil", "/a b", "/a\\b", `/${"a".repeat(512)}`, "store/tables", 5, null, undefined]) {
    assert.equal((await run(d, "GET", p)).status, 400, String(p));
  }
  assert.equal(calls.length, 0, "어느 것도 도구를 부르지 않았다");
  ok("C7~C11 없는 경로 404 · 메서드 405 · 꼴 밖 400 · 도구 0");
}

// ── C12~C14 출입 · 앱 켜짐 · 주소의 판 — 막히면 도구를 부르지 않는다 ──
{
  const { d, calls } = deps({ workspaceAccess: async () => false });
  assert.equal((await run(d, "GET", "/store/tables")).status, 403, "C12 출입 불가");
  const { d: d2, calls: c2 } = deps({ workspaceAccess: async () => { throw new Error("등록부 장애"); } });
  assert.equal((await run(d2, "GET", "/store/tables")).status, 403, "C12 판정 불가면 막는다(fail-closed)");
  const { d: d3, calls: c3 } = deps();
  assert.equal((await run(d3, "GET", "/store/tables", undefined, { app: app({ enabled: false }) })).status, 409, "C13 꺼진 앱");
  assert.equal((await run(d3, "GET", "/store/tables", undefined, { app: app({ status: "failed" }) })).status, 409, "C13 활성 아님");
  const drafted = app({ draft_by: "carol", published_version_no: 2 });
  assert.equal((await run(d3, "GET", "/store/tables", undefined, { a: act({ var: "draft" }), app: drafted })).status, 404, "C14 남의 초안 주소");
  assert.equal(calls.length + c2.length + c3.length, 0, "막힌 요청은 도구를 부르지 않는다");
  assert.equal((await run(d3, "GET", "/store/tables", undefined, { a: act({ var: "draft", mid: "carol" }), m: member("carol"), app: drafted })).status, 200, "C14 초안 주인은 초안 주소");
  assert.equal(c3.at(-1)!.address, "draft");
  ok("C12~C14 출입 불가 403(장애도) · 꺼진 앱 409 · 남의 초안 주소 404 · 도구 0");
}

// ── C15~C19 실패 → 답 ──
{
  const consent = () => { throw new HttpError(403, "앱 'talk' 사용 동의(grant)가 없습니다", { body: { code: "consent_required" } }); };
  const { d } = deps({ tool: consent });
  const r = await run(d, "POST", "/store/notes/query", {});
  assert.equal(r.status, 403);
  assert.deepEqual(r.json, { code: "consent_required", error: "앱 'talk' 사용 동의(grant)가 없습니다",
    consent_url: "https://lively-46e3.app.lvly.io/ui/#/app-grant/talk?v=pub" }, "C15 동의 자리 — 라이블리 동의 화면(돌아갈 앱 주소는 싣지 않는다 — 화면이 지금 워크스페이스로 만든다)");
  const rd = await run(d, "POST", "/store/notes/query", {}, { a: act({ var: "draft", mid: "alice" }), app: app({ draft_by: "alice", published_version_no: 2 }) });
  assert.equal((rd.json as { consent_url?: string }).consent_url, "https://lively-46e3.app.lvly.io/ui/#/app-grant/talk?v=draft", "C15 초안 주소면 v=draft");
  const { d: d2 } = deps({ tool: consent, gatewayBase: async () => null });
  const r2 = await run(d2, "POST", "/store/notes/query", {});
  assert.equal(r2.status, 403);
  assert.deepEqual(r2.json, { code: "consent_required", error: "앱 'talk' 사용 동의(grant)가 없습니다" }, "C16 게이트웨이 주소가 없으면 consent_url 없이");
  const { d: d3 } = deps({ tool: () => { throw new HttpError(429, "너무 잦습니다", { body: { retry_after_ms: 250 } }); } });
  assert.deepEqual(await run(d3, "POST", "/store/sql", {}), { status: 429, json: { retry_after_ms: 250, error: "너무 잦습니다" } }, "C17 HttpError 는 상태 · body 그대로");
  const { d: d4 } = deps({ tool: () => { throw new Error("Forbidden: user 'alice' lacks scope 'admin'"); } });
  const r4 = await run(d4, "POST", "/tools/x_tool", {});
  assert.equal(r4.status, 403, "C18 스코프 판정");
  const { d: d5 } = deps({ tool: () => { throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2"); } });
  const r5 = await run(d5, "POST", "/store/sql", {});
  assert.equal(r5.status, 500, "C19 그 밖은 500");
  assert.ok(!JSON.stringify(r5.json).includes("10.0.0.5") && !JSON.stringify(r5.json).includes("hunter2"), "C19 내부 글은 앱으로 안 샌다");
  const { d: d6, calls: c6 } = deps({ tool: () => { throw new HttpError(403, "다른 403", { body: { code: "other" } }); } });
  const r6 = await run(d6, "POST", "/store/sql", {});
  assert.ok(r6.status === 403 && !("consent_url" in (r6.json as object)) && c6.length === 1, "동의가 아닌 403 엔 동의 자리를 싣지 않는다");
  //  동의 자리는 동의 실패에만 — 다른 HttpError 엔 동의 주소를 만들 수 있어도 싣지 않는다(엉뚱한 화면으로 보내지 않게)
  assert.deepEqual(apiErrorReply(new HttpError(409, "꺼짐"), () => "https://x/ui/#/app-grant/a"), { status: 409, json: { error: "꺼짐" } });
  assert.deepEqual(apiErrorReply(new HttpError(403, "동의 없음", { body: { code: "consent_required" } }), () => "https://x/ui/#/app-grant/a"),
    { status: 403, json: { code: "consent_required", error: "동의 없음", consent_url: "https://x/ui/#/app-grant/a" } });
  ok("C15~C19 동의 자리(공개 · 초안 주소) · 주소 없으면 생략 · 동의 실패에만 · HttpError 그대로 · 스코프 403 · 내부 오류 500 감춤");
}

// ── C19b 도구가 던진 도메인 글(store 의 plain Error)은 REST(wrap)와 같은 4xx — «없음» 404 · 검증 400. 그 밖은 글을 감춘 500 ──
{
  assert.deepEqual(apiErrorReply(new Error("지식 'k' 없음"), () => null), { status: 404, json: { error: "지식 'k' 없음" } }, "C19b «없음» 404 — 안 보이는 것과 없는 것이 같은 답");
  assert.deepEqual(apiErrorReply(new Error("name 은 필수입니다"), () => null), { status: 400, json: { error: "name 은 필수입니다" } }, "C19b 검증 400");
  const r = apiErrorReply(new Error("domainmap fetch failed http://10.0.0.5:7000"), () => null);
  assert.ok(r.status === 500 && !JSON.stringify(r.json).includes("10.0.0.5"), "C19b 내부 서비스 연결 실패는 글을 감춘 500 그대로");
  ok("C19b 도메인 글 — «없음» 404 · 검증 400 · 내부 연결 실패는 감춘 500");
}

// ── C20 도구에 넘기는 주체 — 그 사람 · 주소의 판 · 유효 스코프만 ──
{
  const { d, calls } = deps();
  await run(d, "POST", "/tools/whoami", {}, { a: act({ var: "pub" }) });
  const who = calls.at(-1)!.who;
  assert.equal(who.userId, "alice");
  assert.equal(who.appAddress, "pub", "주소의 판");
  assert.equal(calls.at(-1)!.address, "pub");
  assert.deepEqual(who.scopes, ["memory", "items"], "모르는 스코프는 버린다");
  assert.equal(who.appId, undefined, "앱 주체는 runAppTool 이 동의로 만든다(여기서 미리 굽지 않는다)");
  assert.deepEqual(memberPrincipal(member("bob", { scopes: [] }), "draft"), { userId: "bob", email: "bob@x.io", scopes: [], projects: ["*"], tokenSource: "session", appAddress: "draft" });
  ok("C20 주체 = 그 사람 · appAddress · 유효 스코프");
}

// ── 순수 조각 — 경로 · 동의 주소 ──
{
  assert.equal(apiPathOf("/store/notes/query?x=1#h"), "/store/notes/query");
  assert.equal(apiPathOf("/store/tables/"), "/store/tables");
  assert.equal(apiPathOf("/"), "/");
  assert.equal(apiPathOf("/a/../store/sql"), "/store/sql", "점 칸은 정규화(앞단이 이미 했지만 한 번 더)");
  for (const bad of ["", "x", "//h/p", "/a b", "/\u0001", 1, null]) assert.equal(apiPathOf(bad), null, String(bad));
  assert.equal(consentUrlFor(null, T.slug, "talk", "pub", ENV), null);
  assert.equal(consentUrlFor("https://w.example/", T.slug, "talk", "pub", {} as NodeJS.ProcessEnv), null, "앱 도메인이 없으면 돌아올 주소가 없다");
  assert.equal(consentUrlFor("https://w.example/", T.slug, "x".repeat(40), "pub", ENV), null, "주소를 못 만드는 이름");
  assert.ok(!/back=/.test(String(consentUrlFor("https://w.example/", T.slug, "talk", "pub", ENV))), "돌아갈 주소(back)를 싣지 않는다");
  assert.equal(routeAppFrontApi("GET", "/store/tables", null) !== null, true);
  ok("순수 — apiPathOf · consentUrlFor");
}

// ── 세 자리가 같은 글자 — 서버 표지(apps/app-consent.ts) · 그 표지로 consent_url 을 다는 판정 · 웹 SDK 런타임(주입 문자열) ──
//  이게 틀리면: 한쪽 글자만 바뀌어 동의 자리 첨부와 SDK 의 동의 이동이 조용히 사라진다(시험은 리터럴로 짜여 초록 — 격리 리뷰 7).
{
  const { CONSENT_REQUIRED } = await import("./app-consent.js");
  const { readFileSync } = await import("node:fs");
  const rt = readFileSync(new URL("../../web/v2/app-ui-runtime.ts", import.meta.url), "utf8");
  const tc = readFileSync(new URL("../../src/capabilities/app-tool-call.ts", import.meta.url), "utf8");
  assert.ok(rt.includes(`j.code === '${CONSENT_REQUIRED}'`), "SDK 런타임이 같은 글자로 가른다");
  assert.ok(/body: \{ code: CONSENT_REQUIRED \}/.test(tc) && (tc.match(/code: CONSENT_REQUIRED/g) || []).length === 2, "도구 판정의 두 403(동의 없음 · 예전 범위)이 표지를 단다");
  const { d } = deps({ tool: () => { throw new HttpError(403, "x", { body: { code: CONSENT_REQUIRED } }); } });
  assert.ok("consent_url" in ((await run(d, "POST", "/store/sql", {})).json as object), "그 표지면 동의 자리가 붙는다");
  ok("세 자리 consent_required 일치");
}

console.log(`\n${pass} passed`);
