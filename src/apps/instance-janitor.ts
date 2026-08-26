// 유령 세션 인스턴스 청소(#2022) — 세션은 사라졌는데 그 세션을 subject 로 쥔 앱 인스턴스가 active 로 남은 행.
//  좌측 '열린 앱' 목록은 이 행들을 그대로 그리는데, 세션 목록에는 그 id 가 없으므로 이름이 `세션 <id꼬리>` 로,
//  소속이 '프로젝트 없음' 으로 떨어진다 — 되살릴 수도 없는 행이 영영 그 모습으로 남는다(실측 2026-08-26,
//  yoon 계정: 세션 인스턴스 65건 중 26건이 어느 목록에도 없는 id 를 가리켰다).
//
//  세션이 정상 경로로 끝나면 그 자리에서 닫힌다(terminal/routes.ts kill·restore, session-trash-ops 완전삭제).
//  이 스윕은 **그 경로를 안 탄 잔재**(그 배선 이전에 죽은 것, 재부팅으로 증발한 것)를 뒤늦게 치운다.
//
//  ⚠ 안전 규칙 셋 — 살아 있는 세션의 인스턴스를 잘못 닫지 않기 위해서다.
//   ① tmux 가 **확답**해야 한다(strict). 못 물어봤으면 '없다'가 아니라 '모른다'이므로 이번 판은 통째로 건너뛴다.
//   ② desired-state 가 있으면 손대지 않는다 — 그건 '되살릴 수 있는 세션'이지 유령이 아니다.
//   ③ 최근에 손댄 인스턴스는 두고, 조용한 지 오래된 것만 닫는다(오프라인 노드가 돌아올 시간을 준다).
//  닫기는 되돌릴 수 있다 — 그 세션을 다시 열면 createAppInstance 가 같은 행을 status='active' 로 되살린다.
import { itemsPool } from "../db/client.js";
import { logger } from "../log.js";
import { listSessionsRaw } from "../terminal/terminal-sessions.js";
import { listAllSessionStates } from "../sessions/session-state.js";
import { nodeOfSession } from "../node/registry.js";
import { closeSessionAppInstances } from "../org/store/app-instances.js";

/** 이 나이가 지나도록 아무도 손대지 않은 인스턴스만 후보다(오프라인 노드가 돌아올 유예). */
const QUIET_MS = 3 * 24 * 60 * 60_000;

export async function sweepGhostSessionInstances(): Promise<number> {
  // ① tmux 확답 — 실패하면 아무것도 닫지 않는다.
  let liveIds: Set<string>;
  try { liveIds = new Set((await listSessionsRaw({ strict: true })).map((s) => s.id)); }
  catch (err) { logger.warn({ err }, "유령 인스턴스 스윕 건너뜀 — tmux 확답 없음"); return 0; }

  const rows = (await itemsPool.query(
    `SELECT id, subject_ref FROM org_app_instance
      WHERE subject_kind='session' AND status='active' AND subject_ref IS NOT NULL
        AND updated_at < now() - ($1::bigint * interval '1 millisecond')`, [QUIET_MS])).rows;
  if (!rows.length) return 0;

  // ② desired-state 가 있으면 유령이 아니다(복원 가능).
  const restorable = new Set((await listAllSessionStates()).map((s) => s.id));

  let closed = 0;
  for (const r of rows) {
    const sid = String(r.subject_ref);
    if (liveIds.has(sid) || restorable.has(sid)) continue;
    if (nodeOfSession(sid)) continue;                       // 노드 스냅샷에 살아 있다
    closed += await closeSessionAppInstances(sid).catch((err) => {
      logger.warn({ err, sid }, "유령 인스턴스 닫기 실패(비치명)");
      return 0;
    });
  }
  if (closed) logger.info({ closed }, "유령 세션 인스턴스 정리");
  return closed;
}
