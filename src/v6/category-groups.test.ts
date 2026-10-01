// 묶음 룰 테이블(#1631 → #1812 v8) — «어떤 카테고리도 칸 밖으로 못 나간다» 를 **구조로** 지킨다.
//  발주(원준 2026-09-12): «MECE 하게 … 절대로 그 밖에 들어가지 않게» · «직무마다 이름은 달라야 한다 — 학생에게 «거래» 라고 할 거냐».
//  v8(원준 2026-09-30): «own/traded/received 를 모든 곳에 적용한다는 거 자체가 좀 그래 … 우리는 원래 사업/제품/시스템» ·
//   «전문직이 왜 바로 법조인이 된 건지» · «우리 학회는 어디에 위치해».
//  영역 축은 자리마다 달라서 «세 원칙의 합 = 전부» 증명이 없다. 대신 집합마다 판정 질문(ask)·전순서(order)·받침 칸(fallback)이
//   다 갖춰졌는지를 단언한다 — 셋이 있으면 무엇이 와도 정확히 한 칸에 떨어진다. 칸이 «내용상» 맞게 나뉘는지는 설계 문서의 표본 시뮬레이션 몫.
//
//  ── 엣지 표 (행마다 테스트 하나 이상) ──────────────────────────────────────────
//   E1  모든 집합                       → 3~5칸·g1..gN·이름 유일·8자 이내·「기타」 없음·뜻 있음        ①
//   E2  모든 집합                       → 판정 질문이 칸 이름 전부 · 전순서 = 칸 순열 · 받침 ∈ 칸     ②
//   E3  표의 키                         → v7 2단 라벨 29 + default                                  ③
//   E4  학업·모임 / 업무 자리 이름        → 장사 말 / 학교 말 없음                                     ④
//   E5  전문직 네 경로                   → 법무 말 없음                                              ⑤
//   E6  옛 «학회·동아리» · 무대 group     → 동아리·학회·소모임                                         ⑥
//   E7  현행 2단 라벨 21                 → v7 이행표대로 고정                                         ⑦
//   E8  옛 판 답 14                      → 기본 집합이 아님                                           ⑧
//   E9  무대만·자유 입력·둘 다 없음·모르는 무대·2단+무대 → 무대 중립·무대 중립·default·default·2단     ⑨
//   E10 제품을 만드는 자리 세 경로        → 사업/제품/시스템                                           ⑩
//   E11 지시문(그대로인 집합)             → 칸 줄 + 판정 질문·전순서 줄, «누가 만들었나» 없음           ⑪
//   E12 이름 고친 묶음·순서 섞인 묶음·빈 목록 → 일반 문장·알아봄·못 알아봄                           ⑫
//   E13 우리 워크스페이스 카테고리 이름    → 사업/제품/시스템 기대 칸                                   ⑬
//   E14 모든 집합 × 계정 서버 기본 5 + 빈 이름 → 항상 집합 안 · 빈 이름은 받침 칸                      ⑭
//   E15 자리를 모를 때(기본 집합)         → 종전 «누가 만들었나» 표와 같은 답                           ⑮
//   E16 못 알아본 집합 · 묶음 0개         → 묶음 이름 낱말 → 첫 묶음 · null                             ⑯
//   E17 두 칸 낱말이 다 걸리는 이름        → 화면 순서가 아니라 전순서가 이긴다                           ⑰
//   E18 모든 집합 × 칸 이름의 낱말         → 그 칸으로 간다(«사업 개발» 이 «개발» 때문에 시스템으로 가지 않는다) ⑱
//   E19 영문 약어가 다른 낱말 속에 든 이름  → 약어로 안 잡힘 · 소문자도 잡힘                               ⑲
//   E20 두 뜻 낱말(지도·표준화·논문)        → 엉뚱한 칸으로 안 감                                         ⑳
//   E21 프로토타입 키(constructor·__proto__) → 터지지 않고 default                                        ㉑
//   E22 이름 하나 고침 · 칸 하나 더함       → 나머지 칸은 원래 집합 낱말로 · 고친/더한 칸은 그 이름 낱말로   ㉒
//   E23 옛 판(v8 전) 세 칸이 심긴 워크스페이스 → 종전 «누가 만들었나» 배치·지시문 그대로                    ㉓
//   E24 직접 적은 답(카드 없는 자리·전문직·창업·직무)  → 낱말로 맞는 자리                                  ㉔ ㉙ ㉝
//   E25 1인 세무사 세목별 신고                 → 고객 건                                                    ㉕
//   E26 보편 축(default·옛 판) 칸 이름이 일반명사 → 이름 낱말을 안 쓴다 · 회의록 서랍은 주고받은 것          ㉖
//   E27 서버가 만드는 서랍 이름(디스코드 등)   → 받침 칸 · 고친 칸 이름도 영문 경계                          ㉗
//   E28 뜻·판정 질문·경계 예의 예시 문구        → 서버도 같은 칸                                              ㉘
//   E29 이름 둘을 고친 옛 판 · 동점 · 받침 이름만 고침 → 뜻으로 알아봄 · 같은 자리                           ㉚
//   E30 사람이 쓴 구분자(ㆍ & -)               → 낱말을 가른다                                               ㉛
//   E31 낱말 정규식의 괄호 속 «|»              → 맨 바깥에서만 가른다 · 빈 대안 없음                         ㉜
//   E32 창작 집합의 제작 노하우·장비           → 아이디어·노하우                                             ㉞
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { GROUP_SETS, genericRuleLine, closestSet, groupKeyForName, groupRuleLine, groupSetDefFor, groupSetFor, groupSetPromptLines, nameTokens, setMatching, splitTop } from "./category-groups.js";

const SETS = Object.entries(GROUP_SETS);
const names = (stage: string | null, job: string | null | undefined) => groupSetFor(stage, job).map((g) => g.name).join("/");
const DEFAULT = names(null, null);

//  v7 설계(#1968) 2단 라벨 29 — 표의 키. 하나라도 빠지면 화면이 v7 로 바뀌는 날 그 자리만 무대 폴백으로 떨어진다.
const V7_LABELS = [
  "팀 공용", "스타트업·제품 조직", "경영·기획·전략", "마케팅·브랜드·홍보", "영업·거래처 관리", "고객 응대·의료·돌봄",
  "개발·IT·데이터", "디자인·콘텐츠·미디어", "연구개발·연구", "생산·건설·운송·물류", "재무·인사·총무·법무·행정", "교육·교원",
  "전문직·컨설팅 서비스",
  "외주·용역·프리랜스", "자문·상담·돌봄 서비스", "교육·강의", "스타트업·내 제품·서비스", "가게·판매·제조",
  "창작·콘텐츠·크리에이터", "영업·중개", "임대·투자·자산 운용",
  "수업·과제·팀플", "연구·논문", "시험·자격·어학 준비", "취업·진학 준비",
  "동아리·학회·소모임", "자치·대표 기구", "커뮤니티·스터디·동문회", "봉사·비영리·종교·지역",
];

