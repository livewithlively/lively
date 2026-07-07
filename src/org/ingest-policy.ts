// 자동 인입 허용선 정책 평가(#638) — distill/mirror 가 지식을 어느 lifecycle 로 적재할지 결정하는 순수함수.
//  오너가 org_ingest_policy(웹 관리)로 카테고리·출처·경로·민감라벨별 규칙을 정의하면, 인입 시점에 facets 를 대조해
//  action(auto|confirm|drop)을 뽑는다. DB·IO 없음(규칙 rows 는 호출부가 읽어 넘김) → 테스트로 회귀 고정(ingest-policy.test.ts).
//
//  시맨틱(사용자 결정, 윤상민 2026-07-07 — [[ingest-autonomy-gate-design-638]]):
//   · 디폴트 = auto — 매치되는 규칙이 하나도 없으면 auto(현행과 100% 동일, 오너가 켠 만큼만 gate).
//   · 매치 규칙이 여럿이면 '가장 보수적 승리'(drop > confirm > auto) — 안전 방향으로 수렴. priority 는 표시/정렬용(v1 평가 미사용).
//   · 각 match_* 는 null/'' = any(그 축 무시). facet 이 없으면(null) 그 축에 구체 match 값을 건 규칙은 불일치.
//   · auto=즉시 active, confirm=pending(검토 큐 격리), drop=미적재.

export type IngestAction = "auto" | "confirm" | "drop";

// org_ingest_policy 행의 평가에 필요한 부분집합(호출부가 SELECT 해 넘긴다).
export interface IngestPolicyRule {
  match_category?: string | null;
  match_system?: string | null;
  match_channel?: string | null;
  match_provenance?: string | null;
  match_sensitive?: string | null;
  action: IngestAction;
  priority?: number | null;
  enabled?: boolean;
}

// 인입 항목의 분류 신호 — mirror/distill 이 채워 넘긴다(없는 축은 null/undefined).
export interface IngestFacets {
  category?: string | null;    // 도메인 key
  system?: string | null;      // slack/notion/gdrive…
  channel?: string | null;     // 채널·폴더 등 출처
  provenance?: string | null;  // observed(mirror) | authored(distill)
  sensitive?: string | null;   // LLM 민감 라벨(cooking/planning/unfinished…) 또는 null
}

const RANK: Record<IngestAction, number> = { auto: 1, confirm: 2, drop: 3 };

// 한 축 매치 — 규칙값이 비었으면(any) 항상 매치, 아니면 facet 값과 정확히 일치해야 매치.
function axisMatch(ruleVal: string | null | undefined, factVal: string | null | undefined): boolean {
  if (ruleVal == null || ruleVal === "") return true; // any(그 축 무시)
  return ruleVal === factVal;
}

// 규칙의 모든 구체 축(AND)이 facet 과 맞아야 매치.
function ruleMatches(rule: IngestPolicyRule, f: IngestFacets): boolean {
  return axisMatch(rule.match_category, f.category)
    && axisMatch(rule.match_system, f.system)
    && axisMatch(rule.match_channel, f.channel)
    && axisMatch(rule.match_provenance, f.provenance)
    && axisMatch(rule.match_sensitive, f.sensitive);
}

// 정책 평가 — 매치 규칙 중 가장 보수적 action(drop>confirm>auto), 매치 0 이면 auto(디폴트).
export function resolveIngestPolicy(facets: IngestFacets, rules: IngestPolicyRule[]): IngestAction {
  let strongest: IngestAction = "auto";
  for (const rule of rules) {
    if (rule.enabled === false) continue;
    if (!ruleMatches(rule, facets)) continue;
    if (RANK[rule.action] > RANK[strongest]) strongest = rule.action;
  }
  return strongest;
}
