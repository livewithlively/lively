// 묶음 룰 테이블(#1631) — «어떤 카테고리도 세 칸 밖으로 못 나간다» 를 **구조로** 지킨다.
//  발주(원준 2026-09-12): «MECE 하게 … 절대로 그 밖에 들어가지 않게» · «3개 정도로 조금 더 general 하게» ·
//   «직무마다 이름은 달라야 한다 — 학생에게 «거래» 라고 할 거냐».
//  말로 «MECE 하다» 는 다음 사람이 한 줄 고치면 깨진다. 그래서 집합마다 세 갈래의 **분할**을 단언한다.
import test from "node:test";
import assert from "node:assert/strict";
import { GROUP_PRINCIPLES, GROUP_SETS, PRINCIPLE_TIE_BREAK, groupSetFor, groupSetPromptLines } from "./category-groups.js";

const SETS = Object.entries(GROUP_SETS);

//  처음 설정 2단이 실제로 보내는 값 — 화면 라벨 그대로다(web/v2/onboarding.ts 의 STAGES.opts).
//   하나라도 빠지면 그 사람만 조용히 기본 묶음으로 떨어진다(빈손이 아니라서 «묶음이 나왔다» 로는 안 잡힌다).
const ONBOARDING_LABELS: Array<[string, string]> = [
  ["company", "제품·기획"], ["company", "마케팅·브랜드"], ["company", "영업·고객"], ["company", "개발·데이터"],
  ["company", "디자인"], ["company", "경영·전략"], ["company", "재무·회계·법무"], ["company", "인사·총무·운영"],
  ["solo", "컨설팅·자문"], ["solo", "개발·외주"], ["solo", "디자인·크리에이티브"], ["solo", "콘텐츠·미디어"],
  ["solo", "커머스"], ["solo", "교육·강의"], ["solo", "전문직"],
  ["study", "학부생"], ["study", "석사"], ["study", "박사"], ["study", "포닥·연구원"], ["study", "교원"],
  ["study", "수험(자격·고시)"],
];
//  옛 판(2026-09-12 이전)으로 답해 저장돼 있는 값 — 이 사람들도 같은 대우를 받아야 한다.
const LEGACY_JOBS = ["기획·PO", "마케팅", "개발", "운영·재무", "법무·계약", "1인 사업", "연구·대학원", "학생",
  "학부연구생", "외부 시험(자격 시험 등)", "수업·과제", "학회·동아리", "창업·사이드 프로젝트", "취업"];

test("① 집합마다 세 갈래의 분할이다 — 빠짐 없고 겹치지 않는다(= 그 밖이 필요 없다)", () => {
  for (const [job, set] of SETS) {
    const seen: string[] = [];
    for (const g of set) {
      assert.ok(g.covers.length > 0, `${job}/${g.key}: 덮는 갈래가 없다`);
      for (const p of g.covers) {
        assert.ok(GROUP_PRINCIPLES.includes(p), `${job}/${g.key}: 모르는 갈래 ${p}`);
        assert.ok(!seen.includes(p), `${job}: 갈래 ${p} 가 두 묶음에 겹친다`);
        seen.push(p);
      }
    }
    assert.deepEqual([...seen].sort(), [...GROUP_PRINCIPLES].sort(), `${job}: 세 갈래를 다 안 덮는다`);
  }
});

test("② 칸은 정확히 셋이고 key 는 g1·g2·g3 다 — 이름을 바꿔도 카테고리가 가리키는 값은 안 변한다", () => {
  for (const [job, set] of SETS) {
    assert.equal(set.length, 3, `${job}: 묶음이 ${set.length}개(셋이어야 한다)`);
    assert.deepEqual(set.map((g) => g.key), ["g1", "g2", "g3"], `${job}: key 규약 위반`);
  }
});

test("③ 「기타·그 밖·미분류」 묶음을 두지 않는다 · 이름과 뜻이 비어 있지 않다", () => {
  for (const [job, set] of SETS) {
    for (const g of set) {
      assert.doesNotMatch(g.name, /기타|그 밖|그밖|미분류|etc|other/i, `${job}/${g.key}: 그 밖 묶음이다`);
      assert.ok(g.name.trim() && g.hint.trim(), `${job}/${g.key}: 이름·뜻이 비었다`);
      assert.ok(g.name.length <= 8, `${job}/${g.key}: 이름이 길다(«${g.name}») — 한눈에 읽히는 일반명사여야 한다`);
    }
  }
});

