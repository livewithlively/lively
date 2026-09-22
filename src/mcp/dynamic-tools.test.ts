// 커넥터 통합(P1·P2·P3, #746) 순수 로직 단위 체크 — 등급→vault 폴백 정책 + JSON스키마 위생(기존).
// 실행: npm run build && node dist/mcp/dynamic-tools.test.js
//  runHttpProxyTool 의 네트워크/DB 경로는 실 pg 통합(scripts/integration/connector-proxy-pg.mjs)에서.
import assert from "node:assert/strict";
import { proxyAuthFallback, assertSafeJsonSchema, buildProxyAuthHeaders, applyUrlTemplate, urlTemplateKeys, urlPathTemplateKeys, buildProxyRequest } from "./dynamic-tools.js";
import { credentialHeaderNames } from "../net/ssrf.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// P1·P2 — 등급이 vault 자격 폴백 정책을 정한다: L2(집행)만 per-user 필수(통합 폴백 금지).
t("proxyAuthFallback: L0/L1/null → true(통합 폴백 허용)", () => {
  assert.equal(proxyAuthFallback("L0"), true);
  assert.equal(proxyAuthFallback("L1"), true);
  assert.equal(proxyAuthFallback(null), true);
  assert.equal(proxyAuthFallback(undefined), true);
});
t("proxyAuthFallback: L2 및 예상밖 값 → false(allow-list, fail-closed)", () => {
  assert.equal(proxyAuthFallback("L2"), false);
  assert.equal(proxyAuthFallback("L3"), false); // 예상 밖 값도 폴백 금지(fail-closed)
  assert.equal(proxyAuthFallback("admin" as unknown as string), false);
});

// P1 — vault 해소 결과 → 인증 헤더(순수). 기본 Bearer + 커스텀 헤더명/prefix.
t("buildProxyAuthHeaders: 기본 Authorization: Bearer", () => {
  const b = buildProxyAuthHeaders(undefined, "glpat-XYZ");
  assert.equal(b.headerName, "Authorization");
  assert.equal(b.headers.Authorization, "Bearer glpat-XYZ");
});
t("buildProxyAuthHeaders: 커스텀 헤더명(PRIVATE-TOKEN)·빈 prefix", () => {
  const b = buildProxyAuthHeaders({ auth_header: "PRIVATE-TOKEN", token_prefix: "" }, "glpat-XYZ");
  assert.equal(b.headerName, "PRIVATE-TOKEN");
  assert.equal(b.headers["PRIVATE-TOKEN"], "glpat-XYZ");
});

// B14 확장 — 크로스-오리진 리다이렉트 시 벗길 자격 헤더 집합(커스텀 헤더명 포함).
t("credentialHeaderNames: Authorization·cookie 항상 + 커스텀(소문자화)", () => {
  const s = credentialHeaderNames(["PRIVATE-TOKEN"]);
  assert.ok(s.has("authorization") && s.has("cookie") && s.has("private-token"));
  assert.ok(!s.has("user-agent"));
});

// 기존 JSON 스키마 위생(회귀) — $ref·프로토타입 오염·과대·비-object 거부.
t("assertSafeJsonSchema: 정상 object 통과", () => {
  assertSafeJsonSchema({ type: "object", properties: { q: { type: "string" } } });
});
t("assertSafeJsonSchema: $ref·프로토타입 오염·비object 거부", () => {
  assert.throws(() => assertSafeJsonSchema({ $ref: "#/x" }));
  // own 속성 '__proto__' (리터럴이 아니라 JSON.parse 로 만들어야 stringify 에 포함됨 — 실제 위협 형태)
  assert.throws(() => assertSafeJsonSchema(JSON.parse('{"properties":{"__proto__":{"type":"string"}}}')));
  assert.throws(() => assertSafeJsonSchema({ type: "array" }));
});

// ── L. 경로 템플릿 (#1655). 사양·엣지 표 = spec-1655 표 L. ──────────────────────────────────
//  왜 뚫었나: 구글 클래식 API 는 리소스 id 가 경로에 있어(`/files/{fileId}`) 고정 URL 만으로는 **검색은 되는데
//   읽기가 안 된다.** 왜 위험한가: 그 자리가 곧 경로 조작 통로가 될 수 있다 — 아래는 그 통로가 막혔는지를 본다.
//  단언은 **실제로 나가는 요청**(buildProxyRequest 의 결과)으로 한다 — 조립 규칙을 여기서 재구현하면 테스트가
//  실물이 아니라 사본을 보게 되고, 그 순간 '경로 키를 query 에 중복 적재' 같은 회귀를 통째로 놓친다(실측).
const finalUrl = (tmpl: string, args: Record<string, unknown>): string => buildProxyRequest(tmpl, "GET", args).url.toString();
const G = "https://www.googleapis.com";

