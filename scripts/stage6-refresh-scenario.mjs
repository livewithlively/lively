// Stage⑥ 듀얼엔진 '구조 리프레시' 동등성 시나리오 — 쓰기 동등성 증명에서 빠져 있던
// core/refresh.ts(+aggregateFileChanges) 경로를 scratch DB 에서 1:1 비교한다(검수 finding 대응).
//   --mode=old : 구 엔진 HTTP (호스트 :7798, DATABASE_URL=dm_scratch_old 로 띄운 server.mjs)
//   --mode=new : 신 엔진 직결 (dist core, DOMAINMAP_DATABASE_URL=dm_scratch_new)
// 출력: /tmp/stage6-golden/refresh-<mode>.json — 스텝별 {step, status, body} 순서 배열.
// 시나리오(repo=productivity, actor stage6r):
//   0) ingest 픽스처(유닛 4 + 도메인 1 + 매핑 2) → 1) gone 매핑 confirm(orphan 케이스 전제)
//   2) refresh granularity:'file' — 리네임 클러스터(mod→box, 2표)·1표 ambiguous(keep)·신규 디렉 2·
//      기존 유닛 내 add no-op·delete no-op (aggregateFileChanges 전 분기)
//   3) refresh unit — 저신뢰 rename(score 45 → drift debt) + confirmed-매핑 삭제(orphan flag)
//   4) refresh unit — 재추가 A → revive
//   5) 읽기 기록: stage6r debts + history(저신뢰/orphan note 형식 비교)
// 쓰기는 전부 scratch DB 에만 — 라이브 무영향. write-scenario 와 같은 세션에서 이어 돌려
// 시퀀스 정렬을 유지한다(양 모드 동일 순서 필수).
import { writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import assert from "node:assert";

const mode = (process.argv.find((a) => a.startsWith("--mode=")) ?? "").slice(7);
if (mode !== "old" && mode !== "new") { console.error("--mode=old|new 필수"); process.exit(2); }
const OLD_BASE = process.env.STAGE6_OLD_BASE ?? "http://127.0.0.1:7798";
const REPO = "productivity";
const ACTOR_ID = "stage6r";

const results = [];
const record = (step, status, body) => { results.push({ step, status, body }); };

let core = null;
if (mode === "new") {
  core = {
    queries: await import("../dist/domainmap/core/queries.js"),
    changelog: await import("../dist/domainmap/core/changelog.js"),
    mappings: await import("../dist/domainmap/core/mappings.js"),
    reconcile: await import("../dist/domainmap/core/reconcile.js"),
    refresh: await import("../dist/domainmap/core/refresh.js"),
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

// new 모드: core fn 호출을 구 server.mjs sendErr 엔벨로프로 변환(write-scenario 와 동일 규약).
async function coreCall(fn) {
  try {
    const body = await fn();
    return { status: 200, body: JSON.parse(JSON.stringify(body)) };
  } catch (e) {
    return { status: e?.status ?? 500, body: { error: e?.message ?? String(e) } };
  }
}

const agent = { type: "agent", id: ACTOR_ID };
const human = { type: "human", id: ACTOR_ID };

async function ingest(payload) {
  if (mode === "old") {
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
async function refresh(payload) {
  if (mode === "old") {
    return httpJson("POST", `/api/repo/${REPO}/refresh`, payload,
      { "x-actor": ACTOR_ID, "x-actor-type": "agent" });
  }
  return coreCall(() => core.refresh.refresh(REPO, payload, agent));
}
async function mappingConfirm(id) {
  if (mode === "old") return httpJson("POST", `/api/mapping/${id}/confirm`, {}, { "x-actor": ACTOR_ID });
  return coreCall(() => core.mappings.confirmMapping(id, human));
}
async function readDomainDetail(id) {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/domain/${id}`)).body;
  return JSON.parse(JSON.stringify(await core.queries.domainDetail(REPO, id)));
}
async function readDebts() {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/debts`)).body;
  return JSON.parse(JSON.stringify(await core.queries.listDebts(REPO)));
}
async function readHistory(limit) {
  if (mode === "old") return (await httpJson("GET", `/api/repo/${REPO}/history?limit=${limit}`)).body;
  return JSON.parse(JSON.stringify(await core.changelog.history(REPO, limit)));
}

// ── step 0: 픽스처 ingest ──
const FIXTURE = {
  repo: { name: REPO, root_path: "/target", detected_stack: null },
  run: { runbook: "stage6-refresh-equivalence", actor_type: "agent", actor_id: ACTOR_ID },
  domains: [{ key: "stage6r-d", name: "스테이지6R 도메인", description: "refresh 동등성 시나리오" }],
  code_units: [
    { kind: "module", path: "stage6r/mod", label: "stage6r mod" },
    { kind: "module", path: "stage6r/low", label: "stage6r low" },
    { kind: "module", path: "stage6r/gone", label: "stage6r gone" },
    { kind: "module", path: "stage6r/keep", label: "stage6r keep" },
  ],
  mappings: [
    { target_kind: "code_unit", target: "stage6r/gone", domain_key: "stage6r-d", confidence: 0.95 },
    { target_kind: "code_unit", target: "stage6r/mod", domain_key: "stage6r-d", confidence: 0.9 },
  ],
};
{
  const r = await ingest(FIXTURE);
  record("0:ingest-fixture", r.status, r.body);
}

// ── step 1: gone 매핑 confirm (삭제-orphan 케이스의 전제 = confirmed 매핑) ──
let domId;
{
  // 도메인 id 발견(키 기준) — listDomains 로
  const ds = mode === "old"
    ? (await httpJson("GET", `/api/repo/${REPO}/domains`)).body
    : JSON.parse(JSON.stringify(await core.queries.listDomainsApi(REPO)));
  domId = ds.find((d) => d.key === "stage6r-d")?.id;
  assert.ok(domId, "stage6r-d 도메인 없음");
  const det = await readDomainDetail(domId);
  const mGone = det.code_units.find((x) => x.path === "stage6r/gone")?.mapping?.id;
  assert.ok(mGone, "stage6r/gone 매핑 없음");
  const r = await mappingConfirm(mGone);
  record("1:confirm-gone-mapping", r.status, r.body);
}

// ── step 2: refresh granularity:'file' — 집계 전 분기 ──
{
  const r = await refresh({
    base: "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1",
    head: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    granularity: "file",
    changes: [
      { status: "R", from: "stage6r/mod/a.ts", to: "stage6r/box/a.ts", score: 90 },
      { status: "R", from: "stage6r/mod/b.ts", to: "stage6r/box/b.ts", score: 88 }, // 2표 클러스터 → mod→box 모듈 rename
      { status: "R", from: "stage6r/keep/x.ts", to: "stage6r/elsewhere/x.ts", score: 70 }, // 1표 → ambiguous → ADD 후보
      { status: "A", path: "stage6r/brand/new.ts" },  // 신규 디렉 후보 stage6r/brand
      { status: "A", path: "stage6r/low/inside.ts" }, // 기존 유닛 내 → noop_in_existing
      { status: "M", path: "stage6r/gone/file.ts" },  // 파일 modify → 집계서 무시
      { status: "D", path: "stage6r/low/old.ts" },    // 파일 delete → noop_delete(유닛 보존)
    ],
  });
  record("2:refresh-file-granularity", r.status, r.body);
  assert.strictEqual(r.body?.tally?.renamed, 1, "module rename 1건이어야 함");
  assert.strictEqual(r.body?.tally?.aggregation?.module_renames, 1);
  assert.strictEqual(r.body?.tally?.aggregation?.ambiguous_moves?.length, 1);
}

// ── step 3: refresh unit — 저신뢰 rename + confirmed-매핑 삭제(orphan) ──
{
  const r = await refresh({
    base: "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2",
    head: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    changes: [
      { status: "R", from: "stage6r/low", to: "stage6r/low2", score: 45 }, // <60 → drift debt
      { status: "D", path: "stage6r/gone" },                               // confirmed 매핑 → orphan flag
    ],
  });
  record("3:refresh-lowconf+orphan", r.status, r.body);
  assert.strictEqual(r.body?.tally?.renamed_lowconf, 1, "저신뢰 rename 1건이어야 함");
  assert.strictEqual(r.body?.tally?.orphaned, 1, "orphan 1건이어야 함");
}

// ── step 4: refresh unit — 재추가 → revive ──
{
  const r = await refresh({
    base: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
    head: "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4",
    changes: [{ status: "A", path: "stage6r/gone" }],
  });
  record("4:refresh-revive", r.status, r.body);
  assert.strictEqual(r.body?.tally?.revived, 1, "revive 1건이어야 함");
}

// ── step 5: 읽기 기록 — drift debt 2종 + 최근 이력(note/before/after 형식 비교) ──
{
  const debts = (await readDebts()).filter((d) => d.title.includes("stage6r"));
  record("5a:debts-stage6r", 200, debts);
  const h = (await readHistory(30)).filter((c) => ["rename", "remove", "revive", "insert"].includes(c.op));
  record("5b:history-structural-ops", 200, h.map((c) => ({
    op: c.op, entity_type: c.entity_type, entity_id: c.entity_id,
    actor_type: c.actor_type, actor_id: c.actor_id, before: c.before, after: c.after, note: c.note,
  })));
}

writeFileSync(`/tmp/stage6-golden/refresh-${mode}.json`, JSON.stringify(results, null, 2) + "\n");
console.log(`refresh scenario done (${mode}) — ${results.length} steps recorded`);
if (mode === "new") await core.db.endPool();
