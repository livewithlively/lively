// «못 봤다» 가 «작업 완료» 로 둔갑하던 것 (#2544 후속, 상민님 신고 2026-09-10) — 값으로 고정한다.
//  사양·엣지 표(E1~E15)는 스크래치패드 spec.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
//  실측: 매니지드 중계가 끊긴 틱에 서버가 DB desired 행으로 목록을 채우는데(observed:false), 그 행은
//   열람 시각(lastAttached·lastViewed)과 restorable 을 **아예 안 싣는다**(tmux 만 아는 값이라 DB 에 없다).
//   화면이 그 표식을 한 곳도 안 읽어서 한 틱에 세 가지가 함께 났다:
//    ① 최근 24시간 안에 작업한 세션이 **전량 초록 '작업 완료'** (열람 0 → «작업 > 열람» 이 늘 참)
//    ② restorable 이 없어 「살아 있는 세션」으로 그려져 사이드바 날짜 컷을 **우회** → 지난 세션 수백 줄 부활
//    ③ ①의 상태 변화가 「치움」 판정을 깨서 **치워 둔 행까지 전부 부활**
//   사용자가 `/exit` 로 직접 죽인 세션이 «작업 완료» 로 떴다 사라진 것이 이 증상이다.
//
//  ⚠ 값과 소스텍스트를 함께 보는 이유(log-rows.test.mjs 와 같다): 잇는 **규칙**이 맞아도 화면이 그걸
//   안 부르면 그대로고, 판정 두 자리(초록점·살아있음)가 표식을 안 보면 되돌린 값이 소용없다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { keepObserved, OBS_CARRY_MS } = await import(join(root, "public/app/v2/obs-carry.js"));
const { isUnreadDone, sessStateKey } = await import(join(root, "public/app/session-status.js"));

const T0 = 1_800_000_000_000;      // 고정 시각(ms) — 경계를 결정론적으로 본다
const sec = (ms) => Math.floor(ms / 1000);

/** 관측된 행 — tmux 에서 읽은 것. «모름» 표식이 없다. */
const observedRow = (over = {}) => ({
  id: "box-a", label: "tmux 호출 계수", projectId: 2600,
  agentState: "offline", attached: false, working: false, awaiting: false, title: "",
  lastActive: sec(T0) - 600, lastAttached: sec(T0) - 300, lastViewed: sec(T0) - 120,
  ...over,
});
/** 중계가 못 본 틱의 폴백 행 — 서버 unobservedSessionInfo 가 내는 모양 그대로(열람 시각·restorable 없음). */
const fallbackRow = (over = {}) => ({
  id: "box-a", label: "tmux 호출 계수", projectId: 2600,
  agentState: "offline", attached: false, working: false, awaiting: false, title: "",
  lastActive: sec(T0) - 600,      // DB 미러 — 이 값만 실려 온다
  observed: false,
  ...over,
});

// ── E1 관측된 판은 그대로 지나가고 기억에 남는다 ─────────────────────────────
{
  const mem = new Map();
  const row = observedRow();
  const [out] = keepObserved([row], mem, T0);
  assert.equal(out, row, "관측된 행은 손대지 않는다");
  assert.equal(mem.size, 1);
  assert.equal(mem.get("box-a").at, T0);
  ok(true, "E1 관측된 판은 그대로 통과하고 기억에 남는다");
}

// ── E2 못 본 판은 직전 관측으로 되돌아온다 ──────────────────────────────────
{
  const mem = new Map();
  keepObserved([observedRow({ agentState: "busy", working: true, lastActive: sec(T0) - 30 })], mem, T0);
  const [carried] = keepObserved([fallbackRow()], mem, T0 + 20_000);
  assert.equal(carried.agentState, "busy");
  assert.equal(carried.working, true);
  assert.equal(carried.lastActive, sec(T0) - 30);
  assert.equal(carried.lastAttached, sec(T0) - 300, "열람 시각이 되살아나야 «안 본 결과» 오판이 안 난다");
  assert.equal(carried.observed, undefined, "되돌린 행은 «직전에 관측한 그 행» 이라 표식이 남으면 안 된다");
  assert.equal(sessStateKey(carried, T0 + 20_000), "busy", "상태도 직전 그대로 — 한 틱 '작업 완료' 로 뒤집히지 않는다");
  ok(true, "E2 못 본 판은 직전 관측으로 되돌아온다 — 화면이 한 픽셀도 안 움직인다");
}

// ── E3 좌표는 새 응답이 정본 ────────────────────────────────────────────────
{
  const mem = new Map();
  keepObserved([observedRow({ label: "옛 이름", projectId: 1 })], mem, T0);
  const [carried] = keepObserved([fallbackRow({ label: "새 이름", projectId: 2, trashedAt: "2026-09-10T00:00:00Z" })], mem, T0 + 1_000);
  assert.equal(carried.label, "새 이름");
  assert.equal(carried.projectId, 2);
  assert.equal(carried.trashedAt, "2026-09-10T00:00:00Z");
  ok(true, "E3 이름·소속·휴지통 표식은 새 응답 것 — DB 가 아는 사실은 폴백에도 정확히 실린다");
}

// ── E4 기억이 없으면 지어내지 않는다(콜드 스타트) ────────────────────────────
{
  const mem = new Map();
  const [row] = keepObserved([fallbackRow()], mem, T0);
  assert.equal(row.observed, false, "이을 것이 없으면 표식을 그대로 남겨 두 판정이 막게 한다");
  assert.equal(isUnreadDone(row, T0), false);
  assert.equal(sessStateKey(row, T0), "offline", "초록점도, 거짓 '중단됨' 도 아니다");
  ok(true, "E4 장애 중 첫 진입 — 상태를 지어내지 않는다");
}

