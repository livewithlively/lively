// resolveIngestPolicy 단위 체크(#638) — DB 불요(순수 함수). 테스트 러너 없이 node:assert 로 자급.
// 실행: npm run build && node dist/org/ingest-policy.test.js
//
// 잠그는 불변식(사용자 결정, [[ingest-autonomy-gate-design-638]]):
//  · 디폴트 auto(규칙 0 = 현행 무변) · 가장 보수적 승리(drop>confirm>auto) · match_* null=any · facet 부재 축은 구체 match 와 불일치.
import assert from "node:assert/strict";
import { resolveIngestPolicy, type IngestPolicyRule } from "./ingest-policy.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 디폴트: 규칙 없음 → auto(현행과 100% 동일, 오너가 켠 만큼만 gate). ──
t("규칙 0개 → auto(디폴트)", () => {
  assert.equal(resolveIngestPolicy({ category: "brand" }, []), "auto");
});

// ── 단일 매치 + 미매치 폴백. ──
t("카테고리 매치 confirm → confirm, 미매치 → auto", () => {
  const rules: IngestPolicyRule[] = [{ match_category: "fundraising", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ category: "fundraising" }, rules), "confirm");
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules), "auto");
});

// ── match_* null/'' = any(그 축 무시). ──
t("match_* 빈값 = any → 다른 축만으로 매치", () => {
  const rules: IngestPolicyRule[] = [{ match_provenance: "observed", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ provenance: "observed", category: "anything" }, rules), "confirm");
});

// ── 여러 매치 → 가장 보수적 승리(drop > confirm > auto). ──
t("drop+confirm+auto 동시 매치 → drop 승리", () => {
  const rules: IngestPolicyRule[] = [
    { match_system: "slack", action: "confirm" },
    { match_channel: "cooking", action: "drop" },
    { action: "auto" }, // 전체 any
  ];
  assert.equal(resolveIngestPolicy({ system: "slack", channel: "cooking" }, rules), "drop");
});
t("confirm vs auto 동시 매치 → confirm 승리", () => {
  const rules: IngestPolicyRule[] = [
    { action: "auto" },
    { match_category: "market-competition", action: "confirm" },
  ];
  assert.equal(resolveIngestPolicy({ category: "market-competition" }, rules), "confirm");
});

// ── facet 부재 + 구체 match → 불일치(그 축 신호가 없으면 그 규칙은 안 걸린다). ──
t("sensitive facet 없음 + match_sensitive 규칙 → 불일치(auto)", () => {
  const rules: IngestPolicyRule[] = [{ match_sensitive: "cooking", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules), "auto");
  assert.equal(resolveIngestPolicy({ sensitive: "cooking" }, rules), "confirm");
});

// ── enabled=false → 평가 제외. ──
t("enabled=false 규칙은 무시", () => {
  const rules: IngestPolicyRule[] = [{ match_category: "brand", action: "drop", enabled: false }];
  assert.equal(resolveIngestPolicy({ category: "brand" }, rules), "auto");
});

// ── 다축 AND — 한 축이라도 어긋나면 미매치. ──
t("다축 규칙 — 한 축 어긋나면 미매치", () => {
  const rules: IngestPolicyRule[] = [{ match_system: "notion", match_provenance: "observed", action: "confirm" }];
  assert.equal(resolveIngestPolicy({ system: "notion", provenance: "observed" }, rules), "confirm");
  assert.equal(resolveIngestPolicy({ system: "notion", provenance: "authored" }, rules), "auto");
});

console.log(`\n${pass} passed`);
