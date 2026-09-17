// #4065 — 세션 목록이 «갓 만든 세션» 을 «중단됨» 으로 내지 않는다.
//
// 실측(2026-09-17 매니지드): 새 노드에 그 워크스페이스의 세션 호스트가 아직 없어서, 방금 만든 세션이 18초 동안
//  호스트 스냅샷에 안 잡혔다. 목록은 DB 행만 보고 그 세션을 «중단됨(restorable)» 으로 냈고, 화면은 대화창으로 열렸다.
//  새 경로는 DB 행을 **가장 먼저** 쓰므로(생성 ① 행 → ② 컨테이너 → ③ 홈 → ④ tmux) 호스트가 있어도 생성 중엔 같은 모양이 난다.
//
// 사양(엣지 표) — 행마다 시험 ≥1:
//  #   | 만든 시각(나이)      | exited | reason | discovered | 옵션 | 기대
//  B1  | 5초 전               | -      | -      | -          | 켬   | 시작 중(restorable=false · starting · idle)
//  B2  | 89.999초 전(경계 안) | -      | -      | -          | 켬   | 시작 중
//  B3  | 정확히 90초 전(경계) | -      | -      | -          | 켬   | 중단됨(restorable · offline)
//  B4  | 1시간 전             | -      | -      | -          | 켬   | 중단됨
//  B5  | 5초 전               | 있음   | -      | -          | 켬   | 종료됨(exitedByUser) — 시작 중 아님
//  B6  | 5초 전               | -      | oom    | -          | 켬   | 메모리 부족(oomKilled) — 시작 중 아님
//  B7  | 5초 전               | -      | -      | 발견       | 켬   | 발견 행 규칙 그대로 — 시작 중 아님
//  B8  | null                 | -      | -      | -          | 켬   | 중단됨
//  B9  | 10초 미래            | -      | -      | -          | 켬   | 시작 중(시계 어긋남)
//  B10 | 1시간 미래(이상값)   | -      | -      | -          | 켬   | 중단됨
//  B11 | 5초 전               | -      | -      | -          | 끔   | 중단됨(종전 — 휴지통 등 다른 호출자)
//  B12 | 5초 전 · 라이브에 있음                                | 켬   | 목록에서 빠짐
//  B13 | 5초 전 · 남의 개인 세션(초대 없음)                    | 켬   | 안 보임
//  B14 | 유예 0 · 음수(신규 옵션의 빈 값)                      | 켬   | 중단됨
//  B15 | 배선 — AI 세션 탭·프로젝트 세션 목록은 켜고, 휴지통 묶음은 안 켠다(구조)
//  B16 | 5초 전 · 노드 세션(node_id)                     | 켬   | 노드 이름·상태 보강 대상(«끊김» 자리표시자로 남지 않음) · 라이브 행은 안 건드림
//
// 실행: npm run build && node --test dist/terminal/session-starting-grace.test.js
import { strict as assert } from "node:assert";
import fs from "node:fs";
import test from "node:test";
import { itemsPool } from "../db/client.js";
import type { LivelyUser } from "../context.js";
import { isStartingDesiredRow, listRestorableSessions, SESSION_STARTING_GRACE_MS, type RestorableListOpts } from "./sessions.js";
import { decorateNodeRows } from "./node-session-state.js";

const NOW_S = 1_800_000_000;     // 기준 시각(epoch 초) — 만든 시각과 시계를 이 값으로 맞춘다
const NOW = NOW_S * 1000;
const ME = "kim";

// ── 얇은 Db 페이크 — 목록이 읽는 desired 행 조회만 답한다. 모르는 SQL 은 던진다(조용한 빈 결과는 아무것도 안 본다).
//  숨김 프로젝트 조회(hiddenProjects)도 던지게 둔다 — 그러면 종전 규칙대로 «판정 불가» 가 되어 개인 폴더 세션만 보인다.
type Row = Record<string, unknown>;
let rows: Row[] = [];
let stateQueries = 0;
let nodeQueries = 0;
const NODE_ROWS = [{ id: "n-mac", name: "상민 맥북" }];
(itemsPool as unknown as { query: unknown }).query = async (sqlIn: unknown) => {
  const sql = String(sqlIn).replace(/\s+/g, " ").trim();
  if (sql.startsWith("SELECT * FROM org_session_state WHERE superseded_by IS NULL")) { stateQueries++; return { rows }; }
  //  노드 행 보강(decorateNodeRows)이 이름을 찾는 조회 — 이 시험 프로세스엔 연결된 노드가 없어 DB 갈래로 온다.
  if (sql.startsWith("SELECT * FROM org_node ORDER BY created_at")) { nodeQueries++; return { rows: NODE_ROWS }; }
  throw new Error(`시험 페이크가 모르는 SQL: ${sql.slice(0, 80)}`);
};

let seq = 0;
function row(over: Row = {}): Row {
  seq++;
  return {
    id: `box-kim-${String(seq).padStart(8, "0")}`, owner: ME, harness: "claude", label: "일",
    dir: "/home/box_kim", root_key: "personal", subpath: "", flags: {}, auto_approve: false, invites: [],
    project_id: null, created: NOW_S - 5, last_busy: null, exited_at: null, exit_reason: null,
    discovered: false, node_id: null, superseded_by: null,
    ...over,
  };
}

