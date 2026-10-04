// #4530 안 A — 통합검색 미리보기 칸의 순수 규칙(web/lib/omni-preview.ts). 원준 2026-10-04: «지식, 세션, 프로젝트 뭐든 내부 안까지
//  어떻게 보여줘야 사용자에게 가장 만족스럽게 보여줄지 다 구현해».
//
// 사양·엣지 표(입력 → 기대). 행마다 시험 하나.
//  | 행  | 입력                                                    | 기대                                             |
//  | P1  | 본문에 낱말이 든 줄 셋(낱말 둘 든 줄 하나)              | 낱말 둘 든 줄이 반드시 뽑힌다 · 화면 순서는 문서 순서 |
//  | P2  | 맞은 줄의 앞뒤 줄                                       | 같은 제목 아래의 이웃만 붙는다(다른 절의 줄은 안 붙는다) |
//  | P3  | 맞은 줄이 붙어 있다                                     | 한 덩이로 합쳐지고 같은 줄이 두 번 서지 않는다    |
//  | P4  | 제목 줄 · 표 구분 줄 · 가로줄 · 주석 · 자동 안내문      | 읽을 줄이 아니다(뽑히지 않는다)                   |
//  | P5  | 표의 한 줄 `| a | b |`                                  | «a · b» 로 보인다                                 |
//  | P6  | 코드 블록 안의 줄                                       | 뽑히되 울타리(```) 줄은 안 선다                   |
//  | P7  | 낱말이 본문에 없다                                      | blocks 0 · total 0 → leadLines 가 앞부분을 준다   |
//  | P8  | 목차                                                    | 가장 얕은 두 층만 · 자동 생성 «첫 지시(원문)» 제목은 뺀다 |
//  | P9  | 태스크 진행                                             | 취소는 전체에서 뺀다 · 끝남/하는 중/할 일         |
//  | P10 | 상태 말                                                 | 보관·초안이 상태보다 먼저                         |
//  | P11 | 태스크 순서                                             | 이름에 낱말 든 것 → 하는 중 → 할 일 → 끝남        |
//  | P12 | 대소문자 · 빈 낱말 목록                                 | 대소문자 무시 · 낱말이 없으면 blocks 0            |
//  | P13 | 인용(>) 안의 표 · 제목 · 글 · 코드 블록                 | 머리표를 떼고 읽는다(표는 가운뎃점 · 구분 줄은 소음) |
//  | P14 | 식별자 안의 밑줄 · 곱셈(__init__ · a**b)                | 글자 그대로 · 짝 맞는 **굵게** 와 `코드` 만 걷는다 |
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "omni-preview-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/omni-preview.ts"), path.join(root, "web/lib/omni-rank.ts"), "--rootDir", path.join(root, "web/lib"), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const M = await import(path.join(out, "omni-preview.js"));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => { const a = JSON.stringify(got), b = JSON.stringify(want); a === b ? ok(n) : bad(n, `기대 ${b} · 실제 ${a}`); };
const flat = (r) => r.blocks.map((b) => [b.heading, b.lines.map((l) => (l.hit ? "★" : "") + l.text)]);

const DOC = [
  "# 배포 문서",
  "",
  "> ⚙ 세션의 첫 지시에서 **자동 생성**된 프로젝트입니다 — 제목·본문·분류는 작업이 구체화되면 보강됩니다.",
  "",
  "## 첫 지시(원문)",
  "첫 줄 설명입니다.",
  "",
  "## 1. 절차",
  "먼저 준비를 합니다.",
  "배포 절차는 스테이지 다음 메인입니다.",
  "그다음 확인합니다.",
  "",
  "## 2. 표",
  "| 단계 | 하는 일 |",
  "|---|---|",
  "| 굽기 | 이미지를 굽는다 |",
  "| 롤 | 배포를 마친다 |",
  "---",
  "<!-- 숨은 주석 배포 -->",
  "",
  "### 2.1 코드",
  "```sh",
  "gh workflow run 배포",
  "```",
  "마지막 줄 절차 요약.",
].join("\n");

