// REST ↔ MCP 파리티 테스트 (Stage① — 신규 dep 0, dist 빌드 import).
// co-exposed capability 전수에 같은 입력을 양 어댑터로 호출해 파싱된 페이로드를 deep-equal 한다.
// 실행: npm run parity  (= build 후 node --env-file-if-exists=.env scripts/parity-check.mjs)
// 제약: 라이브 items DB + domainmap 필요(시작 시 fail-fast 헬스체크). 전부 read-only —
//       curate 는 검증에러 경로만(쓰기·audit 행 0 보장). :8080 라이브 프로세스 비접촉(ephemeral 포트 —
//       listen(0) 후 OS 할당 포트 사용: 고정 포트 충돌/외부 서버 오검증 클래스 제거.
//       src/index.ts 는 import 하지 않음). 시크릿(토큰 값)은 절대 stdout 에 출력하지 않는다.
import assert from "node:assert";
import express from "express";
import { BearerVerifier } from "../dist/auth/bearer.js";
import { registerWebUi } from "../dist/web.js";
import { buildServer } from "../dist/server.js";
import { itemsPool } from "../dist/items/store.js";
import { registry } from "../dist/capabilities/index.js"; // fallback 모드용(직접 핸들러 호출)
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";

const HOST = "127.0.0.1";
const REPO = "productivity"; // repo 명시 — DOMAINMAP_DEFAULT_REPO 비의존(결정적)

// ── 토큰 선택: AUTH_TOKENS_JSON 에서 scopes ⊇ {items, context} 인 첫 항목(값 비출력) ──
function pickToken() {
  const raw = process.env.AUTH_TOKENS_JSON;
  if (!raw) fail("AUTH_TOKENS_JSON 미설정 — .env 확인");
  let table;
  try { table = JSON.parse(raw); } catch { fail("AUTH_TOKENS_JSON 파싱 실패"); }
  for (const [token, user] of Object.entries(table)) {
    const scopes = user?.scopes ?? [];
    if (scopes.includes("items") && scopes.includes("context")) return { token, user };
  }
  fail("items+context 스코프 토큰이 AUTH_TOKENS_JSON 에 없음");
}
function fail(msg) { console.error(`FATAL: ${msg}`); process.exit(2); }

const { token, user } = pickToken();

// ── 사전 헬스체크(fail-fast): 어느 한쪽이 죽으면 양측이 '동일하게' 실패해 파리티가 무의미 ──
// Stage⑥: domainmap 엔진 직결 — 구 :7700 fetch 대신 DOMAINMAP_DATABASE_URL 로 SELECT 1.
if (!process.env.DOMAINMAP_DATABASE_URL) fail("DOMAINMAP_DATABASE_URL 미설정 — .env 확인");
try {
  const { dmPool } = await import("../dist/domainmap/db.js");
  await dmPool().query("SELECT 1");
} catch (e) { fail(`domainmap DB 연결 실패 — ${e.message}`); }
try { await itemsPool.query("SELECT 1"); } catch (e) { fail(`items DB 연결 실패 — ${e.message}`); }

// 결정적 대상 아이템: 최소 id + 소형 본문(full 변형용).
const firstId = Number((await itemsPool.query("SELECT id FROM item ORDER BY id LIMIT 1")).rows[0]?.id);
if (!Number.isFinite(firstId)) fail("items DB 에 아이템이 없음");
const smallRow = (await itemsPool.query(
  "SELECT id FROM item WHERE length(body) BETWEEN 1 AND 2000 ORDER BY id LIMIT 1")).rows[0];
const smallId = Number(smallRow?.id ?? firstId);
// rejected 매핑 보유 아이템(있으면) — includeRejected 변형이 실데이터로 의미 있게 갈리는 대상.
const rejRow = (await itemsPool.query(
  `SELECT item_id FROM item_domain WHERE state='rejected'
   UNION SELECT item_id FROM item_project WHERE state='rejected' ORDER BY item_id LIMIT 1`)).rows[0];
