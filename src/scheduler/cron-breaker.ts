// 크론 연속 실패 서킷 브레이커(#1675 ④) — **계속 실패하는 잡은 스스로 멈춘다.**
//
// 어니스트 2026-08-12: 증류 크론이 10분마다 9건씩 위탁을 냈고 **200건 넘게 연속 실패**하는 동안 어떤
//  제동도 없었다. 잡 하나가 계속 실패하는 상태는 그 자체로 고장이지 다음 주기에 나아질 일이 아닌데,
//  스케줄러엔 "몇 번 실패했나"를 세는 자리조차 없었다.
//
// ③(자격 폐기 감지)과의 관계 — **중복이 아니라 계층이 다르다.**
//  ③은 원인을 알아보고 **첫 실패에** 멈춘다(자격). ④는 원인을 몰라도 **N회 뒤에** 멈춘다(그 외 전부:
//  프롬프트 오류·대상 데이터 문제·외부 API 장애). ③이 못 알아보는 실패의 안전망이 ④다.
//
// ⚠ **이 브레이커만으로는 이번 사고를 못 잡았다.** 증류 크론의 last_status 는 내내 `ok` 였다 —
//  헤드리스 액션의 책임은 '위탁 접수'까지라, 접수에 성공하면 ok 를 낸다. 정작 실패한 건 그 뒤의 위탁이다.
//  그래서 ③(위탁 결과를 보는 축)이 이 사고의 본선이고, ④는 보편적 안전망이다. 둘 다 필요하다.
//  (이 문단이 ④를 ③의 대체재로 오해하지 않게 하는 유일한 방어다 — 실측 근거:
//   지식 ernest-token-revoked-session-leak-outage-0812 의 "크론 요약의 status=ok 는 '접수 성공'".)

/** 크론 1회 실행의 결과 성격. `skipped`(중첩 락) 는 **실행 자체를 안 한 것**이라 판정에서 중립이다. */
export type CronRunStatus = "ok" | "error" | "skipped" | (string & {});

export interface BreakerDecision {
  /** 갱신할 연속 실패 카운터. */
  nextStreak: number;
  /** 이번 실행으로 자동 정지에 도달했나. */
  disable: boolean;
}

/**
 * 서킷 브레이커 판정(순수).
 *
 * 정책:
 *  - `error` → 연속 실패 +1. 그 값이 `max` 이상이면 정지.
 *  - `skipped` → **아무것도 바꾸지 않는다**(이전 실행이 아직 도는 중 = 이번 회차는 실행되지 않았다).
 *  - 그 외(`ok` 포함) → 0 으로 리셋.
 *  - `max <= 0` → 브레이커 끔(카운터는 계속 세되 정지하지 않는다 — 관측은 남는다).
 *
 * ⚠ 실패로 세는 건 **`error` 뿐**이다. 알 수 없는 status 를 실패로 몰면 새 액션이 다른 낱말을 반환하는
 *  순간 멀쩡한 잡이 꺼진다 — 자동 정지는 보수적이어야 한다.
 */
export function cronBreakerDecision(o: { status: CronRunStatus; streak: number; max: number }): BreakerDecision {
  const cur = Number.isFinite(o.streak) && o.streak > 0 ? Math.floor(o.streak) : 0;
  if (o.status === "skipped") return { nextStreak: cur, disable: false };
  if (o.status !== "error") return { nextStreak: 0, disable: false };
  const next = cur + 1;
  return { nextStreak: next, disable: o.max > 0 && next >= o.max };
}