t("L1 자리표시가 없으면 종전 그대로(무회귀)", () => {
  assert.equal(finalUrl(`${G}/drive/v3/files`, { q: "name contains 'x'" }), `${G}/drive/v3/files?q=name+contains+%27x%27`);
  assert.equal(applyUrlTemplate(`${G}/drive/v3/files`, {}).consumed.size, 0);
});

t("L2 자리표시를 채우고, 그 키는 query 에 다시 붙지 않는다", () => {
  assert.equal(finalUrl(`${G}/drive/v3/files/{fileId}`, { fileId: "abc123" }), `${G}/drive/v3/files/abc123`);
});

t("L3 슬래시는 인코딩돼 경로 한 칸을 못 넘는다", () => {
  const u = new URL(finalUrl(`${G}/drive/v3/files/{fileId}`, { fileId: "a/b" }));
  assert.equal(u.pathname, "/drive/v3/files/a%2Fb");
  assert.ok(!u.pathname.endsWith("/a/b"), "슬래시가 살아 다른 리소스를 가리켰다");
});

t("L4·L5 상위이동(..)·현재(.)는 거부", () => {
  assert.throws(() => applyUrlTemplate(`${G}/drive/v3/files/{fileId}`, { fileId: ".." }));
  assert.throws(() => applyUrlTemplate(`${G}/drive/v3/files/{fileId}`, { fileId: "." }));
});

t("L6·L7 값이 없거나 비면 거부 — 빈 칸으로 엉뚱한 곳을 때리지 않는다", () => {
  assert.throws(() => applyUrlTemplate(`${G}/drive/v3/files/{fileId}`, {}));
  assert.throws(() => applyUrlTemplate(`${G}/drive/v3/files/{fileId}`, { fileId: "" }));
  assert.throws(() => applyUrlTemplate(`${G}/drive/v3/files/{fileId}`, { fileId: null }));
});

t("L8 경로 인자와 query 인자가 섞여도 각자 자리로 간다", () => {
  const u = new URL(finalUrl(`${G}/drive/v3/files/{fileId}/export`, { fileId: "abc", mimeType: "text/plain" }));
  assert.equal(u.pathname, "/drive/v3/files/abc/export");
  assert.equal(u.searchParams.get("mimeType"), "text/plain");
  assert.equal(u.searchParams.get("fileId"), null, "경로로 쓴 키가 query 에도 실렸다");
});

t("L9 자리표시가 여럿이면 전부 치환되고 전부 소비된다", () => {
  const { url, consumed } = applyUrlTemplate(`${G}/calendar/v3/calendars/{calendarId}/events/{eventId}`, { calendarId: "primary", eventId: "e1" });
  assert.equal(url.pathname, "/calendar/v3/calendars/primary/events/e1");
  assert.deepEqual([...consumed].sort(), ["calendarId", "eventId"]);
});

t("L10 인코딩 우회 시도가 통하지 않는다", () => {
  // %2e%2e / %2F.. 를 넣어도 한 번 더 인코딩돼 고정 경로가 유지된다.
  for (const evil of ["%2e%2e", "%2F..", "..%2F..", "%252e%252e"]) {
    const u = new URL(finalUrl(`${G}/drive/v3/files/{fileId}`, { fileId: evil }));
    assert.ok(u.pathname.startsWith("/drive/v3/files/"), `고정 경로를 벗어났다: ${evil} → ${u.pathname}`);
    assert.equal(u.pathname.split("/").length, 5, `경로 칸수가 늘었다: ${evil} → ${u.pathname}`);
  }
});

t("L11 ?·# 이 query/fragment 로 분리되지 않는다", () => {
  const u = new URL(finalUrl(`${G}/drive/v3/files/{fileId}`, { fileId: "a?b#c" }));
  assert.equal(u.pathname, "/drive/v3/files/a%3Fb%23c");
  assert.equal(u.search, "");
  assert.equal(u.hash, "");
});

t("L13 host 를 바꾸려는 시도는 실패한다", () => {
  for (const evil of ["/evil.com/x", "//evil.com/x", "http://evil.com"]) {
    const u = new URL(finalUrl(`${G}/drive/v3/files/{fileId}`, { fileId: evil }));
    assert.equal(u.host, "www.googleapis.com", `호스트가 바뀌었다: ${evil} → ${u.host}`);
  }
});

