// denyLifecycleChange 단위 체크 — DB 불요(순수 함수).
// 실행: npm run build && node dist/capabilities/knowledge/lifecycle-guard.test.js
//
// 잠그는 불변식:
//  · #638 미러(observed)의 archived→active «복원» 은 **소스 무관** 금지 — 웹·REST·MCP 어디서 와도 같다(UI 버튼 숨김은 한 겹일 뿐).
//  · 단 미러의 pending→active «검토 승인» 은 사람의 정상 경로다 — 미러도 인입정책 confirm 이면 pending 으로 들어온다.
//  · #783 자가승인 차단은 MCP 에만 — 사람(web)의 승인은 그대로 통과해야 한다(검토 큐가 그걸로 돈다).
//  · 미러라도 archived/superseded 로의 전환은 여기서 막지 않는다(스윕·전파 경로가 쓴다).
import assert from "node:assert/strict";
import { denyLifecycleChange } from "./lifecycle-guard.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── #638 미러 복원 금지 — 소스 무관. ──
t("미러 →active: web 도 막힌다", () => {
  const d = denyLifecycleChange({ source: "web", target: "active", current: "archived", provenance: "observed", externalSystem: "notion" });
  assert.ok(d && d.includes("원본"));
});

t("미러 →active: mcp 도 막힌다", () => {
  assert.ok(denyLifecycleChange({ source: "mcp", target: "active", current: "archived", provenance: "observed", externalSystem: "notion" }));
});

t("미러 →active: source 미상(내부 호출)도 막힌다", () => {
  assert.ok(denyLifecycleChange({ source: null, target: "active", current: "archived", provenance: "observed", externalSystem: "notion" }));
});

t("미러 pending→active 는 통과 — 검토 큐 승인은 사람의 정상 경로다", () => {
  assert.equal(denyLifecycleChange({ source: "web", target: "active", current: "pending", provenance: "observed", externalSystem: "notion" }), null);
});

t("미러 pending→active: mcp 는 여전히 막힌다(자가승인)", () => {
  const d = denyLifecycleChange({ source: "mcp", target: "active", current: "pending", provenance: "observed", externalSystem: "notion" });
  assert.ok(d && d.includes("승인"));
});

t("미러 active→active 무연산은 통과 — 복원이 아니다", () => {
  assert.equal(denyLifecycleChange({ source: "web", target: "active", current: "active", provenance: "observed", externalSystem: "notion" }), null);
});

t("미러 →archived 는 통과 — 스윕·원본 전파가 쓰는 경로다", () => {
  assert.equal(denyLifecycleChange({ source: "web", target: "archived", current: "active", provenance: "observed", externalSystem: "notion" }), null);
});

// ── 저작(authored) 지식은 미러 규칙과 무관. ──
t("저작 지식 →active: 사람이면 통과(검토 승인)", () => {
  assert.equal(denyLifecycleChange({ source: "web", target: "active", current: "pending", provenance: "authored", externalSystem: null }), null);
});

// ── #783 자가승인 차단 — MCP 한정. ──
t("저작 지식 →active: mcp 면 막힌다(자가승인)", () => {
  const d = denyLifecycleChange({ source: "mcp", target: "active", current: "pending", provenance: "authored", externalSystem: null });
  assert.ok(d && d.includes("승인"));
});

t("pending 지식의 상태 변경: mcp 면 막힌다(큐에서 치우기 방지)", () => {
  const d = denyLifecycleChange({ source: "mcp", target: "archived", current: "pending", provenance: "authored", externalSystem: null });
  assert.ok(d && d.includes("검토 대기"));
});

t("pending 아닌 지식의 →archived: mcp 도 통과", () => {
  assert.equal(denyLifecycleChange({ source: "mcp", target: "archived", current: "active", provenance: "authored", externalSystem: null }), null);
});

t("current 미상이면 pending 가드는 적용 안 함", () => {
  assert.equal(denyLifecycleChange({ source: "mcp", target: "superseded", current: undefined, provenance: null, externalSystem: null }), null);
});

t("provenance 가 authored 로 뒤집혀도 외부 좌표가 있으면 막는다 — 미러 표식은 좌표다", () => {
  assert.ok(denyLifecycleChange({ source: "web", target: "active", current: "archived", provenance: "authored", externalSystem: "notion" }));
});

t("외부 좌표 없는 observed 행의 복원은 통과 — 싱크가 없어 여기가 유일한 복원 경로다", () => {
  assert.equal(denyLifecycleChange({ source: "web", target: "active", current: "archived", provenance: "observed", externalSystem: null }), null);
});

console.log(`\n${pass} passed`);