const rejId = Number(rejRow?.item_id ?? firstId);

// ── REST 측: express + registerWebUi (ephemeral 포트 — listen(0), OS 가 빈 포트 할당) ──
const app = express();
app.use(express.json({ limit: "1mb" }));
const verifier = new BearerVerifier();
registerWebUi(app, verifier);
const httpServer = await new Promise((resolve) => {
  const s = app.listen(0, HOST, () => resolve(s));
});
const PORT = httpServer.address().port;

async function rest(path, opts = {}) {
  const res = await fetch(`http://${HOST}:${PORT}${path}`, {
    ...opts,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(opts.headers ?? {}) },
  });
  let json = null;
  try { json = await res.json(); } catch { /* 빈 바디 */ }
  return { status: res.status, json };
}

// ── MCP 측: buildServer + InMemoryTransport. SDK Client 는 authInfo 를 안 보내므로
//    ct.send 몽키패치로 모든 메시지에 authInfo 주입(REST 와 동일 principal). 1.29.0 검증.
//    패치가 SDK 업그레이드로 깨지면 PARITY_DIRECT=1 로 레지스트리 핸들러 직접 호출 fallback. ──
const DIRECT = process.env.PARITY_DIRECT === "1";
let client = null;
const authInfo = {
  token: "parity", // 실토큰 비전달(전송 경로 최소화) — 검증은 extra(user)로 이뤄짐
  clientId: user.userId,
  scopes: user.scopes,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  extra: user,
};
if (!DIRECT) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const origSend = ct.send.bind(ct);
  ct.send = (msg, opts) => origSend(msg, { ...opts, authInfo });
  const mcpServer = buildServer();
  await mcpServer.connect(st);
  client = new Client({ name: "parity-check", version: "0.0.1" });
  await client.connect(ct);
}

// mcp(name, args) → { ok, payload?, errText? } — isError 면 errText.
async function mcp(name, args = {}) {
  if (DIRECT) {
    const cap = registry.get(name);
    if (!cap || !cap.expose.mcp) return { ok: false, errText: `capability ${name} 비노출` };
    try {
      return { ok: true, payload: JSON.parse(JSON.stringify(await cap.handler(args, user, { source: "mcp" }))) };
    } catch (e) { return { ok: false, errText: e.message }; }
  }
  const r = await client.callTool({ name, arguments: args });
  const text = r.content?.[0]?.text ?? "";
  if (r.isError) return { ok: false, errText: text };
  return { ok: true, payload: JSON.parse(text) };
}

// ── 케이스 러너 ──
let passCount = 0;
const failures = [];
function report(name, fn) {
  return fn().then(
    () => { passCount++; console.log(`PASS ${name}`); },
    (e) => { failures.push(name); console.error(`FAIL ${name}\n  ${String(e.message).split("\n").slice(0, 14).join("\n  ")}`); },
  );
}
async function expectEqual(name, mcpArgsCall, restPath) {
  await report(name, async () => {
    const [m, r] = await Promise.all([mcp(...mcpArgsCall), rest(restPath)]);
    assert.ok(m.ok, `MCP 에러: ${m.errText}`);
    assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
    assert.deepStrictEqual(m.payload, r.json);
  });
}

// ════════ co-exposed deep-equal 커버리지 ════════
await expectEqual("repo_list ↔ GET /api/ui/repos", ["repo_list", {}], "/api/ui/repos");

await expectEqual("search_items{repo} ↔ /api/ui/items?repo",
  ["search_items", { repo: REPO, limit: 5 }], `/api/ui/items?repo=${REPO}&limit=5`);
await expectEqual("search_items{query} ↔ /api/ui/items?q",
  ["search_items", { query: "피벗", limit: 5 }], `/api/ui/items?q=${encodeURIComponent("피벗")}&limit=5`);
await expectEqual("search_items{domainKey+repo} ↔ /api/ui/items?domainKey",
  ["search_items", { domainKey: "domain-cartography", repo: REPO, limit: 5 }],
  `/api/ui/items?domainKey=domain-cartography&repo=${REPO}&limit=5`);

