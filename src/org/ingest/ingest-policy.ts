// 인입 허용선 정책 경계(#638 · #783) — **타입·계약은 코어(AGPL), 평가 구현은 Enterprise(src/ee/ingest/ingest-policy.ts).**
//
//  이 게이트는 조직이 '무엇을 자동으로 지식이 되게 할지'를 강제하는 거버넌스 장치다.
//  EE 미탑재면 규칙 자체가 없으므로 전부 auto(현행 무변) — 다만 **규칙이 남아 있는데 EE 만 빠진** 경우는
//  조직이 켠 게이트가 조용히 무력화되는 것이라 거부한다(ingest-policy-load.ts 의 orphan 검사와 한 쌍).
import { ee, assertEnterpriseForCompliance } from "../../enterprise/registry.js";

export type CreateAction = "auto" | "confirm" | "drop";
export type UpdateAction = "auto" | "review" | "stage" | "drop";
// 구 이름(#638) — 신규 축만 쓰는 호출부 호환.
export type IngestAction = CreateAction;

// org_ingest_policy 행의 평가에 필요한 부분집합(호출부가 SELECT 해 넘긴다).
export interface IngestPolicyRule {
  id?: number | null;
  match_category?: string | null;
  match_system?: string | null;
  match_channel?: string | null;
  match_provenance?: string | null;
  match_sensitive?: string | null;
  match_actor_kind?: string | null;    // #783 누가 — ai(MCP=에이전트) | human(웹=사람).
  match_agent?: string | null;         // #783 하네스 — claude-code|codex|openclaw…
  match_type?: string | null;          // #783 page-type — decision|concept|how-to|reference|research|entity.
  action: CreateAction;                // 신규 저장 시.
  action_update?: UpdateAction | null; // 기존 지식 수정 시(미지정=auto).
  is_exception?: boolean;              // #783 예외(carve-out).
  priority?: number | null;
  enabled?: boolean;
}

// 쓰기 항목의 분류 신호 — mirror/knowledge_save 가 채워 넘긴다(없는 축은 null/undefined).
export interface IngestFacets {
  category?: string | null;    // 도메인 key
  system?: string | null;      // slack/notion/gdrive…
  channel?: string | null;     // 채널·폴더 등 출처
  provenance?: string | null;  // observed(미러) | authored(저작·증류)
  sensitive?: string | null;   // LLM 민감 라벨(cooking/planning/unfinished…) 또는 null
  actor_kind?: string | null;  // ai | human
  agent?: string | null;       // 하네스 id
  type?: string | null;        // page-type
}

// 평가 결과 — 축별 액션 + 그 액션을 결정한 규칙 id.
export interface IngestDecision {
  create: CreateAction;
  update: UpdateAction;
  create_rule_id: number | null;
  update_rule_id: number | null;
}

/** 규칙 없음 = 게이트 없음(현행 무변). */
const DEFAULT_DECISION: IngestDecision = { create: "auto", update: "auto", create_rule_id: null, update_rule_id: null };

export function resolveIngestPolicy(facets: IngestFacets, rules: IngestPolicyRule[]): IngestDecision {
  const h = ee().ingestPolicy;
  if (h) return h.resolveIngestPolicy(facets, rules);
  // 규칙이 넘어왔는데 평가할 EE 가 없다 = 조직이 켠 게이트를 무시하게 된다 → 거부.
  if (rules.length > 0) assertEnterpriseForCompliance("인입 허용선");
  return DEFAULT_DECISION;
}
