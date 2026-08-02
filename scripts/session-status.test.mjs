// AI 세션 상태 어휘 (#1059 감사 P1) — 두 화면이 공유하는 판정 표를 고정한다.
//  컴파일 결과(public/app/session-status.js)를 그대로 import 한다(DOM 무의존 순수 모듈이라 가능).
//
// 이 표가 틀렸을 때 실제로 났던 일:
//  🔴 셸 세션이 '종료됨'으로 표시됐다 — 고객사 A의 '종료됨' 3건이 전부 **살아 있는** 셸 세션이었고, 사용자는
//     정리 대상으로 오인했다.
//  🔴 카드는 '종료됨'인데 필터 '종료됨'엔 안 잡히고 '복원 가능'에 잡혔다(라벨과 버킷이 어긋남).
//  🔴 대시보드에서 '종료됨'을 고르면 **오프라인까지** 딸려왔다(3건 고르려다 45건).
//  🔴 '작업 완료'가 대시보드에만 있어, 가장 행동을 요하는 상태가 AI 세션 탭에선 '대기 중'에 묻혔다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = await import(join(root, "public/app/session-status.js"));
const { SESS_STATES, SESS_STATE_KEYS, sessStateKey, sessLabel, sessRank, sessIsDead, isUnreadDone } = mod;

let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const eqk = (s, want, n, now) => { assert.equal(sessStateKey(s, now), want, `${n}: '${want}' 여야 하는데 '${sessStateKey(s, now)}'`); ok(n); };

const NOW = 1_800_000_000_000;           // 고정 시각(ms) — 24h 가드 경계를 결정론적으로 본다
const nowSec = NOW / 1000;

// ── 상태 판정 표 ──
eqk({ agentState: "shell", harness: "shell" }, "shell", "①셸 하네스 세션은 'shell' — 종전처럼 '종료됨' 아님");
// claude 가 끝나 셸만 남은 것도 사용자 눈엔 같은 '셸'이다(백엔드는 두 값을 구분해 주지만 표시는 한 칸).
eqk({ agentState: "exited", harness: "claude" }, "shell", "②AI 가 끝나 셸만 남은 세션도 '셸' — 살아 있으므로");
eqk({ restorable: true, exitedByUser: false }, "restorable", "③재부팅·회수로 중단 = 복원 가능");
eqk({ restorable: true, exitedByUser: true }, "exited_user", "④내가 exit = 별도 key(종전엔 restorable 에 묶여 필터가 어긋났다)");
eqk({ agentState: "busy" }, "busy", "⑤작업 중");
eqk({ agentState: "waiting" }, "waiting", "⑥확인 필요");
eqk({ agentState: "idle" }, "idle", "⑦대기 중");
eqk({ agentState: "offline" }, "offline", "⑧오프라인(탭 없음 — 프로세스는 살아 있다)");
eqk({}, "shell", "⑨상태 미상 → '셸' 폴백(tmux 에 살아 있으면 셸이 떠 있다)");
eqk({ agentState: "무슨상태" }, "shell", "⑩모르는 값 → '셸' 폴백(정의에 없는 key 를 그대로 쓰지 않는다)");

// restorable 은 agentState 보다 먼저 — 서버가 offline 으로 주지만 복원 가능이 더 구체적인 사실이다.
eqk({ agentState: "offline", restorable: true, exitedByUser: false }, "restorable", "⑪복원 가능이 agentState 보다 앞선다");

// ── '작업 완료'(안 본 결과) ──
eqk({ agentState: "idle", lastActive: nowSec - 60, lastAttached: nowSec - 600 }, "done",
  "⑫작업이 마지막 열람보다 뒤 + 24h 내 → 작업 완료", NOW);
eqk({ agentState: "offline", lastActive: nowSec - 60, lastAttached: nowSec - 600 }, "done",
  "⑬탭을 닫은 사이 끝난 것도 작업 완료", NOW);
eqk({ agentState: "idle", lastActive: nowSec - 600, lastAttached: nowSec - 60 }, "idle",
  "⑭이미 열어봤으면(열람이 더 최신) 작업 완료 아님 — 들어가 보면 자동 해제", NOW);
eqk({ agentState: "idle", lastActive: nowSec - 25 * 3600, lastAttached: nowSec - 30 * 3600 }, "idle",
  "⑮24h 넘으면 알림이 아니라 이력 → 승격 안 함", NOW);
eqk({ agentState: "busy", lastActive: nowSec - 60, lastAttached: nowSec - 600 }, "busy",
  "⑯작업 중이면 '작업 완료'로 덮지 않는다(아직 안 끝났다)", NOW);
eqk({ restorable: true, lastActive: nowSec - 60, lastAttached: nowSec - 600 }, "restorable",
  "⑰복원 가능 세션은 '작업 완료'로 승격하지 않는다", NOW);
assert.equal(isUnreadDone({ agentState: "idle", lastActive: 0, lastAttached: 0 }, NOW), false);
ok("⑱작업 기록이 없으면 '작업 완료' 판정 불가(false)");