// includeRejected 변형 — REST 의 '1' 문자열→boolean 매핑이 정확히 어댑터 경계 코드(파리티의 핵심 대상).
await expectEqual("search_items{repo,includeRejected} ↔ /api/ui/items?repo&includeRejected=1",
  ["search_items", { repo: REPO, limit: 5, includeRejected: true }],
  `/api/ui/items?repo=${REPO}&limit=5&includeRejected=1`);

await expectEqual(`get_item{id:${firstId},thread} ↔ /api/ui/items/${firstId}`,
  ["get_item", { id: firstId, thread: true }], `/api/ui/items/${firstId}`);
await expectEqual(`get_item{id:${smallId},full} ↔ /api/ui/items/${smallId}?full=1`,
  ["get_item", { id: smallId, thread: true, full: true }], `/api/ui/items/${smallId}?full=1`);
await expectEqual(`get_item{id:${rejId},includeRejected} ↔ /api/ui/items/${rejId}?includeRejected=1`,
  ["get_item", { id: rejId, thread: true, includeRejected: true }], `/api/ui/items/${rejId}?includeRejected=1`);
// MCP 전용 토큰 다이어트 경로 — thread:false 면 페이로드에 thread 키 자체가 없어야 한다.
await report("smoke: get_item{thread:false} 는 thread 키 생략 (MCP)", async () => {
  const m = await mcp("get_item", { id: firstId, thread: false });
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
  assert.ok(!("thread" in m.payload), "thread:false 인데 thread 키가 존재");
});

await expectEqual("list_unmapped ↔ /api/ui/inbox",
  ["list_unmapped", { missing: "either", repo: REPO, limit: 5 }],
  `/api/ui/inbox?missing=either&repo=${REPO}&limit=5`);

await expectEqual("mapping_candidates ↔ /api/ui/candidates",
  ["mapping_candidates", { repo: REPO }], `/api/ui/candidates?repo=${REPO}`);

// context_overview: items 필드 ≡ /api/ui/stats(sanctioned subset), 나머지 ≡ domainmap overview proxy.
await report("context_overview.items ≡ GET /api/ui/stats + 나머지 ≡ domainmap overview", async () => {
  const m = await mcp("context_overview", { repo: REPO });
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
  const stats = await rest("/api/ui/stats");
  assert.strictEqual(stats.status, 200);
  assert.deepStrictEqual(m.payload.items, stats.json);
  const ov = await rest(`/api/ui/domainmap/${REPO}/overview`);
  assert.strictEqual(ov.status, 200);
  const { items: _items, ...restOfPayload } = m.payload;
  assert.deepStrictEqual(restOfPayload, ov.json);
});

// 사실상 co-exposed 데이터(domainmap passthrough) — 동일성 확인.
await expectEqual("domain_list ≡ domainmap proxy /domains",
  ["domain_list", { repo: REPO }], `/api/ui/domainmap/${REPO}/domains`);
await expectEqual("project_list ≡ domainmap proxy /projects",
  ["project_list", { repo: REPO }], `/api/ui/domainmap/${REPO}/projects`);

// ════════ 동일 페이로드 REST 짝 없음 → 스모크(에러 없이 JSON)만 — deep-equal 제외 ════════
await report("smoke: debt_list (MCP)", async () => {
  const m = await mcp("debt_list", { repo: REPO });
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
});
await report("smoke: domain_get (MCP)", async () => {
  const domains = await mcp("domain_list", { repo: REPO });
  assert.ok(domains.ok && Array.isArray(domains.payload) && domains.payload.length, "도메인 0건 — domain_get 스모크 불가");
  const m = await mcp("domain_get", { id: Number(domains.payload[0].id), repo: REPO });
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
});
await report("smoke: GET /api/ui/me (REST)", async () => {
  const r = await rest("/api/ui/me");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.userId, user.userId);
});
await report("smoke: GET /api/ui/mapping-counts (REST)", async () => {
  const r = await rest(`/api/ui/mapping-counts?repo=${REPO}`);
  assert.strictEqual(r.status, 200);
  assert.ok(Array.isArray(r.json.domains) && Array.isArray(r.json.projects));
});
await report("smoke: GET /api/ui/domainmap/:repo/entities (REST, kind 화이트리스트)", async () => {
  const r = await rest(`/api/ui/domainmap/${REPO}/entities`);
  assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json), "entities 응답이 배열이 아님");
});

