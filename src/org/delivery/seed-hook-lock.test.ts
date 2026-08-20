// 시드 훅 잠금(#1836) 순수 판정부 — 사양 엣지 표 13행 전수. DB·네트워크 없이 돈다.
//  실행: npm run build && node dist/org/delivery/seed-hook-lock.test.js
//  사양: "라이블리가 배포하는 훅은 조직이 동작을 못 바꾼다(켜기/끄기·대상·정렬만) · 실행 본문은 언제나 제품 코드".
import assert from "node:assert/strict";
import { DEFAULT_HOOKS } from "./default-content.js";
import { effectiveHook, isSeedHook, lockedFieldViolations, seedHookIds } from "./seed-hook-lock.js";

let pass = 0; const fails: string[] = [];
const t = (name: string, fn: () => void) => {
  try { fn(); pass++; console.log("ok  " + name); }
  catch (e) { fails.push(name); console.log("FAIL " + name + " — " + ((e as Error).message || "").split("\n")[0]); }
};

const CUSTOM_ID = "org-made-hook-not-in-seed";
const SEED = DEFAULT_HOOKS[0];
// 표 5·6 이 쓰는 '패턴 없는 시드 훅'. 없으면 그 두 행은 검증되지 않은 것이므로 아래 배선 단언이 잡는다.
const NO_MATCHER = DEFAULT_HOOKS.find((h) => h.matcher === null || h.matcher === "");

// ── 배선(관측 장치 생존) — 이게 죽으면 아래 표 전부가 헛돈다 ─────────────────
t("배선: 시드 훅 목록이 비어 있지 않고 대표 훅이 본문을 갖는다", () => {
  assert.ok(DEFAULT_HOOKS.length > 0, "DEFAULT_HOOKS 가 비었다");
  assert.ok(SEED && typeof SEED.source_code === "string" && SEED.source_code.length > 50, "대표 시드 훅에 본문이 없다");
});
t("배선: 패턴 없는 시드 훅이 실제로 존재한다(표 5·6 의 전제)", () => {
  assert.ok(NO_MATCHER, "matcher 가 비어 있는 시드 훅이 없다 — 표 5·6 이 검증되지 않는다");
});

// ── 쓰기 게이트 (표 1~8) ─────────────────────────────────────────────────
t("표1: 시드 훅 본문을 다른 값으로 → 거부", () =>
  assert.deepEqual(lockedFieldViolations(SEED.id, { source_code: SEED.source_code + "\n// 조직이 덧붙임" }), ["source_code"]));

t("표2: 시드 훅 이벤트+하네스를 다른 값으로 → 둘 다 거부", () => {
  const other = SEED.event === "Stop" ? "PreToolUse" : "Stop";
  const otherH = SEED.harness === "codex" ? "claude" : "codex";
  assert.deepEqual(lockedFieldViolations(SEED.id, { event: other, harness: otherH }).sort(), ["event", "harness"]);
});

t("표3: 시드 훅이라도 켜기/끄기·대상 구성원·정렬은 통과", () =>
  assert.deepEqual(lockedFieldViolations(SEED.id, { enabled: false, target_members: ["yoon"], sort: 7 }), []));

t("표4: 잠긴 항목 전부를 같은 값으로 재전송(멱등) → 통과", () =>
  assert.deepEqual(lockedFieldViolations(SEED.id, {
    source_code: SEED.source_code, event: SEED.event, matcher: SEED.matcher, harness: SEED.harness,
    timeout_sec: SEED.timeout_sec, label: SEED.label, note: SEED.note, summary: SEED.summary,
  }), []));

t("표5: 패턴 없는 훅에 빈 문자열 패턴 → 통과(없음과 등가)", () =>
  assert.deepEqual(lockedFieldViolations(NO_MATCHER!.id, { matcher: "" }), []));

t("표6: 패턴 없는 훅에 실제 패턴 문자열 → 거부(표5 의 경계 반대편)", () =>
  assert.deepEqual(lockedFieldViolations(NO_MATCHER!.id, { matcher: "Write|Edit" }), ["matcher"]));

t("표7: 키는 있으나 값이 미지정 → 통과", () =>
  assert.deepEqual(lockedFieldViolations(SEED.id, { source_code: undefined, event: undefined, matcher: undefined }), []));

t("표8: 조직 커스텀 훅은 무엇을 바꾸든 통과", () =>
  assert.deepEqual(lockedFieldViolations(CUSTOM_ID, { source_code: "// 딴 코드", event: "Stop", harness: "codex", matcher: "X" }), []));

// ── 서빙 (표 9~12) ──────────────────────────────────────────────────────
t("표9: 낡은 본문·지문 행 → 코드 본문·새 지문으로 교체, 켜짐 상태 보존", () => {
  const stale = { id: SEED.id, source_code: "// 한 달 낡은 편집본", content_hash: "staleeeee", enabled: true, target_members: ["yoon"] };
  const eff = effectiveHook(stale);
  assert.equal(eff.source_code, SEED.source_code, "본문이 코드 것으로 안 바뀌었다");
  assert.notEqual(eff.content_hash, "staleeeee", "지문이 낡은 채로 남았다 — 받는 쪽이 실행을 거부한다");
  assert.ok(eff.content_hash && eff.content_hash.length >= 32, "지문이 유효하지 않다");
  assert.equal(eff.enabled, true, "조직의 결정(켜짐)이 덮였다");
  assert.deepEqual(eff.target_members, ["yoon"], "조직의 결정(대상)이 덮였다");
});

t("표10: 이미 코드와 같은 행 → 그대로(같은 객체)", () => {
  const row = { id: SEED.id, source_code: SEED.source_code, content_hash: "keep-me" };
  assert.equal(effectiveHook(row), row, "불필요한 사본이 생겼다");
});

t("표11: 조직 커스텀 훅 본문은 절대 대체되지 않는다", () => {
  const row = { id: CUSTOM_ID, source_code: "// 조직이 만든 훅", content_hash: "abc" };
  const eff = effectiveHook(row);
  assert.equal(eff.source_code, "// 조직이 만든 훅");
  assert.equal(eff.content_hash, "abc");
});

t("표12: 지문 항목이 아예 없는 행 → 교체 후 지문이 생겨 있어야 한다", () => {
  const noHash = { id: SEED.id, source_code: "// 낡음" };
  const eff = effectiveHook(noHash);
  assert.equal(eff.source_code, SEED.source_code);
  assert.ok(eff.content_hash && String(eff.content_hash).length >= 32, "지문 없이 본문만 바뀌면 받는 쪽이 실행을 거부한다");
});

// ── 판정 (표 13) ────────────────────────────────────────────────────────
t("표13: 시드 id 는 잠금 대상, 커스텀 id 는 아님", () => {
  assert.equal(isSeedHook(SEED.id), true);
  assert.equal(isSeedHook(CUSTOM_ID), false);
  assert.equal(seedHookIds().length, DEFAULT_HOOKS.length);
});

console.log("\n" + pass + " passed, " + fails.length + " failed");
if (fails.length) process.exit(1);