const user = { userId: ME } as unknown as LivelyUser;

async function one(r: Row, opts: RestorableListOpts = { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW }) {
  rows = [r];
  const before = stateQueries;
  const out = await listRestorableSessions(user, new Set(), opts);
  assert.equal(stateQueries, before + 1, "배선: 목록이 desired 행 조회를 실제로 했어야 한다");
  assert.equal(out.length, 1, `행이 목록에 있어야 한다(가시성 전제): ${JSON.stringify(out)}`);
  return out[0]!;
}

function assertStarting(s: Awaited<ReturnType<typeof one>>, why: string): void {
  assert.equal(s.restorable, false, `🔴 ${why} — «중단됨» 으로 냈다(화면이 대화창으로 떨어진다)`);
  assert.equal(s.starting, true, `${why} — 시작 중 표시가 없다`);
  assert.equal(s.agentState, "idle", `${why} — 살아 있는 행의 상태가 아니다`);
}
function assertRestorable(s: Awaited<ReturnType<typeof one>>, why: string): void {
  assert.equal(s.restorable, true, `🔴 ${why} — 중단된 세션을 되살릴 수 없게 됐다`);
  assert.equal(s.starting, undefined, `🔴 ${why} — 죽은 세션을 «시작 중» 으로 냈다`);
  assert.equal(s.agentState, "offline", why);
}

test("[4065-B0] 유예는 90초다(사양 값)", () => {
  assert.equal(SESSION_STARTING_GRACE_MS, 90_000);
});

test("[4065-B1] ★ 5초 전에 만든 세션은 «시작 중» — 살아 있는 행", async () => {
  assertStarting(await one(row({ created: NOW_S - 5 })), "갓 만든 세션");
});

test("[4065-B2·B3] ★ 경계 — 89.999초는 시작 중, 정확히 90초는 중단됨", async () => {
  const r = row({ created: NOW_S });
  assertStarting(await one(r, { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW + 89_999 }), "유예 안(89.999초)");
  assertRestorable(await one(r, { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW + 90_000 }), "유예 끝(90초)");
});

test("[4065-B4] 1시간 전에 만든 세션은 종전대로 중단됨", async () => {
  assertRestorable(await one(row({ created: NOW_S - 3600 })), "오래된 세션");
});

test("[4065-B5] 사람이 끝낸 세션은 갓 만들었어도 «종료됨» — 시작 중이 아니다(사유가 없어도)", async () => {
  //  종료 표시만 있고 사유 칸이 빈 행(옛 훅)도 있다 — 사유가 아니라 표시만으로 가려야 한다.
  const bare = await one(row({ created: NOW_S - 5, exited_at: new Date(NOW - 1000).toISOString(), exit_reason: null }));
  assertRestorable(bare, "사용자 종료(사유 없음)");
  assert.equal(bare.exitedByUser, true);
  const withReason = await one(row({ created: NOW_S - 5, exited_at: new Date(NOW - 1000).toISOString(), exit_reason: "prompt_input_exit" }));
  assertRestorable(withReason, "사용자 종료(사유 있음)");
});

test("[4065-B6] 메모리로 죽은 세션은 갓 만들었어도 «메모리 부족» — 시작 중이 아니다", async () => {
  const s = await one(row({ created: NOW_S - 5, exit_reason: "oom" }));
  assertRestorable(s, "OOM");
  assert.equal(s.oomKilled, true);
});

test("[4065-B7] 노드 스냅샷에서 발견한 행은 갓 만들었어도 종전 규칙(복원 약속 없음 · 시작 중 아님)", async () => {
  const s = await one(row({ created: NOW_S - 5, discovered: true, root_key: null }));
  assert.equal(s.restorable, false, "발견 행은 좌표를 몰라 되살리지 않는다(#2022)");
  assert.equal(s.discovered, true);
  assert.equal(s.starting, undefined, "🔴 발견 행을 게이트웨이가 방금 만든 세션으로 읽었다");
  assert.equal(s.agentState, "offline");
});

test("[4065-B8] 만든 시각을 모르면 종전대로 중단됨", async () => {
  assertRestorable(await one(row({ created: null })), "시각 모름");
});

test("[4065-B9·B10] 시계 어긋남 — 조금 미래는 시작 중, 유예보다 먼 미래는 이상값이라 종전대로", async () => {
  assertStarting(await one(row({ created: NOW_S + 10 })), "10초 미래");
  assertRestorable(await one(row({ created: NOW_S + 3600 })), "1시간 미래");
});

test("[4065-B11] 옵션을 안 켠 호출자(휴지통 등)는 종전대로 — 갓 만든 세션도 중단됨", async () => {
  assertRestorable(await one(row({ created: NOW_S - 5 }), { nowMs: NOW }), "옵션 없음");
});