t("L14 숫자 id 는 허용(문자열화) — id 가 숫자인 API 가 있다", () => {
  assert.equal(new URL(finalUrl(`${G}/x/{id}`, { id: 123 })).pathname, "/x/123");
  assert.throws(() => applyUrlTemplate(`${G}/x/{id}`, { id: { nested: 1 } }), "객체를 경로에 밀어넣었다");
});

t("L12 POST 면 경로로 쓴 키가 본문에서도 빠진다", () => {
  const r = buildProxyRequest(`${G}/upload/{fileId}`, "POST", { fileId: "abc", title: "제목" });
  assert.equal(r.url.pathname, "/upload/abc");
  const sent = JSON.parse(r.body as string);
  assert.equal(sent.fileId, undefined, "경로로 쓴 키가 본문에도 실렸다");
  assert.equal(sent.title, "제목");
});

t("L12b GET 이 아니면 body 를 만들고, GET 이면 만들지 않는다(무회귀)", () => {
  assert.equal(buildProxyRequest(`${G}/x`, "GET", { a: 1 }).body, undefined);
  assert.equal(buildProxyRequest(`${G}/x`, "GET", { a: 1 }).url.search, "?a=1");
  assert.equal(JSON.parse(buildProxyRequest(`${G}/x`, "POST", { a: 1 }).body as string).a, 1);
  assert.equal(buildProxyRequest(`${G}/x`, "POST", { a: 1 }).url.search, "", "POST 인데 인자가 query 에도 실렸다");
});

t("urlTemplateKeys: 자리표시 이름을 뽑는다(저장 검증용)", () => {
  assert.deepEqual(urlTemplateKeys(`${G}/calendars/{calendarId}/events/{eventId}`), ["calendarId", "eventId"]);
  assert.deepEqual(urlTemplateKeys(`${G}/files`), []);
});

// ── 쿼리 값 자리표시(#4211 Outlook) — Graph 는 쿼리 이름이 `$search`·`$filter` 라 인자 이름으로 못 쓴다. ────────────
//  관리자가 URL 에 뚫은 **값 자리**만 인자가 채운다. 아래는 그 자리가 ①다른 쿼리를 보태거나 경로를 바꾸는 통로가 되지 않는지
//  ②없는 인자가 빈 쿼리로 새지 않는지 ③종전 경로 자리 규칙이 그대로인지를 본다. 단언은 실제로 나가는 URL 로.
const MS = "https://graph.microsoft.com/v1.0";

t("Q1 쿼리 값 자리를 채운다 — 공백은 %20, &·=·#·? 는 인코딩돼 쿼리를 보태거나 경로를 못 바꾼다", () => {
  const url = finalUrl(`${MS}/me/messages?$search=%22{q}%22&$top=25`, { q: "from:kim 견적 & x=1#y?z" });
  assert.ok(url.includes("$search=%22from%3Akim%20%EA%B2%AC%EC%A0%81%20%26%20x%3D1%23y%3Fz%22"), url);
  assert.ok(!url.includes("+"), "공백이 + 로 바뀌면 Graph 가 공백으로 안 읽는다");
  const u = new URL(url);
  assert.equal(u.pathname, "/v1.0/me/messages");
  assert.equal(u.hash, "", "#가 살아 fragment 로 잘렸다");
  assert.deepEqual([...u.searchParams.keys()].sort(), ["$search", "$top"], "값이 새 쿼리를 보탰다");
  assert.equal(u.searchParams.get("$search"), '"from:kim 견적 & x=1#y?z"');
});

t("Q2 인자가 없거나 비면 그 쌍을 통째로 뺀다 — 다른 쌍은 남고, 던지지 않는다", () => {
  const tmpl = `${MS}/me/messages?$search=%22{q}%22&$top=25&$filter=conversationId%20eq%20'{cid}'`;
  const u1 = new URL(finalUrl(tmpl, {}));
  assert.deepEqual([...u1.searchParams.keys()], ["$top"], "빈 $search 가 나가면 Graph 가 400 을 준다");
  const u2 = new URL(finalUrl(tmpl, { q: "", cid: "AAQk=" }));
  assert.deepEqual([...u2.searchParams.keys()], ["$top", "$filter"]);
  assert.equal(u2.searchParams.get("$filter"), "conversationId eq 'AAQk='");
  assert.equal(new URL(finalUrl(`${MS}/me/messages?$search={q}`, {})).search, "", "쌍이 다 빠지면 ? 도 남기지 않는다");
  assert.equal(new URL(finalUrl(`${MS}/me/messages?$search={q}`, { q: { x: 1 } })).search, "", "객체는 값이 못 된다 — 새지 않고 빠진다");
});

