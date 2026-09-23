// #177 아웃바운드 write-through — 로컬 편집(web/MCP)을 외부 PM(ClickUp)로 푸시할 아웃박스 적재.
//  우리 DB=master: project/task/subtask 의 로컬 생성·수정·삭제를 외부 미러에 반영한다.
//  ⚠ 루프 차단: 커넥터(인바운드)는 connector-mirror 가 project 테이블에 직접 INSERT 하므로 project-store 를
//     거치지 않는다 → 여기 적재 안 됨. 추가 방어로 source='connector' 면 enqueue skip.
//  coalesce: pending(done_at NULL)은 (system, entity_id)당 1행 — 여러 편집이 한 번의 푸시로 수렴(드레인이 현재 행 재읽기).
import { itemsPool } from "../db/client.js";
import type { WriteCtx } from "./content-audit.js";
import { logger } from "../log.js";

export type OutboxOp = "upsert" | "delete";

// 닫힘 근거 노트 — 닫힘은 쓰는 순간에만 before→after 로 판정된다(드레인은 합쳐진 현재 행만 봐서 «방금 닫혔나»를 모른다).
//  그래서 쓰는 쪽이 노트를 행에 싣고, 드레인이 외부 PM 에 상태를 반영한 뒤 코멘트로 보낸다.
export const CLOSED_CATEGORIES: ReadonlySet<string> = new Set(["done", "canceled"]);
const REASON_MAX = 1000;

export interface CloseNote {
  category: "done" | "canceled";
  reason: string | null;
  actor: string | null;
  source: string | null;
  at: string;
}

/** 열린 상태 → 닫힌 상태로 **넘어가는** 쓰기일 때만 노트를 만든다. 닫힌 것끼리의 이동(done↔canceled 포함)·재저장은 null. */
export function closeNoteOf(
  beforeCategory: string | null | undefined,
  afterCategory: string | null | undefined,
  ctx?: WriteCtx,
  at: Date = new Date(),
): CloseNote | null {
  if (!afterCategory || !CLOSED_CATEGORIES.has(afterCategory)) return null;
  if (beforeCategory && CLOSED_CATEGORIES.has(beforeCategory)) return null;
  const reason = (ctx?.reason ?? "").trim();
  return {
    category: afterCategory as CloseNote["category"],
    reason: reason ? reason.slice(0, REASON_MAX) : null,
    actor: ctx?.actor ?? null,
    source: ctx?.source ?? null,
    at: at.toISOString(),
  };
}


// 외부 푸시 아웃박스에 적재(best-effort — 적재 실패가 본 쓰기를 깨면 안 됨; 다음 편집/백필이 수렴).
//  op='delete' 는 ext_id_snapshot(삭제 전 external_id)을 실어 행 삭제 후에도 외부 삭제 가능.
export async function enqueueExternalPush(
  entityId: number,
  op: OutboxOp,
  ctx?: WriteCtx,
  extIdSnapshot?: string | null,
  closeNote?: CloseNote | null,
): Promise<void> {
  if (ctx?.source === "connector") return; // 인바운드 미러 쓰기는 푸시 안 함(루프 차단).
  try {
    await itemsPool.query(
      // close_note 는 COALESCE — 닫은 뒤 이름만 고친 편집이 합쳐져도 닫힘 근거가 지워지지 않는다.
      //  닫았다 다시 연 경우는 노트가 남지만 드레인이 현재 상태(닫힘인가)를 다시 보고 코멘트를 건너뛴다.
      `INSERT INTO external_outbox(entity_id, system, op, ext_id_snapshot, close_note)
       VALUES($1,'clickup',$2,$3,$4::jsonb)
       ON CONFLICT (tenant_id, system, entity_id) WHERE done_at IS NULL
       DO UPDATE SET op=EXCLUDED.op,
         ext_id_snapshot=COALESCE(EXCLUDED.ext_id_snapshot, external_outbox.ext_id_snapshot),
         close_note=COALESCE(EXCLUDED.close_note, external_outbox.close_note),
         updated_at=now(), attempts=0, last_error=NULL`,
      [entityId, op, extIdSnapshot ?? null, closeNote ? JSON.stringify(closeNote) : null],
    );
  } catch (e) {
    logger.warn({ err: e, entityId, op }, "external_outbox enqueue 실패(무시 — 본 쓰기는 성공)");
  }
}
