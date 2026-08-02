// #177 아웃바운드 write-through — 로컬 편집(web/MCP)을 외부 PM(ClickUp)로 푸시할 아웃박스 적재.
//  우리 DB=master: project/task/subtask 의 로컬 생성·수정·삭제를 외부 미러에 반영한다.
//  ⚠ 루프 차단: 커넥터(인바운드)는 connector-mirror 가 project 테이블에 직접 INSERT 하므로 project-store 를
//     거치지 않는다 → 여기 적재 안 됨. 추가 방어로 source='connector' 면 enqueue skip.
//  coalesce: pending(done_at NULL)은 (system, entity_id)당 1행 — 여러 편집이 한 번의 푸시로 수렴(드레인이 현재 행 재읽기).
import { itemsPool } from "../db/client.js";
import type { WriteCtx } from "./content-audit.js";
import { logger } from "../log.js";

export type OutboxOp = "upsert" | "delete";

// 외부 푸시 아웃박스에 적재(best-effort — 적재 실패가 본 쓰기를 깨면 안 됨; 다음 편집/백필이 수렴).
//  op='delete' 는 ext_id_snapshot(삭제 전 external_id)을 실어 행 삭제 후에도 외부 삭제 가능.
export async function enqueueExternalPush(
  entityId: number,
  op: OutboxOp,
  ctx?: WriteCtx,
  extIdSnapshot?: string | null,
): Promise<void> {
  if (ctx?.source === "connector") return; // 인바운드 미러 쓰기는 푸시 안 함(루프 차단).
  try {
    await itemsPool.query(
      `INSERT INTO external_outbox(entity_id, system, op, ext_id_snapshot)
       VALUES($1,'clickup',$2,$3)
       ON CONFLICT (system, entity_id) WHERE done_at IS NULL
       DO UPDATE SET op=EXCLUDED.op,
         ext_id_snapshot=COALESCE(EXCLUDED.ext_id_snapshot, external_outbox.ext_id_snapshot),
         updated_at=now(), attempts=0, last_error=NULL`,
      [entityId, op, extIdSnapshot ?? null],
    );
  } catch (e) {
    logger.warn({ err: e, entityId, op }, "external_outbox enqueue 실패(무시 — 본 쓰기는 성공)");
  }
}