// P1 — 낱말 둘 든 줄이 뽑히고 화면은 문서 순서
{
  const r = M.excerptBlocks(DOC, ["배포", "절차"], { max: 2, ctx: 0 });
  eq(r.total, 4, "P1 낱말이 든 줄 수(제목·주석·구분 줄 제외) = 4");
  eq(flat(r), [["1. 절차", ["★배포 절차는 스테이지 다음 메인입니다."]], ["2. 표", ["★롤 · 배포를 마친다"]]], "P1 낱말 둘 든 줄 먼저 뽑고 화면은 문서 순서");
}
// P2 — 이웃은 같은 제목 아래만
{
  const r = M.excerptBlocks(DOC, ["스테이지"], { max: 1, ctx: 1 });
  eq(flat(r), [["1. 절차", ["먼저 준비를 합니다.", "★배포 절차는 스테이지 다음 메인입니다.", "그다음 확인합니다."]]], "P2 앞뒤 한 줄씩(같은 절)");
  const edge = M.excerptBlocks(DOC, ["확인합니다"], { max: 1, ctx: 1 });
  eq(flat(edge), [["1. 절차", ["배포 절차는 스테이지 다음 메인입니다.", "★그다음 확인합니다."]]], "P2 다음 절(2. 표)의 줄은 이웃으로 붙지 않는다");
}
// P3 — 붙은 맞은 줄은 한 덩이
{
  const r = M.excerptBlocks("가 낱말\n나 낱말\n다 낱말\n라", ["낱말"], { max: 3, ctx: 1 });
  eq(flat(r), [["", ["★가 낱말", "★나 낱말", "★다 낱말", "라"]]], "P3 겹치는 창은 한 덩이 · 같은 줄 한 번");
}
// P4 — 읽을 줄이 아닌 것
{
  eq(M.excerptBlocks(DOC, ["자동"]).total, 0, "P4 자동 생성 안내문은 뽑히지 않는다");
  eq(M.excerptBlocks(DOC, ["숨은"]).total, 0, "P4 HTML 주석은 뽑히지 않는다");
  eq(M.excerptBlocks(DOC, ["원문"]).total, 0, "P4 제목 줄은 본문 줄이 아니다");
  eq([M.isNoiseLine("|---|:--:|"), M.isNoiseLine("---"), M.isNoiseLine("  "), M.isNoiseLine("- 목록 한 줄")], [true, true, true, false], "P4 구분 줄·가로줄·빈 줄은 소음 · 목록 줄은 아니다");
}
// P5 — 표 한 줄
eq(M.cleanLine("| 굽기 | **이미지**를 `굽는다` |"), "굽기 · 이미지를 굽는다", "P5 표의 칸막이는 가운뎃점 · 기호는 걷는다");
eq(M.cleanLine("- [x] 끝낸 일"), "끝낸 일", "P5 체크 목록 머리를 걷는다");
// P6 — 코드 블록
{
  const r = M.excerptBlocks(DOC, ["workflow"], { max: 1, ctx: 1 });
  eq(flat(r), [["2.1 코드", ["★gh workflow run 배포", "마지막 줄 절차 요약."]]], "P6 코드 줄은 뽑히고 울타리 줄은 서지 않는다");
}
// P7 — 낱말이 본문에 없다
{
  const r = M.excerptBlocks(DOC, ["어디에도없는말"]);
  eq([r.blocks.length, r.total], [0, 0], "P7 낱말이 없으면 blocks 0 · total 0");
  eq(M.leadLines(DOC, 3), ["첫 줄 설명입니다.", "먼저 준비를 합니다.", "배포 절차는 스테이지 다음 메인입니다."], "P7 앞부분 = 읽을 줄만(안내문·제목 제외)");
}
// P8 — 목차
eq(M.outline(DOC), [{ level: 0, text: "배포 문서" }, { level: 1, text: "1. 절차" }, { level: 1, text: "2. 표" }], "P8 목차 = 가장 얕은 두 층 · «첫 지시(원문)» 제외 · 셋째 층 제외");
eq(M.outline("글만 있는 문서"), [], "P8 제목이 없으면 빈 목차");
// P9 — 태스크 진행
eq(M.taskSummary([{ status_category: "done" }, { status_category: "started" }, { status_category: "unstarted" }, { status_category: "canceled" }, {}]),
  { total: 4, done: 1, doing: 1, todo: 2 }, "P9 취소는 전체에서 뺀다 · 상태 없는 것은 할 일");
