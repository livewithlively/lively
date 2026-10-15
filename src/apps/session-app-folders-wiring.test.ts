// 세션에 붙인 앱 폴더(#4684) — 이어진 자리: 세션 만들기·복원 · 붙이기/떼기 응답 · 앱 상태·동의·공개·제거 · 앱 칸의 폴더 자리.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import test from "node:test";
import { describeAttached, folderNote } from "../capabilities/session-apps.js";
import { GATEWAY_CAPABILITY_NAMES } from "../sessions/gateway-capabilities.js";
import type { SessionAppRow } from "./session-apps.js";

const src = (rel: string): string => readFileSync(new URL(`../../src/${rel}`, import.meta.url), "utf8");
const slice = (s: string, from: string, to: string): string => {
  const i = s.indexOf(from);
  assert.ok(i >= 0, `못 찾았다: ${from}`);
  const j = s.indexOf(to, i + from.length);
  return s.slice(i, j < 0 ? undefined : j);
};

test("W1 세션을 만들 때 — 새 id 복원이면 (어느 경로든) 검증 뒤에 넘기고, 붙어 있어야 할 앱 목록을 확보 요청에 싣는다(비었으면 안 싣는다)", () => {
  const s = src("terminal/sessions.ts");
  const fn = slice(s, "export async function createSession(", "\ninterface OwnerMeta");
  const carry = fn.indexOf("appFolders.carry(input.carryAppsFrom, id)");
  const inside = fn.indexOf("if (inside) {");
  const list = fn.indexOf("appFolders.listFor(id)");
  const ensure = fn.indexOf("await ensureSessionContainerViaRelay(");
  assert.ok(carry > 0 && inside > carry, "승계는 컨테이너 갈래 밖(앞)이어야 셀프호스트·노드 아닌 경로도 붙은 앱을 잃지 않는다");
  //  검증(작업 폴더 공개범위 · 하네스 · 초대)에서 막힌 복원이 한 번도 안 뜬 id 에 붙은 앱을 남기지 않게 — 승계는 검증 뒤다.
  for (const gate of ["await assertCwdVisible(user, rootKeyUsed, subpathUsed)", '"허용되지 않은 하네스입니다"', "await validInvites("]) {
    const g = fn.indexOf(gate);
    assert.ok(g > 0 && carry > g, `승계가 검증(${gate})보다 앞이다`);
  }
  assert.ok(list > inside && ensure > list, "목록 → 확보 순서여야 새 컨테이너에 붙는다");
  //  만들기가 실패하면 승계한 기록을 되돌린다 — 확보 실패 · 판 실패 · (판이 사라진 것을 확인한) 표식 실패.
  assert.match(slice(fn, "await ensureSessionContainerViaRelay(", "await prepareMemberHome("), /await dropOwnRow\(\);\s*await dropCarried\(\);/);
  assert.match(slice(fn, "try { await tmux(args); }", "const meta = sessionMetaCmds("), /await dropCarried\(\);\s*throw e;/);
  assert.match(slice(fn, "try { await tmuxBatch(meta); }", "if (input.managed)"), /if \(gone\) await dropCarried\(\);/);
  //  되돌림은 이번 호출이 넘긴 기록만 — 같은 id 복원(넘긴 것 없음)이 실패해도 진짜 세션의 붙은 앱을 지우지 않는다.
  assert.match(fn, /const dropCarried = \(\): Promise<void> => \(carried && appFolders \? appFolders\.drop\(id\)/);
  //  맞추기의 주인 조회는 오류를 던지는 쪽이어야 한다(오류를 «주인 없음» 으로 접으면 도는 세션의 폴더를 모두 뗀다 — L2e).
  assert.match(src("apps/session-app-folders.ts"), /sessionOwner: sessionOwnerStrict, canEnter: sessionCanEnter,/);
  assert.match(fn, /\.\.\.\(folderApps && folderApps\.length \? \{ apps: folderApps \} : \{\}\)/);
  const after = fn.indexOf("appFolders.afterCreate(id, folderApps)");
  assert.ok(after > ensure, "만든 뒤 확인은 확보가 끝난 다음이어야 한다(만드는 사이 바뀐 붙이기를 새 컨테이너에 맞춘다)");
  assert.ok(GATEWAY_CAPABILITY_NAMES.includes("sessionAppFolders"), "선언이 빠지면 배선 가드가 index.ts 등록을 요구하지 않는다");
  const idx = src("index.ts");
  assert.match(idx, /sessionAppFolders: \{\s*listFor: \(id\) => folderAppsFor\(id\), carry: \(from, to\) => carrySessionApps\(from, to\), drop: \(id\) => dropSessionApps\(id\),\s*afterCreate: \(id, sent\) => \{ void resyncIfChangedAfterCreate\(id, sent\); \},\s*\}/);
});


test("W2 복원 — 같은 id 는 넘길 것이 없고, 새 id 는 옛 id 에서 붙은 앱을 넘긴다", () => {
  const r = src("terminal/routes.ts");
  assert.match(r, /\.\.\.\(sameId \? \{\} : \{ carryAppsFrom: id \}\),/);
  assert.match(r, /\.\.\.\(sameId \? \{ reuseId: id \} : \{\}\),/);
});

test("W3 붙이기·떼기는 기록 뒤 앱 폴더를 맞추고 그 결과(folder)를 응답에 싣는다", () => {
  const s = src("capabilities/session-apps.ts");
  const att = slice(s, 'name: "session_app_attach"', 'name: "session_app_detach"');
  assert.ok(att.indexOf("attachAppRow(") < att.indexOf("syncSessionAppFolders(sid)"), "기록 전에 맞추면 새 앱이 목록에 없다");
  assert.match(att, /folder_status, hint: HINT \};/);
  const det = slice(s, 'name: "session_app_detach"', "export const sessionAppsCapabilities");
  assert.ok(det.indexOf("detachAppRow(") < det.indexOf("syncSessionAppFolders(sid)"), "기록 전에 맞추면 뗀 앱이 다시 붙는다");
  assert.match(det, /return \{ session_id: sid, detached, folder_status \};/);
});

