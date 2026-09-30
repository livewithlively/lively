// #3870 — 통합검색(⌘K)에서 프로젝트를 고르면 **프로젝트 화면**이 열린다(새 세션 자리 `?new=1` 이 아니다).
//
//  원준 2026-09-30 신고: "검색 창에서 프로젝트를 골라서 누르면 프로젝트 창으로 들어가게 해줘. 이 텍스트 입력기 있는
//   new=1로 보내지말고".
//  종전엔 검색 결과의 프로젝트 줄이 `#/p/<id>` 로 갔다. 그 주소는 라우터가 맨 위 세션으로 갈아 끼우고, 세션이 없으면
//   새 세션 자리(지시 입력칸 · `?new=1`)를 여는 '거쳐 가는 문'이다(main.ts onHash · renderRoute page==='p').
//  고침: 프로젝트 줄은 사이드바 [→] 와 같은 `#/app/projects2/p/<id>` 로, 여는 동작도 [→] 와 같은 openProjectPage 로.
//  시나리오 번호(E1~E12)는 사양의 엣지 표 행이다.
//
//  | #   | 입력                                     | 기대                                   |
//  |-----|------------------------------------------|----------------------------------------|
//  | E1  | 서버 결과 · level=project                | #/app/projects2/p/<id>                 |
//  | E2  | 셸 목록(level 없음)                      | #/app/projects2/p/<id>                 |
//  | E3  | 문자열 id '12'                            | #/app/projects2/p/12                   |
//  | E4  | level=task                               | #/projects2/t/<id> (종전 그대로)       |
//  | E5  | level=subtask                            | #/projects2/t/<id> (종전 그대로)       |
//  | E6  | 주소 판독: 프로젝트 화면                  | 그 번호                                |
//  | E7  | 주소 판독: 세션 문 #/p/<id>(?new=1)       | 0 (프로젝트 화면이 아니다)             |
//  | E8  | 주소 판독: 도구 화면·태스크·0·빈 값·부재   | 0                                      |
//  | E9  | omni.ts 네 채널(셸·의미·유사·grep)         | 전부 projHitHref — `'#/p/'` 조립 0      |
//  | E10 | main.ts 통합검색 open 훅                  | 프로젝트 화면이면 openProjectPage 로   |
//  | E11 | main.ts openProjectPage                   | 주소를 projectPageHref 로 만든다        |
//  | E12 | 왕복(경계 1 포함)                         | projectPageId(projectPageHref(n)) = n  |
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const SRC = process.env.PROJ_PAGE_SRC || path.join(root, "web/lib/proj-page.ts");
const out = mkdtempSync(path.join(tmpdir(), "omni-proj-page-"));
execFileSync(
  path.join(root, "node_modules/.bin/tsc"),
  [SRC, "--rootDir", path.dirname(SRC), "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"],
  { stdio: "inherit" },
);
const { projHitHref, projectPageId, projectPageHref } = await import(path.join(out, path.basename(SRC).replace(/\.ts$/, ".js")));

let pass = 0, fail = 0;
const ok  = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL  ${n} — ${why}`); };
const eq = (got, want, n) => (got === want ? ok(n) : bad(n, `기대 ${JSON.stringify(want)} · 실제 ${JSON.stringify(got)}`));
//  정적 배선 검사는 **주석을 걷고** 본다 — 설명 주석에 같은 낱말이 있으면 거짓 빨강·거짓 초록이 난다(side-card-self-row 교훈).
const code = (rel, env) => readFileSync(process.env[env] || path.join(root, rel), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:'"`])\/\/.*$/gm, "$1");

// ── 주소 만들기 ──
eq(projHitHref({ id: 3870, level: "project" }), "#/app/projects2/p/3870", "E1 서버 결과 프로젝트 → 프로젝트 화면");
eq(projHitHref({ id: 42 }), "#/app/projects2/p/42", "E2 셸 목록(level 없음) → 프로젝트 화면");
eq(projHitHref({ id: "12", level: "project" }), "#/app/projects2/p/12", "E3 문자열 id");
eq(projHitHref({ id: 4509, level: "task" }), "#/projects2/t/4509", "E4 태스크는 태스크 창(종전 그대로)");
eq(projHitHref({ id: 77, level: "subtask" }), "#/projects2/t/77", "E5 서브태스크는 태스크 창(종전 그대로)");

