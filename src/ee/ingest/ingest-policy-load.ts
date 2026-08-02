// 인입 허용선 정책 규칙 로더(#783) — DB 조회 + 짧은 캐시. 평가 자체는 순수함수(ingest-policy.ts).
//  두 소비자가 공유한다: connector-mirror(미러 배치 — 항목마다 조회하면 안 됨) · knowledge_save(에이전트·사람 저장마다 1회).
//  · 캐시 TTL 10s + 정책 쓰기 시 즉시 무효화 → 관리탭에서 스위치를 켜면 곧바로 반영된다(다음 저장부터).
//  · 실패(테이블 부재 등) = 빈 규칙 → 디폴트 auto(현행 무변, fail-open). 게이트는 '켠 만큼만' 이라는 설계 원칙과 일치.
import { itemsPool } from "../../db/client.js";
import type { IngestPolicyRule } from "../../org/ingest/ingest-policy.js";

const TTL_MS = 10_000;
let cache: { at: number; rules: IngestPolicyRule[] } | null = null;

export function invalidateIngestPolicyCache(): void { cache = null; }

export async function getIngestPolicyRules(): Promise<IngestPolicyRule[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.rules;
  try {
    const r = await itemsPool.query(
      `SELECT id, match_category, match_system, match_channel, match_provenance, match_sensitive,
              match_actor_kind, match_agent, match_type, action, action_update, is_exception, priority, enabled
         FROM org_ingest_policy WHERE enabled=true`);
    cache = { at: now, rules: r.rows as IngestPolicyRule[] };
    return cache.rules;
  } catch { return []; }  // 테이블/컬럼 부재 등 → 정책 없음 = 디폴트 auto(현행 무변)
}