test("④ 이름이 직무마다 그 사람 말이다 — 학생에게 «거래»·«고객» 이라고 하지 않는다", () => {
  for (const job of ["학부생", "석사", "박사", "포닥·연구원", "교원", "수험(자격·고시)"]) {
    const names = GROUP_SETS[job].map((g) => g.name).join(" ");
    assert.doesNotMatch(names, /거래|고객|매출|정산/, `${job}: 학업 자리에 장사 말이 들어갔다(${names})`);
  }
  //  거꾸로, 회사·사업 자리에 학교 말이 들어가도 안 된다.
  for (const job of ["제품·기획", "영업·고객", "커머스", "전문직"]) {
    const names = GROUP_SETS[job].map((g) => g.name).join(" ");
    assert.doesNotMatch(names, /학사|과제|교재|수강/, `${job}: 업무 자리에 학교 말이 들어갔다(${names})`);
  }
  //  그리고 세 칸이 서로 다른 이름이어야 한다(같으면 고를 수가 없다).
  for (const [job, set] of SETS) {
    assert.equal(new Set(set.map((g) => g.name)).size, 3, `${job}: 같은 이름이 두 번 쓰였다`);
  }
});

test("⑤ 처음 설정 2단 답이 전부 자기 집합을 갖는다 — 기본 묶음으로 조용히 떨어지지 않는다", () => {
  const fallback = GROUP_SETS.default.map((g) => g.name).join("/");
  for (const [stage, label] of ONBOARDING_LABELS) {
    const set = groupSetFor(stage, label);
    assert.equal(set.length, 3, `${label}: 묶음이 셋이 아니다`);
    assert.notEqual(set.map((g) => g.name).join("/"), fallback, `${label}: 기본 묶음으로 떨어졌다(제 이름이 없다)`);
  }
});

test("⑥ 옛 판 답도 같은 대우를 받는다 — 별칭이 끊기면 옛 사용자만 기본으로 떨어진다", () => {
  const fallback = GROUP_SETS.default.map((g) => g.name).join("/");
  for (const job of LEGACY_JOBS) {
    const set = groupSetFor(null, job);
    assert.notEqual(set.map((g) => g.name).join("/"), fallback, `옛 답 「${job}」 이 기본 묶음으로 떨어졌다`);
  }
});

test("⑦ 2단을 건너뛰어도 1단에 맞는 칸이 나온다 — 학업이 회사원 묶음을 받지 않는다", () => {
  assert.deepEqual(groupSetFor("study", null).map((g) => g.name), GROUP_SETS["학부생"].map((g) => g.name));
  assert.deepEqual(groupSetFor("academy", "").map((g) => g.name), GROUP_SETS["석사"].map((g) => g.name));
  assert.deepEqual(groupSetFor("student", undefined).map((g) => g.name), GROUP_SETS["학부생"].map((g) => g.name));
  assert.deepEqual(groupSetFor("solo", null).map((g) => g.name), GROUP_SETS["컨설팅·자문"].map((g) => g.name));
  assert.deepEqual(groupSetFor("company", "모르는답").map((g) => g.name), GROUP_SETS.default.map((g) => g.name));
  assert.deepEqual(groupSetFor(null, null).map((g) => g.name), GROUP_SETS.default.map((g) => g.name));
  //  2단이 1단을 이긴다 — 학업 자리라도 «개발·데이터» 를 골랐으면 그 집합이다.
  assert.deepEqual(groupSetFor("study", "개발·데이터").map((g) => g.name), GROUP_SETS["개발·데이터"].map((g) => g.name));
});

test("⑧ 지시문에 실을 줄 — 칸마다 key·이름·뜻이 있고, 가르는 기준이 함께 간다", () => {
  const lines = groupSetPromptLines(GROUP_SETS["개발·데이터"]);
  assert.equal(lines.length, 4);
  for (const g of GROUP_SETS["개발·데이터"]) {
    assert.ok(lines.some((l) => l.includes(`\`${g.key}\``) && l.includes(g.name) && l.includes(g.hint)), `${g.key} 줄이 없다`);
  }
  assert.match(lines[3], /누가 만들었나/);
  assert.match(lines[3], /사내 규정은 첫째 칸/);
  assert.deepEqual([...PRINCIPLE_TIE_BREAK].sort(), [...GROUP_PRINCIPLES].sort());
});