// ── E5 경계: 기억 나이가 정확히 임계면 **잇는다** ────────────────────────────
{
  const mem = new Map();
  keepObserved([observedRow({ agentState: "busy", working: true })], mem, T0);
  const [still] = keepObserved([fallbackRow()], mem, T0 + OBS_CARRY_MS);
  assert.equal(still.working, true, "정확히 임계인 순간은 아직 '잠깐의 끊김' 이다");
  assert.equal(still.observed, undefined);
  ok(true, "E5 임계 경계 — 나이 == 임계는 잇는다(오프바이원)");
}

// ── E6 오래 못 보면 잇기를 그만두고 기억을 버린다 ────────────────────────────
{
  const mem = new Map();
  keepObserved([observedRow({ agentState: "busy", working: true })], mem, T0);
  const [faded] = keepObserved([fallbackRow()], mem, T0 + OBS_CARRY_MS + 1);
  assert.equal(faded.observed, false);
  assert.equal(faded.working, false);
  assert.equal(sessStateKey(faded, T0 + OBS_CARRY_MS + 1), "offline", "점은 꺼지되 «관측 안 됨» 이라고 말하지는 않는다");
  assert.equal(mem.size, 0, "낡은 기억은 버린다 — 세션 수백 개 계정에서 무한히 자라지 않는다");
  ok(true, "E6 장애가 길어지면 점이 조용히 꺼진다");
}

// ── E7 id 없는 행 ───────────────────────────────────────────────────────────
{
  const mem = new Map();
  const odd = { label: "id 가 없다", observed: false };
  const [out] = keepObserved([odd], mem, T0);
  assert.equal(out, odd);
  assert.equal(mem.size, 0, "지목할 수 없는 행을 기억에 담으면 남의 행에 그 값이 붙는다");
  ok(true, "E7 id 없는 행은 그대로 통과하고 기억에 안 남는다");
}

// ── E8 기억에 없던 관측 필드는 되돌린 행에도 없다 ────────────────────────────
{
  const mem = new Map();
  //  직전 관측엔 title 이 없었는데(그 세션은 pane 제목이 빈 채였다) 폴백 행이 title 을 들고 왔다.
  const prev = observedRow(); delete prev.title;
  keepObserved([prev], mem, T0);
  const [carried] = keepObserved([fallbackRow({ title: "지어낸 제목" })], mem, T0 + 1_000);
  assert.equal("title" in carried, false, "폴백이 지어낸 관측값이 되돌린 행에 남으면 안 된다");
  ok(true, "E8 기억에 없던 관측 필드는 «없음» 그대로 남는다");
}

// ── E9 배열이 아닌 입력 ─────────────────────────────────────────────────────
{
  assert.deepEqual(keepObserved(null, new Map(), T0), []);
  assert.deepEqual(keepObserved(undefined, new Map(), T0), []);
  ok(true, "E9 배열이 아니면 빈 목록 — 응답이 깨져도 화면이 던지지 않는다");
}

// ── E10 관측이 돌아오면 그 값이 곧 정본 ─────────────────────────────────────
{
  const mem = new Map();
  keepObserved([observedRow({ agentState: "busy", working: true })], mem, T0);
  keepObserved([fallbackRow()], mem, T0 + 1_000);
  const [back] = keepObserved([observedRow({ agentState: "idle", working: false })], mem, T0 + 2_000);
  assert.equal(back.agentState, "idle", "관측이 돌아오면 되돌리기가 그 값을 덮지 않는다");
  assert.equal(mem.get("box-a").at, T0 + 2_000, "기억도 새 관측으로 갱신된다");
  ok(true, "E10 관측 재개 — 새 값이 곧 정본이고 기억도 갱신된다");
}

// ── E11·E12 「안 본 작업 완료」 판정이 표식을 본다 ───────────────────────────
{
  assert.equal(isUnreadDone(fallbackRow({ lastActive: sec(T0) - 60 }), T0), false);
  ok(true, "E11 관측 못 한 행은 '작업 완료'가 아니다 — 열람 시각이 없다고 «안 봤다» 로 읽지 않는다");
  assert.equal(isUnreadDone(observedRow({ lastAttached: 0, lastViewed: 0, lastActive: sec(T0) - 60 }), T0), true);
  ok(true, "E12 관측된 행은 종전 그대로 승격된다 — 가드가 멀쩡한 초록점까지 끄지 않는다");
}

// ── E13 상태 key ────────────────────────────────────────────────────────────
{
  assert.equal(sessStateKey(fallbackRow({ lastActive: sec(T0) - 60 }), T0), "offline");
  ok(true, "E13 «모름» 행의 상태는 점 없는 '오프라인'");
}

// ── E14·E15 화면이 실제로 이 규칙을 지난다 ──────────────────────────────────
{
  const views = read("web/v2/views.ts");
  ok(/r\.observed === false \? false : !sessIsDead\(r, now\)/.test(views),
    "E14 세션 목록 조립이 «못 본 행» 을 살아 있다고 말하지 않는다 — 없으면 날짜 컷이 통째로 우회된다");
  const main = read("web/v2/main.ts");
  ok(/keepObserved\(live as any\[\], obsMemory\)/.test(main),
    "E15 loadData 가 세션 응답을 keepObserved 로 받는다 — 규칙이 맞아도 안 부르면 그대로다");
}

console.log(`\n${pass} passed`);
