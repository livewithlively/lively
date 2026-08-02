// Notion 싱크 라이프사이클 훅(#1313 R44) — 구 run-sync.ts 의 notion 특례(원장 로드·후처리)를 verbatim 이관.
//  오케스트레이터는 이제 `system === 'notion'` 을 모른다: SPI 훅(prepareSync/postSync)으로만 부른다.
//  커서 전진 불변식은 postSync 의 반환값(PostSyncResult)이 운반한다 — 여기서 return 하는 freezeCursor 가
//  구 run-sync 의 `return true`(커서 미기록 + run 실패)와 정확히 같은 뜻이다.
import type { BackfillOpts, PostSyncCtx, PostSyncResult } from "../types.js";
import type { NotionRunStats } from "./state.js";
import { itemsPool } from "../../db/client.js";
import {
  applyNotionChildrenOrder, loadNotionLedger, materializeNotionLinks, sweepNotionArchived,
} from "../../v6/connector-mirror.js";
import { logger } from "../../log.js";

/** 커서에 저장된 이전 run 의 귀속 실패 목록(retry_ids) — 문자열만 추린다. */
function readRetryIds(cursor: Record<string, unknown> | null): string[] {
  return Array.isArray(cursor?.retry_ids)
    ? (cursor.retry_ids as unknown[]).filter((x): x is string => typeof x === "string")
    : [];
}

// ── prepareSync — #586 notion 원장 ───────────────────────────────────────────
//  증분(델타)·full(가속 full: 미변경 스킵+관측) 양쪽에 전달. 이전 run 의 귀속 실패 목록(retry_ids)도 함께 —
//  커서가 전진했어도 그 항목들은 강제 재수집(부분 성공 시맨틱).
//  로드 실패는 비치명(원장 없이도 전체 트래버스로 안전 동작 — 손실 방향 아님).
export async function prepareNotionSync(cursor: Record<string, unknown> | null): Promise<Partial<BackfillOpts>> {
  const prevRetry = readRetryIds(cursor);
  try {
    const ledger = await loadNotionLedger(itemsPool);
    logger.info({ entries: ledger.byId.size, dataSources: ledger.dsToDb.size, retryCarried: prevRetry.length }, "notion 원장 로드(델타/가속 full 기준)");
    return { ...(ledger.byId.size ? { ledger } : {}), ...(prevRetry.length ? { retryIds: prevRetry } : {}) };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err) }, "notion 원장 로드 실패 — 전체 트래버스로 진행(안전 폴백)");
    return prevRetry.length ? { retryIds: prevRetry } : {};
  }
}

// ── postSync — #551 링크 물질화(연결구조) + 자식 순서 수렴(페이지 트리) + full 스윕(삭제 전파). ──
//  두 겹의 실패 감지(조용한 손실 금지):
//   ① 커넥터 내부 부분 실패(페이지/자산) — 예외로 안 오고 stats 로 온다.
//   ② 미러 부분 실패 — ingestItems 가 best-effort 로 삼키므로(store.ts), DB 실측으로 대사:
//      이번 run 에 적재된 행 수(last_synced_at ≥ runStart) < 방출 수 면 미러가 일부 실패한 것.
//  어느 쪽이든 커서 동결(다음 run 재수집) + full 스윕 생략(살아있는 페이지 오탐 아카이브 방지).
export async function notionPostSync(ctx: PostSyncCtx, stats: NotionRunStats | null): Promise<PostSyncResult> {
  const { pool, runStartIso, incremental } = ctx;
  let mirrorShortfall = 0;
  try {
    if (stats) {
      const m = await pool.query(
        `SELECT count(*)::int AS n FROM knowledge WHERE external_system='notion' AND last_synced_at >= $1::timestamptz`,
        [runStartIso]);
      mirrorShortfall = Math.max(0, stats.emitted - Number((m.rows[0] as { n: number } | undefined)?.n ?? 0));
    }
    // 가속 full 관측 갱신 — 원장 일치로 스킵(미방출)한 항목의 last_synced_at 을 올린다(스윕 오탐 방지).
    //  mirrorShortfall 계산 **후**(방출 대사를 부풀리지 않게), 스윕 **전**.
    if (stats?.observedIds?.length) {
      for (let i = 0; i < stats.observedIds.length; i += 5000) {
        await pool.query(
          `UPDATE knowledge SET last_synced_at = now() WHERE external_system='notion' AND external_id = ANY($1::text[])`,
          [stats.observedIds.slice(i, i + 5000)]);
      }
      logger.info({ observed: stats.observedIds.length }, "가속 full — 미변경 관측 갱신(last_synced_at)");
    }
    const links = await materializeNotionLinks(pool);
    const reordered = await applyNotionChildrenOrder(pool);
    let archived = 0;
    if (!incremental && stats && stats.failures === 0 && mirrorShortfall === 0) {
      archived = await sweepNotionArchived(pool, runStartIso); // full + 완전 무실패에서만(오탐 아카이브 방지)
    }
    logger.info({ system: "notion", links, reordered, archived, mirrorShortfall,
      stats: { ...stats, observedIds: stats?.observedIds?.length, retryIds: stats?.retryIds?.length } }, "notion 후처리 완료(링크·순서·스윕)");
  } catch (err) {
    logger.error({ err: (err as Error)?.message ?? String(err) }, "notion 후처리 실패 — 커서 동결(다음 run 재수집)");
    return { freezeCursor: true };
  }
  if ((stats && stats.failures > 0) || mirrorShortfall > 0) {
    // #586 부분 성공 시맨틱 — 실패가 **전부 귀속**(어느 항목인지 안다)이면 커서를 전진시키고 목록만 재시도.
    //  all-or-nothing 동결은 '뭘 놓쳤는지 모르는' 실패(발견 실패·미러 대사 불일치)에만 남긴다 —
    //  귀속된 실패는 창을 닫아도 유실이 아니다(다음 run 이 강제 재수집, 스윕은 어차피 무실패에서만).
    const retryNow = stats ? [...new Set(stats.retryIds)] : [];
    const attributable = stats != null && mirrorShortfall === 0 && stats.unattributed === 0
      && retryNow.length > 0 && retryNow.length <= 5000;
    if (!attributable) {
      logger.error({ failures: stats?.failures ?? -1, mirrorShortfall, unattributed: stats?.unattributed ?? -1, failedIds: (stats?.failedIds ?? []).slice(0, 20) },
        "notion 부분 실패(귀속 불가) — 커서 동결(적재분은 멱등 보존, 다음 run 이 실패분 재수집)");
      return { freezeCursor: true };
    }
    logger.warn({ failures: stats!.failures, retry: retryNow.length },
      "notion 부분 실패(전부 귀속) — 커서 전진 + 재시도 목록 기록(다음 run 이 해당 항목만 재수집)");
    return { retryIds: retryNow };
  }
  return { retryIds: [] }; // 무실패 — 이전 재시도 목록 청산
}
