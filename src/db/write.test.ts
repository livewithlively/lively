// audit channel 정규화 단위 체크 — 허용 set 밖 source 가 'unknown' 으로 강제되는지(constraint 위반 방지).
// 실행: npm run build && node dist/db/write.test.js
import assert from "node:assert/strict";
import { normalizeAuditChannel } from "./write.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 허용값은 그대로 보존 ──
for (const c of ["mcp", "web", "connector", "cli", "migration", "unknown"]) {
  t(`허용 채널 보존: ${c}`, () => assert.equal(normalizeAuditChannel(c), c));
}

// ── NULL/undefined 는 허용(constraint 가 NULL 허용) → 보존 ──
t("null 보존", () => assert.equal(normalizeAuditChannel(null), null));
t("undefined → null", () => assert.equal(normalizeAuditChannel(undefined), null));

// ── 허용 set 밖은 'unknown' 으로 강제(이게 regenAgents id=174 류 크래시의 방어막) ──
t("clickup → unknown", () => assert.equal(normalizeAuditChannel("clickup"), "unknown"));
t("빈 문자열 → unknown (NULL 과 구분 — '' 는 constraint 위반값)", () => assert.equal(normalizeAuditChannel(""), "unknown"));
t("임의 하네스/에이전트명 → unknown", () => assert.equal(normalizeAuditChannel("claude-code"), "unknown"));
t("대소문자 구분 — 'Web' 은 허용값 아님 → unknown", () => assert.equal(normalizeAuditChannel("Web"), "unknown"));

console.log(`\n${pass} passed`);
