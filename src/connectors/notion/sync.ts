// Notion 싱크 라이프사이클 훅(#1313 R44) — 구 run-sync.ts 의 notion 특례(원장 로드·후처리)를 verbatim 이관.
//  오케스트레이터는 이제 `system === 'notion'` 을 모른다: SPI 훅(prepareSync/postSync)으로만 부른다.
//  커서 전진 불변식은 postSync 의 반환값(PostSyncResult)이 운반한다 — 여기서 return 하는 freezeCursor 가
//  구 run-sync 의 `return true`(커서 미기록 + run 실패)와 정확히 같은 뜻이다.
import type { BackfillOpts, PostSyncCtx, PostSyncResult } from "../types.js";
import type { NotionRunStats } from "./state.js";
import { itemsPool } from "../../db/client.js";
import { resolveNotionInstance } from "./client.js";
import { boundCollector, collectorClaimKey } from "../config.js";
import {
  applyNotionChildrenOrder, countNotionClaimedSince, loadNotionLedger, materializeNotionLinks,
  observeNotionRows, sweepNotionArchived,
} from "../../v6/connector-mirror.js";
import type { NotionSweepPlan, NotionSweepResult } from "../../v6/connector-mirror.js";
import { loadNotionSweepPeers, planNotionSweep, recordNotionSweepReady } from "./sweep-peers.js";
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
    // #1881 — 원장은 **이 수집기의 워크스페이스**만. 남의 인스턴스가 섞이면 델타가 '이미 안다'로 오판한다.
    // #4059 — 항목마다 «이 수집기의 몫인가» 를 싣는다(델타 범위 판정이 남의 몫을 내 범위의 증거로 쓰지 않게).
    //  표식 값은 적재(run-sync)가 쓰는 것과 같은 식이다 — 같은 프로세스·같은 바인딩이라 같은 값이 나온다.
    const instance = await resolveNotionInstance();
    const ledger = await loadNotionLedger(itemsPool, instance, collectorClaimKey("notion"));
    logger.info({ instance, entries: ledger.byId.size, dataSources: ledger.dsToDb.size, retryCarried: prevRetry.length }, "notion 원장 로드(델타/가속 full 기준)");
    return { ...(ledger.byId.size ? { ledger } : {}), ...(prevRetry.length ? { retryIds: prevRetry } : {}) };
  } catch (err) {
    logger.warn({ err: (err as Error)?.message ?? String(err) }, "notion 원장 로드 실패 — 전체 트래버스로 진행(안전 폴백)");
    return prevRetry.length ? { retryIds: prevRetry } : {};
  }
}

// ── postSync — #551 링크 물질화(연결구조) + 자식 순서 수렴(페이지 트리) + full 스윕(삭제 전파). ──
//  두 겹의 실패 감지(조용한 손실 금지):
//   ① 커넥터 내부 부분 실패(페이지/자산) — 예외로 안 오고 stats 로 온다.
//   ② 미러 부분 실패 — ingestItems 가 best-effort 로 삼키므로(store.ts), 항목 단위 실패 수(ctx.mirrorFailures)와
//      DB 실측으로 대사: 이번 run 에 **이 수집기가** 적재한 행 수 < 방출 수 면 미러가 일부 실패한 것.
//      (#4059 — 종전엔 last_synced_at 으로 셌다. 같은 워크스페이스의 다른 수집기가 동시에 쓴 행까지 세어져 부족분이 가려졌다.)
//  어느 쪽이든 커서 동결(다음 run 재수집) + full 스윕 생략(살아있는 페이지 오탐 아카이브 방지).
export async function notionPostSync(ctx: PostSyncCtx, stats: NotionRunStats | null): Promise<PostSyncResult> {
  const { pool, runStartIso, incremental, claimKey } = ctx;
  let mirrorShortfall = 0;
  try {
    if (stats) {
      const written = await countNotionClaimedSince(pool, { instance: stats.instance, claimKey, sinceIso: runStartIso });
      mirrorShortfall = Math.max(0, stats.emitted - written);
    }
    // 가속 full 관측 갱신 — 원장 일치로 스킵(미방출)한 항목의 last_synced_at·내 표식을 올린다(스윕 오탐 방지).
    //  mirrorShortfall 계산 **후**(방출 대사를 부풀리지 않게), 스윕 **전**.
    if (stats?.observedIds?.length) {
      await observeNotionRows(pool, { instance: stats.instance, ids: stats.observedIds, claimKey });
      logger.info({ observed: stats.observedIds.length }, "가속 full — 미변경 관측 갱신(last_synced_at·수집기 표식)");
    }
    const links = await materializeNotionLinks(pool);
    const reordered = await applyNotionChildrenOrder(pool);
    let sweep: (NotionSweepResult & { plan: NotionSweepPlan }) | null = null;
    if (!incremental && stats && stats.failures === 0 && mirrorShortfall === 0 && ctx.mirrorFailures === 0) {
      // full + 완전 무실패 + **이 워크스페이스·이 수집기의 몫만**(#1881 · #4059) — 오탐 아카이브 방지.
      const bound = boundCollector();
      const peerState = await loadNotionSweepPeers(pool, {
        instance: stats.instance, claimKey,
        boundId: bound?.id ?? null, boundVersion: bound?.version ?? null,
      });
      const plan = planNotionSweep({ runStartIso, selfChanged: peerState.selfChanged, peers: peerState.peers });
      const result = await sweepNotionArchived(pool, { runStartIso, instance: stats.instance, claimKey, plan });
      sweep = { ...result, plan };
      // 깨끗한 전체 점검을 마쳤다 — 같은 워크스페이스의 다른 수집기 스윕이 이 기록으로 «이 수집기는 안 맡는다» 를 증명한다.
      await recordNotionSweepReady(pool, { claimKey, runStartIso, boundVersion: bound?.version ?? null });
      if (!plan.archive) {
        logger.warn({ instance: stats.instance, claimKey, reason: plan.reason, notReady: plan.notReady ?? [],
          released: result.released, orphaned: result.orphaned },
          "notion 스윕 — 보관 보류(같은 워크스페이스를 맡은 수집기가 아직 전체 점검을 마치지 않았거나 설정이 바뀜). 떼어 낸 표식은 다음 스윕이 정리한다");
      }
    }
    logger.info({ system: "notion", instance: stats?.instance ?? null, claimKey, links, reordered,
      archived: sweep?.archived ?? 0, released: sweep?.released ?? 0, orphaned: sweep?.orphaned ?? 0,
      sweepHeld: sweep?.held ?? null, sole: sweep?.plan.archive ? sweep.plan.sole : null,
      mirrorShortfall, mirrorFailures: ctx.mirrorFailures,
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