test("[4065-B12] 라이브에 있는 세션은 목록에서 빠진다(이중표기 없음)", async () => {
  const live = row({ created: NOW_S - 5 });
  const other = row({ created: NOW_S - 5 });
  rows = [live, other];
  const out = await listRestorableSessions(user, new Set([String(live.id)]), { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW });
  assert.deepEqual(out.map((s) => s.id), [other.id], "라이브 행만 빠지고 나머지는 남는다");
});

test("[4065-B13] 남의 개인 세션(초대 없음)은 시작 중이어도 안 보인다", async () => {
  const theirs = row({ created: NOW_S - 5, owner: "lee" });
  const mine = row({ created: NOW_S - 5 });
  rows = [theirs, mine];
  const out = await listRestorableSessions(user, new Set(), { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW });
  assert.deepEqual(out.map((s) => s.id), [mine.id], "🔴 가시성 규칙이 시작 중 행에서 풀렸다");
});

test("[4065-B14] 유예 0·음수는 «유예 없음» — 종전대로 중단됨", async () => {
  assertRestorable(await one(row({ created: NOW_S - 5 }), { startingGraceMs: 0, nowMs: NOW }), "유예 0");
  assertRestorable(await one(row({ created: NOW_S - 5 }), { startingGraceMs: -1, nowMs: NOW }), "유예 음수");
});

test("[4065-B14b] 판정 함수 — 형식 밖 시각은 시작 중이 아니다", () => {
  const base = { exited_at: null, exit_reason: null, discovered: false };
  assert.equal(isStartingDesiredRow({ ...base, created: Number("x") }, NOW, SESSION_STARTING_GRACE_MS), false, "NaN");
  assert.equal(isStartingDesiredRow({ ...base, created: NOW_S }, NOW, Number.NaN), false, "유예 NaN");
  assert.equal(isStartingDesiredRow({ ...base, created: NOW_S }, NOW, SESSION_STARTING_GRACE_MS), true, "대조군");
});

//  B16 — 노드 세션(desired 행에 node_id)도 시작 중이면 노드 이름·연결 상태를 채운다. 안 채우면 막 만든 노드 세션이
//   프로젝트 화면·세션 목록에서 자리표시자(`name=id · online:false` = «끊김»)로 보인다.
test("[4065-B16] ★ 시작 중 노드 행도 노드 이름을 채운다 · 라이브 행과 노드 없는 행은 안 건드린다", async () => {
  rows = [
    row({ created: NOW_S - 5, node_id: "n-mac" }),             // 시작 중 + 노드
    row({ created: NOW_S - 3600, node_id: "n-mac" }),          // 중단됨 + 노드(종전 갈래 — 대조군)
    row({ created: NOW_S - 5 }),                               // 시작 중 · 노드 없음
  ];
  const out = await listRestorableSessions(user, new Set(), { startingGraceMs: SESSION_STARTING_GRACE_MS, nowMs: NOW });
  const [startingNode, deadNode, startingPlain] = out;
  assert.equal(startingNode!.starting, true, "전제: 첫 행은 시작 중");
  assert.equal(deadNode!.restorable, true, "전제: 둘째 행은 중단됨");
  //  라이브 행(관측에서 온 행)은 보강 대상이 아니다 — 스냅샷이 이미 정확한 이름·상태를 싣는다.
  const liveRow = { ...startingNode!, id: "box-kim-live", starting: undefined, restorable: undefined, node: { id: "n-mac", name: "스냅샷 이름", online: true } };
  const before = nodeQueries;
  await decorateNodeRows([startingNode!, deadNode!, startingPlain!, liveRow]);
  assert.ok(nodeQueries > before, "배선: 보강이 노드 이름을 실제로 조회했어야 한다");
  assert.equal(startingNode!.node?.name, "상민 맥북", "🔴 시작 중 노드 행이 자리표시자 이름(id)으로 남았다 — 화면에 id 가 보인다");
  assert.equal(deadNode!.node?.name, "상민 맥북", "중단됨 노드 행 보강(종전 동작)이 깨졌다");
  assert.equal(startingPlain!.node, undefined, "노드 없는 행에 노드를 지어 붙였다");
  assert.deepEqual(liveRow.node, { id: "n-mac", name: "스냅샷 이름", online: true }, "라이브 행을 덮었다");
});

test("[4065-B15] ★ 배선 — 목록 두 곳은 켜고, 휴지통 묶음은 안 켠다", () => {
  const read = (p: string) => fs.readFileSync(new URL(`../../src/${p}`, import.meta.url), "utf8");
  const call = /listRestorableSessions\([^;]*?\{\s*startingGraceMs:\s*SESSION_STARTING_GRACE_MS\s*\}\)/;
  assert.match(read("terminal/routes.ts"), call, "🔴 AI 세션 탭 목록이 유예를 안 켠다 — 갓 만든 세션이 대화창으로 열린다");
  assert.match(read("project/project-routes.ts"), call, "🔴 프로젝트 세션 목록이 유예를 안 켠다 — 두 목록의 답이 갈린다");
  assert.doesNotMatch(read("capabilities/projects-v6.ts"), /startingGraceMs/,
    "휴지통 묶음이 유예를 켰다 — 도는 세션을 «지난 세션» 에서 뺄 수 없게 된다");
});
