//  증류 배치 세션 알아보기(#4824 사양 R7) — knowledge_save · source_link_knowledge 가 «이 호출이 헤드리스 증류 배치에서 왔나» 를 본다.
//   org_task · org_cron 의 모양(크론 표식 'cron:<잡>#<레인>')을 아는 자리라 가시성 모듈(v6/derived-visibility)이 아니라 증류 쪽에 둔다.
import { itemsPool } from "../../db/client.js";
import { logger } from "../../log.js";

//  헤드리스 증류만: 세션 id(x-lively-session) → org_task.session_id(org_task_session_idx) → requester_session
//   'cron:<잡>#<레인>' 또는 'cron:<잡>'(레인 없는 방치·전역 배치) → org_cron.action = 'distill_sources_headless'.
//   그 태스크 하나가 곧 배치 하나다 — 잡이 나중에 꺼져도 그 판은 증류 배치였다(켜짐을 안 본다).
//  세션 주입(distill_sources)은 판정하지 않는다 — 그 상시 세션은 다른 크론·사람도 함께 쓴다(격리 검토). 프롬프트로만 안내한다.
//  ⚠ 세션 id 는 하네스가 싣는 머리글이다(모델이 고르는 값이 아니다) — 이 판정이 막는 것은 모델의 실수(연결 빠뜨림)지
//   일부러 피하려는 사람이 아니다. 판정을 못 하면(구 스키마 등) 막지 않는다(저장 자체를 깨지 않는다). 아니라는 판정은 캐시하지
//   않는다 — 태스크 행이 세션보다 조금 늦게 기록될 수 있다(markRunning).
const BATCH_TTL_MS = 60_000;
const batchCache = new Map<string, { since: Date; at: number }>();

/** 이 세션이 헤드리스 증류 배치면 그 배치의 시작 시각, 아니면 null. */
export async function distillBatchOf(sessionId: string | null | undefined): Promise<{ since: Date } | null> {
  const sid = String(sessionId ?? "").trim();
  if (!sid) return null;
  const now = Date.now();
  const hit = batchCache.get(sid);
  if (hit && now - hit.at < BATCH_TTL_MS) return { since: hit.since };
  try {
    const r = await itemsPool.query(
      `SELECT COALESCE(t.started_at, t.created_at) AS since
         FROM org_task t
         JOIN org_cron c ON c.id = split_part(substr(t.requester_session, 6), '#', 1)
        WHERE t.session_id = $1 AND t.requester_session LIKE 'cron:%'
          AND c.action = 'distill_sources_headless'
        ORDER BY t.id DESC LIMIT 1`, [sid]);
    const since = r.rows[0]?.since ? new Date(r.rows[0].since) : null;
    if (!since) return null;
    if (batchCache.size > 2000) batchCache.clear();
    batchCache.set(sid, { since, at: now });
    return { since };
  } catch (e) {
    if ((e as { code?: string })?.code !== "42P01") logger.warn({ err: (e as Error)?.message }, "[derived-vis] 증류 배치 판정 실패 — 막지 않는다");
    return null;
  }
}

/** 시험용 — 캐시를 비운다. */
export function invalidateDistillBatchCache(): void { batchCache.clear(); }
