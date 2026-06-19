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

// item 폐기·ku 흡수(2026-06): search_items/get_item parity 케이스 제거(툴 표면에서 제거됨).
//  활동검색/스레드는 ctx_ls/ctx_grep/ctx_cat 이 흡수 — ctx_* 의 자체 parity 케이스가 커버한다.
//  결정적 ku 미러 name(스레드 parity 용): notion 미러 중 parent_name 보유 행(자식)·그 부모.
const ctxChildRow = (await itemsPool.query(
  "SELECT name FROM knowledge_unit WHERE source<>'authored' AND parent_name IS NOT NULL ORDER BY name LIMIT 1")).rows[0];
const ctxThreadName = ctxChildRow?.name ?? null; // 없으면 스레드 케이스 skip
// curate_item_mapping 은 ku 좌표(knowledge_unit.name) — 검증에러 parity 용 실재 observed ku name 1건.
const firstName = (await itemsPool.query(
  "SELECT name FROM knowledge_unit WHERE source<>'authored' ORDER BY name LIMIT 1")).rows[0]?.name;
if (!firstName) fail("knowledge_unit(observed)에 단위가 없음(curate parity 대상)");

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

// ── item 흡수: ctx_ls/ctx_grep 의 활동필터(system/since/source/type) ↔ REST 동치 ──
await expectEqual("ctx_ls{system} ↔ /api/ui/ctx/ls?system",
  ["ctx_ls", { system: "notion", limit: 5 }], "/api/ui/ctx/ls?system=notion&limit=5");
await expectEqual("ctx_ls{source:observed} ↔ /api/ui/ctx/ls?source",
  ["ctx_ls", { source: "observed", limit: 5 }], "/api/ui/ctx/ls?source=observed&limit=5");
await expectEqual("ctx_ls{type:doc} ↔ /api/ui/ctx/ls?type",
  ["ctx_ls", { type: "doc", limit: 5 }], "/api/ui/ctx/ls?type=doc&limit=5");
await expectEqual("ctx_grep{query,system} ↔ /api/ui/ctx/grep?query&system",
  ["ctx_grep", { query: "a", system: "clickup", limit: 5 }],
  `/api/ui/ctx/grep?query=${encodeURIComponent("a")}&system=clickup&limit=5`);

// ── item 흡수: ctx_cat thread(parent_name 재귀) ↔ REST 동치 — 미러 자식 행이 있을 때만 ──
if (ctxThreadName) {
  await expectEqual(`ctx_cat{thread} ↔ /api/ui/ctx/cat?thread=1 (${ctxThreadName})`,
    ["ctx_cat", { name: ctxThreadName, thread: true }],
    `/api/ui/ctx/cat?name=${encodeURIComponent(ctxThreadName)}&thread=1`);
  // MCP 전용 토큰 다이어트 — thread 생략(기본) 시 페이로드에 thread 키 없음.
  await report("smoke: ctx_cat{thread 생략} 은 thread 키 없음 (MCP)", async () => {
    const m = await mcp("ctx_cat", { name: ctxThreadName });
    assert.ok(m.ok, `MCP 에러: ${m.errText}`);
    assert.ok(!("thread" in m.payload), "thread 미요청인데 thread 키가 존재");
  });
}

// ── 수정이력(작성자/리비전): ctx_cat history opt-in ↔ REST 동치. history=1 시 history(배열)+history_count 포함. ──
const ctxHistName = (await itemsPool.query(
  `SELECT entity_key AS name FROM org_content_audit WHERE entity='knowledge_unit'
     AND entity_key IN (SELECT name FROM knowledge_unit) GROUP BY entity_key ORDER BY entity_key LIMIT 1`)).rows[0]?.name;
