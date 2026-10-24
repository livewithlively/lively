// 조건부 다시 받기 — api(path, { revalidate: true }) (#4989). 사양 표 R1~R12.
//
//  셸은 사이드바 목록을 8초마다 다시 묻는다. 서버는 응답마다 ETag 를 붙이고 If-None-Match 가 맞으면 본문 없이 304 로 답한다.
//  화면은 마지막 본문(글자)과 ETag 를 **메모리에** 쥐고 다시 물을 때 조건 헤더를 싣는다 — 304 면 쥔 글자를 새로 풀어 준다.
//  (/api/ui 는 전부 no-store 라 브라우저 캐시에 맡기지 않는다 — web/lib/net.ts 머리말.)
//
//  R1 처음 묻기 — 조건 헤더 없음 · 본문 그대로          R2 같은 주소 다시 — If-None-Match · 304 면 직전과 같은 값
//  R3 304 가 준 값은 새 객체(앞 판에 고친 것이 안 샌다)  R4 본문이 바뀌면 새 값 · 다음 물음은 새 ETag
//  R5 revalidate 안 고른 GET 은 조건 헤더 없음           R6 본문 보내는 호출은 조건 헤더도 쥐는 것도 없음
//  R7 실패한 답은 쥐지 않고 쥐던 것도 버린다            R8 fetch 에 낯선 키 없음 · 401 종전대로
//  R9 ETag 없는 200 은 쥐지 않는다                       R10 JSON 아닌 본문은 쥐지 않는다
//  R11 쥔 것 없는데 304 — 조용히 null 을 주지 않는다      R12 경계 — 24개까지 쥐고 25번째는 가장 오래 안 쓴 것 하나를 버린다
//  R13 조건 헤더를 실은 물음만 cache: 'no-cache' — 기본 모드면 웹킷(아이폰 사파리) · 파이어폭스가 `Cache-Control: no-cache` 를 붙여
//      서버가 조건을 무시하고 200 전량을 준다(2026-10-25 프로덕션 출처 실측: 기본 = 크로미움만 304 · no-cache = 셋 다 304)
//
// 러너는 web/ 을 수집하지 않으므로 컴파일 산출물(public/app/lib/net.js)을 싣는다(scripts/notify-workspace-web.test.mjs 와 같은 방식).
//  관측은 **흉내 서버가 받은 요청**(조건 헤더 · init)과 돌려받은 값으로 한다.
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const NET = pathToFileURL(join(root, "public/app/lib/net.js")).href;
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
const eq = (got, want, name) => { assert.deepEqual(got, want, `${name}\n  기대 ${JSON.stringify(want)}\n  실제 ${JSON.stringify(got)}`); pass++; console.log(`ok  ${name}`); };

const store = { lively_ui_token: "tok-1" };
globalThis.localStorage = {
  getItem: (k) => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: (k) => { delete store[k]; },
};
globalThis.location = { pathname: "/ui/", search: "", hash: "#/" };
globalThis.history = { state: null, replaceState: () => {} };
globalThis.window = new Proxy({}, { get: (_o, k) => (k === "top" ? globalThis.window : undefined) });

// 흉내 서버 — 주소마다 지금 답(status · etag · body)을 두고, If-None-Match 가 맞으면 304(본문 없음). force304 는 무조건 304.
const server = new Map();
const seen = [];   // 받은 요청 { url, method, inm, init }
globalThis.fetch = async (url, init = {}) => {
  const h = init.headers || {};
  const inm = h["If-None-Match"] ?? null;
  seen.push({ url, method: init.method || "GET", inm, init });
  const cur = server.get(url) || { status: 200, etag: null, body: "{}" };
  if (cur.force304 || (cur.status === 200 && cur.etag && inm === cur.etag)) return new Response(null, { status: 304, headers: cur.etag ? { ETag: cur.etag } : {} });
  const headers = { "Content-Type": "application/json" };
  if (cur.etag) headers.ETag = cur.etag;
  return new Response(cur.body, { status: cur.status, headers });
};
const last = () => seen[seen.length - 1];