// ════════ curate — VALIDATION-ERROR 경로만(쓰기·audit 행 0: 전부 INSERT 이전 throw / 0행 매치) ════════
async function expectBothError(name, mcpArgs, restPath, restBody, restStatus, substr) {
  await report(name, async () => {
    const m = await mcp("curate_item_mapping", mcpArgs);
    assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
    assert.ok(m.errText.includes(substr), `MCP 메시지에 '${substr}' 없음: ${m.errText}`);
    const r = await rest(restPath, { method: "POST", body: JSON.stringify(restBody) });
    assert.strictEqual(r.status, restStatus, `REST ${r.status}: ${JSON.stringify(r.json)}`);
    assert.ok((r.json?.error ?? "").includes(substr), `REST 메시지에 '${substr}' 없음: ${r.json?.error}`);
    // 에러 텍스트 자체도 파리티 — 같은 store throw 가 양 어댑터에서 같은 메시지로 보여야 한다.
    assert.strictEqual(m.errText, r.json?.error ?? "", "REST/MCP 에러 메시지 불일치");
  });
}

// (a) vocab 불일치 — validateDomainKey 가 INSERT 이전에 throw(행·audit 무생성).
await expectBothError("curate(a) vocab 불일치 propose",
  { action: "propose", kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  "/api/ui/propose", { kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  400, "domain_key __parity_nope__ 검증 실패");

// (b) 존재하지 않는 itemId — item 존재 검증이 INSERT 이전에 throw.
await expectBothError("curate(b) 없는 item propose",
  { action: "propose", kind: "domain", itemId: 999999999, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  "/api/ui/propose", { kind: "domain", itemId: 999999999, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  404, "item 999999999 없음");

// (c) 존재하지 않는 매핑 reject — 행 부재 throw(UPDATE 매치 0, 무쓰기).
await expectBothError("curate(c) 없는 매핑 reject",
  { action: "reject", kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO },
  "/api/ui/reject", { kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO },
  404, "매핑 없음");

// (d) MCP 전용: propose evidence 누락(mappedBy 기본 llm) — REST 는 mappedBy='manual' 서버 강제라 비대상.
await report("curate(d) MCP llm evidence 필수", async () => {
  const m = await mcp("curate_item_mapping", { action: "propose", kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO });
  assert.strictEqual(m.ok, false, "MCP 가 에러여야 함");
  assert.ok(m.errText.includes("llm 매핑은 근거(evidence) 필수"), `메시지 불일치: ${m.errText}`);
});

// (e) confirm vocab 불일치 — validateDomainKey 가 INSERT 이전에 throw(무쓰기). confirm 와이어링/alias 커버.
await expectBothError("curate(e) vocab 불일치 confirm",
  { action: "confirm", kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO },
  "/api/ui/confirm", { kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO },
  400, "domain_key __parity_nope__ 검증 실패");

// (f) MCP 전용 가드레일: propose 의 mappedBy='manual'/'rule' 자칭 차단(핸들러 throw — store 도달 전, 무쓰기).
await report("curate(f) MCP propose mappedBy 자칭 차단", async () => {
  for (const by of ["manual", "rule"]) {
    const m = await mcp("curate_item_mapping",
      { action: "propose", kind: "domain", itemId: firstId, key: "__parity_nope__", repo: REPO, evidence: "parity", mappedBy: by });
    assert.strictEqual(m.ok, false, `mappedBy=${by} 가 에러여야 함`);
    assert.ok(m.errText.includes("MCP propose 는 mappedBy='llm' 만 허용"), `메시지 불일치(${by}): ${m.errText}`);
  }
});

// ════════ Stage② domainmap 큐레이션(REST 전용, expose.mcp=false) ════════
// 읽기 3종은 기존 MCP 읽기 op 와 같은 dmGet 경로 — deep-equal 가능한 짝은 deep-equal,
// 쓰기 9종은 전부 검증에러 경로만(parse 에서 throw — domainmap 도달 0, 쓰기·audit 행 0).

// 읽기: dm_debt_list REST ≡ MCP debt_list(같은 dmGet /debts), dm_domain_detail REST ≡ MCP domain_get.
await report("dm_debt_list REST ≡ debt_list (MCP)", async () => {
  const [m, r] = await Promise.all([mcp("debt_list", { repo: REPO }), rest(`/api/ui/domainmap/debts?repo=${REPO}`)]);
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
  assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.deepStrictEqual(m.payload, r.json);
});
await report("dm_domain_detail REST ≡ domain_get (MCP)", async () => {
  const domains = await mcp("domain_list", { repo: REPO });
  assert.ok(domains.ok && domains.payload.length, "도메인 0건 — detail 파리티 불가");
  const id = Number(domains.payload[0].id);
  const [m, r] = await Promise.all([mcp("domain_get", { id, repo: REPO }), rest(`/api/ui/domainmap/${REPO}/domain/${id}`)]);
  assert.ok(m.ok, `MCP 에러: ${m.errText}`);
  assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.deepStrictEqual(m.payload, r.json);
});
await report("smoke: GET /api/ui/domainmap/history (REST, limit 기본 80)", async () => {
  const r = await rest(`/api/ui/domainmap/history?repo=${REPO}`);
  assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json) && r.json.length <= 80, "history 응답이 배열(≤80)이 아님");
  if (r.json.length) {
    for (const k of ["id", "at", "op", "entity_type", "entity_id", "actor_type"]) assert.ok(k in r.json[0], `history 행에 ${k} 없음`);
  }
});

// 검증에러 경로(쓰기 0 보장 — 전부 parse 단계 throw).
async function expectRestError(name, path, opts, status, substr) {
  await report(name, async () => {
    const r = await rest(path, opts);
    assert.strictEqual(r.status, status, `REST ${r.status}: ${JSON.stringify(r.json)}`);
    assert.ok((r.json?.error ?? "").includes(substr), `메시지에 '${substr}' 없음: ${r.json?.error}`);
  });
}
await expectRestError("dm(a) debts repo 누락", "/api/ui/domainmap/debts", {}, 400, "repo 필수");
await expectRestError("dm(b) history repo 형식", `/api/ui/domainmap/history?repo=${encodeURIComponent("bad repo!")}`, {}, 400, "repo 형식이 잘못되었습니다");
await expectRestError("dm(c) domain confirm id 비정수", "/api/ui/domainmap/domain/abc/confirm",
  { method: "POST", body: "{}" }, 400, "양의 정수");
await expectRestError("dm(d) debt status enum 밖", "/api/ui/domainmap/debt/1/status",
  { method: "POST", body: JSON.stringify({ status: "bogus" }) }, 400, "status 는 open|ack|resolved|dismissed 만 허용됩니다");
await expectRestError("dm(e) merge 자기 자신", "/api/ui/domainmap/domain/merge",
  { method: "POST", body: JSON.stringify({ fromId: 1, intoId: 1 }) }, 400, "같은 영역으로는 합칠 수 없습니다");
await expectRestError("dm(f) edit 빈 패치", "/api/ui/domainmap/domain/1/edit",
  { method: "POST", body: "{}" }, 400, "수정할 필드가 필수입니다");
await expectRestError("dm(g) mapping move domainId 누락", "/api/ui/domainmap/mapping/1/move",
  { method: "POST", body: "{}" }, 400, "양의 정수");

// ⑤ 도메인 authoring(propose_domain·domain_deprecate) — 검증에러-only(전부 zod/parse 단계
// throw → dmPost 도달 0, domainmap 쓰기·audit 행 0 — productivity 베이스라인 불변 불변식 유지).
// lively 403·실제 propose 는 e2e-sandbox e2e 에서 검증(파리티 무쓰기 컨벤션 보존).
await expectRestError("dm(i) propose repo 형식", "/api/ui/domainmap/domain/propose",
  { method: "POST", body: JSON.stringify({ repo: "bad repo!", key: "k1", name: "X", evidence: "x" }) },
  400, "repo 형식이 잘못되었습니다");
await expectRestError("dm(j) propose evidence 누락", "/api/ui/domainmap/domain/propose",
  { method: "POST", body: JSON.stringify({ repo: REPO, key: "k1", name: "X" }) },
  400, "evidence 필수");
await expectRestError("dm(k) propose key 형식", "/api/ui/domainmap/domain/propose",
  { method: "POST", body: JSON.stringify({ repo: REPO, key: "BAD KEY", name: "X", evidence: "x" }) },
  400, "형식");
await expectRestError("dm(l) deprecate id 비정수", "/api/ui/domainmap/domain/abc/deprecate",
  { method: "POST", body: "{}" }, 400, "양의 정수");
// MCP 측: zod 가 evidence 누락을 isError 로 거부(handler 미도달 — 무쓰기).
await report("dm(m) MCP propose_domain evidence 누락 isError", async () => {
  const m = await mcp("propose_domain", { repo: REPO, key: "k1", name: "X" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
});

// 토큰 없는 쓰기 = 401(쓰기 경로가 인증 뒤에 있는지).
await report("dm(h) 무토큰 쓰기 401", async () => {
  const res = await fetch(`http://${HOST}:${PORT}/api/ui/domainmap/mapping/1/confirm`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.strictEqual(res.status, 401, `무토큰 쓰기가 ${res.status} — 401 이어야 함`);
  await res.text().catch(() => "");
});

// ════════ tools/list — 최종 MCP 표면 보고 ════════
// 표면 동결: 아래 22개 전체 이름을 deepStrictEqual 로 고정 — 몰래 추가/누락/리네임 전부 FAIL.
// 단일 출처: src/capabilities/index.ts 의 freeze 주석('MCP 22툴') + src/tools/* 등록 배열.
// 표면을 의도적으로 바꿀 때는 freeze 주석과 이 배열을 같은 커밋에서 함께 갱신한다.
const EXPECTED_MCP_SURFACE = [
  "context_overview", "curate_item_mapping", "db_query", "db_schema", "db_sources", "debt_list",
  "domain_deprecate", "domain_get", "domain_list", "get_item", "list_unmapped",
  "mapping_candidates", "memory_save", "memory_search", "pm_task_archive", "pm_task_assign", "pm_task_comment",
  "pm_task_create", "pm_task_link", "pm_task_update_status", "project_list",
  "propose_domain", "repo_list", "search_items",
]; // 24 (06-16 memory_save/memory_search 추가 — 팀 공유 메모리)
if (!DIRECT) {
  await report("tools/list 표면 보고", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`  MCP tools (${names.length}): ${names.join(", ")}`);
    assert.ok(!names.includes("propose_item_domain") && !names.includes("propose_item_project"), "구 propose 툴이 남아있음");
    assert.deepStrictEqual(names, EXPECTED_MCP_SURFACE,
      "MCP 표면이 동결 목록(24)과 다름 — 의도적 변경이면 EXPECTED_MCP_SURFACE + freeze 주석(src/capabilities/index.ts) 동시 갱신");
  });
}

// ── 종료(명시 exit — itemsPool 이 이벤트루프를 잡고 있음) ──
httpServer.close();
if (client) await client.close().catch(() => {});
const code = failures.length ? 1 : 0;
console.log(failures.length
  ? `\n파리티 실패 ${failures.length}건: ${failures.join(" | ")} (성공 ${passCount})`
  : `\n파리티 전부 통과 (${passCount}건)`);
process.exit(code);
