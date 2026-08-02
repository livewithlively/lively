// resolveIngestPolicy 단위 체크(#638 → #783) — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/ingest/ingest-policy.test.js
//
// 잠그는 불변식(사용자 결정, [[ingest-autonomy-gate-design-638]] + #783):
//  · 디폴트 auto(규칙 0 = 현행 무변) · 축별 가장 보수적 승리 · match_* null=any · facet 부재 축은 구체 match 와 불일치.
//  · create(신규): drop>confirm>auto · update(수정): drop>stage>review>auto — 두 축은 독립 평가.
//  · action_update 미지정 규칙(=구 #638 행)은 update=auto — 구 규칙이 수정을 게이트하지 않는다(무변 보장).
import assert from "node:assert/strict";
import { resolveIngestPolicy } from "./ingest-policy.js";
import type { IngestPolicyRule } from "../../org/ingest/ingest-policy.js"; // 타입 계약은 코어

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 디폴트: 규칙 없음 → auto(현행과 100% 동일, 오너가 켠 만큼만 gate). ──
t("규칙 0개 → create=auto·update=auto(디폴트)", () => {
  const d = resolveIngestPolicy({ category: "brand" }, []);
  assert.equal(d.create, "auto");
  assert.equal(d.update, "auto");
  assert.equal(d.create_rule_id, null);
});

// ── 단일 매치 + 미매치 폴백. ──
t("카테고리 매치 confirm → confirm, 미매치 → auto", () => {
  const rules: IngestPolicyRule[] = [{ match_category: "fundraising", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ category: "fundraising" }, rules).create, "confirm");
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules).create, "auto");
});

// ── match_* null/'' = any(그 축 무시). ──
t("match_* 빈값 = any → 다른 축만으로 매치", () => {
  const rules: IngestPolicyRule[] = [{ match_provenance: "observed", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ provenance: "observed", category: "anything" }, rules).create, "confirm");
});

// ── 여러 매치 → 가장 보수적 승리(drop > confirm > auto). ──
t("drop+confirm+auto 동시 매치 → drop 승리", () => {
  const rules: IngestPolicyRule[] = [
    { match_system: "slack", action: "confirm" },
    { match_channel: "cooking", action: "drop" },
    { action: "auto" }, // 전체 any
  ];
  assert.equal(resolveIngestPolicy({ system: "slack", channel: "cooking" }, rules).create, "drop");
});
t("confirm vs auto 동시 매치 → confirm 승리", () => {
  const rules: IngestPolicyRule[] = [
    { action: "auto" },
    { match_category: "market-competition", action: "confirm" },
  ];
  assert.equal(resolveIngestPolicy({ category: "market-competition" }, rules).create, "confirm");
});

// ── facet 부재 + 구체 match → 불일치(그 축 신호가 없으면 그 규칙은 안 걸린다). ──
t("sensitive facet 없음 + match_sensitive 규칙 → 불일치(auto)", () => {
  const rules: IngestPolicyRule[] = [{ match_sensitive: "cooking", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules).create, "auto");
  assert.equal(resolveIngestPolicy({ sensitive: "cooking" }, rules).create, "confirm");
});

// ── enabled=false → 평가 제외. ──
t("enabled=false 규칙은 무시", () => {
  const rules: IngestPolicyRule[] = [{ match_category: "brand", action: "drop", enabled: false }];
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules).create, "auto");
});

// ── 다축 AND — 한 축이라도 어긋나면 미매치. ──
t("다축 규칙 — 한 축 어긋나면 미매치", () => {
  const rules: IngestPolicyRule[] = [{ match_system: "notion", match_provenance: "observed", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ system: "notion", provenance: "observed" }, rules).create, "confirm");
  assert.equal(resolveIngestPolicy({ system: "notion", provenance: "authored" }, rules).create, "auto");
});

// ════════ #783 — 작성자(actor_kind)·하네스(agent)·타입 축 + 수정(update) 액션 ════════

// ── 프로젝트 #783 의 캐노니컬 규칙: "에이전트(MCP)가 저작한 지식은 검토 후 반영". ──
t("actor_kind=ai 규칙 → 에이전트 저작만 게이트, 사람 웹 저작은 무영향", () => {
  const rules: IngestPolicyRule[] = [
    { id: 7, match_actor_kind: "ai", match_provenance: "authored", action: "confirm", action_update: "review" },
  ];
  const agent = resolveIngestPolicy({ actor_kind: "ai", provenance: "authored", category: "brand" }, rules);
  assert.equal(agent.create, "confirm");
  assert.equal(agent.update, "review");
  assert.equal(agent.create_rule_id, 7);   // 어느 규칙이 걸었는지 설명가능
  assert.equal(agent.update_rule_id, 7);

  const human = resolveIngestPolicy({ actor_kind: "human", provenance: "authored", category: "brand" }, rules);
  assert.equal(human.create, "auto");      // 웹에서 사람이 쓴 지식은 그대로 라이브
  assert.equal(human.update, "auto");
});

// ── 구 #638 규칙(action_update 부재) → 수정은 게이트되지 않는다(하위호환 불변식). ──
t("action_update 미지정(구 규칙) → update=auto", () => {
  const rules: IngestPolicyRule[] = [{ match_provenance: "observed", action: "confirm" }];
  const d = resolveIngestPolicy({ provenance: "observed" }, rules);
  assert.equal(d.create, "confirm");
  assert.equal(d.update, "auto");          // 구 규칙이 갑자기 수정을 막지 않는다
  assert.equal(d.update_rule_id, null);
});