const { api } = await import(NET);

// ── 배선 — 스텁이 죽어 있으면 아래가 전부 vacuous 다 ─────────────────────────
{
  server.set("/api/ui/wire", { status: 200, etag: null, body: '{"w":1}' });
  eq(await api("/api/ui/wire"), { w: 1 }, "배선: 흉내 fetch 를 거쳐 JSON 이 풀린다");
  eq(last().url, "/api/ui/wire", "배선: 흉내 서버가 그 요청을 받았다");
  eq(last().init.headers.Authorization, "Bearer tok-1", "배선: 토큰 헤더가 실린다");
}

// ── R1 · R2 · R3 ────────────────────────────────────────────────────────────
{
  server.set("/api/ui/list", { status: 200, etag: 'W/"a"', body: '{"rows":[1,2]}' });
  const first = await api("/api/ui/list", { revalidate: true });
  eq(first, { rows: [1, 2] }, "R1 처음 묻기 — 본문을 그대로 준다");
  eq(last().inm, null, "R1 처음 묻기 — 조건 헤더가 없다");
  eq(last().init.cache, undefined, "R13 처음 묻기는 캐시 모드를 건드리지 않는다");
  first.rows.push(99);   // 호출부가 받은 객체를 고쳐 쓴다(셸은 행에 표식을 덧붙인다)
  const n0 = seen.length;
  const again = await api("/api/ui/list", { revalidate: true });
  eq(seen.length, n0 + 1, "R2 (다시 묻기는 실제로 서버에 한 번 나간다)");
  eq(last().inm, 'W/"a"', "R2 같은 주소 다시 — 받은 ETag 를 If-None-Match 로 싣는다");
  eq(last().init.cache, "no-cache", "R13 조건 헤더를 실은 물음은 cache: 'no-cache' — 기본 모드면 사파리 · 파이어폭스가 304 를 못 받는다");
  eq(again, { rows: [1, 2] }, "R2 304 면 직전 본문과 같은 값을 준다");
  ok(again !== first && again.rows !== first.rows, "R3 304 가 준 값은 새 객체다(앞 판에 고쳐 쓴 것이 새지 않는다)");
}

// ── R4 ──────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/list", { status: 200, etag: 'W/"b"', body: '{"rows":[3]}' });
  eq(await api("/api/ui/list", { revalidate: true }), { rows: [3] }, "R4 서버 답이 바뀌면 새 값을 준다");
  eq(last().inm, 'W/"a"', "R4 (그 물음은 옛 ETag 를 실었다)");
  await api("/api/ui/list", { revalidate: true });
  eq(last().inm, 'W/"b"', "R4 다음 물음은 새 ETag 를 싣는다");
}

// ── R5 ──────────────────────────────────────────────────────────────────────
{
  eq(await api("/api/ui/list"), { rows: [3] }, "R5 revalidate 없는 호출도 값은 그대로");
  eq(last().inm, null, "R5 revalidate 를 안 고른 호출은 조건 헤더를 싣지 않는다");
  eq(last().init.cache, undefined, "R5 · R13 고르지 않은 호출은 캐시 모드도 종전 그대로");
}

// ── R6 ──────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/post", { status: 200, etag: 'W/"p"', body: '{"ok":true}' });
  await api("/api/ui/post", { method: "POST", body: "{}", revalidate: true });
  await api("/api/ui/post", { method: "POST", body: "{}", revalidate: true });
  eq(last().inm, null, "R6 본문을 보내는 호출은 조건 헤더를 싣지 않는다(쥐지도 않았다)");
}

