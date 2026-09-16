// 위탁 배정이 **왜** 안 됐는지를 한 낱말로 — 사람 문장 옆에 코드 축을 둔다 (#3994 T5 · #968).
//
// 왜 필요한가: 지금 배정 실패는 **사람이 읽는 문장 하나**로만 돌아온다(task-scheduler.capacityReason).
//  그래서 «자리가 없어 잠깐 기다리는 것»과 «이 배포에선 영영 못 도는 것»이 호출자에게 같아 보이고,
//  크론은 둘 다 ok 로 적었다 — #968 이 정확히 그 자리다(위탁 199/200 실패, 크론 last_status 는 내내 ok,
//  파이프라인 화면은 초록). 문자열을 파싱해 가르면 문구를 고치는 순간 조용히 깨지므로 **코드**로 싣는다.
//
// ⚠ 이 파일은 순수다(DB·프로세스 접근 없음) — 판정만 담고, 문장·기록은 호출부가 한다.

/** 배정이 실패한 이유의 종류. 문장(reason)과 **함께** 싣는다 — 문장은 사람용, 코드는 판정용. */
export type AssignFailCode =
  /** 후보 자체가 0 — 자격·소유 규칙상 이 의뢰자가 쓸 수 있는 노드가 없다. */
  | "no_nodes"
  /** 후보는 있는데 그 하네스를 보고한 노드가 없다(#1884 축). */
  | "no_harness"
  /** 후보도 하네스도 있는데 지금 자리가 없다 — 슬롯 만석·RAM·디스크·코어. */
  | "capacity"
  /** 고른 노드가 그 사이 비활성이 됐다. */
  | "node_disabled"
  /** 판을 띄우다 예외가 났다(스폰 실패·RPC 오류). */
  | "spawn_error"
  /**
   * 실행 멤버에게 그 하네스 자격이 없다(#4012 T2) — 기다려도 안 풀린다. 사람이 등록해야 한다.
   *  종전엔 이 경우가 «적합 노드 없음» 으로 10분 뒤에야 드러났다.
   */
  | "no_credential";

/**
 * 이 실패가 «기다리면 풀리는 것»인가, «사람이 봐야 하는 것»인가(순수).
 *
 * ⚠ 코드가 없으면(옛 호출부·미지정) **fault** 로 본다 — 모르는 실패를 «정상 배압» 으로 적으면
 *  그게 곧 #968 의 재발이다. 보수적인 쪽이 안전하다.
 */
export function assignFailKind(code: AssignFailCode | undefined | null): "backpressure" | "fault" {
  return code === "capacity" ? "backpressure" : "fault";
}

/**
 * 헤드리스 접수 잡이 크론에 적을 상태(순수).
 *
 *  · 배정됨 → `ok`
 *  · 자리가 없어 큐에 남음(`capacity`) → `ok` — 다음 tick 이 집어간다. 이건 정상 배압이다.
 *  · 그 밖의 미배정(후보 없음·하네스 없음·노드 비활성·스폰 예외) → `error`
 *
 * 이 값이 곧 `org_cron.last_status` 이고 서킷 브레이커(cron-breaker)의 입력이다 — 즉 여기서
 *  `ok` 를 내면 **연속 실패가 세지지 않아** 잡이 영원히 헛돈다(#968 은 10시간 동안 그랬다).
 */
export function headlessEnqueueStatus(o: { assigned: boolean; code?: AssignFailCode | null }): "ok" | "error" {
  if (o.assigned) return "ok";
  return assignFailKind(o.code) === "backpressure" ? "ok" : "error";
}