if (ctxHistName) {
  await expectEqual(`ctx_cat{history} ↔ /api/ui/ctx/cat?history=1 (${ctxHistName})`,
    ["ctx_cat", { name: ctxHistName, history: true }],
    `/api/ui/ctx/cat?name=${encodeURIComponent(ctxHistName)}&history=1`);
  // 토큰 다이어트 — history 생략(기본) 시 history/history_count 키 없음.
  await report("smoke: ctx_cat{history 생략} 은 history 키 없음 (MCP)", async () => {
    const m = await mcp("ctx_cat", { name: ctxHistName });
    assert.ok(m.ok, `MCP 에러: ${m.errText}`);
    assert.ok(!("history" in m.payload), "history 미요청인데 history 키가 존재");
  });
  // history opt-in 시 행 shape 검증(누가/언제/경로/내용 노출 — 작성자 숨기지 않음).
  await report("smoke: ctx_cat{history} 행 shape(version/op/actor/actor_kind/channel) (MCP)", async () => {
    const m = await mcp("ctx_cat", { name: ctxHistName, history: true });
    assert.ok(m.ok, `MCP 에러: ${m.errText}`);
    assert.ok(Array.isArray(m.payload.history), "history 가 배열이 아님");
    assert.ok(typeof m.payload.history_count === "number", "history_count 가 숫자가 아님");
    if (m.payload.history.length) {
      for (const k of ["version", "op", "at", "actor", "actor_kind", "channel"]) {
        assert.ok(k in m.payload.history[0], `history 행에 ${k} 없음`);
      }
      assert.ok(typeof m.payload.history[0].version === "number", "version 이 숫자가 아님(뷰 int 캐스트 확인)");
    }
  });
}

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
// P-V3-2: /api/ui/learn — ground-truth(kind_registry + data_source) 렌더 화면의 단일 출처(REST 전용, MCP 비노출).
//  V4-P2a: 본질 4종(R/K/H/W) — registry legacy 행 제거. 정의가 비어 있지 않고, data_source 시드(discord=dropped) 노출.
await report("smoke: GET /api/ui/learn (REST, ground-truth 렌더)", async () => {
  const r = await rest("/api/ui/learn");
  assert.strictEqual(r.status, 200, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok(Array.isArray(r.json.kinds) && r.json.kinds.length === 4, "kinds 4개여야 함(R/K/H/W)");
  const k = r.json.kinds[0];
  assert.ok(k.kind && k.label && "criteria" in k && "storage" in k && "delivery" in k, "kind 행에 분류기준/저장/전달 필드");
  assert.ok(r.json.kinds.every((x) => x.description && x.criteria && x.storage && x.delivery), "4 kind 정의 4필드 전부 채워짐");
  assert.ok(Array.isArray(r.json.sources) && r.json.sources.length >= 1, "data_source 시드 노출");
  assert.ok(r.json.sources.some((s) => s.system === "discord" && s.status === "dropped"), "discord=dropped 시드");
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
  { action: "propose", kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  "/api/ui/propose", { kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO, evidence: "parity" },
  400, "domain_key __parity_nope__ 검증 실패");

// (b) 존재하지 않는 ku name — knowledge_unit 존재 검증이 INSERT 이전에 throw.
await expectBothError("curate(b) 없는 ku propose",
  { action: "propose", kind: "domain", name: "__no_such_ku__", key: "__parity_nope__", repo: REPO, evidence: "parity" },
  "/api/ui/propose", { kind: "domain", name: "__no_such_ku__", key: "__parity_nope__", repo: REPO, evidence: "parity" },
  404, "knowledge_unit __no_such_ku__ 없음");

// (c) 존재하지 않는 매핑 reject — 행 부재 throw(UPDATE 매치 0, 무쓰기).
await expectBothError("curate(c) 없는 매핑 reject",
  { action: "reject", kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO },
  "/api/ui/reject", { kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO },
  404, "매핑 없음");

// (d) MCP 전용: propose evidence 누락(mappedBy 기본 llm) — REST 는 mappedBy='manual' 서버 강제라 비대상.
await report("curate(d) MCP llm evidence 필수", async () => {
  const m = await mcp("curate_item_mapping", { action: "propose", kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO });
  assert.strictEqual(m.ok, false, "MCP 가 에러여야 함");
  assert.ok(m.errText.includes("llm 매핑은 근거(evidence) 필수"), `메시지 불일치: ${m.errText}`);
});

// (e) confirm vocab 불일치 — validateDomainKey 가 INSERT 이전에 throw(무쓰기). confirm 와이어링/alias 커버.
await expectBothError("curate(e) vocab 불일치 confirm",
  { action: "confirm", kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO },
  "/api/ui/confirm", { kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO },
  400, "domain_key __parity_nope__ 검증 실패");

// (f) MCP 전용 가드레일: propose 의 mappedBy='manual'/'rule' 자칭 차단(핸들러 throw — store 도달 전, 무쓰기).
await report("curate(f) MCP propose mappedBy 자칭 차단", async () => {
  for (const by of ["manual", "rule"]) {
    const m = await mcp("curate_item_mapping",
      { action: "propose", kind: "domain", name: firstName, key: "__parity_nope__", repo: REPO, evidence: "parity", mappedBy: by });
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

// ════════ P-V3-4a 통제어휘 CRUD(domain_create·domain_rename·repo_create·repo_rename·repo_deprecate) ════════
//  전부 expose.mcp=true(MCP+REST co-exposed). 쓰기라 동일 페이로드 deep-equal 짝 없음 — 검증에러 경로만
//  (parse/zod 단계 throw → 코어 도달 0, 도메인맵 쓰기·audit 행 0: productivity 라이브 데이터 비파괴 컨벤션 유지).
await expectRestError("crud(a) repo_create 이름 형식", "/api/ui/domainmap/repo/create",
  { method: "POST", body: JSON.stringify({ name: "bad repo!" }) }, 400, "repo 형식이 잘못되었습니다");
await expectRestError("crud(b) repo_rename newName 누락", "/api/ui/domainmap/repo/rename",
  { method: "POST", body: JSON.stringify({ name: REPO }) }, 400, "repo 필수");
await expectRestError("crud(c) repo_deprecate name 누락", "/api/ui/domainmap/repo/deprecate",
  { method: "POST", body: "{}" }, 400, "repo 필수");
await expectRestError("crud(d) domain_create repo 형식", "/api/ui/domainmap/domain/create",
  { method: "POST", body: JSON.stringify({ repo: "bad repo!", key: "k1", name: "X" }) }, 400, "repo 형식이 잘못되었습니다");
await expectRestError("crud(e) domain_create key 형식", "/api/ui/domainmap/domain/create",
  { method: "POST", body: JSON.stringify({ repo: REPO, key: "BAD KEY", name: "X" }) }, 400, "슬러그");
await expectRestError("crud(f) domain_rename 빈 변경", "/api/ui/domainmap/domain/1/rename",
  { method: "POST", body: "{}" }, 400, "변경할 필드가 필수입니다");
await expectRestError("crud(g) domain_rename id 비정수", "/api/ui/domainmap/domain/abc/rename",
  { method: "POST", body: JSON.stringify({ newName: "X" }) }, 400, "양의 정수");
// MCP 측: zod 가 필수/형식 위반을 isError 로 거부(handler 미도달 — 무쓰기).
await report("crud(h) MCP domain_create key 누락 isError", async () => {
  const m = await mcp("domain_create", { repo: REPO, name: "X" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
});
// M-마 권한: repo rename/deprecate 는 agent(MCP) 금지 — 핸들러 가드 403(코어 도달 0·무쓰기).
await report("crud(i) MCP repo_rename agent 금지(403)", async () => {
  const m = await mcp("repo_rename", { name: REPO, newName: "__crud_parity_nope__" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  assert.ok(m.errText.includes("사람(웹)만 가능"), `메시지 불일치: ${m.errText}`);
});
await report("crud(j) MCP repo_deprecate agent 금지(403)", async () => {
  const m = await mcp("repo_deprecate", { name: REPO });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  assert.ok(m.errText.includes("사람(웹)만 가능"), `메시지 불일치: ${m.errText}`);
});

// ════════ hard-delete(영구삭제) — 검증에러/권한 경로만(parse·zod·agent-deny throw → 코어 도달 0·무삭제) ════════
//  실제 삭제는 비파괴 컨벤션상 e2e-sandbox 에서. 여기선 (a) parse 검증 (b) agent(MCP) 금지 403 만.
await expectRestError("del(a) domain_delete id 비정수", "/api/ui/domainmap/domain/abc/delete",
  { method: "POST", body: "{}" }, 400, "양의 정수");
await expectRestError("del(b) domain_delete force 비boolean", "/api/ui/domainmap/domain/1/delete",
  { method: "POST", body: JSON.stringify({ force: "yes" }) }, 400, "force 는 boolean");
await expectRestError("del(c) repo_delete name 누락", "/api/ui/domainmap/repo/delete",
  { method: "POST", body: "{}" }, 400, "repo 필수");
await expectRestError("del(d) repo_delete name 형식", "/api/ui/domainmap/repo/delete",
  { method: "POST", body: JSON.stringify({ name: "bad repo!" }) }, 400, "repo 형식이 잘못되었습니다");
// agent(MCP) 금지 403 — hard-delete 는 비가역이라 사람(웹) 전용(핸들러 가드, 코어 도달 0·무삭제).
await report("del(e) MCP domain_delete agent 금지(403)", async () => {
  const m = await mcp("domain_delete", { id: 1 });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  assert.ok(m.errText.includes("영구삭제는 사람(웹)만 가능"), `메시지 불일치: ${m.errText}`);
});
await report("del(f) MCP repo_delete agent 금지(403)", async () => {
  const m = await mcp("repo_delete", { name: REPO });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  assert.ok(m.errText.includes("영구삭제는 사람(웹)만 가능"), `메시지 불일치: ${m.errText}`);
});

// 토큰 없는 쓰기 = 401(쓰기 경로가 인증 뒤에 있는지).
await report("dm(h) 무토큰 쓰기 401", async () => {
  const res = await fetch(`http://${HOST}:${PORT}/api/ui/domainmap/mapping/1/confirm`,
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.strictEqual(res.status, 401, `무토큰 쓰기가 ${res.status} — 401 이어야 함`);
  await res.text().catch(() => "");
});

// ════════ ctx_*(P1b) — FS형 컨텍스트. 읽기 3종 co-exposed deep-equal(REST=MCP 동일 JSON),
//          쓰기 ctx_save 는 검증에러 경로만(note 누락 → 양 어댑터 동일 에러·무쓰기). ════════
// ls: 전 풀 메타 목록(데이터 유무 무관 동일). limit/lifecycle 변형으로 어댑터 경계 매핑 검증.
await expectEqual("ctx_ls ↔ GET /api/ui/ctx/ls", ["ctx_ls", { limit: 50 }], "/api/ui/ctx/ls?limit=50");
await expectEqual("ctx_ls{kind:R,lifecycle:active} ↔ /api/ui/ctx/ls?kind&lifecycle",
  ["ctx_ls", { kind: "R", lifecycle: "active", limit: 50 }], "/api/ui/ctx/ls?kind=R&lifecycle=active&limit=50");
// path 접두 파생(D/<domain>/) — 명시 인자 없이 path 만으로 kind/domain 동일 파생.
await expectEqual("ctx_ls{path:'K/'} ↔ /api/ui/ctx/ls?path=K/",
  ["ctx_ls", { path: "K/", limit: 50 }], `/api/ui/ctx/ls?path=${encodeURIComponent("K/")}&limit=50`);

// grep: 부분일치 스니펫(데이터 유무 무관 동일 — 0건이면 양쪽 {matches:[]}).
await expectEqual("ctx_grep ↔ GET /api/ui/ctx/grep",
  ["ctx_grep", { query: "피벗", limit: 5 }], `/api/ui/ctx/grep?query=${encodeURIComponent("피벗")}&limit=5`);
await expectEqual("ctx_grep{kind} ↔ /api/ui/ctx/grep?kind",
  ["ctx_grep", { query: "도메인", kind: "R", limit: 5 }], `/api/ui/ctx/grep?query=${encodeURIComponent("도메인")}&kind=R&limit=5`);

// cat: 없는 name → 양 어댑터 404/isError(부재 계약, get_item 정합 — REST 404, MCP isError).
await report("ctx_cat{없는 name} — 양 어댑터 404/isError", async () => {
  const m = await mcp("ctx_cat", { name: "__parity_absent__" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  const r = await rest("/api/ui/ctx/cat?name=__parity_absent__");
  assert.strictEqual(r.status, 404, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok((r.json?.error ?? "").includes("없음"), `REST 메시지에 '없음' 없음: ${r.json?.error}`);
});

// ctx_save 검증에러 — note 누락. MCP=zod isError, REST=mount.parse 400 "note 필수"(무쓰기·무 audit).
await report("ctx_save(a) note 누락 — 양 어댑터 거부(무쓰기)", async () => {
  const m = await mcp("ctx_save", { title: "no body" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  const r = await rest("/api/ui/ctx/save", { method: "POST", body: JSON.stringify({ title: "no body" }) });
  assert.strictEqual(r.status, 400, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok((r.json?.error ?? "").includes("note"), `REST 메시지에 'note' 없음: ${r.json?.error}`);
});

// ctx_save 이름충돌 — 기존 R 섹션(managed-policy)명으로 저장 시 가드 거부. MCP isError / REST 400(무쓰기·무 audit).
//  (knowledge_unit 에 managed-policy(R) 가 마이그로 존재 — initOrgSchema 가 부팅 시 보장.)
await report("ctx_save(b) 섹션명 충돌 — 양 어댑터 거부(무쓰기)", async () => {
  const m = await mcp("ctx_save", { name: "managed-policy", note: "__parity_collision__" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  const r = await rest("/api/ui/ctx/save", { method: "POST", body: JSON.stringify({ name: "managed-policy", note: "__parity_collision__" }) });
  assert.strictEqual(r.status, 400, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok((r.json?.error ?? "").includes("충돌"), `REST 메시지에 '충돌' 없음: ${r.json?.error}`);
});

// overview: kind_registry × active 집계(데이터 유무 무관 동일 — 양쪽 동일 JSON). co-exposed deep-equal(read).
await expectEqual("ctx_overview ↔ GET /api/ui/ctx/overview", ["ctx_overview", {}], "/api/ui/ctx/overview");

// ls{confidence} 변형 — REST 의 confidence 쿼리스트링 매핑이 어댑터 경계 코드(파리티 대상). 0건이어도 양쪽 동일.
await expectEqual("ctx_ls{confidence:ai} ↔ /api/ui/ctx/ls?confidence=ai",
  ["ctx_ls", { confidence: "ai", limit: 50 }], "/api/ui/ctx/ls?confidence=ai&limit=50");

// ctx_set_lifecycle 검증에러 — 없는 name → 양 어댑터 404/isError(부재 계약, 무쓰기·무 audit).
await report("ctx_set_lifecycle(a) 없는 name — 양 어댑터 404/isError(무쓰기)", async () => {
  const m = await mcp("ctx_set_lifecycle", { name: "__parity_absent__", lifecycle: "rejected" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  assert.ok(m.errText.includes("없음"), `MCP 메시지에 '없음' 없음: ${m.errText}`);
  const r = await rest("/api/ui/ctx/set-lifecycle", { method: "POST", body: JSON.stringify({ name: "__parity_absent__", lifecycle: "rejected" }) });
  assert.strictEqual(r.status, 404, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok((r.json?.error ?? "").includes("없음"), `REST 메시지에 '없음' 없음: ${r.json?.error}`);
});

// ctx_set_lifecycle 검증에러 — 잘못된 lifecycle → MCP zod isError / REST parse 400 "허용"(handler 미도달·무쓰기).
await report("ctx_set_lifecycle(b) 잘못된 lifecycle — 양 어댑터 거부(무쓰기)", async () => {
  const m = await mcp("ctx_set_lifecycle", { name: "whatever", lifecycle: "bogus" });
  assert.strictEqual(m.ok, false, `MCP 가 에러여야 함 — 받음: ${JSON.stringify(m.payload)}`);
  const r = await rest("/api/ui/ctx/set-lifecycle", { method: "POST", body: JSON.stringify({ name: "whatever", lifecycle: "bogus" }) });
  assert.strictEqual(r.status, 400, `REST ${r.status}: ${JSON.stringify(r.json)}`);
  assert.ok((r.json?.error ?? "").includes("허용"), `REST 메시지에 '허용' 없음: ${r.json?.error}`);
});

// ════════ tools/list — 최종 MCP 표면 보고 ════════
// 표면 동결: 아래 34개 전체 이름을 deepStrictEqual 로 고정 — 몰래 추가/누락/리네임 전부 FAIL.
// 단일 출처: src/capabilities/index.ts 의 freeze 주석('MCP 34툴') + src/tools/* 등록 배열.
// 표면을 의도적으로 바꿀 때는 freeze 주석과 이 배열을 같은 커밋에서 함께 갱신한다.
const EXPECTED_MCP_SURFACE = [
  "activity_list", "activity_log",
  "context_overview", "ctx_cat", "ctx_grep", "ctx_ls", "ctx_overview", "ctx_save", "ctx_set_lifecycle",
  "curate_item_mapping", "db_query", "db_schema", "db_sources", "debt_list",
  "domain_create", "domain_delete", "domain_deprecate", "domain_get", "domain_list", "domain_rename", "domain_set_should", "list_unmapped",
  "mapping_candidates", "memory_get", "memory_save", "memory_search", "pm_task_archive", "pm_task_assign", "pm_task_comment",
  "pm_task_create", "pm_task_link", "pm_task_update_status", "project_list",
  "propose_domain", "repo_create", "repo_delete", "repo_deprecate", "repo_list", "repo_rename",
]; // 39 (P4: domain_set_should 추가 38→39. P3: activity_log·activity_list 36→38. hard-delete: domain_delete·repo_delete. item 폐기 2026-06: search_items·get_item 36→34→36)
if (!DIRECT) {
  await report("tools/list 표면 보고", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`  MCP tools (${names.length}): ${names.join(", ")}`);
    assert.ok(!names.includes("propose_item_domain") && !names.includes("propose_item_project"), "구 propose 툴이 남아있음");
    assert.deepStrictEqual(names, EXPECTED_MCP_SURFACE,
      "MCP 표면이 동결 목록(39)과 다름 — 의도적 변경이면 EXPECTED_MCP_SURFACE + freeze 주석(src/capabilities/index.ts) 동시 갱신");
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
