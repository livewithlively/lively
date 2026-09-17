// 가속 full 의 자식 발견(#4059 후속) — 바뀐 페이지를 다시 긁을 때 «원장이 아는 자식» 은 강제 수집하지 않는다.
//  실행: npm run build && node dist/connectors/notion/fastfull-children.test.js
//
//  왜: 강제 표시(forceChanged)가 붙은 자식은 가속 full 의 1req 관측 경로를 건너뛰고 블록 트리를 통째로 다시 긁는다.
//   그 자식의 자식도 같은 길을 타서, 루트 하나만 편집돼도 트리 전체를 다시 수집했다(가짜 노션 실측 13/13).
//   soltimal 의 큰 수집기는 그래서 전체 점검이 50분을 넘겨 매시간 롤에 끊겼다.
//  노션 API 는 fetch 스텁으로 대신한다 — 부모의 블록 목록 하나만 답한다.
import assert from "node:assert/strict";
import { processPage } from "./traverse.js";
import { pageNode } from "./state.js";
import type { Traversal } from "./state.js";

const P = "aaaaaaaa-0000-4000-8000-000000000001";          // 다시 긁히는 부모
const OTHER = "aaaaaaaa-0000-4000-8000-000000000002";      // 다른 부모
const kid = (n: number) => `bbbbbbbb-0000-4000-8000-${String(n).padStart(12, "0")}`;
const KNOWN = kid(1), NEW = kid(2), ARCHIVED = kid(3), MOVED = kid(4), DBKIND = kid(5), QUEUED = kid(6), ROWKIND = kid(7), PEER = kid(8);
const KIDS = [KNOWN, NEW, ARCHIVED, MOVED, DBKIND, QUEUED, ROWKIND, PEER];

let blockCalls = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes(`/blocks/${P}/children`)) {
    blockCalls++;
    const results = KIDS.map((id) => ({ object: "block", id, type: "child_page", has_children: true, child_page: { title: id.slice(-2) } }));
    return new Response(JSON.stringify({ object: "list", results, has_more: false, next_cursor: null }), { status: 200 });
  }
  return new Response(JSON.stringify({ object: "error", status: 404 }), { status: 404 });
}) as typeof fetch;

