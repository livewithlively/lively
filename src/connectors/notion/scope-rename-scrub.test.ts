// 델타 개명 판정과 수집 가림(#5308) — 가림을 켠 수집기의 원장 제목은 «가린 모양» 이다.
//  실행: npm run build && node dist/connectors/notion/scope-rename-scrub.test.js
//
//  사양: 제목에 연락처가 든 페이지가 고쳐져 델타에 들어와도, 제목 자체가 그대로면 «개명» 이 아니다 — 부모(소속 DB·상위 페이지)와
//   역링크 페이지를 다시 받지 않는다. 가림을 끈 수집기는 종전 그대로 원문 제목끼리 비교한다.
//  노션 API 는 fetch 스텁으로 대신한다 — «무엇을 다시 받으려고 큐에 넣었나»(t.pages)가 곧 판정의 부작용이다.
import assert from "node:assert/strict";
import { discoverDelta } from "./scope.js";
import { withCollector } from "../config.js";
import { scrubText } from "../../org/ingest/content-scrub.js";

const ROOT = "11111111-1111-4111-8111-111111111111";     // 수집기 루트
const R = "22222222-2222-4222-8222-222222222222";        // 상위 페이지
const P = "33333333-3333-4333-8333-333333333333";        // 제목에 연락처가 든 페이지(이번에 고쳐짐)
const B = "44444444-4444-4444-8444-444444444444";        // P 를 본문에서 멘션하는 페이지(역링크)
const LIVE_TITLE = "고객 김 010-1234-5678";
const SCRUBBED = scrubText(LIVE_TITLE);

const recent = new Date(Date.now() - 3_600_000).toISOString();
const old = "2026-01-01T00:00:00.000Z";
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input);
  asked.push(`${init?.method ?? "GET"} ${url.replace("https://api.notion.com/v1", "")}`);
  if (!url.startsWith("https://api.notion.com/v1/")) throw new Error(`노션 밖으로 나갔다: ${url}`);
  const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (url.endsWith("/search")) {
    const body = JSON.parse(String(init?.body ?? "{}")) as { filter?: { value?: string } };
    if (body.filter?.value === "data_source") return json({ results: [], has_more: false });
    return json({ results: [{
      object: "page", id: P, last_edited_time: recent, parent: { type: "page_id", page_id: R },
      properties: { title: { type: "title", title: [{ plain_text: LIVE_TITLE }] } },
    }], has_more: false });
  }
  return json({ object: "error", status: 404, message: "not found" });
}) as typeof fetch;

const led = (parentExt: string, title: string) => ({
  lastEdited: old, syncedAt: old, parentExt, kind: "page", title, lifecycle: "active", dsEdited: null, unsupported: false, mine: true,
});
function traversal(pTitle: string) {
  return {
    cfg: { token: "test-token", instance: "ws-1", version: "2025-09-03", rootIds: [ROOT], excludeIds: [], comments: "off", assetDir: "/nonexistent" },
    sinceMs: Date.now(), fastFull: false, ledgerChildren: new Map(), membership: new Map(), excluded: new Map(),
    ledger: {
      byId: new Map([[R, led(ROOT, "상위")], [P, led(R, pTitle)], [B, led(ROOT, "회의록")]]),
      dsToDb: new Map<string, string>(),
      backlinks: new Map<string, string[]>([[P, [B]]]),
    },
    commentsDenied: false, pages: new Map(), dbs: new Map(), dsToDb: new Map(), users: new Map(), assetJobs: new Map(),
    stats: { instance: "ws-1", pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [],
      retryIds: [], unattributed: 0, observedIds: [], assets: 0, assetFailures: 0, requests: 0 },
  };
}
const ON = { id: 990_601, presetKey: "notion", instanceKey: "t", piiScrub: true };
let pass = 0;

// R1 가림 켬 · 원장 제목 = 가린 모양 · 제목 그대로 → 개명 아님(부모·역링크 재수집 없음)
{
  const t = traversal(SCRUBBED);
  asked.length = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await withCollector(ON, () => discoverDelta(t as any, Date.now()));
  assert.ok(asked.filter((a) => a === "POST /search").length === 2, `배선 — 검색이 안 불렸다: ${asked.join(" | ")}`);
  assert.ok(t.pages.has(P), "배선 — 고쳐진 페이지가 후보가 아니다(아래 판정은 아무것도 안 본 것)");
  assert.ok(SCRUBBED !== LIVE_TITLE, "전제 — 시험 제목이 가려지지 않았다");
  assert.ok(!t.pages.has(R), "R1 ★가린 제목을 개명으로 봐서 부모를 다시 받으려 한다");
  assert.ok(!t.pages.has(B), "R1 ★가린 제목을 개명으로 봐서 역링크 페이지를 다시 받으려 한다");
  pass++; console.log("ok  R1 가림 켬 — 가린 원장 제목은 개명이 아니다");
}

// R2 가림 켬 · 실제로 개명됨 → 개명(부모·역링크 재수집) — 고친 판정이 진짜 개명까지 삼키지 않는다
{
  const t = traversal(scrubText("예전 제목 010-1234-5678"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await withCollector(ON, () => discoverDelta(t as any, Date.now()));
  assert.ok(t.pages.has(R) && t.pages.has(B), "R2 실제 개명인데 부모·역링크를 다시 받지 않는다");
  pass++; console.log("ok  R2 가림 켬 — 진짜 개명은 그대로 잡는다");
}

// R3 가림 끔(바인딩 없음) · 원장 제목 = 원문 · 제목 그대로 → 개명 아님(종전 동작)
{
  const t = traversal(LIVE_TITLE);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await discoverDelta(t as any, Date.now());
  assert.ok(t.pages.has(P) && !t.pages.has(R) && !t.pages.has(B), "R3 가림을 끈 수집기의 종전 판정이 바뀌었다");
  pass++; console.log("ok  R3 가림 끔 — 종전처럼 원문 제목끼리 비교한다");
}

console.log(`\n${pass} passed`);
