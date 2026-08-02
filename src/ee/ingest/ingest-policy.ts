// 지식 인입 허용선 정책 평가(#638 → #783 확장) — 지식이 어느 lifecycle 로 적재될지 결정하는 순수함수.
//  오너가 org_ingest_policy(관리탭)로 규칙을 정의하면, 쓰기 시점에 facets 를 대조해 결정을 뽑는다.
//  DB·IO 없음(규칙 rows 는 호출부가 읽어 넘김) → 테스트로 회귀 고정(ingest-policy.test.ts).
//
//  적용 경로:
//   · mirror(커넥터 미러, connector-mirror.ts)              — decision.create 만(재싱크 update 는 원본이 진실 → 게이트 밖).
//   · knowledge_save(capabilities/knowledge.ts)            — create/update 양축. 에이전트(MCP)·사람(웹)·distill 이 모두 이 경로.
//
//  시맨틱(윤상민 결정 — [[ingest-autonomy-gate-design-638]] + #783):
//   · 디폴트 = auto — 매치 규칙이 하나도 없으면 create=auto·update=auto(현행과 100% 동일, 오너가 켠 만큼만 gate).
//   · 매치 규칙이 여럿이면 '가장 보수적 승리' — 축별 독립 평가(create: drop>confirm>auto · update: drop>stage>review>auto).
//   · **예외 규칙(is_exception)** 은 그 누적을 건너뛴다 — 매치된 예외 중 우선순위 최상위 1개가 그대로 확정(#783).
//     보수적 누적만으론 "전부 검토하되 이 도메인·하네스만 자동통과" 같은 carve-out 을 표현할 수 없어서다(완화 방향은 명시적으로만).
//   · 각 match_* 는 null/'' = any(그 축 무시). facet 이 없으면(null) 그 축에 구체 match 값을 건 규칙은 불일치.
//   · 어느 규칙이 이겼는지(create_rule_id/update_rule_id)도 반환 — 검토 큐가 "왜 여기 왔나"를 사람에게 설명한다.
//
//  액션이 신규/수정 2축인 이유(#783): 에이전트 쓰기의 상당수는 '기존 지식 갱신'이다(중복 방지 가이드가 그렇게 시킨다).
//   신규만 막으면 게이트가 새고, 수정까지 pending 으로 숨기면 이미 승인된 라이브 지식이 검색에서 사라진다 → 수정은 별도 축으로 분리:
//    · auto   = 즉시 반영(현행)
//    · review = 즉시 반영 + 검토 큐에 diff 적재(사후검토 — 라이브 유지, 사람이 확인 또는 되돌리기)
//    · stage  = 본문 미반영 + 리비전 제안(승인해야 반영 — 라이브 본문은 옛 승인본 유지)
//    · drop   = 수정 거부(에러 — 에이전트가 이 지식을 못 건드리게)

// 타입 계약은 코어 소유(src/org/ingest/ingest-policy.ts) — EE 는 평가 구현만 제공한다.
import type { CreateAction, UpdateAction, IngestPolicyRule, IngestFacets, IngestDecision } from "../../org/ingest/ingest-policy.js";

const CREATE_RANK: Record<CreateAction, number> = { auto: 1, confirm: 2, drop: 3 };
const UPDATE_RANK: Record<UpdateAction, number> = { auto: 1, review: 2, stage: 3, drop: 4 };

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
    && axisMatch(rule.match_sensitive, f.sensitive)
    && axisMatch(rule.match_actor_kind, f.actor_kind)
    && axisMatch(rule.match_agent, f.agent)
    && axisMatch(rule.match_type, f.type);
}

// 정책 평가 — ① 매치된 예외 규칙이 있으면 그중 우선순위 최상위 1개가 확정(carve-out), ② 없으면 축별 가장 보수적 승리.
//  매치 0 이면 create=auto·update=auto(디폴트 — 현행 무변).
export function resolveIngestPolicy(facets: IngestFacets, rules: IngestPolicyRule[]): IngestDecision {
  const matched = rules.filter((r) => r.enabled !== false && ruleMatches(r, facets));

  // ① 예외(carve-out) — 우선순위 desc, 동률이면 먼저 만든 규칙(id asc)이 확정. 이 규칙 하나가 두 축을 모두 정한다.
  const exceptions = matched.filter((r) => r.is_exception);
  if (exceptions.length) {
    const win = exceptions.reduce((a, b) =>
      (b.priority ?? 0) > (a.priority ?? 0) ? b
        : (b.priority ?? 0) < (a.priority ?? 0) ? a
          : (b.id ?? Infinity) < (a.id ?? Infinity) ? b : a);
    return {
      create: win.action ?? "auto",
      update: win.action_update ?? "auto",
      create_rule_id: win.id ?? null,
      update_rule_id: win.id ?? null,
    };
  }

  // ② 보수적 누적 — 축별로 독립 평가(안전 방향 수렴).
  const out: IngestDecision = { create: "auto", update: "auto", create_rule_id: null, update_rule_id: null };
  for (const rule of matched) {
    const c = rule.action;
    if (c && CREATE_RANK[c] > CREATE_RANK[out.create]) { out.create = c; out.create_rule_id = rule.id ?? null; }
    const u = rule.action_update ?? "auto";
    if (UPDATE_RANK[u] > UPDATE_RANK[out.update]) { out.update = u; out.update_rule_id = rule.id ?? null; }
  }
  return out;
}