const led = (parentExt: string, over: Record<string, unknown> = {}) => ({
  lastEdited: "2026-09-01T00:00:00.000Z", syncedAt: "2026-09-02T00:00:00.000Z", parentExt, kind: "page", title: "t",
  lifecycle: "active", dsEdited: null, unsupported: false, mine: true, ...over,
});
function ledger() {
  return {
    byId: new Map<string, ReturnType<typeof led>>([
      [P, led("root-parent")],
      [KNOWN, led(P)],
      [ARCHIVED, led(P, { lifecycle: "archived" })],
      [MOVED, led(OTHER)],
      [DBKIND, led(P, { kind: "database" })],
      [QUEUED, led(P)],
      [ROWKIND, led(P, { kind: "db_row" })],
      [PEER, led(P, { mine: false })],   // 같은 워크스페이스의 다른 수집기가 적재한 행
    ]),
    dsToDb: new Map<string, string>(), backlinks: new Map<string, string[]>(),
  };
}
function traversal(mode: "fastFull" | "delta" | "plain"): Traversal {
  const t = {
    cfg: { token: "x", instance: "ws", version: "2025-09-03", rootIds: [], excludeIds: [], comments: "off", assetDir: "/nonexistent" },
    sinceMs: mode === "delta" ? Date.parse("2026-09-10T00:00:00Z") : undefined,
    ledger: mode === "plain" ? null : ledger(),
    fastFull: mode === "fastFull",
    ledgerChildren: new Map(), membership: new Map(), excluded: new Map(), commentsDenied: false,
    pages: new Map(), dbs: new Map(), dsToDb: new Map(), users: new Map(), assetJobs: new Map(),
    stats: { instance: "ws", pages: 0, databases: 0, emitted: 0, failures: 0, failedIds: [], inaccessible: 0, inaccessibleIds: [],
      retryIds: [], unattributed: 0, observedIds: [], assets: 0, assetFailures: 0, requests: 0 },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return t as any;
}
async function rescan(t: Traversal): Promise<void> {
  const parent = pageNode(t, P);
  parent.page = { object: "page", id: P, last_edited_time: "2026-09-17T00:00:00.000Z",
    parent: { type: "workspace", workspace: true }, properties: {} } as never;
  parent.forceChanged = true; // 부모는 바뀐 페이지 — 다시 긁혀 자식을 발견한다
  const before = blockCalls;
  await processPage(t, parent);
  assert.equal(blockCalls, before + 1, "부모 블록 목록을 실제로 긁지 않았다(시험이 아무것도 안 본다)");
  assert.equal(t.stats.failures, 0);
  assert.deepEqual(parent.childrenOrder, KIDS, "자식 순서가 부모에 다 실려야 한다(강제 여부와 무관)");
}
const forced = (t: Traversal, id: string) => t.pages.get(id)?.forceChanged === true;

let pass = 0;
const ok = (name: string) => { pass++; console.log(`ok  ${name}`); };

{
  const t = traversal("fastFull");
  pageNode(t, QUEUED).forceChanged = true; // F9 — 재시도 등으로 이미 강제 큐잉
  await rescan(t);
  for (const id of KIDS) assert.ok(t.pages.has(id), `가속 full 은 모든 자식을 큐에 올려야 한다(관측돼야 스윕이 오탐하지 않는다): ${id}`);
  assert.equal(forced(t, KNOWN), false, "F1 같은 부모의 활성 자식을 강제로 긁는다 — 트리 전체 재수집");
  ok("F1 가속 full · 아는 자식은 강제 아님(1req 관측 경로)");
  assert.equal(forced(t, NEW), true, "F2 원장에 없는 자식은 강제여야 한다");
  ok("F2 가속 full · 원장에 없는 자식은 강제");
  assert.equal(forced(t, ARCHIVED), true, "F3 보관 상태 자식(복원)은 강제여야 한다");
  ok("F3 가속 full · 보관 자식은 강제");
  assert.equal(forced(t, MOVED), true, "F4 원장상 부모가 다른 자식(이동)은 강제여야 한다");
  ok("F4 가속 full · 옮겨 온 자식은 강제");
  assert.equal(forced(t, DBKIND), true, "F5 원장이 database 로 아는 id 는 페이지로서 아는 것이 아니다");
  ok("F5 가속 full · database 종류로 아는 id 는 강제");
  assert.equal(forced(t, QUEUED), true, "F9 이미 강제로 큐에 있던 노드의 표시를 풀었다");
  ok("F9 가속 full · 이미 강제인 노드는 그대로");
  assert.equal(forced(t, ROWKIND), false, "F10 같은 부모의 활성 행 종류도 아는 자식이다");
  ok("F10 가속 full · 같은 부모 활성 db_row 종류는 강제 아님");
  assert.equal(forced(t, PEER), false, "F11 남의 몫(mine=false)이라고 강제로 긁었다 — 몫은 범위 판정용이지 재수집 판정용이 아니다");
  ok("F11 가속 full · 같은 부모 활성 자식은 남의 몫이어도 강제 아님");
}
{
  const t = traversal("delta");
  await rescan(t);
  assert.equal(t.pages.has(KNOWN), false, "F6 델타에서 아는 자식의 노드를 만들었다(요청 낭비)");
  ok("F6 델타 · 아는 자식은 노드 없음(기존 동작)");
  assert.equal(forced(t, NEW), true, "F7 델타에서 모르는 자식은 강제여야 한다");
  ok("F7 델타 · 모르는 자식은 강제(기존 동작)");
}
{
  const t = traversal("plain");
  await rescan(t);
  assert.ok(t.pages.has(KNOWN) && t.pages.has(NEW));
  assert.equal(t.pages.get(KNOWN)?.forceChanged, undefined, "F8 원장 없는 full 에 강제 표시가 붙었다");
  assert.equal(t.pages.get(NEW)?.forceChanged, undefined);
  ok("F8 원장 없는 full · 강제 표시 없음");
}

console.log(`\n${pass} passed`);