//  지금 처음 설정 2단이 실제로 보내는 값(web/v2/onboarding.ts 의 STAGES.opts) → v7 이행표(#1968 §4-6)가 정한 자리.
//   예외: 1인 «컨설팅·자문»·«전문직» 은 전문직 집합으로(R2 실측 — 세무사 세목별 신고가 자문 집합에선 살림 칸으로 갔다).
const CURRENT_LABELS: Array<[stage: string, label: string, v7: string]> = [
  ["company", "제품·기획", "경영·기획·전략"], ["company", "마케팅·브랜드", "마케팅·브랜드·홍보"],
  ["company", "영업·고객", "영업·거래처 관리"], ["company", "개발·데이터", "개발·IT·데이터"],
  ["company", "디자인", "디자인·콘텐츠·미디어"], ["company", "경영·전략", "경영·기획·전략"],
  ["company", "재무·회계·법무", "재무·인사·총무·법무·행정"], ["company", "인사·총무·운영", "재무·인사·총무·법무·행정"],
  ["solo", "컨설팅·자문", "전문직·컨설팅 서비스"], ["solo", "개발·외주", "외주·용역·프리랜스"],
  ["solo", "디자인·크리에이티브", "외주·용역·프리랜스"], ["solo", "콘텐츠·미디어", "창작·콘텐츠·크리에이터"],
  ["solo", "커머스", "가게·판매·제조"], ["solo", "교육·강의", "교육·강의"], ["solo", "전문직", "전문직·컨설팅 서비스"],
  ["study", "학부생", "수업·과제·팀플"], ["study", "석사", "연구·논문"], ["study", "박사", "연구·논문"],
  ["study", "포닥·연구원", "연구개발·연구"], ["study", "교원", "교육·교원"], ["study", "수험(자격·고시)", "시험·자격·어학 준비"],
];
//  옛 판(2026-09-12 이전)으로 답해 저장돼 있는 값 — 이 사람들도 같은 대우를 받아야 한다.
const LEGACY_JOBS = ["기획·PO", "마케팅", "개발", "운영·재무", "법무·계약", "1인 사업", "연구·대학원", "학생",
  "학부연구생", "외부 시험(자격 시험 등)", "수업·과제", "학회·동아리", "창업·사이드 프로젝트", "취업"];

//  계정 서버가 모든 워크스페이스에 심는 기본 카테고리 — 묶음보다 먼저 생겨 서버 이름 규칙이 받는다.
const ACCOUNT_DEFAULTS = ["업무 프로젝트", "리서치·자료", "사람·조직", "운영·행정", "개인"];

test("① 집합마다 3~5칸 · key 는 g1부터 차례로 · 이름은 유일하고 8자 이내 · 「기타·그 밖·미분류」 없음", () => {
  for (const [label, set] of SETS) {
    const gs = set.groups;
    assert.ok(gs.length >= 3 && gs.length <= 5, `${label}: 칸이 ${gs.length}개(3~5여야 한다)`);
    assert.deepEqual(gs.map((g) => g.key), gs.map((_, i) => `g${i + 1}`), `${label}: key 규약 위반`);
    assert.equal(new Set(gs.map((g) => g.name)).size, gs.length, `${label}: 같은 이름이 두 번 쓰였다`);
    for (const g of gs) {
      assert.doesNotMatch(g.name, /기타|그 밖|그밖|미분류|etc|other/i, `${label}/${g.key}: 그 밖 묶음이다`);
      assert.ok(g.name.trim() && g.hint.trim(), `${label}/${g.key}: 이름·뜻이 비었다`);
      assert.ok(g.name.length <= 8, `${label}/${g.key}: 이름이 길다(«${g.name}»)`);
    }
  }
});

test("② ★지시문과 서버가 같은 칸 구성을 말한다 — 판정 질문이 칸 이름을 전부 부르고, 전순서가 모든 칸을 한 번씩, 받침 칸이 집합 안에 있다", () => {
  for (const [label, set] of SETS) {
    const keys = set.groups.map((g) => g.key);
    for (const g of set.groups) assert.ok(set.ask.includes(`«${g.name}»`), `${label}: 판정 질문이 «${g.name}» 을 안 부른다`);
    assert.deepEqual([...set.order].sort(), [...keys].sort(), `${label}: 전순서가 칸을 빠짐없이 한 번씩 덮지 않는다(${set.order.join(",")})`);
    assert.ok(keys.includes(set.fallback), `${label}: 받침 칸 ${set.fallback} 이 집합에 없다`);
    assert.deepEqual(Object.keys(set.words).sort(), [...keys].sort(), `${label}: 서버 낱말이 칸마다 없다`);
  }
});

test("③ 표의 키는 v7 2단 라벨 29개 + default — 빠진 자리도 남는 키도 없다", () => {
  assert.deepEqual(Object.keys(GROUP_SETS).filter((k) => k !== "default").sort(), [...V7_LABELS].sort());
});

test("④ 이름이 그 사람 말이다 — 학업·모임 자리에 장사 말 없음 · 업무 자리에 학교 말 없음", () => {
  for (const job of ["수업·과제·팀플", "연구·논문", "시험·자격·어학 준비", "취업·진학 준비", "동아리·학회·소모임", "커뮤니티·스터디·동문회"]) {
    assert.doesNotMatch(names(null, job), /거래|고객|매출|정산|손님/, `${job}: 학업·모임 자리에 장사 말(${names(null, job)})`);
  }
  for (const job of ["경영·기획·전략", "영업·거래처 관리", "가게·판매·제조", "전문직·컨설팅 서비스", "스타트업·제품 조직"]) {
    //  «과제» 는 뺀다 — 회사에서도 쓰는 말이다(전략 과제·추진 과제·연구 과제).
    assert.doesNotMatch(names(null, job), /학사|교재|수강|팀플|필기/, `${job}: 업무 자리에 학교 말(${names(null, job)})`);
  }
});

test("⑤ ★전문직은 법조인이 아니다 — 세무사·회계사·건축사·노무사가 같이 쓰는 이름", () => {
  for (const [stage, job] of [["solo", "전문직"], ["solo", "법무·계약"], [null, "전문직·컨설팅 서비스"], [null, "자문·상담·돌봄 서비스"]] as const) {
    assert.doesNotMatch(names(stage, job), /법령|판례|소송|변론|사건|수임/, `${job}: 법무 말투(${names(stage, job)})`);
  }
  assert.notEqual(names("solo", "전문직"), "검토/계약/법령");
});

test("⑥ ★학회는 모임 자리다 — 학부생 세트(과제·학사)로 떨어지지 않는다", () => {
  assert.equal(names(null, "학회·동아리"), names(null, "동아리·학회·소모임"));
  assert.equal(names("group", null), names(null, "동아리·학회·소모임"));
  assert.doesNotMatch(names(null, "학회·동아리"), /과제|학사/);
});