// ── R7 ──────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/flaky", { status: 200, etag: 'W/"f1"', body: '{"v":1}' });
  await api("/api/ui/flaky", { revalidate: true });
  server.set("/api/ui/flaky", { status: 500, etag: 'W/"f2"', body: '{"error":"boom"}' });
  await assert.rejects(() => api("/api/ui/flaky", { revalidate: true }), /boom/);
  eq(last().inm, 'W/"f1"', "R7 (실패한 그 물음은 쥐고 있던 ETag 를 실었다)");
  server.set("/api/ui/flaky", { status: 200, etag: 'W/"f1"', body: '{"v":1}' });
  eq(await api("/api/ui/flaky", { revalidate: true }), { v: 1 }, "R7 실패 뒤의 물음도 값을 받는다");
  eq(last().inm, null, "R7 실패한 답은 쥐지 않고 쥐던 것도 버린다 — 다음 물음은 조건 없이");
}

// ── R8 ──────────────────────────────────────────────────────────────────────
{
  ok(!("revalidate" in last().init), "R8 fetch 에 revalidate 라는 낯선 키가 넘어가지 않는다");
  server.set("/api/ui/me", { status: 401, etag: null, body: '{"error":"unauthenticated"}' });
  await assert.rejects(() => api("/api/ui/me", { revalidate: true }), (e) => e.status === 401);
  eq("lively_ui_token" in store, false, "R8 401 은 종전대로 토큰을 버리고 status 401 로 던진다");
  store.lively_ui_token = "tok-1";
}

// ── R9 ──────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/noetag", { status: 200, etag: null, body: '{"n":1}' });
  await api("/api/ui/noetag", { revalidate: true });
  await api("/api/ui/noetag", { revalidate: true });
  eq(last().inm, null, "R9 ETag 없는 200 은 쥐지 않는다 — 다음 물음도 조건 없이");
}

// ── R10 ─────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/text", { status: 200, etag: 'W/"t"', body: "not json" });
  eq(await api("/api/ui/text", { revalidate: true }), null, "R10 JSON 아닌 본문은 종전대로 null");
  await api("/api/ui/text", { revalidate: true });
  eq(last().inm, null, "R10 JSON 으로 못 푼 본문은 쥐지 않는다(304 로 다시 풀 수 없다)");
}

// ── R11 ─────────────────────────────────────────────────────────────────────
{
  server.set("/api/ui/odd", { force304: true, etag: null });
  await assert.rejects(() => api("/api/ui/odd", { revalidate: true }), (e) => e.status === 304);
  eq(last().inm, null, "R11 (쥔 것이 없어 조건 헤더 없이 물었다) — 304 를 조용히 null 로 넘기지 않는다");
}

// ── R12 경계 — 상한 24 ──────────────────────────────────────────────────────
{
  const u = (i) => `/api/ui/many-${i}`;
  for (let i = 0; i <= 24; i++) server.set(u(i), { status: 200, etag: `W/"m${i}"`, body: `{"i":${i}}` });
  //  앞 판들(위 R1~R11)이 쥔 것을 밀어내려면 24개를 새로 채운다 — 그 뒤엔 이 24개만 남는다.
  for (let i = 0; i < 24; i++) await api(u(i), { revalidate: true });
  await api(u(0), { revalidate: true });
  eq(last().inm, 'W/"m0"', "R12 24개째까지는 하나도 안 버린다(첫 주소가 아직 쥐어져 있다 — 304 로 쓴 것은 '최근' 이 된다)");
  await api(u(24), { revalidate: true });   // 25번째 — 가장 오래 안 쓴 것 하나(u1)가 밀려난다
  await api(u(2), { revalidate: true });
  eq(last().inm, 'W/"m2"', "R12 25번째가 와도 나머지는 남는다");
  await api(u(0), { revalidate: true });
  eq(last().inm, 'W/"m0"', "R12 최근에 304 로 쓴 첫 주소는 밀려나지 않았다");
  await api(u(1), { revalidate: true });
  eq(last().inm, null, "R12 가장 오래 안 쓴 주소 하나만 버려졌다");
}

console.log(`\n${pass} passed`);