// ── 주소 읽기 ──
eq(projectPageId("#/app/projects2/p/3870"), 3870, "E6 프로젝트 화면 주소 → 번호");
eq(projectPageId("#/p/3870"), 0, "E7 세션 문은 프로젝트 화면이 아니다");
eq(projectPageId("#/p/3870?new=1"), 0, "E7 새 세션 자리는 프로젝트 화면이 아니다");
eq(projectPageId("#/app/projects2/p/3870/board"), 0, "E8 도구 화면은 열기 문 대상이 아니다");
eq(projectPageId("#/projects2/t/4509"), 0, "E8 태스크 창");
eq(projectPageId("#/app/projects2/p/0"), 0, "E8 번호 0");
eq(projectPageId("#/app/projects2"), 0, "E8 구역 첫 화면");
eq(projectPageId(""), 0, "E8 빈 주소");
eq(projectPageId(undefined), 0, "E8 주소 없음");
for (const n of [1, 42, 3870]) eq(projectPageId(projectPageHref(n)), n, "E12 왕복 " + n);

// ── 배선 ──
//  프로젝트 줄은 네 채널에서 온다: 셸 목록(local) · 의미검색(proj:sem) · 유사도(proj:sim) · grep(proj:grep).
//  #4517 — 서버 채널 셋은 줄 만들기 한 벌(projRow)을 함께 쓴다. 그래서 줄을 **만드는 자리**는 둘(셸 목록 · projRow)이고,
//   서버 채널 셋이 전부 그 한 벌을 거치는지를 따로 본다(한 채널만 제 손으로 줄을 만들면 그 줄만 옛 문으로 샌다).
const omni = code("web/v2/omni.ts", "OMNI_SRC");
const projHits = (omni.match(/kind: 'proj'[\s\S]{0,400}?href: ([^,}\n]+)/g) || []).map((m) => m.replace(/[\s\S]*href: /, "").trim());
if (projHits.length === 2 && projHits.every((h) => h.startsWith("projHitHref("))) ok("E9 프로젝트 줄을 만드는 두 자리 모두 projHitHref");
else bad("E9 프로젝트 줄을 만드는 두 자리 모두 projHitHref", "자리별 href = " + JSON.stringify(projHits));
const viaRow = ["proj:sem", "proj:sim", "proj:grep"].filter((src) => !new RegExp(`put\\('${src}'[\\s\\S]{0,160}?projRow\\(`).test(omni));
if (!viaRow.length) ok("E9 서버 채널 셋(의미·유사·grep)이 모두 projRow 로 줄을 만든다");
else bad("E9 서버 채널 셋(의미·유사·grep)이 모두 projRow 로 줄을 만든다", "projRow 를 안 거치는 채널 = " + JSON.stringify(viaRow));
if (/['"`]#\/p\/['"`]/.test(omni)) bad("E9 omni 가 세션 문을 조립하지 않는다", "'#/p/' 가 코드에 남아 있다");
else ok("E9 omni 가 세션 문을 조립하지 않는다");

const main = code("web/v2/main.ts", "MAIN_SRC");
const hookAt = main.indexOf("setOmniHooks(");
const hook = hookAt >= 0 ? main.slice(hookAt, main.indexOf("bindOmniKey()", hookAt)) : "";
//  모양까지 본다 — 판독값을 그대로 쓰고 · 조건 없이(⌘ 클릭 포함) 열고 · 곧바로 끝낸다(일반 경로로 새지 않는다).
const opens = hook.search(/if \(pid\) \{\s*openProjectPage\(pid\);\s*return;\s*\}/);
const routesProject = /const pid = projectPageId\(href\);/.test(hook) && opens >= 0;
const beforeGeneric = opens >= 0 && opens < hook.indexOf("tabsApi.find(href)");
if (hook && routesProject && beforeGeneric) ok("E10 통합검색 open 훅이 프로젝트 화면을 [→] 와 같은 문으로 연다");
else bad("E10 통합검색 open 훅이 프로젝트 화면을 [→] 와 같은 문으로 연다", `훅 ${!!hook} · 판독+열기 ${routesProject} · 일반 경로보다 먼저 ${beforeGeneric}`);
const oppAt = main.indexOf("function openProjectPage(");
const opp = oppAt >= 0 ? main.slice(oppAt, oppAt + 400) : "";
if (/const href = projectPageHref\(projectId\)/.test(opp)) ok("E11 openProjectPage 가 주소 한 벌을 쓴다");
else bad("E11 openProjectPage 가 주소 한 벌을 쓴다", "openProjectPage 의 주소가 projectPageHref 가 아니다");

console.log(`\n${pass} 통과 · ${fail} 실패`);
if (fail) process.exit(1);