// ── 라벨·필터 일치 (감사 P1-②) ──
{
  assert.equal(sessLabel({ restorable: true, exitedByUser: true }), "종료됨");
  assert.equal(sessLabel({ restorable: true, exitedByUser: false }), "중단됨");
  assert.equal(sessLabel({ agentState: "exited" }), "셸");
  assert.equal(sessLabel({ agentState: "shell" }), "셸");
  ok("⑲'중단됨'(끊김) · '종료됨'(내가 exit) · '셸'(지금 셸이 떠 있음) 이 서로 다른 문구");
}
{
  // 카드 라벨과 필터 항목이 **같은 집합**이어야 한다 — 이게 어긋나면 "고른 것과 다른 결과"가 나온다.
  const filterLabels = SESS_STATE_KEYS.map((k) => SESS_STATES[k].label);
  assert.equal(new Set(filterLabels).size, filterLabels.length, "필터 라벨에 중복이 있으면 사용자가 구분할 수 없다");
  for (const k of SESS_STATE_KEYS) assert.ok(SESS_STATES[k], `필터 key ${k} 의 정의가 없다`);
  assert.deepEqual(SESS_STATE_KEYS.slice().sort(), Object.keys(SESS_STATES).sort(),
    "정의된 상태와 필터 항목이 1:1 이어야 한다(빠진 칸이 곧 '고를 수 없는 상태')");
  ok("⑳필터 항목 = 정의된 상태 전부, 라벨 중복 없음");
}

// ── 정렬 우선순위 ──
{
  const order = ["waiting", "done", "busy", "idle", "offline", "shell", "restorable", "exited_user"];
  const ranks = order.map((k) => SESS_STATES[k].rank);
  assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), "'지금 볼 것 먼저' 순서가 단조여야 한다");
  assert.ok(SESS_STATES.waiting.rank < SESS_STATES.done.rank, "확인 필요가 작업 완료보다 먼저");
  assert.ok(SESS_STATES.done.rank < SESS_STATES.idle.rank, "작업 완료가 대기 중보다 먼저(#1098 위계)");
  ok("㉑정렬 우선순위: 확인 필요 → 작업 완료 → 작업 중 → 대기 중 → …");
}

// ── '끝남' 판정 (감사 P1-③) ──
{
  assert.equal(sessIsDead({ agentState: "offline" }), false, "오프라인은 끝난 게 아니다(프로세스 살아 있음)");
  assert.equal(sessIsDead({ agentState: "shell" }), false, "셸 세션은 살아 있다");
  assert.equal(sessIsDead({ agentState: "exited" }), false, "AI 가 끝나도 셸이 떠 있으면 들어가서 쓸 수 있다");
  assert.equal(sessIsDead({ restorable: true }), true);
  assert.equal(sessIsDead({ restorable: true, exitedByUser: true }), true);
  ok("㉒'끝남' = 중단됨·종료됨 (tmux 에서 사라진 것들만 — 셸·오프라인은 살아 있다)");
}

// ── #1251 메모리 부족(OS 강제 종료) ──────────────────────────────────────────────────────
// 재부팅·자동회수('중단됨')와 **다른 사실**이다. 한 칸으로 뭉뚱그리면 사용자는 자기 세션이 왜 사라졌는지
//  모른 채 원인을 엉뚱한 데서 찾는다.
{
  assert.equal(sessStateKey({ restorable: true, oomKilled: true }), 'oom_killed');
  ok("㉓ 메모리 부족으로 죽은 세션은 '중단됨'과 다른 칸");

  assert.equal(sessStateKey({ restorable: true }), 'restorable');
  ok("㉔ 대조군 — 사유가 없으면 종전대로 '중단됨'(과잉 분류 금지)");

  // 우선순위: 사용자가 /exit 한 것은 **확정 사실**, OOM 표시는 관측 기반 **추정**. 겹치면 확정이 이긴다.
  assert.equal(sessStateKey({ restorable: true, exitedByUser: true, oomKilled: true }), 'exited_user');
  ok("㉕ 사용자 종료가 OOM 추정을 이긴다(확정 > 추정)");

  assert.equal(SESS_STATES.oom_killed.label, '메모리 부족');
  assert.ok(SESS_STATE_KEYS.includes('oom_killed'), '필터 버킷에도 있어야 카드와 필터가 안 갈린다');
  ok("㉖ 라벨·필터 버킷 등록(카드에만 있고 필터에 없으면 감사 P1-② 재현)");

  // 살아있는 세션에는 절대 안 붙는다 — restorable 이 아니면 OOM 표시가 있어도 무시.
  assert.equal(sessStateKey({ restorable: false, oomKilled: true, agentState: 'idle', attached: true }), 'idle');
  ok("㉗ 살아있는 세션엔 안 붙는다(restorable 일 때만 의미 있는 사실)");
}

console.log(`\n${pass} passed`);
