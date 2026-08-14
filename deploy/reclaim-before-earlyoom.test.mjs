// 압박 회수 ↔ earlyoom 경합 회귀락 (#1675 ⑤).
//
// 이 테스트가 지키는 약속은 하나다: **게이트웨이 압박 회수가 earlyoom 보다 먼저 동작한다.**
//  그게 이 기능의 존재 이유이고(회수는 desired-state 를 보존해 복원 가능하지만 earlyoom 의 SIGTERM 은
//  예고 없이 세션을 지운다), 어니스트 2026-08-12 에 **지켜지지 않았다**: 그 박스는 pressure_used_pct=95 로
//  켜져 있었는데 earlyoom 은 94%(=`-m 6`)에서 발동한다. 1%p 차이로 우리 방어는 한 번도 못 돌았다.
//
// 두 값은 **다른 파일**에 산다 — 정책 상수는 TypeScript, earlyoom 인자는 셸 스크립트. 그래서 한쪽만 바뀌면
//  아무도 모르게 약속이 깨진다. 여기서 둘을 묶는다.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.join(here, "..");
const sh = fs.readFileSync(path.join(here, "lib", "common.sh"), "utf8");

// 배선 단언 — 엉뚱한 파일을 읽고 조용히 통과하지 않게(vacuous 방지).
assert.ok(/ensure_host_memory_safety\(\)/.test(sh), "common.sh 에서 메모리 안전장치 함수를 찾지 못했다");
const argsM = /local args="([^"]+)"/.exec(sh);
assert.ok(argsM, "EARLYOOM_ARGS args 정의를 찾지 못했다");
const args = argsM[1];

// ── earlyoom 이 실제로 발동하는 사용률을 셸에서 읽어낸다 ──
//  earlyoom 은 `MemAvailable% <= -m` 에서 발동하므로, 사용률로 환산하면 100 - m 이다.
const mM = /-m\s+(\d+)/.exec(args);
assert.ok(mM, "-m 인자를 못 찾았다 — earlyoom 발동선을 알 수 없다");
const earlyoomUsedPct = 100 - Number(mM[1]);

const policy = await import(path.join(repo, "dist", "sessions", "session-reclaim-policy.js"));
const {
  EARLYOOM_TRIGGER_USED_PCT, RECLAIM_PRESSURE_PCT_MAX, RECLAIM_SWAP_PCT_MAX,
  normalizeSessionReclaimPolicy,
} = policy;

// ① 코드가 아는 earlyoom 발동선 == 실제로 배포되는 값. 어긋나면 그 뒤 계산이 전부 헛것이다.
assert.equal(EARLYOOM_TRIGGER_USED_PCT, earlyoomUsedPct,
  `코드 상수(${EARLYOOM_TRIGGER_USED_PCT}%)와 배포되는 earlyoom 발동선(${earlyoomUsedPct}% = -m ${mM[1]})이 다르다`
  + " — 한쪽만 고쳤다. 둘을 맞춰라.");

// ② 정책으로 고를 수 있는 가장 늦은 임계조차 earlyoom 보다 앞서야 한다.
assert.ok(RECLAIM_PRESSURE_PCT_MAX < EARLYOOM_TRIGGER_USED_PCT,
  `압박 임계 상한(${RECLAIM_PRESSURE_PCT_MAX})이 earlyoom(${EARLYOOM_TRIGGER_USED_PCT})보다 늦다`
  + " — 그 값을 고른 운영자의 방어는 영원히 안 돈다(어니스트 95% 가 정확히 그랬다).");
// 5분 tick 이 도는 사이의 여유가 있어야 한다 — 1%p 여유는 여유가 아니다.
assert.ok(EARLYOOM_TRIGGER_USED_PCT - RECLAIM_PRESSURE_PCT_MAX >= 3,
  `여유가 ${EARLYOOM_TRIGGER_USED_PCT - RECLAIM_PRESSURE_PCT_MAX}%p 뿐이다 — 회수 tick 은 5분 주기다.`);

// ③ **어니스트가 실제로 쓰던 값(95)을 넣으면 유효 범위로 접혀야 한다.** 기존 박스가 update 만 받아도 고쳐진다.
{
  const p = normalizeSessionReclaimPolicy({ pressure_used_pct: 95 });
  assert.ok(p.pressure_used_pct <= RECLAIM_PRESSURE_PCT_MAX,
    `95 를 저장했더니 ${p.pressure_used_pct} 로 남았다 — earlyoom 뒤에 서는 설정이 계속 가능하다`);
  assert.ok(p.pressure_used_pct < EARLYOOM_TRIGGER_USED_PCT);
}

// ④ 스왑 축은 earlyoom 과 **경합하지 않는다** — 그 근거(`-s 100`= 스왑 조건 무시)가 실제 인자에 있어야
//   RECLAIM_SWAP_PCT_MAX 를 99 까지 열어둔 판단이 성립한다. `-s` 가 낮아지면 이 전제가 깨진다.
{
  const sM = /-s\s+(\d+)(?:,(\d+))?/.exec(args);
  assert.ok(sM, "-s 인자를 못 찾았다");
  assert.equal(Number(sM[1]), 100,
    "earlyoom 이 스왑 조건을 다시 보기 시작했다(-s < 100) — 그러면 스왑 축도 earlyoom 과 경합하므로"
    + " RECLAIM_SWAP_PCT_MAX(99)를 그대로 두면 안 된다. 이 전제를 다시 검토하라.");
  assert.equal(RECLAIM_SWAP_PCT_MAX, 99, "스왑 축 상한이 바뀌었다 — 위 전제와 함께 검토하라");
}

// ⑤ 기본값은 여전히 '끔'이다(무회귀) — 이 프로젝트는 상한을 조인 것이지 자동으로 켜는 게 아니다.
{
  const d = normalizeSessionReclaimPolicy({});
  assert.equal(d.pressure_used_pct, 0, "압박 회수가 기본으로 켜졌다 — 무회귀 원칙 위반");
  assert.equal(d.pressure_swap_pct, 0, "스왑 압박 회수가 기본으로 켜졌다 — 무회귀 원칙 위반");
}

console.log("reclaim-before-earlyoom.test: ok");
