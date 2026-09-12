// 처음 설정 1단의 축을 **사람에서 자리로** 옮겼다 (#1631, 원준님 2026-09-12)
//
//  지시: *"처음부터 디폴트로 직업이 뭐냐? 이렇게 물어보니까 좀 별로다 … 어떤 목적으로 만들어진
//   워크스페이스 인지를 물어보는 과정이 하나 더 있어야하지 않을까?"*
//
//  결론은 «단을 늘린다» 가 아니었다 — 늘리려던 갈래(업무/학업/…)가 이미 1단과 **같은 축**이라
//  클릭만 늘고 새 정보가 0이었다. 대신 1단의 축을 갈아끼웠다:
//   · 종전 「어디에서 일하고 계세요?」 = 사람. 워크스페이스를 둘 만들어도 답이 같다.
//   · 지금  「이 워크스페이스를 무엇에 쓰실 건가요?」 = 자리. 워크스페이스마다 다르다.
//  가르는 기준은 **소속**이다(회사·팀 / 내 사업 / 학업·연구). 공유 구조(혼자냐 팀이냐)는
//  묻지 않는다 — 인원에서 나오기로 이미 정해져 있다(#1875 D1, web/v2/rail.ts).
//
//  ⚠ 이 검사가 지키는 핵심은 **층 분리**다: 자리는 워크스페이스 칸(welcome.stage), 사람은 계정 칸(work).
//   한 칸에 몰면 워크스페이스 둘을 만든 사람에게 뒤가 앞을 덮는다 — #2265 가 고친 바로 그 사고다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { groupSetFor } from "../../v6/category-groups.js";

const read = (rel: string): string =>
  readFileSync(new URL(rel, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const strip = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

const WEB = strip(read("../../../web/v2/onboarding.ts"));
const WELCOME = strip(read("../../capabilities/delivery/welcome.ts"));

test("① 1단이 사람이 아니라 자리를 묻는다", () => {
  assert.match(WEB, /이 워크스페이스를 무엇에 쓰실 건가요\?/, "자리를 묻는 문구가 없다");
  assert.doesNotMatch(WEB, /어디에서 일하고 계세요\?/, "사람에게 묻던 옛 문구가 남아 있다");
});

test("② 카드는 세 장이고, 값은 company·solo·study 다", () => {
  const m = WEB.match(/const ID = \{([^}]*)\};/);
  assert.ok(m, "1단 ID 맵을 못 찾았다 — 검사가 헛돈다");
  const ids = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(ids, ["company", "solo", "study"], `1단 값이 다르다: ${ids.join(",")}`);
  for (const label of ["회사·팀 업무", "내 사업·프리랜스", "학업·연구"]) {
    assert.ok(WEB.includes(`card('${label}'`), `카드 「${label}」 가 없다`);
  }
  //  옛 카드 라벨이 화면에 남아 있으면 두 축이 한 화면에 섞인다.
  for (const gone of ["card('회사·조직'", "card('1인·프리랜서'", "card('학교·연구'", "card('학생'"]) {
    assert.ok(!WEB.includes(gone), `옛 카드가 남아 있다: ${gone}`);
  }
});

test("③ 「두 번만 고르시면 됩니다」 약속을 지킨다 — 질문은 여전히 둘", () => {
  assert.match(WEB, /두 번만 고르시면 됩니다/, "약속 문구가 사라졌다");
  const order = WEB.match(/const ORDER = \[([^\]]*)\]/);
  assert.ok(order, "ORDER 를 못 찾았다");
  const qs = ["'stage'", "'role'"].filter((k) => order[1].includes(k));
  assert.deepEqual(qs, ["'stage'", "'role'"], "질문 장면이 둘이 아니다 — 약속과 화면이 어긋난다");
  //  단을 하나 더 끼우려던 갈래가 되살아나면 약속이 깨진다.
  assert.ok(!order[1].includes("'purpose'"), "1단 앞에 또 다른 질문 장면이 끼었다");
});

//  (#3872 와의 맞물림) 초대로 합류한 사람의 차례표(ORDER_JOIN)에는 stage 가 없다 — 그 자리의 용도는
//   이미 정해져 있으므로 묻지 않는 게 맞다. 그런데 2단 머리글이 1단 답을 되뇌고 있어서, 합류자에게는
//   «답한 적 없는 것»을 «…시군요» 라고 말하게 된다. 그리고 카드 라벨을 문장에 그대로 이으면
//   «회사·팀 업무이시군요» 가 된다 — 라벨(카드용)과 ack(문장용)를 가른 이유다.
test("③′ 2단 머리글 — 라벨을 문장에 잇지 않고, 안 물은 사람에게 되뇌지 않는다", () => {
  assert.doesNotMatch(WEB, /\$\{esc\(stageOf\(\)\.label\)\}이시군요/,
    "카드 라벨을 문장에 그대로 잇고 있다 — 「회사·팀 업무이시군요」 가 된다");
  assert.match(WEB, /S\.stage \? \(stageOf\(\)\.ack \|\| stageOf\(\)\.label\)/,
    "1단을 안 본 사람(합류자)에게도 되뇌고 있다");
  //  갈래마다 문장이 있어야 한다 — 없으면 label 로 떨어져 같은 어색함이 돌아온다.
  const stages = WEB.match(/"STAGES": \{([\s\S]*?)\n   \},\n   "KINDS7"/);
  assert.ok(stages, "STAGES 표를 못 찾았다");
  const acks = (stages[1].match(/"ack":/g) || []).length;
  const labels = (stages[1].match(/"label":/g) || []).length;
  assert.equal(acks, labels, `갈래 ${labels}개 중 ${acks}개만 문장이 있다`);
});