// P10 — 상태 말
eq([M.statusText({ status_category: "done", archived_at: "2026-01-01" }).text, M.statusText({ status_category: "started", draft: true }).text,
  M.statusText({ status_category: "done" }).text, M.statusText({ status_category: "started" }).text, M.statusText({ status_category: "canceled" }).text, M.statusText({}).text],
  ["보관", "초안", "완료", "진행 중", "취소", "할 일"], "P10 보관·초안이 상태보다 먼저");
// P11 — 태스크 순서
eq(M.orderTasks([{ name: "끝난 일", status_category: "done" }, { name: "할 일", status_category: "unstarted" }, { name: "하는 일", status_category: "started" }, { name: "배포 끝냄", status_category: "done" }], ["배포"]).map((t) => t.name),
  ["배포 끝냄", "하는 일", "할 일", "끝난 일"], "P11 이름에 낱말 든 것 → 하는 중 → 할 일 → 끝남");
// P12 — 대소문자 · 빈 낱말
eq(M.excerptBlocks("Omni.TS 를 고쳤다", ["omni.ts"]).total, 1, "P12 대소문자 무시");
eq(M.excerptBlocks(DOC, []).blocks.length, 0, "P12 낱말이 없으면 blocks 0");

// P13 — 인용 안의 글
{
  const Q = ["> ## 먼저 읽을 것", ">", "> | 회차 | 무엇이 죽었나 |", "> |---|---|", "> | 1 | 랜딩 화면이 다른 배포에 덮임 |", "> ```sh", "> gh 배포 run", "> ```", "", "바깥 글 배포"].join("\n");
  const r = M.excerptBlocks(Q, ["배포"], { max: 3, ctx: 0 });
  eq(flat(r), [["먼저 읽을 것", ["★1 · 랜딩 화면이 다른 배포에 덮임", "★gh 배포 run", "★바깥 글 배포"]]], "P13 인용 안의 표·코드·제목을 머리표 없이 읽는다");
  eq([M.isNoiseLine(">"), M.isNoiseLine("> |---|---|"), M.isNoiseLine("> 글")], [true, true, false], "P13 빈 인용 줄·인용 안의 구분 줄은 소음");
  eq(M.outline(Q), [{ level: 0, text: "먼저 읽을 것" }], "P13 인용 안의 제목도 목차에 선다");
}
// P14 — 식별자는 글자 그대로
eq([M.cleanInline("src/__init__.py 와 __dirname"), M.cleanInline("foo__bar_baz = a**b"), M.cleanInline("**파일:** `web/v2/omni.ts` 를 **고침**"), M.cleanInline("끝이 잘린 **굵게")],
  ["src/__init__.py 와 __dirname", "foo__bar_baz = a**b", "파일: web/v2/omni.ts 를 고침", "끝이 잘린 굵게"], "P14 밑줄·곱셈은 남기고 짝 맞는 굵게·코드 표시만 걷는다");
eq(M.cleanLine("- `__init__.py` 를 **고쳤다**"), "__init__.py 를 고쳤다", "P14 줄 다듬기도 같은 규칙");
//  코드·글롭의 ** 는 글자다(백틱 안이든 밖이든) — 격리 리뷰가 node 로 확인한 사례 그대로.
eq([M.cleanInline("`**kwargs` 를 받는다"), M.cleanInline("f(**opts) 로 넘긴다"), M.cleanInline("`**/*.ts` 와 tmp/**"), M.cleanInline("**굵게**를 **두 번** 쓴 줄"), M.cleanInline("**bold**s"), M.cleanInline("2**10 과 a ** b")],
  ["**kwargs 를 받는다", "f(**opts) 로 넘긴다", "**/*.ts 와 tmp/**", "굵게를 두 번 쓴 줄", "bolds", "2**10 과 a ** b"], "P14 코드·글롭의 ** 는 남기고 짝 맞는 굵게만 걷는다(조사가 붙어도 · 한 줄에 여러 번)");
eq([M.cleanInline("def f(*args, **kwargs):"), M.cleanInline("앞이 잘린 파일:** 뒤 글 없음"), M.cleanInline("잘린 굵게로 끝남:**"), M.cleanInline("**잘린 채 시작 … 그리고 **온전한 굵게** 끝")],
  ["def f(*args, **kwargs):", "앞이 잘린 파일:** 뒤 글 없음", "잘린 굵게로 끝남:", "잘린 채 시작 … 그리고 온전한 굵게 끝"], "P14 한쪽만 남은 ** — 잘린 발췌의 것만 걷는다(코드의 **kwargs 는 그대로)");

console.log(`\n${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