test("W4 앱 끄기·켜기 · 동의 회수 · 공개/«나만» · 제거 뒤에 붙은 세션을 다시 맞춘다", () => {
  const apps = src("capabilities/apps.ts");
  assert.match(slice(apps, 'name: "org_app_set_enabled"', "// ── 멤버 grant"), /resyncSessionsWithApp\(id, input\.enabled \? "앱 켬" : "앱 끔"\)/);
  assert.match(slice(apps, 'name: "me_app_revoke"', "// ── 앱 설치/업데이트"), /if \(revoked\) resyncSessionsWithApp\(id, "동의 회수", owner\)/);
  const vis = slice(apps, 'name: "app_visibility_set"', "/** 예약 앱 id 의 뒤 6자");
  assert.match(vis, /resyncSessionsWithApp\(id, "공개"\)/);
  assert.match(vis, /resyncSessionsWithApp\(id, "「나만」 으로 바꿈"\)/);
  assert.match(slice(apps, 'name: "me_app_grant"', 'name: "me_app_revoke"'), /resyncSessionsWithApp\(id, "동의", actorOf\(user\)\)/);
  const rm = src("apps/remove-run.ts");
  assert.ok(rm.indexOf("const wasAttached = await pruneSessionApps(id)") > 0);
  assert.ok(rm.indexOf("resyncSessions(wasAttached") > rm.indexOf("store.deleteApp(id, ctx)"), "기록을 지운 뒤에 맞춰야 빠진다");
});

const row: SessionAppRow = { session_id: "box-a", app_id: "crm", member_id: "alice", attached_at: "2026-10-15T00:00:00Z" };

test("W5 앱 칸의 folder — 매니지드에서만 자리를 말하고(작업 폴더 기준), 셀프호스트는 null", () => {
  assert.equal(describeAttached(row, null).folder, null);
  assert.equal(describeAttached(row, null, null, { folders: true }).folder, ".lively/apps/crm");
});

test("W6 붙이기·떼기 응답의 folder_status", () => {
  assert.deepEqual(folderNote({ applied: true, supported: true, bound: ["crm"], failed: [] }, "crm", true), { state: "attached", path: ".lively/apps/crm" });
  assert.deepEqual(folderNote({ applied: true, supported: true, bound: [], failed: [{ app: "crm", why: "링크다" }] }, "crm", true),
    { state: "failed", path: ".lively/apps/crm", why: "링크다" });
  assert.equal(folderNote({ applied: true, supported: true, bound: [], failed: [] }, "crm", true).state, "failed", "붙였는데 안 붙었으면 사유와 함께 실패");
  assert.deepEqual(folderNote({ applied: true, supported: true, bound: [], failed: [] }, "crm", false), { state: "detached", path: ".lively/apps/crm" });
  assert.equal(folderNote({ applied: true, supported: false, bound: [], failed: [] }, "crm", true).state, "after-restart");
  assert.deepEqual(folderNote({ applied: true, supported: false, bound: [], failed: [] }, "crm", false), { state: "detached", path: ".lively/apps/crm" }, "떼는 앱이 다시 뜰 때 붙는다고 말하면 안 된다");
  assert.equal(folderNote({ applied: false, reason: "not-running" }, "crm", true).state, "next-start");
  assert.deepEqual(folderNote({ applied: false, reason: "not-managed" }, "crm", true), { state: "none" });
  assert.deepEqual(folderNote({ applied: false, reason: "error", detail: "허브 503" }, "crm", true), { state: "error", why: "허브 503" });
  assert.equal(folderNote({ applied: false, reason: "old-broker", detail: "x" }, "crm", true).state, "error");
});

test("W7 멤버 비활성 — 동의를 한꺼번에 거둔 뒤 그 사람이 붙여 둔 세션의 앱 폴더를 다시 맞춘다", async () => {
  const { reclaimMemberAppFootprint } = await import("./member-deactivation.js");
  const order: string[] = [];
  await reclaimMemberAppFootprint("bob", {
    revokeGrants: async () => { order.push("revoke"); return 1; },
    stopWorkers: async () => { order.push("workers"); return 0; },
    resyncAppFolders: (m: string) => { order.push(`resync:${m}`); },
    listSessions: async () => [], killCentral: async () => undefined, killNode: async () => undefined, deleteState: async () => undefined,
  });
  assert.ok(order.indexOf("resync:bob") > order.indexOf("revoke"), JSON.stringify(order));
  assert.match(src("apps/member-deactivation.ts"), /resyncAppFolders: \(memberId\) => \{/);
});