test("④ 2단 — study 는 단계 축이고, 옛 값 표는 지우지 않았다", () => {
  const stages = WEB.match(/"STAGES": \{([\s\S]*?)\n   \},\n   "KINDS7"/);
  assert.ok(stages, "STAGES 표를 못 찾았다");
  const body = stages[1];
  assert.match(body, /"study": \{/, "study 갈래가 없다");
  assert.match(body, /"axis": "어느 단계세요\?"/, "study 의 2단이 단계 축이 아니다");
  for (const step of ["학부생", "석사", "박사", "포닥·연구원", "교원", "수험(자격·고시)"]) {
    assert.ok(body.includes(`"${step}"`), `study 2단에 「${step}」 이 없다`);
  }
  //  ⚠ 하다 만 자리(#2207)에 옛 값이 남은 사람이 있다 — 표를 지우면 그 사람의 2단이 회사 부서로 그려진다.
  assert.match(body, /"academy": \{/, "옛 academy 표를 지웠다 — 하다 만 자리 호환이 깨진다");
  assert.match(body, /"student": \{/, "옛 student 표를 지웠다 — 하다 만 자리 호환이 깨진다");
});

test("⑤ study 의 2단 답이 실제 묶음 집합으로 간다 — 빈손이 없다", () => {
  //  2단 답(직무 슬러그)마다 묶음이 나와야 한다. 안 나오면 그 사람 화면에 갈래 묶음이 안 생긴다.
  for (const job of ["학생", "연구·대학원"]) {
    const set = groupSetFor("study", job);
    assert.ok(set.length >= 3, `직무 「${job}」 의 묶음이 ${set.length}개다`);
  }
  //  ⚠ 단계를 안 고르고 넘어가도(2단 건너뛰기) **학업·연구에 맞는** 묶음이 나와야 한다.
  //   study 가 무대 폴백 표에 없으면 groupSetFor 는 조용히 default(회사원용)로 떨어진다 —
  //   빈손이 아니라서 «묶음이 나왔다» 로는 절대 안 잡히는 고장이다. 그래서 집합을 특정해 못박는다.
  const byStage = groupSetFor("study", null).map((g) => g.key);
  assert.deepEqual(byStage, groupSetFor(null, "학생").map((g) => g.key),
    `study 폴백이 학업용 집합이 아니다: ${byStage.join(",")}`);
  assert.notDeepEqual(byStage, groupSetFor(null, null).map((g) => g.key),
    "study 폴백이 default(회사원용) 집합으로 떨어졌다");
  //  다섯 원칙을 다 덮는다 — 「기타」로 새는 자료가 없어야 한다.
  const covers = new Set(groupSetFor("study", null).flatMap((g) => g.covers));
  for (const c of ["make", "exchange", "money", "rule", "learn"]) {
    assert.ok(covers.has(c as never), `study 폴백이 「${c}」 를 안 덮는다`);
  }
});

test("⑥ ★자리는 워크스페이스 칸으로, 사람은 계정 칸으로 — 한 칸에 몰지 않는다", () => {
  //  자리(용도)는 welcome 에 실린다. welcome 은 #2265 이후 워크스페이스 칸이다.
  assert.match(WELCOME, /welcome: \{ done_at:[^}]*stage: stage \|\| null \}/,
    "1단 답이 워크스페이스 칸(welcome.stage)에 안 실린다 — 두 번째 워크스페이스가 첫 번째를 덮는다");
  //  사람(직무)은 계정 칸 work.asis 그대로. 그래서 두 표가 따로 있어야 한다.
  assert.match(WELCOME, /const STAGE_LABEL: Record<string, string> = \{/, "사람 말 표가 없다");
  assert.match(WELCOME, /export const STAGE_PURPOSE: Record<string, string> = \{/, "자리 이름 표가 없다");
  //  옛 값으로 답한 사람도 자리 이름이 나와야 한다(화면에서만 사라졌지 데이터는 남아 있다).
  const purpose = WELCOME.match(/export const STAGE_PURPOSE: Record<string, string> = \{([\s\S]*?)\};/);
  assert.ok(purpose, "STAGE_PURPOSE 본문을 못 찾았다");
  for (const k of ["company", "solo", "study", "academy", "student"]) {
    assert.ok(new RegExp(`\\b${k}:`).test(purpose[1]), `STAGE_PURPOSE 에 ${k} 가 없다`);
  }
});
