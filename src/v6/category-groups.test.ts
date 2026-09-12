// 묶음 룰 테이블(#1631) — «어떤 지식도 그 밖으로 가지 않는다» 를 **구조로** 지킨다.
//  발주(원준 2026-09-12): «직업·직군마다 MECE 하게 3~5개 … 절대로 그 밖에 들어가지 않게».
//  말로 «MECE 하게 만들었다» 는 다음 사람이 한 줄 고치면 깨진다. 그래서 집합마다 다섯 원칙의
//  **분할**(빠짐 없음·겹침 없음)을 단언한다 — 이름이 바뀌어도, 집합이 늘어도 이 검사는 그대로 돈다.
import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_PRINCIPLES, GROUP_SETS, PRINCIPLE_TIE_BREAK, groupSetFor, groupSetPromptLines } from "./category-groups.js";

const SETS = Object.entries(GROUP_SETS);

test("① 집합마다 다섯 원칙의 분할이다 — 빠짐 없고 겹치지 않는다(=그 밖이 필요 없다)", () => {
  assert.ok(SETS.length >= 8, `직무 집합이 너무 적다(${SETS.length})`);
  for (const [job, set] of SETS) {
    const seen: string[] = [];
    for (const g of set) {
      assert.ok(g.covers.length > 0, `${job}/${g.key}: 덮는 원칙이 없다`);
      for (const p of g.covers) {
        assert.ok(GROUP_PRINCIPLES.includes(p), `${job}/${g.key}: 모르는 원칙 ${p}`);
        assert.ok(!seen.includes(p), `${job}: 원칙 ${p} 가 두 묶음에 겹친다`);
        seen.push(p);
      }
    }
    assert.deepEqual([...seen].sort(), [...GROUP_PRINCIPLES].sort(), `${job}: 다섯 원칙을 다 안 덮는다`);
  }
});

test("② 집합 크기는 3~5개 — 사람이 한눈에 보는 층이다", () => {
  for (const [job, set] of SETS) {
    assert.ok(set.length >= 3 && set.length <= 5, `${job}: 묶음이 ${set.length}개(3~5 이어야 한다)`);
  }
});

test("③ 「기타·그 밖·미분류」 묶음을 두지 않는다", () => {
  for (const [job, set] of SETS) {
    for (const g of set) {
      assert.doesNotMatch(g.name, /기타|그 밖|그밖|미분류|etc|other/i, `${job}/${g.key}: 그 밖 묶음이다`);
      assert.ok(g.name.trim().length > 0 && g.hint.trim().length > 0, `${job}/${g.key}: 이름·설명이 비었다`);
    }
  }
});

test("④ key 는 집합 안에서 유일하고 슬러그다 — 이름을 바꿔도 카테고리가 이 값을 계속 가리킨다", () => {
  for (const [job, set] of SETS) {
    const keys = set.map((g) => g.key);
    assert.equal(new Set(keys).size, keys.length, `${job}: key 가 겹친다`);
    for (const k of keys) assert.match(k, /^[a-z][a-z0-9-]{0,30}$/, `${job}: key 규약 위반 ${k}`);
  }
});

test("⑤ 처음 설정의 직무 선택지가 전부 자기 집합을 갖는다(TALLY7 키와 같은 말)", () => {
  //  온보딩 화면이 주는 값 — 하나라도 빠지면 그 직무는 default 로 떨어진다(그건 사고지 설계가 아니다).
  for (const job of ["기획·PO", "마케팅", "연구·대학원", "법무·계약", "개발", "운영·재무", "1인 사업", "학생"]) {
    assert.ok(GROUP_SETS[job], `직무 ${job} 의 집합이 없다`);
    assert.equal(groupSetFor("company", job), GROUP_SETS[job]);
  }
});

test("⑥ 직무가 먼저, 없으면 무대, 그래도 없으면 default — 어느 경로로도 빈손이 없다", () => {
  assert.equal(groupSetFor("student", null), GROUP_SETS["학생"]);
  assert.equal(groupSetFor("academy", ""), GROUP_SETS["연구·대학원"]);
  assert.equal(groupSetFor("solo", undefined), GROUP_SETS["1인 사업"]);
  assert.equal(groupSetFor("company", "모르는직무"), GROUP_SETS.default);
  assert.equal(groupSetFor(null, null), GROUP_SETS.default);
  assert.equal(groupSetFor("", ""), GROUP_SETS.default);
  //  무대가 직무를 이기지 않는다 — 학생 무대라도 직무를 골랐으면 그 직무 집합이다.
  assert.equal(groupSetFor("student", "개발"), GROUP_SETS["개발"]);
});

test("⑦ 지시문에 실을 줄 — 묶음마다 key·이름·뜻이 있고, 겹칠 때의 순서가 함께 간다", () => {
  const lines = groupSetPromptLines(GROUP_SETS["개발"]);
  assert.equal(lines.length, GROUP_SETS["개발"].length + 1);
  for (const g of GROUP_SETS["개발"]) {
    assert.ok(lines.some((l) => l.includes(`\`${g.key}\``) && l.includes(g.name) && l.includes(g.hint)), `${g.key} 줄이 없다`);
  }
  assert.match(lines[lines.length - 1], /둘 이상에 맞으면/);
  assert.equal(PRINCIPLE_TIE_BREAK.length, GROUP_PRINCIPLES.length);
  assert.deepEqual([...PRINCIPLE_TIE_BREAK].sort(), [...GROUP_PRINCIPLES].sort());
});
