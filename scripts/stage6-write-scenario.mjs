// Stage⑥ 듀얼엔진 쓰기 동등성 시나리오 — 동일 스크립트를 두 모드로 실행해 응답을 1:1 비교한다.
//   --mode=old : 구 엔진 HTTP (호스트 :7798, DATABASE_URL=dm_scratch_old 로 띄운 server.mjs)
//   --mode=new : 신 엔진 직결 (dist core, DOMAINMAP_DATABASE_URL=dm_scratch_new)
// 출력: /tmp/stage6-golden/write-<mode>.json — 스텝별 {step, status, body} 순서 배열.
//   new 모드는 구 server.mjs 의 sendErr 규약(status = e.status ?? 500, body={error: message})을
//   재현해 must-fail 케이스(restore 400 / reassign 23505→500)까지 키 단위 비교 가능하게 한다.
//   단, new 모드에서 reassign 충돌이 '정말 raw pg(code 23505)'로 전파되는지 별도 단언(콘솔)한다.
// 시나리오(repo=productivity, actor stage6): ingest 보호/드리프트/신규 → confirm → edit(human/agent 403)
// → propose+confirm → merge(fold) → deprecate/no-op/undeprecate → restore must-fail → mapping
// confirm/reject/reassign + 충돌 must-fail → debt 상태 3연.
// 쓰기는 전부 scratch DB 에만 — 라이브 무영향.
import { writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";

const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "").slice(7);
if (mode !== "old" && mode !== "new") { console.error("--mode=old|new 필수"); process.exit(2); }
const OLD_BASE = process.env.STAGE6_OLD_BASE ?? "http://127.0.0.1:7798";
const REPO = "productivity";
const ACTOR_ID = "stage6";

const fixture = JSON.parse(readFileSync("/tmp/stage6-golden/fixture-domain18.json", "utf8"));

const results = [];
const record = (step, status, body) => { results.push({ step, status, body }); };

// ── 엔진 어댑터: call(step, kind, args...) — old=HTTP, new=직결(+sendErr 엔벨로프 재현) ──
let core = null;
if (mode === "new") {
  core = {
    queries: await import("../dist/domainmap/core/queries.js"),
    changelog: await import("../dist/domainmap/core/changelog.js"),
    domains: await import("../dist/domainmap/core/domains.js"),
    mappings: await import("../dist/domainmap/core/mappings.js"),
    debts: await import("../dist/domainmap/core/debts.js"),
    reconcile: await import("../dist/domainmap/core/reconcile.js"),
    db: await import("../dist/domainmap/db.js"),
  };
}

