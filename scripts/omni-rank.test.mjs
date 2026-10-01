// #4530 — 통합검색(⌘K) 순서·줄 다듬기의 순수 규칙(web/lib/omni-rank.ts). 원준 2026-10-01: «관련도가 적당히 있는 걸 시간순으로
//  보여 줘야지» · «대화 내용의 일부나 그 세션에서 고쳤던 대상을 어렴풋하게 쳐서 그 세션을 찾고 싶은데 퀄리티가 형편없다».
//  점검 근거: 지식 omni-search-audit-defects-4530. 엣지 표 — 행마다 단언:
//
//  | #   | 입력                                                     | 기대                                                         |
//  |-----|----------------------------------------------------------|--------------------------------------------------------------|
//  | R1  | 같은 질의 표를 화면 규칙과 서버 규칙(src/v6/query-terms)에 | 낱말·조사 뗀 꼴·세기가 글자 하나까지 같다                     |
//  | R2  | «검색을» 이 «통합검색 결함» 에 · «세션이» 가 «세션 목록» 에 | 맞음(조사 뗀 꼴 0.8)                                         |
//  | R3  | 여러 자리에 낱말이 나뉘어 있음(이름·하는 일·프로젝트)       | matchAllAcross 맞음 · 한 자리에 없는 낱말이 있으면 아님        |
//  | R4  | 색칠 낱말: 한 글자 낱말 · 조사 뗀 꼴 · 긴 것 먼저           | 한 글자 빠짐 · 뗀 꼴 들어감 · 길이 내림차순                    |
//  | R5  | 지식 제목 머리말(as-built(#…, 날짜): · ⚠실측(…): · 결정:)  | 머리말 «as-built · #4135» 따로 · 제목은 머리말 뒤              |
//  | R6  | 머리말이 아닌 콜론(시각 «12:30», 너무 짧은 뒤)              | 떼지 않는다                                                   |
//  | R7  | 둘째 줄 — 자동 생성 안내문 · 마크다운 기호 · 에이전트 안내   | 걷고 첫 지시 글만 남는다                                       |
//  | R8  | 식별자 — 번호 정확 · 번호 부분 · key 같은 말 · 평범한 낱말  | exact · null · partial · null(«session» 이 key 일부라도)       |
//  | R9  | 맨 위 셋 — 번호 > 이름 같음 > 이름에 모두 > 서버 표시 대화 > key 일부 | 그 층 순서 · 최대 셋                                |
//  | R10 | 이름에 모두 든 것끼리 — 낱말이 앞에 놓인 것, 그다음 짧은 것 | «회의록» 에서 «811회의록» > «0810회의록» > «우리 825 회의록이랑…» |
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const compile = (src, tag) => {
  const out = mkdtempSync(path.join(tmpdir(), tag));
  execFileSync(path.join(root, "node_modules/.bin/tsc"),
    [src, "--rootDir", path.dirname(src), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  return import(path.join(out, path.basename(src).replace(/\.ts$/, ".js")));
};
const M = await compile(process.env.OMNI_RANK_SRC || path.join(root, "web/lib/omni-rank.ts"), "omni-rank-");
const S = await compile(path.join(root, "src/v6/query-terms.ts"), "query-terms-");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };

// ── R1 화면 규칙 = 서버 규칙 ──
const TABLE = ["검색을 omni.ts에서", '"관련도 순" 세션이', "통합검색(⌘K) 왜?", "100% a_b", "화면에서는 프로젝트로", "이가 나는 검색", "OMNI omni", "   "];
for (const q of TABLE) eq(M.parseTerms(q), S.parseQueryTerms(q).map(({ t, stem, quoted }) => ({ t, stem, quoted })), `R1 낱말 같음 «${q}»`);
for (const w of ["검색을", "세션이", "화면에서는", "omni.ts에서", "이가", "검색"]) eq(M.stemKo(w), S.stemKo(w), `R1 조사 떼기 같음 «${w}»`);
for (const [text, q] of [["통합검색 결함", "검색을"], ["세션 목록", "세션이"], ["omni.ts", "omni.ts에서"], ["없음", "검색"]]) {
  eq(M.termStrength(text.toLowerCase(), M.parseTerms(q)[0]), S.termStrength(text.toLowerCase(), S.parseQueryTerms(q)[0]), `R1 세기 같음 «${q}» in «${text}»`);
}
eq(M.KO_JOSA, S.KO_JOSA, "R1 조사 표가 같다");

// ── R2 조사 뗀 꼴 ──
eq(M.termStrength("통합검색 결함", M.parseTerms("검색을")[0]), 0.8, "R2 «검색을» 이 «통합검색» 에 0.8");
eq(M.matchAll("세션 목록", M.parseTerms("세션이 목록")), true, "R2 «세션이 목록» 이 «세션 목록» 과 맞음");

// ── R3 여러 자리 ──
eq(M.matchAllAcross(["검색 결함 점검", "UI 버그 해결", null], M.parseTerms("결함 버그")), true, "R3 이름·프로젝트에 나뉜 낱말");
eq(M.matchAllAcross(["검색 결함 점검", "UI 버그 해결"], M.parseTerms("결함 로고")), false, "R3 한 낱말이 어디에도 없으면 아님");
eq(M.matchAll("아무거나", []), false, "R3 낱말 없음 = 아님");

// ── R4 색칠 ──
eq(M.highlightWords(M.parseTerms("관측 창")), ["관측"], "R4 한 글자 «창» 은 칠하지 않는다");
eq(M.highlightWords(M.parseTerms("검색을 omni")), ["omni", "검색을", "검색"], "R4 조사 뗀 꼴도 · 긴 것 먼저(겹칠 때 긴 낱말이 먼저 잡히게)");

// ── R5·R6 지식 제목 머리말 ──
eq(M.splitKnowTitle("as-built(#4135, 2026-09-28): 세션 신원은 세션을 연 사람 것"), { head: "as-built · #4135", main: "세션 신원은 세션을 연 사람 것" }, "R5 as-built(#…, 날짜):");
eq(M.splitKnowTitle("⚠실측(2026-09-16): 임베딩 자동 백필의 sweepRunning"), { head: "실측", main: "임베딩 자동 백필의 sweepRunning" }, "R5 ⚠실측(날짜):");
eq(M.splitKnowTitle("원인규명·수정·배포(#3739, 2026-09-08): 매니지드 새 세션이 2시간 동안"), { head: "원인규명·수정·배포 · #3739", main: "매니지드 새 세션이 2시간 동안" }, "R5 가운뎃점 낀 머리말");
eq(M.splitKnowTitle("결정: 라이블리 BM(fit) 확정본"), { head: "결정", main: "라이블리 BM(fit) 확정본" }, "R5 결정:");
eq(M.splitKnowTitle("통합검색(스포트라이트, ⌘K) — 자원별 REST 팬아웃"), { head: "", main: "통합검색(스포트라이트, ⌘K) — 자원별 REST 팬아웃" }, "R6 콜론 없는 제목은 그대로");
eq(M.splitKnowTitle("회의 12:30 정리"), { head: "", main: "회의 12:30 정리" }, "R6 시각의 콜론은 머리말이 아니다");
eq(M.splitKnowTitle("결정: 예"), { head: "", main: "결정: 예" }, "R6 뒤가 너무 짧으면 떼지 않는다");

// ── R7 둘째 줄 ──
eq(M.cleanSnippet("> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.\n\n## 첫 지시(원문)\n\n지금 우리 검색 (cmd+k)에 불편한게 너무 많아"),
  "지금 우리 검색 (cmd+k)에 불편한게 너무 많아", "R7 자동 생성 안내문 걷고 첫 지시만");
eq(M.cleanSnippet("# 통합검색 2차 — `key` 로 **찾는다** [[omni-unified]] [링크](http://x)"), "통합검색 2차 — key 로 찾는다 omni-unified 링크", "R7 마크다운 기호 걷기");
eq(M.cleanSnippet("L37: 색인기 readAlignedWindow (+3 matches) → knowledge_get"), "색인기 readAlignedWindow", "R7 줄 번호·에이전트 안내 걷기");
//  서버가 본문 줄을 못 맞히면 앞부분을 한 줄로 접어 보낸다(search-util grepSnippet 폴백) — 안내문만 걷고 첫 지시는 남긴다(전엔 둘째 줄이 비었다)
eq(M.cleanSnippet("> ▤ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다. ## 첫 지시(원문) 지금 우리 검색 (cmd+k)에 불편한게 너무 많아."),
  "지금 우리 검색 (cmd+k)에 불편한게 너무 많아.", "R7 한 줄로 접힌 안내문 — 첫 지시는 남는다");
eq(M.cleanSnippet("# 통합검색 결함 점검 ## 메타데이터 - 상태: active > 인용 **굵게** `code`"), "통합검색 결함 점검 메타데이터 상태: active 인용 굵게 code", "R7 한 줄로 접힌 발췌 속 줄머리 기호");
eq(M.cleanSnippet("omni-rank.ts 와 a-b, x->y"), "omni-rank.ts 와 a-b, x->y", "R7 낱말 속 기호는 둔다");
eq(M.cleanSnippet("가".repeat(200), 10), "가".repeat(10) + "…", "R7 길이 상한");
//  둘째 줄은 첫 맞은 낱말 조금 앞에서 — 폰에서 맞은 낱말이 줄임표 뒤로 밀려 왜 떴는지 안 보였다(배포 뒤 실화면)
{
  const sub = "…바뀝니다. 세 번 시도해 세 번 모두 바뀌었습니다. 3. 칩을 누르면 키보드가 끊깁니다. 그 뒤로 글";
  const f = M.focusSnippet(sub, ["키보드"]);
  eq([f.startsWith("…"), f.indexOf("키보드") >= 0 && f.indexOf("키보드") <= 16, f.endsWith("그 뒤로 글")], [true, true, true], "R7 맞은 낱말 앞에서 시작");
  eq(M.focusSnippet("키보드가 끊깁니다", ["키보드"]), "키보드가 끊깁니다", "R7 앞쪽에 있으면 그대로");
  eq(M.focusSnippet(sub, []), sub, "R7 낱말이 없으면 그대로");
  eq(M.focusSnippet("aaaaaaaaaaaaaaaaaaaa 😀 OMNI.ts", ["omni.ts"]).includes("OMNI.ts"), true, "R7 대소문자 무시");
}

// ── R8 식별자 ──
const T = (q) => M.parseTerms(q);
eq(M.identKind("1835", T("#1835")), "exact", "R8 번호 정확(#)");
eq(M.identKind("1835", T("183")), null, "R8 번호 부분은 아님");
eq(M.identKind("omni-unified-search-spotlight-1835", T("omni-unified")), "partial", "R8 key 같은 말(하이픈)은 부분일치");
eq(M.identKind("session-equals-task-4084", T("session")), null, "R8 평범한 낱말은 key 일부여도 호명이 아니다(점검: 10줄 전부 key 일치)");
eq(M.identKind("omni-unified", T("omni unified")), null, "R8 낱말 둘이면 호명 아님");

// ── R9·R10 맨 위 셋 ──
const H = (key, name, extra = {}) => ({ key, kind: "know", name, ...extra });
const top = M.pickTop([
  H("conv", "아무 세션", { kind: "conv", serverTop: true }),
  H("namefull", "검색 결함 점검"),
  H("exact", "다른 이름", { kind: "proj", ident: "4530" }),
  H("plain", "관계없는 문서"),
], T("4530"), "4530");
eq(top.map((x) => x.key), ["exact", "conv"], "R9 번호 질의 — 번호가 맞은 것이 1위 · 그 번호를 이야기한 대화(서버 표시)가 다음 · 근거 없는 줄은 안 선다");
const top2 = M.pickTop([
  H("conv", "아무 세션", { kind: "conv", serverTop: true, at: 9 }),
  H("partial", "x", { ident: "검색-결함-key" }),
  H("names", "검색 결함 점검", { at: 1 }),
  H("same", "검색 결함"),
  H("none", "관계없는 문서"),
], T("검색 결함"), "검색 결함");
eq(top2.map((x) => x.key), ["same", "names", "conv"], "R9 이름 같음 > 이름에 모두 > 서버 표시 대화 · 최대 셋 · 아무 근거 없는 줄은 안 선다");
const top3 = M.pickTop([H("a", "우리 825 회의록이랑 그 바로 이전 회의록 참고해서"), H("b", "0810회의록"), H("c", "811회의록"), H("d", "회의록에서 세션 프로젝트 정리안 찾기")], T("회의록"), "회의록");
eq(top3.map((x) => x.key), ["d", "c", "b"], "R10 이름에 모두 든 것끼리 — 낱말이 앞에 놓인 것 먼저, 그다음 짧은 것");
eq(M.pickTop([H("a", "x"), H("b", "y")], T("z"), "z").length, 0, "R9 근거가 없으면 맨 위가 비어 있다");

console.log(`\n${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
