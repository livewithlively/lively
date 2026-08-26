// 유령 세션 인스턴스 청소(#2022) — 세션은 사라졌는데 그 세션을 subject 로 쥔 앱 인스턴스가 active 로 남은 행.
//  좌측 '열린 앱' 목록은 이 행들을 그대로 그리는데, 세션 목록에는 그 id 가 없으므로 이름이 `세션 <id꼬리>` 로,
//  소속이 '프로젝트 없음' 으로 떨어진다 — 되살릴 수도 없는 행이 영영 그 모습으로 남는다(실측 2026-08-26,
//  yoon 계정: 세션 인스턴스 65건 중 26건이 어느 목록에도 없는 id 를 가리켰다).
//
//  세션이 정상 경로로 끝나면 그 자리에서 닫힌다(terminal/routes.ts kill·restore, session-trash-ops 완전삭제).
//  이 스윕은 **그 경로를 안 탄 잔재**(그 배선 이전에 죽은 것, 재부팅으로 증발한 것)를 뒤늦게 치운다.
//
//  ⚠ 판정은 **건별 확답**이다 — 전역 목록으로 '없더라'를 추론하지 않는다.
//   `sessionGone(id)` 는 tmux 가 "그런 세션 없다"고 **확답**할 때만 true 다(소켓 불통·타임아웃은 false, #835).
//   종전 초안은 `listSessionsRaw({strict:true})` 한 번으로 살아있는 id 집합을 만들어 그 여집합을 유령으로 봤는데,
//   그 방식은 (a) 그 인자가 없는 배포(서빙 브랜치)에서 안전장치째 사라지고 (b) '못 물어봤다'와 '없다'를 한 번의
//   전역 판정에 몰아넣는다. 건별 확답은 두 문제가 다 없다.
//
//  ⚠ 되돌릴 수 있는 일만 한다 — 세션을 죽이지 않는다. 인스턴스를 닫을 뿐이고, 그 세션을 다시 열면
//   createAppInstance 가 같은 행을 status='active' 로 되살린다. 그래서 오프라인 노드의 세션을 잘못 닫더라도
//   손실은 '좌측 목록에서 잠깐 빠짐'이지 데이터가 아니다.
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { sessionGone } from "../terminal/terminal-sessions.js";
import { listAllSessionStates } from "../sessions/session-state.js";
import { nodeOfSession } from "../node/registry.js";
import { closeSessionAppInstances } from "../org/store/app-instances.js";

/** 이 나이가 지나도록 아무도 손대지 않은 인스턴스만 후보다(오프라인 노드가 돌아올 유예). */
const QUIET_MS = 3 * 24 * 60 * 60_000;
/** 한 판에 확인할 후보 상한 — 건별로 tmux 에 묻기 때문에 폭주를 막는다(남은 것은 다음 판에). */
const MAX_PER_SWEEP = 200;

export async function sweepGhostSessionInstances(): Promise<number> {
  const rows = (await itemsPool.query(
    `SELECT id, subject_ref FROM org_app_instance
      WHERE subject_kind='session' AND status='active' AND subject_ref IS NOT NULL
        AND updated_at < now() - ($1::bigint * interval '1 millisecond')
      ORDER BY updated_at ASC
      LIMIT $2`, [QUIET_MS, MAX_PER_SWEEP])).rows;
  if (!rows.length) return 0;

  // desired-state 가 있으면 유령이 아니다 — 되살릴 수 있는 세션이다.
  const restorable = new Set((await listAllSessionStates()).map((s) => s.id));

  let closed = 0;
  for (const r of rows) {
    const sid = String(r.subject_ref);
    if (restorable.has(sid)) continue;
    if (nodeOfSession(sid)) continue;                       // 노드 스냅샷에 살아 있다
    if (!(await sessionGone(sid).catch(() => false))) continue;   // tmux 확답 없으면 손대지 않는다
    closed += await closeSessionAppInstances(sid).catch((err) => {
      logger.warn({ err, sid }, "유령 인스턴스 닫기 실패(비치명)");
      return 0;
    });
  }
  if (closed) logger.info({ closed, checked: rows.length }, "유령 세션 인스턴스 정리");
  return closed;
}
