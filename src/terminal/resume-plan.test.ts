// #3870 — 복원 이어받기 인자 결정(resumePlan)의 **엣지 표**(사양: 세 방식 · 네 정책 · 두 불변식).
//  표의 한 행 = 시험 하나. 바뀌는 것은 «없다» 확답 행(★)뿐이고, 나머지는 종전 동작을 **못 박는** 회귀 방지다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resumePlan, resumedKind, type ResumePlanInput, type ResumePlan } from "./resume-plan.js";

const ID = "dd17f75c-f920-4883-ad9a-7cbc2000bd50";
const HARNESSES = ["claude", "codex", "antigravity", "shell", ""];
const CHECKS: ResumePlanInput["check"][] = ["present", "absent", "unknown"];
const BRANCHES: ResumePlanInput["branch"][] = ["box", "node"];
const plan = (o: Partial<ResumePlanInput>): ResumePlan =>
  resumePlan({ mappedId: ID, harness: "claude", check: "unknown", branch: "box", ...o });

// ── ①② 대화 id 를 모르면 피커 ────────────────────────────────────────────────────
test("① 대화 id 가 없으면 어떤 조합에서도 피커다 — 사람이 눈으로 고르는 길은 남긴다", () => {
  for (const harness of HARNESSES) for (const check of CHECKS) for (const branch of BRANCHES) {
    assert.deepEqual(resumePlan({ mappedId: null, harness, check, branch }), { resumePick: true },
      `null/${harness}/${check}/${branch}`);
  }
});

test("② 대화 id 가 **빈 문자열**이어도 피커다(컬럼이 '' 로 남을 수 있다)", () => {
  for (const check of CHECKS) for (const branch of BRANCHES) {
    assert.deepEqual(resumePlan({ mappedId: "", harness: "claude", check, branch }), { resumePick: true },
      `''/${check}/${branch}`);
  }
});

// ── ③④ «있다» 확답 → 그 id ──────────────────────────────────────────────────────
test("③④ «있다» 확답이면 박스·노드 모두 그 id 로 정밀 이어받기다", () => {
  assert.deepEqual(plan({ check: "present", branch: "box" }), { resume: ID });
  assert.deepEqual(plan({ check: "present", branch: "node" }), { resume: ID });
});

// ── ★ ⑤⑥⑦ 이 과업이 바꾸는 자리 — «없다» 확답이면 피커를 열지 않는다 ─────────────
test("⑤ «없다» 확답 · 박스 → 새 대화(빈 피커에 가두지 않는다)", () => {
  assert.deepEqual(plan({ check: "absent", harness: "claude", branch: "box" }), {});
});

test("⑥ «없다» 확답 · 노드 → 새 대화 — 실측 사고의 모양(대화 id 는 있는데 그 기계에 파일이 없다)", () => {
  assert.deepEqual(plan({ check: "absent", harness: "claude", branch: "node" }), {});
});

test("⑦ «없다» 는 하네스와 무관하다 — 확인해서 없으면 없는 것이다", () => {
  for (const harness of HARNESSES) for (const branch of BRANCHES) {
    assert.deepEqual(resumePlan({ mappedId: ID, harness, check: "absent", branch }), {}, `${harness}/${branch}`);
  }
});

// ── ⑧⑨⑩⑪ «모른다» 는 종전 그대로 — 못 본 것을 «없다» 로 접지 않는다 ──────────────
test("⑧ 모른다 · claude · 박스 → 피커(종전에 확인 실패는 피커였다)", () => {
  assert.deepEqual(plan({ check: "unknown", harness: "claude", branch: "box" }), { resumePick: true });
});

test("⑨ 모른다 · claude · 노드 → 그 id 로 시도(종전에도 확인 없이 시도했다)", () => {
  //  이 줄이 뒤집히면 사람 PC 노드를 복원할 때마다 멀쩡한 대화를 두고 새 대화가 열린다 — 함정보다 나쁜 실패다.
  assert.deepEqual(plan({ check: "unknown", harness: "claude", branch: "node" }), { resume: ID });
});

test("⑩ 모른다 · 규약 미실측 하네스 → 어느 갈래든 그 id 로 시도", () => {
  for (const harness of ["codex", "antigravity", "shell"]) for (const branch of BRANCHES) {
    assert.deepEqual(resumePlan({ mappedId: ID, harness, check: "unknown", branch }), { resume: ID }, `${harness}/${branch}`);
  }
});

test("⑪ 모른다 · **빈 하네스('')** → 그 id 로 시도(하네스 표식이 빈 세션이 실재한다 — #3892)", () => {
  for (const branch of BRANCHES) {
    assert.deepEqual(resumePlan({ mappedId: ID, harness: "", check: "unknown", branch }), { resume: ID }, branch);
  }
});

// ── 불변식 — 전 조합(2×5×3×2 = 60) 을 훑는다 ────────────────────────────────────
test("불변식: 결과는 셋 중 하나뿐이고, resume 과 resumePick 은 함께 설 수 없다", () => {
  let seen = 0;
  const kinds = new Set<string>();
  for (const mappedId of [ID, null]) for (const harness of HARNESSES) for (const check of CHECKS) for (const branch of BRANCHES) {
    const p = resumePlan({ mappedId, harness, check, branch });
    seen++;
    const keys = Object.keys(p).sort().join(",");
    assert.ok(keys === "" || keys === "resume" || keys === "resumePick", `${harness}/${check}/${branch}: 예상 밖 키 «${keys}»`);
    assert.ok(!(p.resume && p.resumePick), "resume 과 resumePick 은 함께 설 수 없다");
    kinds.add(resumedKind(p));
  }
  assert.equal(seen, 2 * HARNESSES.length * CHECKS.length * BRANCHES.length);   // 배선 — 표를 실제로 다 돌았나
  assert.deepEqual([...kinds].sort(), ["fresh", "picker", "precise"]);          // 배선 — 세 갈래가 전부 실제로 났나
});

test("resumedKind 는 세 갈래를 그대로 옮긴다 — 화면이 «이어받았어요» 를 거짓으로 말하지 않게", () => {
  assert.equal(resumedKind({ resume: ID }), "precise");
  assert.equal(resumedKind({ resumePick: true }), "picker");
  assert.equal(resumedKind({}), "fresh");
});
