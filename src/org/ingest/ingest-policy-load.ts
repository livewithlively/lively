// 인입 허용선 정책 규칙 로더 경계(#783) — **구현은 Enterprise(src/ee/ingest/ingest-policy-load.ts).**
//  EE 미탑재면 규칙이 없으므로 빈 배열(디폴트 auto — 현행 무변)이다.
//  ⚠ 단 org_ingest_policy 에 **켜진 규칙이 남아 있는데** EE 만 빠진 경우는 조직이 설정한 게이트가 조용히
//   무력화되는 것이라 거부한다 — '기능 없음'과 '정책 무시'를 가르는 자리다.
import { itemsPool } from "../../db/client.js";
import { ee, assertEnterpriseForCompliance } from "../../enterprise/registry.js";
import type { IngestPolicyRule } from "./ingest-policy.js";

export function invalidateIngestPolicyCache(): void {
  ee().ingestPolicy?.invalidateIngestPolicyCache();
  _orphanCache = null;
}

export async function getIngestPolicyRules(): Promise<IngestPolicyRule[]> {
  const h = ee().ingestPolicy;
  if (h) return h.getIngestPolicyRules();
  await assertNoOrphanIngestPolicy();
  return [];
}

// 켜진 규칙이 하나라도 있으면 거부. 조회 실패(테이블 부재 등)는 '정책 없음'으로 본다 —
//  종전 로더도 실패를 fail-open 으로 다뤘고(게이트는 '켠 만큼만'), 감사 설정 조회 실패로 저장 경로를 죽이지 않는다.
const ORPHAN_TTL_MS = 10_000;
let _orphanCache: { at: number; count: number } | null = null;

async function assertNoOrphanIngestPolicy(): Promise<void> {
  const now = Date.now();
  if (!_orphanCache || now - _orphanCache.at >= ORPHAN_TTL_MS) {
    let count = 0;
    try {
      const r = await itemsPool.query("SELECT count(*)::int AS n FROM org_ingest_policy WHERE enabled=true");
      count = Number(r.rows[0]?.n ?? 0);
    } catch {
      count = 0;
    }
    _orphanCache = { at: now, count };
  }
  if (_orphanCache.count > 0) assertEnterpriseForCompliance("인입 허용선");
}