test("⑦′ 위 21개 라벨이 지금 화면 그대로다 — 화면 라벨이 바뀌면 이 표(와 별칭)도 바뀌어야 한다", () => {
  //  web 은 dist 로 굽히지 않는다 — 소스를 읽는다(onboarding-purpose-axis.test.ts 와 같은 방법).
  const web = readFileSync(new URL("../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/../../web/", "/web/"), "utf8");
  const stages = web.match(/"STAGES": \{([\s\S]*?)\n   \},\n   "KINDS7"/);
  assert.ok(stages, "STAGES 표를 못 찾았다");
  for (const st of ["company", "solo", "study"]) {
    const at = stages[1].indexOf(`"${st}": {`);
    assert.ok(at >= 0, `${st} 표를 못 찾았다`);
    const from = stages[1].indexOf('"opts": [', at);
    const block = stages[1].slice(from, stages[1].indexOf("\n     ]", from));
    const labels = [...block.matchAll(/\[\s*"([^"]+)"/g)].map((m) => m[1]);
    assert.ok(labels.length >= 5, `${st}: 라벨을 못 읽었다(${labels.length})`);
    assert.deepEqual(labels.sort(), CURRENT_LABELS.filter(([s]) => s === st).map(([, l]) => l).sort(), `${st}: 화면 라벨과 표가 다르다`);
  }
});

test("⑦ 지금 처음 설정 2단 답 21개가 v7 이행표대로 간다 — 별칭이 끊기면 무대 폴백으로 조용히 떨어진다", () => {
  for (const [stage, label, v7] of CURRENT_LABELS) {
    assert.equal(groupSetDefFor(stage, label), GROUP_SETS[v7], `${label}: ${v7} 집합이 아니다(${names(stage, label)})`);
  }
});

test("⑧ 옛 판 답도 같은 대우를 받는다 — 별칭이 끊기면 옛 사용자만 기본으로 떨어진다", () => {
  for (const job of LEGACY_JOBS) assert.notEqual(names(null, job), DEFAULT, `옛 답 「${job}」 이 기본 묶음으로 떨어졌다`);
});

test("⑨ 2단을 건너뛰면 1단에 맞는 중립 칸 · 무대도 모르면 default · 2단이 1단을 이긴다", () => {
  assert.equal(names("company", null), names(null, "팀 공용"));
  assert.equal(names("company", "모르는답"), names(null, "팀 공용"));     // 자유 입력 = 무대 중립(v7 §4-6)
  assert.equal(names("solo", null), names(null, "외주·용역·프리랜스"));
  assert.equal(names("study", null), names(null, "수업·과제·팀플"));
  assert.equal(names("academy", ""), names(null, "연구·논문"));
  assert.equal(names("student", undefined), names(null, "수업·과제·팀플"));
  assert.equal(names(null, null), "작업/주고받은 것/자료");
  assert.equal(names("모르는무대", null), DEFAULT);
  assert.equal(names("study", "개발·데이터"), names(null, "개발·IT·데이터"));
});

test("⑩ 제품을 만드는 자리는 사업/제품/시스템 — 회사 쪽과 내 사업 쪽이 같은 집합", () => {
  assert.equal(names(null, "스타트업·제품 조직"), "사업/제품/시스템");
  assert.equal(names(null, "스타트업·내 제품·서비스"), "사업/제품/시스템");
  assert.equal(names(null, "창업·사이드 프로젝트"), "사업/제품/시스템");
});

test("⑪ 지시문 줄 — 칸마다 key·이름·뜻, 마지막 줄은 그 집합의 판정 질문·카테고리 규칙·받침 칸", () => {
  const def = groupSetDefFor(null, "개발·IT·데이터");
  const lines = groupSetPromptLines(def.groups);
  assert.equal(lines.length, def.groups.length + 1);
  for (const g of def.groups) {
    assert.ok(lines.some((l) => l.includes(`\`${g.key}\``) && l.includes(g.name) && l.includes(g.hint)), `${g.key} 줄이 없다`);
  }
  const rule = lines[lines.length - 1];
  assert.ok(rule.includes(def.ask), "판정 질문이 없다");
  //  묶음에 드는 것은 카테고리다 — 대부분이 가는 칸, 고루 걸치면 본업(받침) 칸. 리브가 받침 칸을 모르면 서버와 엇갈린다.
  assert.match(rule, /카테고리는 이름이 아니라 그 안에 모일 자료 대부분이 해당하는 칸/);
  assert.match(rule, /하나를 통째로 담은 카테고리도 내용이 대부분 한 칸이면 그 칸/);   // 채널·행사·스터디 하나를 담은 카테고리(#1812 R9)
  assert.match(rule, /종류로 나눈 서랍도,/);   // 회의록을 무조건 받침 칸으로 보내지 않는다(R2)
  assert.match(rule, /어느 칸에도 딱 맞지 않거나 정말 고루 걸치면 «시스템»/);
  assert.match(rule, /칸이 비어도 된다/);                                   // 5칸을 채우려고 카테고리를 지어내지 않는다(R4)
  assert.doesNotMatch(rule, /가장 많이 든 칸/);                             // 2턴엔 늘 동수라 뺐다(R4)
  assert.equal(rule.trim(), groupRuleLine(def));
  assert.doesNotMatch(rule, /누가 만들었나|내 손에서 나온/, "영역 축 자리에 종전 보편 축 문장이 남았다");
});

test("⑫ 사람이 이름을 고친 묶음이면 집합을 못 알아본다 — 일반 기준 문장으로 간다", () => {
  const gs = groupSetFor(null, "스타트업·제품 조직").map((g) => ({ ...g }));
  assert.ok(setMatching(gs), "그대로인 묶음을 못 알아본다");
  gs[1] = { ...gs[1], name: "프로덕트" };
  assert.equal(setMatching(gs), null);
  assert.equal(groupSetPromptLines(gs).slice(-1)[0].trim(), genericRuleLine(gs));
  //  일반 문장도 받침 칸을 이름으로 말한다 — 서버가 이름으로 모르는 카테고리를 넣는 그 칸(이름을 고쳤어도 같은 자리).
  assert.match(genericRuleLine(gs), /정말 고루 걸치면 «프로덕트»/);
  assert.match(genericRuleLine([{ key: "a", name: "우리 일" }, { key: "b", name: "바깥" }]), /정말 고루 걸치면 «우리 일»/);
  //  key 순서가 섞여 와도(화면 순서를 바꿨다) 같은 집합이다.
  assert.equal(setMatching([...groupSetFor(null, "팀 공용")].reverse()), GROUP_SETS["팀 공용"]);
  assert.equal(setMatching([]), null);
});

//  ── 서버 이름 규칙 — 묶음보다 먼저 생긴 카테고리를 «그 밖» 에 두지 않는 마지막 받침 ──
test("⑬ 우리 워크스페이스(사업/제품/시스템) 표본 — 이름만으로 맞는 칸", () => {
  const gs = groupSetFor(null, "스타트업·제품 조직");
  const k = (name: string) => gs.find((g) => g.key === groupKeyForName(name, gs))?.name;
  for (const n of ["시장·경쟁", "펀드레이징", "브랜드", "GTM(시장진입)", "수익모델·프라이싱", "조직", "조직·인력 운영", "시장 리서치", "재무·회계"]) assert.equal(k(n), "사업", n);
  for (const n of ["사용자 리서치", "고객 인터뷰", "VOC 모음"]) assert.equal(k(n), "제품", n);   // 사용자·고객 인터뷰는 제품(경계 예)
  for (const n of ["웹 UI 디자인 시스템", "지표·실험", "제품 계획", "하네스 표준화", "세션 작업환경"]) assert.equal(k(n), "제품", n);
  for (const n of ["개발 규약", "실행 인프라·운영", "접근통제·주권", "서비스 운영 알림"]) assert.equal(k(n), "시스템", n);
});

test("⑭ 어느 집합에서도 계정 서버 기본 카테고리가 칸 밖으로 안 떨어진다 · 빈 이름은 받침 칸", () => {
  for (const [label, set] of SETS) {
    const keys = set.groups.map((g) => g.key);
    for (const n of [...ACCOUNT_DEFAULTS, "", "   ", null, undefined]) {
      const got = groupKeyForName(n, set.groups);
      assert.ok(got && keys.includes(got), `${label}: «${String(n)}» → ${got}`);
    }
    assert.equal(groupKeyForName("", set.groups), set.fallback, `${label}: 빈 이름이 받침 칸으로 안 간다`);
    assert.equal(groupKeyForName(null, set.groups), set.fallback, `${label}: null 이름이 받침 칸으로 안 간다`);
  }
});

test("⑮ 자리를 모를 때(기본 집합)는 종전 표와 같은 답 — 상대가 있는 말 > 바깥 말 > 나머지", () => {
  const gs = groupSetFor(null, null);
  const k = (n: string) => groupKeyForName(n, gs);
  for (const n of ["견적·계약", "정산·세금", "회의록", "사람·조직", "고객 리서치"]) assert.equal(k(n), "g2", n);
  for (const n of ["리서치·자료", "시장·경쟁 동향", "업계 표준"]) assert.equal(k(n), "g3", n);
  for (const n of ["인쇄·제작", "업무 프로젝트", "개인", "운영·행정", "하네스 표준화"]) assert.equal(k(n), "g1", n);
});

test("⑯ 집합을 못 알아보면 — 묶음 이름의 낱말 → 없으면 화면 순서상 첫 묶음 · 묶음이 0개면 null", () => {
  const gs = [{ key: "a", name: "우리 일" }, { key: "b", name: "시장·고객" }];
  assert.equal(groupKeyForName("시장 조사", gs), "b");
  assert.equal(groupKeyForName("하네스", gs), "a");
  assert.equal(groupKeyForName("", gs), "a");
  assert.equal(groupKeyForName("시장 조사", []), null);
});

test("⑰ 두 칸 낱말이 다 걸리면 화면 순서가 아니라 전순서가 이긴다", () => {
  //  개발·IT·데이터: 화면 순서는 기능(g1) 먼저지만 전순서는 운영 > 기능 — «장애»(운영)·«API»(기능)가 함께 든 이름은 운영.
  const dev = groupSetFor(null, "개발·IT·데이터");
  assert.equal(dev.find((g) => g.key === groupKeyForName("장애 대응 API", dev))?.name, "운영");
  //  재무·인사·총무·법무·행정: 화면 순서는 재무(g1) 먼저지만 전순서는 법무 > 재무 — «계약»(법무)·«정산»(재무).
  const bo = groupSetFor(null, "재무·인사·총무·법무·행정");
  assert.equal(bo.find((g) => g.key === groupKeyForName("계약 정산", bo))?.name, "법무");
});

test("⑱ 칸 이름의 낱말은 그 칸으로 간다 — 영역 축 집합마다 전수(두 칸이 같이 쓰는 낱말은 빼고 — «연구 과제»·«과제 행정» 의 «과제»)", () => {
  //  «누가 만들었나» 보편 축(default)은 뺀다 — 칸 이름이 «자료» 같은 일반명사라 낱말로 쓰지 않는다(㉖).
  for (const [label, set] of SETS.filter(([k]) => k !== "default")) {
    for (const g of set.groups) {
      for (const t of nameTokens(g.name).filter((x) => !set.nameWordSkips.includes(x))) {
        const got = groupKeyForName(t, set.groups);
        assert.equal(got, g.key, `${label}: «${t}» → ${set.groups.find((x) => x.key === got)?.name}(«${g.name}» 이어야 한다)`);
      }
    }
  }
  const pb = groupSetFor(null, "스타트업·제품 조직");
  const at = (n: string) => pb.find((g) => g.key === groupKeyForName(n, pb))?.name;
  assert.equal(at("사업 개발"), "사업");
  assert.equal(at("제품 개발"), "제품");
});

test("⑲ 영문 약어는 낱말로만 잡는다 — AIRFLOW 의 IR·BUILD 의 UI 가 아니다 · 대소문자 무시", () => {
  const pb = groupSetFor(null, "스타트업·제품 조직");
  const at = (n: string) => pb.find((g) => g.key === groupKeyForName(n, pb))?.name;
  assert.equal(at("AIRFLOW 설정"), "제품");          // 받침 칸 — «사업»(IR) 아님
  assert.equal(at("IR 자료"), "사업");
  assert.equal(at("ir 덱"), "사업");
  const dev = groupSetFor(null, "개발·IT·데이터");
  const dv = (n: string) => dev.find((g) => g.key === groupKeyForName(n, dev))?.name;
  assert.equal(dv("BUILD 노트"), "시스템");           // 받침 칸 — «기능»(UI) 아님
  assert.equal(dv("api 문서"), "기능");
  assert.equal(dv("A/B 테스트"), "분석");             // «테스트»(규약·도구)보다 분석이 앞선다
});

test("⑳ 두 뜻 낱말이 엉뚱한 칸으로 보내지 않는다", () => {
  const at = (job: string, n: string) => { const gs = groupSetFor(null, job); return gs.find((g) => g.key === groupKeyForName(n, gs))?.name; };
  assert.equal(at("연구·논문", "지도 데이터 분석"), "연구");             // «지도» 교수가 아니다
  assert.equal(at("연구·논문", "지도 교수 미팅"), "연구실·수업");
  assert.equal(at("연구개발·연구", "공정 표준화"), "연구 과제");        // «표준화» 는 «표준»(문헌) 이 아니다
  assert.equal(at("연구개발·연구", "업계 표준"), "문헌");
  assert.equal(at("연구개발·연구", "내 논문 원고"), "연구 과제");       // 내가 쓰는 원고는 문헌이 아니다
  assert.equal(at("팀 공용", "고객 미팅 회의록"), "대외");              // «회의» 가 조직으로 끌지 않는다
  assert.equal(at("전문직·컨설팅 서비스", "세법 개정 검토"), "기준·동향"); // «검토» 가 고객 건으로 끌지 않는다
  assert.equal(at("외주·용역·프리랜스", "종합소득세"), "사업 운영");      // «세금» 만으로는 못 잡던 세목
  assert.equal(at("경영·기획·전략", "OEM 제조사 발주"), "기획·과제");     // «제조사» 의 «조사» 가 아니다(칸 이름 낱말에도 같은 경계)
  assert.equal(at("마케팅·브랜드·홍보", "제조사 미팅"), "캠페인·콘텐츠");
  assert.equal(at("재무·인사·총무·법무·행정", "위험성평가"), "총무·행정"); // «평가» 가 인사로 끌지 않는다
  assert.equal(at("재무·인사·총무·법무·행정", "인사 평가"), "인사");
  assert.equal(at("가게·판매·제조", "광고 성과·ROAS"), "손님·판매");
});

test("㉑ 프로토타입 키로 물어도 터지지 않는다 — 기본 집합", () => {
  for (const k of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.equal(names(null, k), DEFAULT, `job=${k}`);
    assert.equal(names(k, null), DEFAULT, `stage=${k}`);
  }
});

test("㉒ 이름 하나를 고치거나 칸을 하나 더해도 나머지 칸은 원래 집합대로", () => {
  //  우리 워크스페이스에 «개인» 칸을 더했다 — 셋은 그대로다.
  const ours = [...groupSetFor(null, "스타트업·제품 조직").map(({ key, name }) => ({ key, name })), { key: "g4", name: "개인" }];
  const at = (gs: Array<{ key: string; name: string }>, n: string) => gs.find((g) => g.key === groupKeyForName(n, gs))?.name;
  for (const n of ["실행 인프라·운영", "개발 규약", "접근통제·주권"]) assert.equal(at(ours, n), "시스템", n);
  assert.equal(at(ours, "지표·실험"), "제품");
  assert.equal(at(ours, "개인 메모"), "개인");                        // 더한 칸은 그 이름 낱말로
  assert.equal(at(ours, "하네스 표준화"), "제품");                    // 받침 칸은 그대로
  //  개발 집합의 첫 칸 이름을 고쳤다.
  const dev = groupSetFor(null, "개발·IT·데이터").map(({ key, name }) => ({ key, name }));
  dev[0] = { ...dev[0], name: "기능·화면" };
  assert.equal(closestSet(dev), GROUP_SETS["개발·IT·데이터"]);
  assert.equal(setMatching(dev), null);                               // 지시문은 일반 문장(이름이 다르다)
  for (const [n, want] of [["장애 대응", "운영"], ["배포 이력", "운영"], ["코드 리뷰 규칙", "규약·도구"], ["화면 목록", "기능·화면"]] as const) {
    assert.equal(at(dev, n), want, n);
  }
});

test("㉓ 옛 판(v8 전) 세 칸이 심긴 워크스페이스는 종전 «누가 만들었나» 대로 — 첫 칸으로 몰지 않는다", () => {
  const OLD = [["개발", "협업", "자료"], ["기획", "협업", "시장"], ["검토", "계약", "법령"], ["과제", "학사", "자료"], ["강의", "수강생", "자료"]];
  for (const [a, b, c] of OLD) {
    const gs = [{ key: "g1", name: a }, { key: "g2", name: b }, { key: "g3", name: c }];
    const k = (n: string) => groupKeyForName(n, gs);
    assert.equal(k("견적·계약"), "g2", `${a}/${b}/${c}: 견적·계약`);
    assert.equal(k("시장·경쟁 동향"), "g3", `${a}/${b}/${c}: 시장·경쟁 동향`);
    assert.equal(k("인쇄·제작"), "g1", `${a}/${b}/${c}: 인쇄·제작`);
    const rule = groupSetPromptLines(gs).slice(-1)[0];
    assert.match(rule, /내 손에서 나온 것/, `${a}/${b}/${c}: 옛 축 문장이 아니다`);
    assert.ok(rule.includes(`«${b}»`), `${a}/${b}/${c}: 칸 이름이 문장에 없다`);
  }
});

test("㉔ 직접 적은 답도 맞는 자리로 — 카드가 없는 학회·자치·종교·현장·전문직이 무대 폴백으로 떨어지지 않는다", () => {
  const R: Array<[string, string, string]> = [
    ["study", "경영학회 회장", "동아리·학회·소모임"],
    ["company", "아파트 입주자대표회의 회장", "자치·대표 기구"],
    ["study", "교회 청년부 회장", "봉사·비영리·종교·지역"],
    ["company", "건설 현장소장", "생산·건설·운송·물류"],
    ["solo", "1인 세무사 사무소", "전문직·컨설팅 서비스"],
    ["solo", "한의원 원장", "자문·상담·돌봄 서비스"],
    ["company", "요양병원 간호사", "고객 응대·의료·돌봄"],
    ["company", "3인 스타트업 대표", "스타트업·제품 조직"],
    ["solo", "1인 SaaS 창업", "스타트업·내 제품·서비스"],
    ["solo", "공방 운영", "가게·판매·제조"],
    ["company", "고등학교 교사", "교육·교원"],
    ["study", "이직 준비", "취업·진학 준비"],
    ["study", "공시 준비", "시험·자격·어학 준비"],
    ["company", "데이터 분석가", "개발·IT·데이터"],
  ];
  for (const [stage, job, want] of R) assert.equal(groupSetDefFor(stage, job), GROUP_SETS[want], `${stage}/«${job}» → ${names(stage, job)}`);
  //  낱말이 없으면 종전대로 무대 중립 · 무대마다 갈리는 낱말은 그 무대가 없으면 건너뛴다.
  assert.equal(names("company", "현장 영업"), names(null, "영업·거래처 관리"));   // 직무 낱말 — 업종 낱말보다 먼저(R3)
  assert.equal(names("company", "교육 담당자"), names(null, "팀 공용"));          // 낱말이 없으면 무대 중립
  assert.equal(names("company", "온라인 쇼핑몰 MD"), names(null, "팀 공용"));      // 쇼핑몰은 1인 무대에서만 가게
  assert.equal(names("solo", "온라인 쇼핑몰"), names(null, "가게·판매·제조"));
  //  라벨·별칭이 낱말보다 먼저다 — «교육·강의» 라벨은 교사 낱말(교육·교원)이 아니라 제 집합.
  assert.equal(names("solo", "교육·강의"), names(null, "교육·강의"));
});

test("㉕ ★1인 세무사(«전문직») — 세목별 신고·조사 대응은 고객 건, 사무소 자신의 일은 사무 운영", () => {
  const gs = groupSetFor("solo", "전문직");
  const at = (n: string) => gs.find((g) => g.key === groupKeyForName(n, gs))?.name;
  for (const n of ["종합소득세 신고", "법인세 세무조정", "세무조사 대응"]) assert.equal(at(n), "고객 건", n);
  assert.equal(at("예규·판례"), "기준·동향");
  assert.equal(at("서식·체크리스트"), "노하우·서식");
  assert.equal(at("수임료 청구"), "사무 운영");
  assert.ok(groupSetDefFor("solo", "전문직").ask.includes("세목"), "판정 질문이 세목별 묶음을 고객 건이라고 말하지 않는다");
  //  교원 집합의 맨 «과제» 는 판정 질문에 쓰지 않는다 — 교사의 과제(숙제)와 교수의 과제(연구)가 갈린다(#1812 R8).
  assert.doesNotMatch(GROUP_SETS["교육·교원"].ask, /공부\(과제/);
});

test("㉖ 보편 축(default·옛 판)은 칸 이름을 낱말로 쓰지 않는다 — 종전 판정 그대로 · 회의록 서랍은 지시문과 서버가 같은 칸", () => {
  const cases: Array<[string[], string, string]> = [
    [["작업", "주고받은 것", "자료"], "그 밖의 자료", "g1"], [["작업", "주고받은 것", "자료"], "발표 자료", "g1"],
    [["운영", "거래", "규정"], "사내 규정", "g1"], [["강의", "수강생", "자료"], "강의 자료", "g1"],
    [["개발", "협업", "자료"], "협업 툴 가이드", "g1"],
  ];
  for (const [ns, n, want] of cases) {
    const gs = ns.map((name, i) => ({ key: `g${i + 1}`, name }));
    assert.equal(groupKeyForName(n, gs), want, `${ns.join("/")}: «${n}»`);
  }
  const d = groupSetFor(null, null);
  assert.equal(groupKeyForName("회의록", d), "g2");
  assert.match(groupSetPromptLines(d).slice(-1)[0], /회의록·메일 서랍은 주고받은 것/);
});

test("㉗ 서버가 만드는 서랍 이름(자료 종류·확장자)은 영역 축 집합에서 엉뚱한 칸으로 안 간다 — «디스코드» 는 «코드» 가 아니다", () => {
  const KIND = ["슬랙", "디스코드", "노션 문서", "클릭업 문서", "드라이브 파일", "이미지", "묶음 파일"];
  for (const [label, set] of SETS.filter(([k]) => k !== "default")) {
    for (const n of KIND) {
      const got = groupKeyForName(n, set.groups);
      //  문서 계열은 «문서» 를 낱말로 가진 칸(총무·행정)이 있으면 그 칸도 허용한다 — 나머지는 받침 칸.
      const ok = got === set.fallback || (/문서/.test(n) && set.words[got!]?.test("문서"));
      assert.ok(ok, `${label}: «${n}» → ${set.groups.find((g) => g.key === got)?.name}(받침 «${set.groups.find((g) => g.key === set.fallback)?.name}» 이어야 한다)`);
    }
  }
  //  사람이 고친 칸의 이름 낱말도 같은 경계 — «AI» 칸이 «EMAIL» 을 잡지 않는다.
  const gs = [{ key: "a", name: "업무" }, { key: "b", name: "AI" }];
  assert.equal(groupKeyForName("EMAIL 정리", gs), "a");
  assert.equal(groupKeyForName("ai 실험", gs), "b");
});

test("㉘ ★문구가 서로 맞는다 — 뜻·판정 질문·경계 예에 적힌 예시를 그대로 이름으로 주면 서버도 같은 칸(R3)", () => {
  const T: Array<[string, string, string]> = [
    ["연구개발·연구", "국책과제 A", "연구 과제"], ["연구개발·연구", "연구 과제", "연구 과제"], ["연구개발·연구", "실험법", "방법·장비"],
    ["연구개발·연구", "표준 작업 절차", "방법·장비"], ["연구개발·연구", "특허 출원", "과제 행정"], ["연구개발·연구", "연구 동향", "문헌"],
    ["고객 응대·의료·돌봄", "진료 프로토콜", "지침"], ["고객 응대·의료·돌봄", "상담 매뉴얼", "지침"], ["고객 응대·의료·돌봄", "근무 기록", "운영·프로그램"],
    ["영업·거래처 관리", "영업 자료", "상품·가격"], ["영업·거래처 관리", "영업 화법", "상품·가격"], ["영업·거래처 관리", "영업 회의", "영업 현황"],
    ["개발·IT·데이터", "데이터 모델", "시스템"], ["개발·IT·데이터", "도메인 모델", "시스템"], ["개발·IT·데이터", "지표 적재 구조", "시스템"],
    ["개발·IT·데이터", "코드 규칙", "규약·도구"], ["개발·IT·데이터", "모델 실험", "분석"], ["개발·IT·데이터", "Java/Backend 가이드", "시스템"],   // «A/B» 가 «a/B» 를 잡지 않는다 → 받침
    ["가게·판매·제조", "판매가 정하기", "상품"], ["가게·판매·제조", "원가·마진 계산", "돈·세무"],
    ["동아리·학회·소모임", "학술대회 프로그램", "세션·활동"], ["동아리·학회·소모임", "MT 행사", "운영"], ["동아리·학회·소모임", "연합 행사", "프로젝트·대외"],
    ["팀 공용", "고객 응대 기록", "업무"], ["팀 공용", "이사회", "조직"], ["팀 공용", "응대 매뉴얼", "지침·양식"], ["팀 공용", "결재 문서 양식", "지침·양식"], ["팀 공용", "주간 업무 보고", "업무"], ["팀 공용", "고객 불만 처리", "업무"], ["팀 공용", "FAQ", "지침·양식"], ["팀 공용", "조례", "지침·양식"], ["팀 공용", "교통 정책 사업", "업무"], ["팀 공용", "고객 인사이트", "대외"],
    ["경영·기획·전략", "제품 로드맵", "전략"], ["경영·기획·전략", "사용자 인터뷰", "조사·동향"], ["경영·기획·전략", "A/B 실험", "성과"], ["경영·기획·전략", "기능 백로그", "기획·과제"], ["경영·기획·전략", "가격 정책", "기획·과제"], ["경영·기획·전략", "시장 분석 리포트", "조사·동향"], ["경영·기획·전략", "월간 경영 보고", "성과"], ["경영·기획·전략", "A/B 실험 리포트", "성과"], ["경영·기획·전략", "업계 리포트", "조사·동향"], ["경영·기획·전략", "인터뷰 인사이트", "조사·동향"], ["경영·기획·전략", "신규 사업 제안서", "기획·과제"],
    ["마케팅·브랜드·홍보", "광고 소재", "캠페인·콘텐츠"], ["마케팅·브랜드·홍보", "SNS 콘텐츠", "캠페인·콘텐츠"], ["마케팅·브랜드·홍보", "광고 계정", "채널·성과"], ["마케팅·브랜드·홍보", "대행사 계약", "채널·성과"],
    ["교육·강의", "수강생 모집", "운영"], ["교육·강의", "수강생 후기", "운영"],
    ["시험·자격·어학 준비", "기출 오답 정리", "과목 정리"], ["시험·자격·어학 준비", "강의 노트", "과목 정리"],
    ["수업·과제·팀플", "팀 프로젝트", "수업"], ["수업·과제·팀플", "졸업 프로젝트", "수업"], ["수업·과제·팀플", "사이드 프로젝트", "활동"],
    ["자문·상담·돌봄 서비스", "환자별 처방", "맡은 건"], ["자문·상담·돌봄 서비스", "처방집", "노하우·서식"], ["자문·상담·돌봄 서비스", "놀이 프로그램", "노하우·서식"],
    ["생산·건설·운송·물류", "배송 일정", "현장·작업"], ["생산·건설·운송·물류", "협력사 발주", "거래처·구매"], ["생산·건설·운송·물류", "입고 관리", "현장·작업"], ["생산·건설·운송·물류", "재고 실사", "현장·작업"], ["생산·건설·운송·물류", "원자재 재고", "설비·자재"], ["생산·건설·운송·물류", "하도급 계약", "거래처·구매"],
    ["외주·용역·프리랜스", "블로그 홍보", "고객"], ["외주·용역·프리랜스", "정산·세금계산서", "사업 운영"], ["외주·용역·프리랜스", "수입·지출", "사업 운영"], ["교육·교원", "대학원생 지도", "연구·연수"], ["교육·교원", "학교폭력 업무", "행정 업무"], ["개발·IT·데이터", "CI/CD", "시스템"], ["개발·IT·데이터", "배포 파이프라인", "시스템"], ["개발·IT·데이터", "배포 이력", "운영"],
    ["영업·중개", "세법 개정 소식", "시장·제도"], ["영업·중개", "양도세 상담", "고객"], ["영업·중개", "내 종합소득세", "영업·운영"],
    ["자치·대표 기구", "예산 의결 회의록", "회의·의결"], ["자치·대표 기구", "관리비", "재정"], ["자치·대표 기구", "집행부 인수인계", "안건·사업"],
    ["커뮤니티·스터디·동문회", "모임 발표 자료", "주제·자료"],
    ["연구·논문", "참고 논문", "문헌"], ["연구·논문", "공개 데이터셋", "문헌"],
    ["재무·인사·총무·법무·행정", "직원 교육", "인사"], ["재무·인사·총무·법무·행정", "자산 평가", "재무"], ["재무·인사·총무·법무·행정", "고정자산", "재무"],
    ["교육·교원", "진로 지도", "학생"], ["교육·교원", "담임 업무", "학생"], ["교육·교원", "NRF 과제 A", "연구·연수"], ["교육·교원", "수업 과제", "수업"], ["연구개발·연구", "참고 논문", "문헌"], ["연구개발·연구", "기술 이전 계약", "과제 행정"], ["연구·논문", "리뷰 논문", "문헌"], ["연구·논문", "포닥 지원", "진로"], ["연구·논문", "교수 임용 준비", "진로"], ["연구개발·연구", "펠로십 지원", "과제 행정"], ["재무·인사·총무·법무·행정", "인사 평가", "인사"], ["경영·기획·전략", "고객 인사이트", "조사·동향"], ["마케팅·브랜드·홍보", "페르소나", "시장"], ["영업·거래처 관리", "신입 교육", "상품·가격"], ["창작·콘텐츠·크리에이터", "편집 요령", "아이디어·노하우"], ["교육·교원", "연구비 정산", "행정 업무"], ["교육·교원", "연구실 운영", "행정 업무"],
    ["임대·투자·자산 운용", "전월세 신고", "거래·계약"], ["임대·투자·자산 운용", "임대료", "수익·세금"], ["임대·투자·자산 운용", "매매 일지", "거래·계약"], ["임대·투자·자산 운용", "공모주 청약", "거래·계약"],
    ["디자인·콘텐츠·미디어", "인터뷰 기사", "작업"], ["디자인·콘텐츠·미디어", "팀 회의", "운영"],
    ["봉사·비영리·종교·지역", "프로그램 참여자 명단", "활동"],
  ];
  for (const [job, n, want] of T) {
    const gs = groupSetFor(null, job);
    assert.equal(gs.find((g) => g.key === groupKeyForName(n, gs))?.name, want, `${job}: «${n}»`);
  }
});

test("㉙ 직접 적은 답 — 낱말이 다른 말 속에 들거나 같은 말 다른 뜻이면 잡지 않는다(R3)", () => {
  const R: Array<[string, string, string]> = [
    ["company", "Django 백엔드 개발자", "개발·IT·데이터"], ["company", "MongoDB DBA", "팀 공용"],
    ["company", "국회의원 보좌관", "팀 공용"], ["company", "시의원 비서", "팀 공용"],
    ["study", "세무사 준비", "시험·자격·어학 준비"], ["study", "회계사 시험 준비", "시험·자격·어학 준비"],
    ["company", "데이터 기반 마케터", "마케팅·브랜드·홍보"], ["company", "병원 마케팅", "마케팅·브랜드·홍보"],
    ["company", "건설 회사 회계팀", "재무·인사·총무·법무·행정"], ["company", "세무팀 대리", "재무·인사·총무·법무·행정"],
    ["company", "IR·공시 담당", "팀 공용"], ["solo", "고시원 운영", "default"], ["company", "유학원 상담", "팀 공용"],
    ["company", "커뮤니티 매니저", "팀 공용"], ["solo", "네이버 카페 운영자", "default"],
    ["company", "유치원 교사", "교육·교원"], ["company", "앱 개발자", "개발·IT·데이터"],
  ];
  for (const [stage, job, want] of R) assert.equal(groupSetDefFor(stage, job), GROUP_SETS[want], `${stage}/«${job}» → ${names(stage, job)}`);
});

test("㉚ 이름을 고쳐도 심을 때 복사된 뜻으로 알아본다 — 옛 판 두 칸 고침 · 동점 · 받침 칸 이름만 고침", () => {
  //  옛 판 «개발/협업/자료» 의 이름 둘을 고쳤다 — 뜻이 그대로라 «누가 만들었나» 배치가 유지된다(HEAD 와 같은 답).
  const old = [
    { key: "g1", name: "내 작업물", hint: "설계·구현처럼 내가 만든 것" },
    { key: "g2", name: "커뮤니케이션", hint: "리뷰·요청처럼 사람과 오간 것" },
    { key: "g3", name: "자료", hint: "문서·라이브러리·사례처럼 바깥 것" },
  ];
  assert.equal(groupKeyForName("견적·계약", old), "g2");
  assert.equal(groupKeyForName("시장 동향", old), "g3");
  //  옛 판 «강의/수강생/자료» 에서 g3 이름만 고쳤다 — v8 교육·강의(강의/수강생 겹침)가 아니라 옛 판으로 알아본다.
  const lec = [
    { key: "g1", name: "강의", hint: "강의자료·교안처럼 내가 만든 것" },
    { key: "g2", name: "수강생", hint: "수강생·의뢰·정산처럼 상대가 있는 것" },
    { key: "g3", name: "참고", hint: "교재·참고자료처럼 바깥 것" },
  ];
  assert.equal(groupKeyForName("견적·계약", lec), "g2");
  assert.equal(groupKeyForName("회의록", lec), "g2");
  //  받침 칸(제품)의 이름만 «프로덕트» 로 고쳤다 — 같은 자리이므로 받침은 그대로 g2.
  const pb = groupSetFor(null, "스타트업·제품 조직").map((g) => ({ ...g }));
  pb[1] = { ...pb[1], name: "프로덕트" };
  assert.equal(groupKeyForName("하네스", pb), "g2");
  assert.equal(groupKeyForName("프로덕트 로드맵", pb), "g2");
});

test("㉛ 사람이 쓴 칸 이름의 구분자 — 가운뎃점 변형·&·하이픈도 낱말을 가른다", () => {
  assert.deepEqual(nameTokens("기획ㆍ과제"), ["기획", "과제"]);
  assert.deepEqual(nameTokens("디자인&브랜드"), ["디자인", "브랜드"]);
  assert.deepEqual(nameTokens("사업-제품"), ["사업", "제품"]);
  assert.deepEqual(nameTokens("기획•운영"), ["기획", "운영"]);
});

test("㉜ 낱말 정규식은 맨 바깥 «|» 로만 가른다 — 괄호·문자 클래스·이스케이프 안은 그대로", () => {
  assert.deepEqual(splitTop("a|광고(?! ?(소재|원고))|[x|y]|b\\|c"), ["a", "광고(?! ?(소재|원고))", "[x|y]", "b\\|c"]);
  assert.deepEqual(splitTop("(?:CEO|SaaS)|IR"), ["(?:CEO|SaaS)", "IR"]);
  //  모든 집합의 낱말 정규식이 원문 대안 그대로 다시 이어진다(가른 조각이 홀로 컴파일된다).
  for (const [label, set] of SETS) {
    for (const [k, re] of Object.entries(set.words)) {
      for (const alt of splitTop(re.source)) {
        assert.ok(alt.length > 0, `${label}/${k}: 빈 대안 — 무엇에나 맞는다`);
        assert.doesNotThrow(() => new RegExp(alt), `${label}/${k}: «${alt}»`);
      }
      assert.ok(!re.test(""), `${label}/${k}: 빈 이름에 맞는다`);
    }
  }
});

test("㉝ 직접 적은 답 — 직함 낱말·순서(R4): 강사는 시험보다, 가게는 창업보다 먼저 · 모르는 1인 답은 보편 축", () => {
  const R: Array<[string, string, string]> = [
    ["solo", "토익 강사", "교육·강의"], ["solo", "어학원 원장", "교육·강의"], ["study", "토익 준비", "시험·자격·어학 준비"],
    ["study", "교사 임용 준비", "시험·자격·어학 준비"], ["solo", "PT 트레이너", "교육·강의"], ["solo", "수학 과외", "교육·강의"],
    ["solo", "카페 창업 준비", "가게·판매·제조"], ["solo", "공방 창업", "가게·판매·제조"], ["solo", "스마트스토어 2인 창업", "가게·판매·제조"],
    ["solo", "1인 SaaS 창업", "스타트업·내 제품·서비스"],
    ["solo", "유튜버", "창작·콘텐츠·크리에이터"], ["solo", "웹소설 작가", "창작·콘텐츠·크리에이터"], ["company", "방송국 PD", "디자인·콘텐츠·미디어"],
    ["company", "출판사 편집자", "디자인·콘텐츠·미디어"], ["company", "물리치료사", "고객 응대·의료·돌봄"], ["company", "간호사", "고객 응대·의료·돌봄"],
    ["solo", "약사", "자문·상담·돌봄 서비스"], ["company", "제약사 영업", "영업·거래처 관리"], ["company", "정부출연연 연구원", "연구개발·연구"],
    ["solo", "공인중개사", "영업·중개"], ["solo", "부동산 임대업", "임대·투자·자산 운용"], ["solo", "목사", "봉사·비영리·종교·지역"],
    ["company", "담임목사", "봉사·비영리·종교·지역"], ["company", "대학원 행정실", "팀 공용"], ["company", "의사결정 지원", "팀 공용"],
    ["solo", "뭔가 이것저것", "default"],         // 낱말이 없는 1인 답 — 모를 때의 보편 축(외주가 아니다)
    ["company", "뭔가 이것저것", "팀 공용"],
  ];
  for (const [stage, job, want] of R) assert.equal(groupSetDefFor(stage, job), GROUP_SETS[want], `${stage}/«${job}» → ${names(stage, job)}`);
  assert.equal(names("solo", null), names(null, "외주·용역·프리랜스"));   // 건너뛰기(빈 답)는 v7 대로 1인 중립 칸
});

test("㉞ 창작 집합 — 제작 노하우·장비가 갈 칸이 있다(R4)", () => {
  const gs = groupSetFor(null, "창작·콘텐츠·크리에이터");
  const at = (n: string) => gs.find((g) => g.key === groupKeyForName(n, gs))?.name;
  for (const n of ["촬영·편집 노하우", "장비", "작법 공부"]) assert.equal(at(n), "아이디어·노하우", n);
  assert.equal(at("3화 편집본"), "작품");
});

test("㉟ 직접 적은 답 — 흔한 답과 부분일치 함정(#1812 오탐 사냥 236+342건에서 뽑음)", () => {
  const R: Array<[string, string, string]> = [
    //  흔한 답
    ["solo", "자영업", "default"], ["study", "언어학과", "수업·과제·팀플"], ["company", "개발자", "개발·IT·데이터"],
    ["solo", "프리랜서", "외주·용역·프리랜스"], ["solo", "택시 기사", "외주·용역·프리랜스"], ["company", "택배기사", "생산·건설·운송·물류"],
    ["solo", "컨설턴트", "전문직·컨설팅 서비스"], ["solo", "외주 앱 개발", "외주·용역·프리랜스"], ["company", "방송국 pd", "디자인·콘텐츠·미디어"],
    //  함정 — 다른 말 속의 낱말
    ["company", "화학회사 연구원", "연구개발·연구"], ["company", "학생회관 매점", "팀 공용"], ["company", "학교회계직", "팀 공용"],
    ["company", "아동문학 출판 편집자", "디자인·콘텐츠·미디어"], ["company", "학원 마케터", "마케팅·브랜드·홍보"],
    ["company", "중국시장 영업", "영업·거래처 관리"], ["company", "전기자동차 배터리 엔지니어", "팀 공용"],
    ["company", "주의사항 안내 담당", "팀 공용"], ["company", "업무 생산성 컨설팅", "팀 공용"], ["company", "투자분석가", "팀 공용"],
    ["company", "병원 IT팀 개발자", "개발·IT·데이터"], ["company", "HR테크 스타트업 개발자", "개발·IT·데이터"],
    ["solo", "맘카페 운영자", "default"], ["company", "창업진흥원 직원", "팀 공용"], ["company", "건축사업본부", "팀 공용"]   /* 전문직(건축사)이 아니다 */,
  ];
  for (const [stage, job, want] of R) assert.equal(groupSetDefFor(stage, job), GROUP_SETS[want], `${stage}/«${job}» → ${names(stage, job)}`);
});

test("㊱ 직접 적은 답 — 업종 회사의 사무 직무 · 보험 컨설턴트 · 지원기관 · 사내 개발·기획(#1812 새 코퍼스 300건)", () => {
  const R: Array<[string, string, string]> = [
    ["company", "건설회사 경리", "재무·인사·총무·법무·행정"], ["company", "물류회사 회계 담당", "재무·인사·총무·법무·행정"],
    ["company", "병원 인사 담당", "재무·인사·총무·법무·행정"], ["company", "스타트업 경영지원", "재무·인사·총무·법무·행정"],
    ["solo", "보험 컨설턴트", "영업·중개"], ["solo", "보험설계사", "영업·중개"], ["solo", "경영 컨설턴트", "전문직·컨설팅 서비스"],
    ["company", "대학 창업지원단", "팀 공용"], ["company", "대학 취업지원센터", "팀 공용"], ["study", "취업 준비", "취업·진학 준비"],
    ["solo", "유튜브 영상 편집 프리랜서", "외주·용역·프리랜스"], ["solo", "유튜버", "창작·콘텐츠·크리에이터"],
    ["company", "서비스 기획자", "경영·기획·전략"], ["company", "경영기획", "경영·기획·전략"], ["company", "프로덕트 매니저", "경영·기획·전략"], ["company", "제조업 기획팀", "경영·기획·전략"], ["company", "광고대행사 AE", "마케팅·브랜드·홍보"],
    ["company", "안드로이드 개발", "개발·IT·데이터"], ["company", "DevOps 엔지니어", "개발·IT·데이터"],
    ["company", "출판사 편집자", "디자인·콘텐츠·미디어"],
    ["company", "학회 사무국 직원", "재무·인사·총무·법무·행정"], ["company", "교회 사무처", "재무·인사·총무·법무·행정"], ["study", "학회 회장", "동아리·학회·소모임"],
  ];
  for (const [stage, job, want] of R) assert.equal(groupSetDefFor(stage, job), GROUP_SETS[want], `${stage}/«${job}» → ${names(stage, job)}`);
});

test("㊲ 출시된 집합의 칸 이름·뜻 스냅샷 — 바뀌면 이미 심긴 워크스페이스가 알아보지 못한다", () => {
  //  ⚠ 이 테스트가 빨개졌다면: 칸 이름·뜻을 고친 것이다. 이미 심긴 워크스페이스는 심을 때의 이름·뜻으로 집합을 알아본다(closestSet).
  //   고친 집합의 **이전 판을 LEGACY_SETS 처럼 남겨** 알아보게 한 뒤에 아래 해시를 갱신한다(#1812 v8 출시 2026-10-01).
  const j = JSON.stringify(Object.entries(GROUP_SETS).map(([k, v]) => [k, v.groups.map((g) => [g.key, g.name, g.hint])]));
  assert.equal(createHash("sha256").update(j).digest("hex"), "3f15eccbd6e5a2ad08462b4358b54d970c0d75a5f1d5c03912f6a93bc1c2b239");
});