t("Q3 쿼리 자리를 쓴 키는 소비된다 — 같은 이름으로 한 번 더 붙지 않는다", () => {
  const { consumed } = applyUrlTemplate(`${MS}/me/messages?$search={q}`, { q: "a" });
  assert.deepEqual([...consumed], ["q"]);
  const u = new URL(finalUrl(`${MS}/me/messages?$search={q}`, { q: "a" }));
  assert.equal(u.searchParams.get("q"), null, "자리를 채운 인자가 ?q= 로 한 번 더 실렸다");
  // 인자가 없어 쌍을 뺀 키도 소비된 것 — 잘못된 타입이 ?q=[object Object] 로 새지 않는다
  assert.ok(applyUrlTemplate(`${MS}/me/messages?$search={q}`, {}).consumed.has("q"));
});

t("Q4 경로 자리와 쿼리 자리가 섞이면 — 경로는 필수, 쿼리는 선택", () => {
  const tmpl = `${MS}/me/mailFolders/{folder}/messages?$top=25&$search={q}`;
  assert.throws(() => applyUrlTemplate(tmpl, { q: "x" }), "경로 자리가 비었는데 통과했다");
  const u = new URL(finalUrl(tmpl, { folder: "inbox" }));
  assert.equal(u.pathname, "/v1.0/me/mailFolders/inbox/messages");
  assert.deepEqual([...u.searchParams.keys()], ["$top"]);
  assert.deepEqual(urlPathTemplateKeys(tmpl), ["folder"], "required 강제는 경로 자리에만");
  assert.deepEqual(urlTemplateKeys(tmpl), ["folder", "q"]);
});

t("Q5 쿼리 자리만 있어도 고정 경로·호스트 검사를 통과한다(종전엔 ? 이후까지 «고정 접두»로 봐서 오검출)", () => {
  const u = new URL(finalUrl(`${MS}/me/calendarView?startDateTime={s}&endDateTime={e}&$top=50`, { s: "2026-09-22T00:00:00+09:00", e: "2026-09-29T00:00:00+09:00" }));
  assert.equal(u.host, "graph.microsoft.com");
  assert.equal(u.pathname, "/v1.0/me/calendarView");
  assert.equal(u.searchParams.get("startDateTime"), "2026-09-22T00:00:00+09:00", "+ 는 %2B 로 가야 시간대가 산다");
  assert.ok(u.search.includes("startDateTime=2026-09-22T00%3A00%3A00%2B09%3A00"), u.search);
});

t("Q6 경로 자리 규칙은 그대로다 — 쿼리 자리 도입이 경로 탈출 방어를 풀지 않는다", () => {
  for (const evil of ["..", "."]) assert.throws(() => applyUrlTemplate(`${MS}/me/messages/{id}?$select=id`, { id: evil }));
  const u = new URL(finalUrl(`${MS}/me/messages/{id}?$select=id,body`, { id: "a/b?c" }));
  assert.equal(u.pathname, "/v1.0/me/messages/a%2Fb%3Fc");
  assert.equal(u.searchParams.get("$select"), "id,body", "템플릿의 고정 쿼리는 그대로");
});

t("Q7 작은따옴표로 감싼 자리는 값의 ' 를 겹친다 — OData 리터럴을 닫고 조건을 보태지 못한다", () => {
  const evil = "x' or contains(subject,'secret";
  for (const q of ["'", "%27"]) {
    const u = new URL(finalUrl(`${MS}/me/messages?$filter=conversationId%20eq%20${q}{c}${q}&$top=25`, { c: evil }));
    assert.equal(u.searchParams.get("$filter"), "conversationId eq 'x'' or contains(subject,''secret'", `${q}: 리터럴을 빠져나갔다 — ${u.search}`);
    assert.equal(u.searchParams.get("$top"), "25");
  }
  // 따옴표 밖 자리는 값 그대로(겹치면 검색어가 바뀐다)
  assert.equal(new URL(finalUrl(`${MS}/me/messages?$search=%22{q}%22`, { q: "it's" })).searchParams.get("$search"), '"it\'s"');
  // 한쪽만 따옴표면 리터럴이 아니다
  assert.equal(new URL(finalUrl(`${MS}/me/x?a='{q}`, { q: "o'k" })).searchParams.get("a"), "'o'k");
});

console.log(`\ndynamic-tools tests: ${pass} passed`);