async function httpJson(method, path, body, headers = {}) {
  const res = await fetch(`${OLD_BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = { raw: text.slice(0, 200) }; }
  return { status: res.status, body: json };
}

// new 모드: core fn 호출을 구 server.mjs 응답 엔벨로프로 변환.
async function coreCall(fn, { expectPgCode } = {}) {
  try {
    const body = await fn();
    return { status: 200, body: JSON.parse(JSON.stringify(body)) };
  } catch (e) {
    if (expectPgCode) {
      assert.strictEqual(e?.code, expectPgCode, `raw pg 에러(code ${expectPgCode}) 전파 단언 실패 — 받음: status=${e?.status} code=${e?.code} msg=${e?.message}`);
      console.log(`ASSERT OK: raw pg code ${expectPgCode} 전파 (코어 미캐치)`);
    }
    return { status: e?.status ?? 500, body: { error: e?.message ?? String(e) } };
  }
}

const human = { type: "human", id: ACTOR_ID };
const agent = { type: "agent", id: ACTOR_ID };

// 읽기(아이디 발견용 — 결과 비교 대상 아님, 단 발견된 id 는 스텝 출력에 자연 포함되어 모드 간 일치 검증됨)
async function readDomains() {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/domains`)).body;
  return JSON.parse(JSON.stringify(await core.queries.listDomainsApi(REPO)));
}
async function readDomainDetail(id) {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/domain/${id}`)).body;
  return JSON.parse(JSON.stringify(await core.queries.domainDetail(REPO, id)));
}
async function readHistory(limit) {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/history?limit=${limit}`)).body;
  return JSON.parse(JSON.stringify(await core.changelog.history(REPO, limit)));
}
async function readDebts() {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/debts`)).body;
  return JSON.parse(JSON.stringify(await core.queries.listDebts(REPO)));
}
async function domainConfirm(id) {
  if (mode === "old") return httpJson("POST", `/api/domain/${id}/confirm`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.domains.confirmDomain(id, human)); // confirmEntity(dead dispatch) 제거 — 동일 shape
}
async function domainEdit(id, patch, asAgent = false) {
  if (mode === "old") {
    return httpJson("PATCH", `/api/domain/${id}`, patch,
      { "x-actor": ACTOR_ID, ...(asAgent ? { "x-actor-type": "agent" } : {}) });
  }
  return coreCall(() => core.domains.editDomainById(id, patch, asAgent ? agent : human));
}
async function proposeDomain(fields) {
  if (mode === "old") return httpJson("POST", `/api/repo/${REPO}/domain/propose`, fields, { "x-actor": ACTOR_ID });
  return coreCall(() => core.domains.proposeDomain(REPO, fields, human));
}
async function mergeDomains(from_id, into_id) {
  if (mode === "old") return httpJson("POST", "/api/domain/merge", { from_id, into_id }, { "x-actor": ACTOR_ID });
  return coreCall(() => core.domains.mergeDomains(from_id, into_id, human));
}
async function deprecate(id, undo = false) {
  if (mode === "old") return httpJson("POST", `/api/domain/${id}/${undo ? "undeprecate" : "deprecate"}`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.domains.setDomainState(id, undo ? "active" : "deprecated", human));
}
async function restoreChange(changeId) {
  if (mode === "old") return httpJson("POST", `/api/restore/${changeId}`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.changelog.restore(changeId, human));
}
async function mappingConfirm(id) {
  if (mode === "old") return httpJson("POST", `/api/mapping/${id}/confirm`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.mappings.confirmMapping(id, human));
}
async function mappingReject(id) {
  if (mode === "old") return httpJson("POST", `/api/mapping/${id}/reject`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.mappings.rejectMapping(id, human));
}
async function mappingReassign(id, domain_id, expectCollision = false) {
  if (mode === "old") return httpJson("PATCH", `/api/mapping/${id}`, { domain_id }, { "x-actor": ACTOR_ID });
  return coreCall(() => core.mappings.reassignMapping(id, domain_id, human),
    expectCollision ? { expectPgCode: "23505" } : {});
}
async function debtStatus(id, status) {
  if (mode === "old") return httpJson("PATCH", `/api/debt/${id}`, { status }, { "x-actor": ACTOR_ID });
  return coreCall(() => core.debts.setDebtStatus(id, status, human));
}
async function ingest(payload) {
  if (mode === "old") {
    // server.mjs 는 ingest 라우트가 없다 — 구 엔진의 정식 ingest 진입점인 store.mjs CLI 를
    // scratch_old DB(env STAGE6_OLD_DB — 값 비출력)로 child process 실행(시퀀스 정렬을 위해
    // 시나리오의 정확히 같은 지점에서). 동일 store-core.ingest 코드 경로.
    const dmDir = process.env.STAGE6_OLD_DIR ?? "/Users/lively/.openclaw/workspace/productivity/domain-map";
    const out = execFileSync("node", ["store.mjs", "ingest"], {
      cwd: dmDir,
      input: JSON.stringify(payload),
      env: { ...process.env, DATABASE_URL: process.env.STAGE6_OLD_DB, SYNC_BLOCKED_REPOS: "lively" },
      encoding: "utf8",
    });
    return { status: 200, body: JSON.parse(out) };
  }
  return coreCall(() => core.reconcile.ingest(payload));
}

// ── ingest payloads (양 모드 동일 — old 모드는 셸이 store.mjs ingest 로 선실행하고 그 출력을 주입) ──
export const INGEST_A = {
  repo: { name: REPO, root_path: "/target", detected_stack: null },
  run: { runbook: "stage6-write-equivalence", actor_type: "agent", actor_id: ACTOR_ID },
  domains: [
    { key: fixture.key, name: fixture.name, description: fixture.description, cross_cutting: fixture.cross_cutting }, // (i) 보호: confirmed 동일값 → unchanged
    { key: "stage6-a", name: "스테이지6 A", description: "쓰기 동등성 시나리오용 A" },
    { key: "stage6-b", name: "스테이지6 B", description: "쓰기 동등성 시나리오용 B" },
  ],
  code_units: [
    { kind: "module", path: "stage6/alpha", label: "stage6 alpha" },
    { kind: "module", path: "stage6/beta", label: "stage6 beta" },
  ],
  mappings: [
    { target_kind: "code_unit", target: "stage6/alpha", domain_key: "stage6-a", confidence: 0.9 },
    { target_kind: "code_unit", target: "stage6/alpha", domain_key: "stage6-b", confidence: 0.8 }, // merge-fold 준비(동일 타깃 양쪽)
    { target_kind: "code_unit", target: "stage6/beta", domain_key: "stage6-a", confidence: 0.7 },
  ],
  debts: [
    { kind: "scenario", title: "stage6 동등성 검증용 debt", detail: "stage6", cited_refs: ["stage6/alpha"] },
  ],
};
export const INGEST_B = {
  repo: { name: REPO, root_path: "/target", detected_stack: null },
  run: { runbook: "stage6-write-equivalence", actor_type: "agent", actor_id: ACTOR_ID },
  domains: [
    { key: fixture.key, name: "드리프트 유발 이름", description: fixture.description, cross_cutting: fixture.cross_cutting }, // (ii) drift: 값 보존돼야 함
  ],
};

// ════════ 시나리오 본문 ════════
// step 0 — 기존 proposed 도메인을 human confirm (보호/드리프트 케이스의 전제).
{
  const r = await domainConfirm(fixture.id);
  record("0:confirm-existing-domain", r.status, r.body);
}

// step 1 — ingest A(보호+신규) / B(드리프트). 양 모드 같은 지점에서 실행(시퀀스 정렬).
{
  const a = await ingest(INGEST_A);
  record("1a:ingest-A(tally)", a.status, a.body);
  const b = await ingest(INGEST_B);
  record("1b:ingest-B(drift tally)", b.status, b.body);
}
// 드리프트 후 값 보존 검증(읽기): confirmed 도메인 name 이 원본 그대로인지.
{
  const ds = await readDomains();
  const d = ds.find((x) => x.key === fixture.key);
  record("1c:drift-kept-human-value", 200, { key: d.key, name: d.name, status: d.status });
  assert.strictEqual(d.name, fixture.name, "drift 가 human 값을 덮어씀!");
}

// 도메인 id 발견 (이후 스텝 공통)
const domainsNow = await readDomains();
const idOf = (key) => { const d = domainsNow.find((x) => x.key === key); assert.ok(d, `도메인 ${key} 없음`); return d.id; };
const idA = idOf("stage6-a"), idB = idOf("stage6-b");

// step 2 — domain confirm(stage6-a)
{
  const r = await domainConfirm(idA);
  record("2:domain-confirm-a", r.status, r.body);
}

// step 3 — human edit(name 변경, auto-confirm) → agent edit 시도(403)
{
  const r1 = await domainEdit(idA, { name: "스테이지6 A (개명)" });
  record("3a:domain-edit-human", r1.status, r1.body);
  const r2 = await domainEdit(idA, { name: "에이전트 불가" }, true);
  record("3b:domain-edit-agent-403", r2.status, r2.body);
}

// step 4 — propose_domain(stage6-c, evidence) → note 형식 확인 → confirm
let idC;
{
  const r = await proposeDomain({ key: "stage6-c", name: "스테이지6 C", description: "제안 흐름", evidence: "동등성 검증을 위한 근거 텍스트" });
  record("4a:propose-domain-c", r.status, r.body);
  idC = r.body.id;
  const h = await readHistory(5);
  const ent = h.find((x) => x.op === "insert" && x.entity_type === "domain" && x.entity_id === idC);
  record("4b:propose-note-format", 200, { note: ent?.note });
  assert.ok(ent?.note?.startsWith("propose (evidence): "), "propose note 형식 불일치");
  const c = await domainConfirm(idC);
  record("4c:domain-confirm-c", c.status, c.body);
}

// step 5 — merge stage6-b → stage6-a (fold 1 + move 집계)
{
  const r = await mergeDomains(idB, idA);
  record("5:merge-b-into-a", r.status, r.body);
}

// step 6 — deprecate → 재-deprecate(no-op, change_id 무) → undeprecate
{
  const r1 = await deprecate(idC);
  record("6a:deprecate-c", r1.status, r1.body);
  const r2 = await deprecate(idC);
  record("6b:deprecate-c-noop", r2.status, r2.body);
  assert.ok(!("change_id" in (r2.body ?? {})), "no-op 응답에 change_id 가 있음(별도 shape 파손)");
  const r3 = await deprecate(idC, true);
  record("6c:undeprecate-c", r3.status, r3.body);
}

// step 7 — must-fail #1: 매핑이 달린 도메인(stage6-a)의 insert change 를 restore → 400 동일 문구
{
  const h = await readHistory(500);
  const ins = h.find((x) => x.op === "insert" && x.entity_type === "domain" && x.entity_id === idA);
  assert.ok(ins, "stage6-a insert change 못 찾음");
  const r = await restoreChange(ins.id);
  record("7:restore-dependent-rows-400", r.status, r.body);
}

// step 8 — mapping confirm/reject/reassign + 충돌 must-fail
{
  const det = await readDomainDetail(idA);
  const cu = (p) => det.code_units.find((x) => x.path === p);
  const mAlphaA = cu("stage6/alpha")?.mapping?.id;
  const mBetaA = cu("stage6/beta")?.mapping?.id;
  assert.ok(mAlphaA && mBetaA, "stage6 매핑 id 발견 실패");
  const r1 = await mappingConfirm(mAlphaA);
  record("8a:mapping-confirm", r1.status, r1.body);
  const r2 = await mappingReject(mBetaA);
  record("8b:mapping-reject", r2.status, r2.body);
  const r3 = await mappingReassign(mBetaA, idC);
  record("8c:mapping-reassign", r3.status, r3.body);
  // 충돌: merge 때 fold 된 매핑(stage6/alpha → 구 stage6-b, rejected 잔류)을 stage6-a 로 reassign
  // → (alpha, stage6-a) 가 이미 존재(8a 에서 confirm) → UNIQUE 충돌.
  const detB = mode === "old"
    ? (await httpJson("GET", `/api/repo/${REPO}/domain/${idB}`)).body
    : JSON.parse(JSON.stringify(await core.queries.domainDetail(REPO, idB)));
  const folded = detB.code_units.find((x) => x.path === "stage6/alpha")?.mapping?.id;
  assert.ok(folded, "fold 매핑 발견 실패");
  const r4 = await mappingReassign(folded, idA, true);
  record("8d:mapping-reassign-collision", r4.status, r4.body);
}

// step 9 — debt open→ack→resolved
{
  const debts = await readDebts();
  const d = debts.find((x) => x.title === "stage6 동등성 검증용 debt");
  assert.ok(d, "stage6 debt 못 찾음");
  for (const st of ["ack", "resolved"]) {
    const r = await debtStatus(d.id, st);
    record(`9:debt-${st}`, r.status, r.body);
  }
}

writeFileSync(`/tmp/stage6-golden/write-${mode}.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`scenario done (${mode}) — ${results.length} steps recorded`);
if (mode === "new") await core.db.endPool();
