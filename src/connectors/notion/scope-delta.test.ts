// 델타 범위 판정(#4059) — 원장 항목은 «이 수집기의 몫» 일 때만 범위의 증거다.
//  실행: npm run build && node dist/connectors/notion/scope-delta.test.js
//
//  왜: 원장은 워크스페이스 전체다. 같은 워크스페이스를 나눠 맡은 다른 수집기의 페이지도 활성으로 들어 있어,
//   그걸 증거로 쓰면 남의 범위에서 새로 생긴 페이지를 이 수집기가 제 설정으로 적재한다(신규면 분류까지 남의 것).
//  노션 API 는 fetch 스텁으로 대신한다 — 어떤 경로를 실제로 물었는지(조상 워크)가 곧 판정의 부작용이다.
import assert from "node:assert/strict";
import { discoverDelta } from "./scope.js";

const ROOT = "11111111-1111-4111-8111-111111111111";      // 이 수집기(C)의 루트
const P_MINE = "22222222-2222-4222-8222-222222222222";    // C 가 맡은 페이지(루트 아래)
const Q_PEER = "33333333-3333-4333-8333-333333333333";    // 다른 수집기(D)가 맡은 페이지
const S_PEER_ROOT = "44444444-4444-4444-8444-444444444444"; // D 의 루트(원장에 없음) — 그 위는 워크스페이스
const L_LEGACY = "55555555-5555-4555-8555-555555555555";  // 표식이 한 번도 없던 행(이 수정 전 적재분)
const U_RELEASED = "66666666-6666-4666-8666-666666666666"; // 누군가 맡았다가 빠진 행(비게 됨)
const X = "a1111111-1111-4111-8111-111111111111";         // P_MINE 아래 새 페이지
const Y = "a2222222-2222-4222-8222-222222222222";         // Q_PEER 아래 새 페이지
const Z = "a3333333-3333-4333-8333-333333333333";         // L_LEGACY 아래 새 페이지
const V = "a4444444-4444-4444-8444-444444444444";         // U_RELEASED 아래 새 페이지

const recent = new Date(Date.now() - 3_600_000).toISOString();
const old = "2026-01-01T00:00:00.000Z";
const page = (id: string, parent: Record<string, unknown>) => ({
  object: "page", id, last_edited_time: recent, parent,
  properties: { title: { type: "title", title: [{ plain_text: id.slice(0, 2) }] } },
});
const underPage = (pid: string) => ({ type: "page_id", page_id: pid });
const WORKSPACE = { type: "workspace", workspace: true };

// ── fetch 스텁 — 노션 search 두 번(data_source·page) + 조상 워크용 /pages/{id} ──
const asked: string[] = [];
const livePages: Record<string, unknown> = {
  [Q_PEER]: page(Q_PEER, underPage(S_PEER_ROOT)),
  [S_PEER_ROOT]: page(S_PEER_ROOT, WORKSPACE),
  [U_RELEASED]: page(U_RELEASED, WORKSPACE),
};
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(`${init?.method ?? "GET"} ${url.replace("https://api.notion.com/v1", "")}`);
  if (!url.startsWith("https://api.notion.com/v1/")) throw new Error(`노션 밖으로 나갔다: ${url}`);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
  if (url.endsWith("/search")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { filter?: { value?: string } };
    if (body.filter?.value === "data_source") return json({ results: [], has_more: false });
    return json({ results: [page(X, underPage(P_MINE)), page(Y, underPage(Q_PEER)), page(Z, underPage(L_LEGACY)), page(V, underPage(U_RELEASED))], has_more: false });
  }
  const m = url.match(/\/pages\/([0-9a-f-]{36})$/);
  if (m && livePages[m[1]]) return json(livePages[m[1]]);
  return json({ object: "error", status: 404, message: "not found" }, 404);
}) as typeof fetch;

const led = (parentExt: string, mine: boolean) => ({
  lastEdited: old, syncedAt: old, parentExt, kind: "page", title: "t", lifecycle: "active",
  dsEdited: null, unsupported: false, mine,
});
const ledger = {
  byId: new Map<string, ReturnType<typeof led>>([
    [P_MINE, led(ROOT, true)],
    [Q_PEER, led(S_PEER_ROOT, false)],
    [L_LEGACY, led(ROOT, true)],        // 로더가 «기록 한 번도 없음» 을 mine=true 로 싣는다(PG 테스트 S17)
    [U_RELEASED, led(ROOT, false)],     // 로더가 «비게 됨» 을 mine=false 로 싣는다
  ]),
  dsToDb: new Map<string, string>(),
  backlinks: new Map<string, string[]>(),
};
const t = {
  cfg: { token: "test-token", instance: "ws-1", version: "2025-09-03", rootIds: [ROOT], excludeIds: [], comments: "off", assetDir: "/nonexistent" },
  sinceMs: Date.now(), ledger, fastFull: false, ledgerChildren: new Map(), membership: new Map(), excluded: new Map(),
  commentsDenied: false, pages: new Map(), dbs: new Map(), dsToDb: new Map(), users: new Map(), assetJobs: new Map(),
  stats: { instance: "ws-1", pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [],
    retryIds: [], unattributed: 0, observedIds: [], assets: 0, assetFailures: 0, requests: 0 },
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
await discoverDelta(t as any, Date.now());
const candidates = new Set(t.pages.keys());

// 배선 — 스텁이 실제로 불렸고(검색 2회), 조상 워크가 실제로 일어났다(아니면 아래 판정은 아무것도 안 본 것).
assert.ok(asked.filter((a) => a === "POST /search").length === 2, `검색 호출 수가 다르다: ${asked.join(" | ")}`);
assert.equal(t.stats.failures, 0, "스코프 워크가 일시 실패로 집계됐다 — 스텁 경로가 틀렸다");

assert.ok(candidates.has(X), "D1 내 몫 아래 새 페이지가 후보에서 빠졌다");
console.log("ok  D1 내 몫(활성) 아래 새 페이지는 후보");
assert.ok(!candidates.has(Y), "D2 다른 수집기 몫 아래 새 페이지가 후보가 됐다 — 남의 범위를 내 설정으로 적재한다");
assert.ok(asked.includes(`GET /pages/${Q_PEER}`) && asked.includes(`GET /pages/${S_PEER_ROOT}`),
  `D2 남의 몫에서 조상 워크를 안 했다(원장 숏컷을 탔다): ${asked.join(" | ")}`);
console.log("ok  D2 다른 수집기 몫 아래 새 페이지는 후보 아님(조상 워크로 판정)");
assert.ok(candidates.has(Z), "D3 표식이 한 번도 없던 행 아래 새 페이지가 빠졌다(전환기 호환 깨짐)");
assert.ok(!asked.includes(`GET /pages/${L_LEGACY}`), "D3 레거시 행은 원장 숏컷으로 판정해야 한다(불필요한 조회)");
console.log("ok  D3 표식 없던(레거시) 행 아래 새 페이지는 후보");
assert.ok(!candidates.has(V), "D4 비게 된 행 아래 새 페이지가 후보가 됐다");
assert.ok(asked.includes(`GET /pages/${U_RELEASED}`), "D4 비게 된 행에서 조상 워크를 안 했다");
console.log("ok  D4 비게 된 행 아래 새 페이지는 후보 아님");

console.log("\n4 passed");