// ── create/update 는 독립 축 — 서로의 랭킹에 간섭하지 않는다. ──
t("create·update 독립 평가 — 각 축에서 따로 가장 보수적", () => {
  const rules: IngestPolicyRule[] = [
    { id: 1, match_actor_kind: "ai", action: "auto", action_update: "stage" },   // 신규는 통과, 수정은 스테이징
    { id: 2, match_category: "fundraising", action: "confirm", action_update: "auto" }, // 신규는 검토, 수정은 통과
  ];
  const d = resolveIngestPolicy({ actor_kind: "ai", category: "fundraising" }, rules);
  assert.equal(d.create, "confirm");       // 규칙2 승리
  assert.equal(d.create_rule_id, 2);
  assert.equal(d.update, "stage");         // 규칙1 승리
  assert.equal(d.update_rule_id, 1);
});

// ── update 랭킹: drop > stage > review > auto. ──
t("update 가장 보수적 승리 — drop>stage>review>auto", () => {
  const base: IngestPolicyRule[] = [
    { action: "auto", action_update: "review" },
    { action: "auto", action_update: "stage" },
  ];
  assert.equal(resolveIngestPolicy({}, base).update, "stage");
  assert.equal(resolveIngestPolicy({}, [...base, { action: "auto", action_update: "drop" }]).update, "drop");
  assert.equal(resolveIngestPolicy({}, [{ action: "auto", action_update: "review" }, { action: "auto", action_update: "auto" }]).update, "review");
});

// ── 하네스 축 — 특정 하네스(자율 실행)만 좁혀 게이트. ──
t("agent(하네스) 축 — 매치 하네스만 게이트", () => {
  const rules: IngestPolicyRule[] = [{ match_agent: "openclaw", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", agent: "openclaw" }, rules).create, "confirm");
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", agent: "claude-code" }, rules).create, "auto");
  assert.equal(resolveIngestPolicy({ actor_kind: "ai" }, rules).create, "auto"); // 하네스 미식별 → 구체 match 규칙과 불일치
});

// ── page-type 축 — 예: 런북(how-to)만 사람 승인. ──
t("type(page-type) 축", () => {
  const rules: IngestPolicyRule[] = [{ match_actor_kind: "ai", match_type: "how-to", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", type: "how-to" }, rules).create, "confirm");
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", type: "research" }, rules).create, "auto");
});

// ── 완화(carve-out)는 '보수적 누적'으론 불가 — 반드시 예외 규칙으로만. ──
t("보수적 승리 — 일반 규칙으론 완화 불가(전역 confirm + 카테고리 auto → confirm)", () => {
  const rules: IngestPolicyRule[] = [
    { match_actor_kind: "ai", action: "confirm" },
    { match_actor_kind: "ai", match_category: "org", action: "auto" },
  ];
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", category: "org" }, rules).create, "confirm");
});

// ── 예외 규칙(#783) — "에이전트 지식은 전부 검토, 단 이 도메인만 자동통과". ──
t("예외 규칙 → 보수적 누적을 건너뛰고 확정", () => {
  const rules: IngestPolicyRule[] = [
    { id: 1, match_actor_kind: "ai", action: "confirm", action_update: "review" },              // 전역 게이트
    { id: 2, match_actor_kind: "ai", match_category: "org", action: "auto", action_update: "auto", is_exception: true }, // 이 도메인만 통과
  ];
  const exempt = resolveIngestPolicy({ actor_kind: "ai", category: "org" }, rules);
  assert.equal(exempt.create, "auto");        // 예외 승리
  assert.equal(exempt.update, "auto");
  assert.equal(exempt.create_rule_id, 2);

  const gated = resolveIngestPolicy({ actor_kind: "ai", category: "brand" }, rules);
  assert.equal(gated.create, "confirm");      // 예외 미매치 → 전역 게이트 그대로
  assert.equal(gated.update, "review");
});

t("예외 여러 개 매치 → 우선순위 최상위 1개 확정(동률이면 먼저 만든 것)", () => {
  const rules: IngestPolicyRule[] = [
    { id: 1, match_actor_kind: "ai", action: "drop" },
    { id: 2, match_actor_kind: "ai", action: "confirm", priority: 1, is_exception: true },
    { id: 3, match_actor_kind: "ai", action: "auto", priority: 9, is_exception: true },
  ];
  const d = resolveIngestPolicy({ actor_kind: "ai" }, rules);
  assert.equal(d.create, "auto");             // priority 9 예외 승리(보수적 drop 을 이긴다 — 명시적 완화)
  assert.equal(d.create_rule_id, 3);
});

t("예외 규칙도 enabled=false 면 무시", () => {
  const rules: IngestPolicyRule[] = [
    { id: 1, match_actor_kind: "ai", action: "confirm" },
    { id: 2, match_actor_kind: "ai", match_category: "org", action: "auto", is_exception: true, enabled: false },
  ];
  assert.equal(resolveIngestPolicy({ actor_kind: "ai", category: "org" }, rules).create, "confirm");
});

console.log(`\n${pass} passed`);
