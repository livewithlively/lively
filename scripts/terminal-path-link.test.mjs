// #4562 — 터미널 속 **파일 경로**를 링크로(원준 2026-10-04 «정리해서 경로 알려주잖아. 그거 클릭하면 링크 클릭하듯이 … 곁칸에서
//  자료랑 그거 보는 뷰어 바로»). 밑줄은 «열린다»는 약속이라 열 수 없는 글자에 그어지면 고장으로 읽히고, 열 수 있는 경로를 놓치면
//  기능이 없는 것과 같다. 세 겹을 잰다:
//   P·F — 글에서 경로 찾기 · 경로 → 어디서(terminal.ts pathMatches·pathLinkTarget·linkMatches)
//   L   — 이 곁칸이 열 수 있나(web/lib/path-open.ts pathOpenPlan — 셸의 판정)
//   B   — 터미널 ↔ 셸 왕복(답 · 무응답 · 늦은 답 · 연타 · 남의 답) — 가짜 부모 프레임과 가짜 시계로 실제 함수를 돌린다
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const m = await importTerminalModule();
const { pathLinkTarget, linkMatches, urlAtColumn, urlAtCell, urlSpansAt, isPathLink, shortLink, openPathFromTerminal, bareClickLink,
  knowledgeCandidates, knowledgeMatches, learnKnowledge, isKnowledgeLink, openLinkFromTerminal } = m;
for (const f of [pathLinkTarget, linkMatches, urlAtColumn, urlAtCell, urlSpansAt, isPathLink, shortLink, openPathFromTerminal, bareClickLink]) assert.equal(typeof f, "function");

const LIB = process.env.PATH_OPEN_SRC || join(root, "web/lib/path-open.ts");
const out = mkdtempSync(join(tmpdir(), "path-open-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const { pathOpenPlan, pathOpenPlans } = await import(join(out, path.basename(LIB).replace(/\.ts$/, ".js")));

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };

// ── P. 경로 → 어디서 열까 ────────────────────────────────────────────
t("P1 매니지드 절대 경로 = 프로젝트 자료(번호 + 프로젝트 폴더 기준)", () => {
  assert.deepEqual(pathLinkTarget("/work/shared/project/4562/report.md"), { kind: "project", id: 4562, rel: "report.md" });
  assert.deepEqual(pathLinkTarget("/work/shared/project/4562/out/표.xlsx"), { kind: "project", id: 4562, rel: "out/표.xlsx" });
});
t("P2 노드(맥) 절대 경로 · ~ · 공유 루트 기준도 프로젝트 자료 — 대문자 확장자(.HWP)도", () => {
  assert.deepEqual(pathLinkTarget("/Users/a/workspace/project/12/a.md"), { kind: "project", id: 12, rel: "a.md" });
  assert.deepEqual(pathLinkTarget("~/workspace/project/12/docs/a.md"), { kind: "project", id: 12, rel: "docs/a.md" });
  assert.deepEqual(pathLinkTarget("project/12/a.md"), { kind: "project", id: 12, rel: "a.md" });
  assert.deepEqual(pathLinkTarget("/work/shared/project/12/계획.HWP"), { kind: "project", id: 12, rel: "계획.HWP" });
});
t("P3 프로젝트 폴더 안 레포의 project/ 폴더 — 첫 /project/<n>/ 이 프로젝트다", () => {
  assert.deepEqual(pathLinkTarget("/Users/a/workspace/project/4562/lively/src/project/project-fs.ts"),
    { kind: "project", id: 4562, rel: "lively/src/project/project-fs.ts" });
});
t("P4 상대 경로 = 세션 폴더 기준 — 맨 앞이 아닌 project/<n>/ 은 프로젝트가 아니다", () => {
  assert.deepEqual(pathLinkTarget("docs/a.md"), { kind: "session", rel: "docs/a.md" });
  assert.deepEqual(pathLinkTarget("./a.md"), { kind: "session", rel: "a.md" });
  assert.deepEqual(pathLinkTarget("src/project/12/x.ts"), { kind: "session", rel: "src/project/12/x.ts" });
});
t("P5 못 여는 것 = null: project 없는 절대 · 낱말 하나 · .. · 빈 마디 · 폴더 · 번호 0 · 스킴 · 빈 값 · 상대 대문자/1자 확장자", () => {
  for (const p of ["/tmp/a.md", "/etc/hosts.conf", "package.json", "../a.md", "docs/../a.md", "/work/shared/project/1/../2/a.md",
    "docs//a.md", "/work/shared/project/1//a.md", "/work/shared/project/1/", "/work/shared/project/1/out", "project/0/a.md",
    "https://a.io/project/1/a.md", "C:/x/project/1/a.md", "file:///x/project/1/a.md", "", "docs/A.HWP", "src/a.c"]) {
    assert.equal(pathLinkTarget(p), null, p);
  }
});

// ── F. 글 속에서 찾기 ───────────────────────────────────────────────
const urls = (line) => linkMatches(line).map((x) => x.url);
t("F1 문장 속 경로 — 한국어 조사·문장부호 꼬리는 떼고 확장자에서 끊는다", () => {
  assert.deepEqual(urls("저장했어요: /work/shared/project/4562/report.md"), ["/work/shared/project/4562/report.md"]);
  assert.deepEqual(urls("/work/shared/project/4562/report.md에 저장"), ["/work/shared/project/4562/report.md"]);
  assert.deepEqual(urls("(/work/shared/project/4562/a.md), 그리고"), ["/work/shared/project/4562/a.md"]);
  assert.deepEqual(urls("- `docs/plan.md` 와 `docs/b.hwp`."), ["docs/plan.md", "docs/b.hwp"]);
  //  코드를 짚는 꼴 `파일:줄(:칸)` — 줄·칸은 떼고 파일만(리뷰 지적: 첫 판의 `:` 가르기가 «5» 만 남겼다).
  assert.deepEqual(urls("src/foo.ts:12:5 에서"), ["src/foo.ts"]);
  assert.deepEqual(urls("/work/shared/project/9/a.md:12"), ["/work/shared/project/9/a.md"]);
});
t("F2 앞에 붙은 꾸밈·이름표를 떼고 경로만 — Write(…) · **…** · path= · 저장: · →", () => {
  const P = "/work/shared/project/7/out/a.html";
  for (const line of [`⏺ Write(${P})`, `**${P}**`, `path=${P}`, `saved:${P}`, `→${P}`]) assert.deepEqual(urls(line), [P], line);
  const L = `**${P}**`;
  const [x] = linkMatches(L);
  assert.equal(L.slice(x.start, x.end), P, "밑줄 범위도 경로 글자만");
});
t("F3 URL 은 종전대로 URL — 앞에 글자가 붙어도 경로가 가로채지 않는다(리뷰 블로킹 1)", () => {
  assert.deepEqual(urls("https://x.io/ui/project/1/a.md 보기"), ["https://x.io/ui/project/1/a.md"]);
  assert.deepEqual(urls("dev.lvly.io/ui/a.html"), ["https://dev.lvly.io/ui/a.html"]);
  assert.deepEqual(urls("url=https://x.io/page.html"), ["https://x.io/page.html"]);
  assert.deepEqual(urls("--url=https://x.io/a.json"), ["https://x.io/a.json"]);
  assert.deepEqual(urls("→https://x.io/a.html"), ["https://x.io/a.html"]);
  assert.deepEqual(urls("x=www.foo.com/a.html"), ["https://www.foo.com/a.html"]);
  //  http 가 아닌 스킴의 주소는 우리 URL 도, 이 머신의 경로도 아니다 — 남의 박스 경로를 내 프로젝트 자료로 열지 않는다.
  assert.deepEqual(urls("sftp://box/work/shared/project/1/a.md"), []);
});
t("F4 경로가 아닌 것엔 밑줄 없음 — 낱말 · 숫자 · 폴더 · 바깥 절대 · 셸 변수 · 약어", () => {
  for (const line of ["package.json 을 고쳤다", "1/2.5 배", "and/or", "/tmp/x.log 에 남김", "/work/shared/project/4562/ 폴더",
    "a.md", "$HOME/project/12/a.md", "yes/no.Then", "TCP/IP.Next", "e.g./i.e. 처럼", "docs//a.md"]) {
    assert.deepEqual(urls(line), [], line);
  }
});
t("F5 확장자 경계 — 10자까지, 11자는 아니다 · 숫자로 시작하는 «확장자» 는 아니다", () => {
  assert.deepEqual(urls("docs/a.abcdefghij"), ["docs/a.abcdefghij"]);
  assert.deepEqual(urls("docs/a.abcdefghijk"), []);
  assert.deepEqual(urls("docs/v.2"), []);
});
t("F6 한글 이름 — 넓은 글자 자리표(\\0)가 낀 칸 정렬 글: 칸 범위는 화면 그대로, url 은 자리표를 뺀다", () => {
  const cells = "→ /w/project/3/보\0고\0서\0.hwp 끝";
  const [x] = linkMatches(cells);
  assert.equal(x.url, "/w/project/3/보고서.hwp");
  assert.equal(cells.slice(x.start, x.end), "/w/project/3/보\0고\0서\0.hwp");
});
t("F7 클릭 판정(urlAtColumn) — 경로 글자 위는 그 경로, 밖은 null", () => {
  const L = "파일: /work/shared/project/9/a.md 끝";
  assert.equal(urlAtColumn(L, L.indexOf("/work")), "/work/shared/project/9/a.md");
  assert.equal(urlAtColumn(L, L.indexOf("a.md") + 3), "/work/shared/project/9/a.md");
  assert.equal(urlAtColumn(L, 1), null);
  assert.equal(urlAtColumn(L, L.length - 1), null);
});
t("F8 호버 밑줄(urlSpansAt)·칸 판정(urlAtCell)도 같은 판정을 쓴다", () => {
  const rows = ["저장: /work/shared/project/9/a.md"];
  const spans = urlSpansAt(rows, [false], 0, 80);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].url, "/work/shared/project/9/a.md");
  assert.equal(urlAtCell(rows, [false], 0, rows[0].indexOf("a.md"), 80), "/work/shared/project/9/a.md");
});
t("F9 경로 링크 표지 · 메뉴 힌트는 끝(파일 이름)을 보인다 · 긴 URL 은 종전대로 앞", () => {
  assert.equal(isPathLink("/work/a.md"), true);
  assert.equal(isPathLink("docs/a.md"), true);
  assert.equal(isPathLink("https://a.io/x"), false);
  const h = shortLink("/work/shared/project/4562/very-long-report-name.md");
  assert.ok(h.startsWith("…") && h.endsWith("very-long-report-name.md"), h);
  assert.equal(shortLink("https://a.io/x"), "a.io/x");
  //  스킴을 뗀 뒤의 값을 경로로 착각하면 안 된다(그렇게 짠 첫 판을 기존 시험이 잡았다).
  assert.equal(shortLink("https://" + "b".repeat(27)), "b".repeat(25) + "…");
});

t("F10 트래킹 pane 맨클릭 — 세션 상대 경로는 TUI 에 돌려주고(⌘/Ctrl 이면 연다), URL·프로젝트 경로는 연다", () => {
  assert.equal(bareClickLink("src/a.ts", false), null);
  assert.equal(bareClickLink("src/a.ts", true), "src/a.ts");
  assert.equal(bareClickLink("/work/shared/project/9/a.md", false), "/work/shared/project/9/a.md");
  assert.equal(bareClickLink("https://a.io/x", false), "https://a.io/x");
  assert.equal(bareClickLink(null, true), null);
});

// ── S. 이름에 빈칸이 든 경로(원준님 10-05 «파일 경로 클릭해도 안되는데?» — `데모데이 발표덱/…` 이 빈칸 뒤만 링크였다) ──────
const DECK = "/work/shared/project/4100/데모데이 발표덱/원준수정/데모데이덱_원준수정_시안_검토판12_B.html";
t("S1 절대 경로 속 빈칸 — 경로 전체가 한 링크, 밑줄도 전체", () => {
  const L = `저장했어요: ${DECK} 입니다`;
  const ms = linkMatches(L);
  assert.deepEqual(ms.map((x) => x.url), [DECK]);
  assert.equal(L.slice(ms[0].start, ms[0].end), DECK);
  assert.deepEqual(urls(`${DECK}을 열어 보세요`), [DECK]);
});
t("S2 파일 이름 속 빈칸 · ~ · ./ · project/<번호>/ 도", () => {
  assert.deepEqual(urls("/w/project/1/사업 계획서.hwp를 고쳤다"), ["/w/project/1/사업 계획서.hwp"]);
  assert.deepEqual(urls("~/workspace/project/1/2026 GovTech 창업경진대회/a.pdf"), ["~/workspace/project/1/2026 GovTech 창업경진대회/a.pdf"]);
  assert.deepEqual(urls("project/1/지원 서류/a.md"), ["project/1/지원 서류/a.md"]);
});
t("S3 잇지 않는 자리 — 두 칸 · 다른 절대 경로 · 경로 둘이 나란히(앞 것이 이미 파일)", () => {
  assert.deepEqual(urls("/w/project/1/out  a.md"), []);
  assert.deepEqual(urls("/w/project/1/out /w/project/1/a.md"), ["/w/project/1/a.md"]);
  assert.deepEqual(urls("/w/project/1/a.md 와 b.md"), ["/w/project/1/a.md"]);
});
t("S4 잇는 낱말은 5개까지", () => {
  assert.deepEqual(urls("/w/project/1/a b c d e f/x.md"), ["/w/project/1/a b c d e f/x.md"]);
  assert.deepEqual(urls("/w/project/1/a b c d e f g/x.md"), ["g/x.md"], "6낱말째는 잇지 않고, 끝 낱말은 제 혼자 상대 경로");
});
t("S4b 산문을 경로로 삼키지 않는다 — 끝 낱말에 `/` 가 없는 셋 이상 · 문장부호 · 새 경로의 시작에서 멈춘다(리뷰 지적)", () => {
  assert.deepEqual(urls("saved to /work/shared/project/12/out then open a.md"), []);
  assert.deepEqual(urls("/work/shared/project/12/docs 폴더에 정리했어요 → plan.md"), []);
  assert.deepEqual(urls("/work/shared/project/12/docs, 그리고 a/b.md"), ["a/b.md"]);
  assert.deepEqual(urls("/work/shared/project/12/docs see project/12/a.md"), ["project/12/a.md"]);
  assert.deepEqual(urls("/work/shared/project/12/out 끝. 그리고 a/b.md"), ["a/b.md"]);
  assert.deepEqual(urls("/work/shared/project/12/2026 GovTech 창업경진대회/a.pdf"), ["/work/shared/project/12/2026 GovTech 창업경진대회/a.pdf"]);
});
t("S5 상대 경로 — 앞 낱말을 붙인 후보(긴 것 먼저)를 함께 싣는다 · 이름표(`:`·`=`)·두 칸·경로 앞에선 안 붙인다 · 3낱말까지", () => {
  const alts = (line) => linkMatches(line).map((x) => x.alts || []);
  assert.deepEqual(urls("데모데이 발표덱/원준수정/a.html"), ["발표덱/원준수정/a.html"]);
  assert.deepEqual(alts("데모데이 발표덱/원준수정/a.html"), [["데모데이 발표덱/원준수정/a.html"]]);
  assert.deepEqual(alts("x 2026 GovTech 창업경진대회/a.md"), [["x 2026 GovTech 창업경진대회/a.md", "2026 GovTech 창업경진대회/a.md", "GovTech 창업경진대회/a.md"]]);
  assert.deepEqual(alts("a x 2026 GovTech 창업경진대회/a.md")[0].length, 3, "3낱말까지");
  assert.deepEqual(alts("경로: docs/a.md"), [[]]);
  assert.deepEqual(alts("파일은  docs/a.md"), [[]]);
  assert.deepEqual(alts("/w/x.md docs/a.md"), [[]]);
  assert.deepEqual(alts("- docs/a.md"), [[]], "목록 표지는 이름이 아니다");
  assert.deepEqual(alts("├── docs/a.md"), [[]]);
});

// ── R. 빈칸에서 줄이 바뀐 경로 — Claude Code 는 낱말 단위로 끊는다(빈칸 든 경로가 두 행으로 갈린다) ──────────────
//  행은 화면 그대로 칸 정렬로 만든다: 넓은 글자(한글)는 두 칸이라 뒤 칸에 \0 (cellRow 와 같은 규칙).
const cellsOf = (s) => [...s].map((ch) => (/[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3\u4E00-\u9FFF]/.test(ch) ? ch + "\0" : ch)).join("");
const R0 = cellsOf("저장: /work/shared/project/7/데모데이"), R1 = cellsOf("  발표덱/원준수정/a.html 입니다");
const WRAP = "/work/shared/project/7/데모데이 발표덱/원준수정/a.html";
t("R1 빈칸에서 갈린 두 행 — 어느 행을 눌러도 경로 전체, 밑줄은 두 행에 걸친다", () => {
  const cols = R0.length + 3;   // 다음 행 첫 낱말(발표덱/…)이 앞 행에 안 들어간다 — 낱말 줄바꿈이 일어난 폭
  const rows = [R0, R1], soft = [false, false];
  assert.equal(urlAtCell(rows, soft, 1, R1.indexOf("발"), cols), WRAP);
  assert.equal(urlAtCell(rows, soft, 0, R0.indexOf("데"), cols), WRAP);
  const sp = urlSpansAt(rows, soft, 1, cols);
  assert.equal(sp.length, 1);
  assert.equal(sp[0].url, WRAP);
  assert.deepEqual([sp[0].startRow, sp[0].endRow], [0, 1]);
});
t("R2 앞 행에 들어갈 수 있었던 낱말이면 잇지 않는다(우연히 경로 앞부분으로 끝난 짧은 행)", () => {
  const cols = 200;
  assert.equal(urlAtCell([R0, R1], [false, false], 1, R1.indexOf("발"), cols), "발표덱/원준수정/a.html");
});
t("R3 확장자로 이미 끝난 행 · 시작이 분명하지 않은 행은 잇지 않는다", () => {
  const A = cellsOf("/work/shared/project/7/a.md"), B = cellsOf("  docs/b.md");
  assert.equal(urlAtCell([A, B], [false, false], 1, 3, A.length + 3), "docs/b.md");
  const C = cellsOf("파일은 데모데이"), D = cellsOf("  발표덱/a.md");
  assert.equal(urlAtCell([C, D], [false, false], 1, 3, C.length + 3), "발표덱/a.md");
});
t("R3c 잇지 않는 이웃 행 — 짧은 경로 앞부분 행 뒤의 산문 · 꽉 찬 행이 파일로 끝난 뒤의 다른 줄 · 명령(/clear) 뒤", () => {
  const A = cellsOf("결과: /work/shared/project/7/out"), B = cellsOf("  다음은 docs/a.md 를 보세요");
  assert.equal(urlAtCell([A, B], [false, false], 1, B.indexOf("d"), 200), "docs/a.md");
  const C = cellsOf("저장: /work/shared/project/7/a.md"), D = cellsOf("  다음 단계는 배포입니다 x/y.md");
  assert.equal(urlAtCell([C, D], [false, false], 1, D.indexOf("x"), C.length), "x/y.md");
  const E = cellsOf("  /clear"), F = cellsOf("  docs/a.md");
  assert.equal(urlAtCell([E, F], [false, false], 1, 3, E.length + 2), "docs/a.md");
});
t("R4 한 낱말이 폭보다 길어 잘린 한글 경로 — 빈칸 없이 잇는다(빈칸을 지어 넣지 않는다)", () => {
  const A = cellsOf("/w/project/7/원준수정원준수정"), B = cellsOf("  검토판.html");
  const cols = A.length;      // 앞 행이 폭을 꽉 채웠고, 잘린 낱말+다음 조각은 폭보다 길다
  assert.equal(urlAtCell([A, B], [false, false], 1, 3, cols), "/w/project/7/원준수정원준수정검토판.html");
});

// ── L. 이 곁칸이 열 수 있나(셸의 판정) ───────────────────────────────
const here = (o = {}) => ({ projectId: 4562, loose: false, sessDir: (sid) => (sid === "s1" ? "/work/shared/project/4562" : sid === "s2" ? "/w/sessions/s2" : null), ...o });
const msg = (p, sid = "s1") => ({ path: p, target: pathLinkTarget(p), sid });
t("L1 세션 작업 폴더 밑의 절대 경로 → 세션 길(산출물과 같은 openOut — 노드·프로젝트 판정은 거기서)", () => {
  assert.deepEqual(pathOpenPlan(msg("/work/shared/project/4562/out/a.md"), here()), { via: "session", sid: "s1", rel: "out/a.md" });
});
t("L2 상대 경로 → 세션 길 · 모르는 세션(남의 세션 번호)이면 못 연다", () => {
  assert.deepEqual(pathOpenPlan(msg("docs/a.md"), here()), { via: "session", sid: "s1", rel: "docs/a.md" });
  assert.equal(pathOpenPlan(msg("docs/a.md", "남의세션"), here()), null);
  assert.equal(pathOpenPlan(msg("docs/a.md", ""), here()), null);
});
t("L3 세션 폴더 밖의 같은 프로젝트 경로 → 프로젝트 자료 · 남의 프로젝트 · 프로젝트 없는 화면이면 못 연다", () => {
  assert.deepEqual(pathOpenPlan(msg("/Users/a/workspace/project/4562/a.md", "s2"), here()), { via: "project", rel: "a.md" });
  assert.equal(pathOpenPlan(msg("/Users/a/workspace/project/99/a.md", "s2"), here()), null);
  assert.equal(pathOpenPlan(msg("/Users/a/workspace/project/4562/a.md", "s2"), here({ loose: true, projectId: 0 })), null);
});
t("L4 세션 폴더 «이름이 앞만 같은» 옆 폴더는 그 세션 폴더가 아니다", () => {
  assert.deepEqual(pathOpenPlan(msg("/work/shared/project/45620/a.md"), here({ projectId: 45620 })), { via: "project", rel: "a.md" });
  assert.deepEqual(pathOpenPlan(msg("/w/sessions/s2xy/project/4562/a.md", "s2"), here()), { via: "project", rel: "a.md" });
});
t("L6 후보 여럿 → 길 여럿(순서 그대로, 같은 길은 한 번) · 후보가 없는 옛 터미널은 path 하나로", () => {
  const c = (p) => ({ path: p, target: pathLinkTarget(p) });
  const plans = pathOpenPlans({ sid: "s1", cands: [c("데모데이 발표덱/a.md"), c("발표덱/a.md"), c("./발표덱/a.md")] }, here());
  assert.deepEqual(plans, [{ via: "session", sid: "s1", rel: "데모데이 발표덱/a.md" }, { via: "session", sid: "s1", rel: "발표덱/a.md" }]);
  assert.deepEqual(pathOpenPlans(msg("docs/a.md"), here()), [{ via: "session", sid: "s1", rel: "docs/a.md" }]);
  assert.deepEqual(pathOpenPlans({ sid: "남의세션", cands: [c("docs/a.md")] }, here()), []);
});
t("L5 셸이 다시 거른다 — 터미널을 거치지 않은 알림의 .. · 빈 마디 · 절대 rel", () => {
  for (const rel of ["../x.md", "a/../../x.md", "a//x.md", "/etc/passwd", ""]) {
    assert.equal(pathOpenPlan({ path: "/w/project/4562/" + rel, target: { kind: "project", id: 4562, rel }, sid: "s2" }, here()), null, rel);
  }
  assert.equal(pathOpenPlan({ path: "../x.md", target: { kind: "session", rel: "x.md" }, sid: "s1" }, here()), null, "경로 자체가 .. 로 시작");
});

// ── B. 터미널 ↔ 셸 왕복 — 실제 openPathFromTerminal 을 가짜 부모 프레임·가짜 시계로 ─────────
const g = globalThis;
const listeners = new Set();
g.addEventListener = (type, fn) => { if (type === "message") listeners.add(fn); };
g.removeEventListener = (type, fn) => { if (type === "message") listeners.delete(fn); };
let timers = [];
g.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
const tick = (ms) => { const due = timers.filter((x) => x.ms <= ms); timers = timers.filter((x) => x.ms > ms); due.forEach((x) => x.fn()); };
let opened = [];
g.open = (u) => { opened.push(u); return null; };
Object.defineProperty(g, "location", { value: { origin: "https://gw.test", href: "https://gw.test/ui/terminal.html?session=s1", pathname: "/ui/terminal.html", search: "?session=s1", protocol: "https:", host: "gw.test" }, configurable: true, writable: true });
const posted = [];
const parent = { postMessage: (d) => posted.push(d) };
g.parent = parent;
const answer = (data, source = parent) => [...listeners].forEach((fn) => fn({ origin: "https://gw.test", source, data }));
const reset = () => { posted.length = 0; opened = []; timers = []; listeners.clear(); };
const P = "/work/shared/project/12/a.md";
const SHARED = "https://gw.test/ui/#/f?root=shared&path=" + encodeURIComponent("project/12/a.md");

t("B1 셸이 열었다고 답하면 — 알림 한 번(판정 실어서), 새 탭 없음, 시간이 지나도 없음", () => {
  reset();
  openPathFromTerminal(P);
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "lively:open-file-in-pane");
  assert.deepEqual(posted[0].target, { kind: "project", id: 12, rel: "a.md" });
  answer({ type: "lively:open-file-in-pane:ok", path: P, handled: true });
  tick(10000);
  assert.deepEqual(opened, []);
});
t("B2 셸이 못 연다고 답하면 — 곧바로 공유 폴더 뷰어로 한 번", () => {
  reset();
  openPathFromTerminal(P);
  answer({ type: "lively:open-file-in-pane:ok", path: P, handled: false });
  assert.deepEqual(opened, [SHARED]);
  tick(10000);
  assert.deepEqual(opened, [SHARED], "시간이 지나도 두 번 열지 않는다");
});
t("B3 답이 없으면(구 셸·단독 화면) — 400ms 뒤 한 번 폴백, 그 뒤 늦게 온 «열었다» 는 버린다(리뷰 블로킹 2)", () => {
  reset();
  openPathFromTerminal(P);
  tick(399);
  assert.deepEqual(opened, []);
  tick(400);
  assert.deepEqual(opened, [SHARED]);
  answer({ type: "lively:open-file-in-pane:ok", path: P, handled: false });
  assert.deepEqual(opened, [SHARED], "늦은 답이 폴백을 한 번 더 부르지 않는다");
  tick(10000);
  assert.equal(listeners.size, 0, "듣기는 결국 걷힌다");
});
t("B4 연타(더블클릭) — 답을 기다리는 동안 두 번째는 버린다 · 답 뒤엔 다시 열 수 있다", () => {
  reset();
  openPathFromTerminal(P);
  openPathFromTerminal(P);
  assert.equal(posted.length, 1);
  answer({ type: "lively:open-file-in-pane:ok", path: P, handled: false });
  assert.deepEqual(opened, [SHARED]);
  openPathFromTerminal(P);
  assert.equal(posted.length, 2, "끝난 뒤의 클릭은 새 클릭이다");
  tick(10000);
});
t("B5 부모가 아닌 프레임의 답은 듣지 않는다 — 폴백이 그대로 돈다", () => {
  reset();
  openPathFromTerminal(P);
  answer({ type: "lively:open-file-in-pane:ok", path: P, handled: true }, { postMessage() {} });
  tick(400);
  assert.deepEqual(opened, [SHARED]);
  tick(10000);
});
t("B7 빈칸 든 상대 경로 — 앞 낱말 붙인 후보를 먼저, 화면의 경로를 맨 끝에 실어 보낸다", () => {
  reset();
  linkMatches("데모데이 발표덱/원준수정/a.html");      // 클릭 직전의 판정(호버·클릭이 늘 먼저 부른다)
  openPathFromTerminal("발표덱/원준수정/a.html");
  assert.deepEqual(posted[0].cands.map((x) => x.path), ["데모데이 발표덱/원준수정/a.html", "발표덱/원준수정/a.html"]);
  assert.ok(posted[0].cands.every((x) => x.target && x.target.kind === "session"));
  answer({ type: "lively:open-file-in-pane:ok", path: "발표덱/원준수정/a.html", handled: true });
  tick(10000);
});
t("B8 낡은 후보를 싣지 않는다 — 앞서 `파일은 docs/a.md` 로 본 경로를 이번엔 맨몸으로 눌렀다(리뷰 지적)", () => {
  reset();
  linkMatches("파일은 docs/a.md");
  linkMatches("docs/a.md");
  openPathFromTerminal("docs/a.md");
  assert.deepEqual(posted[0].cands.map((x) => x.path), ["docs/a.md"]);
  answer({ type: "lively:open-file-in-pane:ok", path: "docs/a.md", handled: true });
  tick(10000);
});
t("B6 경로가 아닌 것 · 다른 경로의 답 — 아무것도 안 하거나, 남의 답에 끌려가지 않는다", () => {
  reset();
  openPathFromTerminal("/tmp/a.md");
  assert.equal(posted.length, 0);
  openPathFromTerminal(P);
  answer({ type: "lively:open-file-in-pane:ok", path: "/work/shared/project/12/b.md", handled: true });
  tick(400);
  assert.deepEqual(opened, [SHARED], "다른 경로의 답은 이 클릭의 답이 아니다");
  tick(10000);
});

// ── K. 지식 이름 링크(원준님 10-05 «산출 지식 저것도 클릭하면 뜨게하자») — 있다고 확인된 이름에만 ─────────────
const tK = async (n, fn) => { await fn(); pass++; console.log(`ok  ${n}`); };
const names = (line) => knowledgeCandidates(line).map((c) => c.names.map((x) => x.name));
t("K1 후보 꼴 — 하이픈 마디 셋 이상 · 8~64자 · 한글 이름 · 조사 붙은 꼴은 뗀 것도", () => {
  assert.deepEqual(names("산출지식 terminal-path-link-to-pane-viewer-4562 참고"), [["terminal-path-link-to-pane-viewer-4562"]]);
  assert.deepEqual(names("terminal-path-link-to-pane-viewer-4562에 남겼다"), [["terminal-path-link-to-pane-viewer-4562에", "terminal-path-link-to-pane-viewer-4562"]]);
  assert.deepEqual(names(cellsOf("지식 터미널-여러세션-한탭-그리드-열기-745 참고")), [["터미널-여러세션-한탭-그리드-열기-745"]]);
});
t("K2 후보가 아닌 것 — 마디 둘 · 짧은 것 · 경로·URL·파일 이름 속 · 대문자", () => {
  for (const line of ["diff-reviewer 를 돌렸다", "a-b-c", "/x/terminal-path-link-4562.md", "https://a.io/x-y-z-w", "see terminal-path-link.md", "Big-Name-Here-Yes", "https://a.io/terminal-path-link-to-pane 보기", "/w/project/1/terminal-path-link-to-pane",
    "550e8400-e29b-41d4-a716-446655440000", "2026-10-05-00-00", "12345-678-90-abc"]) {
    assert.deepEqual(names(line), [], line);
  }
});
t("K3 확인된 이름만 링크 · 조사 붙은 꼴은 밑줄도 이름까지 · 한글 이름은 칸 범위 그대로", () => {
  const known = (n) => n === "terminal-path-link-to-pane-viewer-4562" || n === "터미널-여러세션-한탭-그리드-열기-745";
  const L = "terminal-path-link-to-pane-viewer-4562에 · unknown-name-here-x";
  const ms = knowledgeMatches(L, known);
  assert.deepEqual(ms.map((x) => x.url), ["terminal-path-link-to-pane-viewer-4562"]);
  assert.equal(L.slice(ms[0].start, ms[0].end), "terminal-path-link-to-pane-viewer-4562");
  const C = cellsOf("지식 터미널-여러세션-한탭-그리드-열기-745 참고");
  const [k] = knowledgeMatches(C, known);
  assert.equal(C.slice(k.start, k.end).replace(/\0/g, ""), "터미널-여러세션-한탭-그리드-열기-745");
  //  이모지(넓은 글자) 바로 뒤 — 밑줄이 이모지의 뒤 칸에서 시작하지 않는다(리뷰 지적)
  const E = "✅\0terminal-path-link-to-pane-viewer-4562 끝";
  const [e] = knowledgeMatches(E, known);
  assert.equal(E.slice(e.start, e.end), "terminal-path-link-to-pane-viewer-4562");
  //  칸 정렬 글에서 조사 붙은 꼴 — 조사의 뒤 칸(\0)은 밑줄 밖
  const P = cellsOf("terminal-path-link-to-pane-viewer-4562에");
  const [q] = knowledgeMatches(P, known);
  assert.equal(P.slice(q.start, q.end), "terminal-path-link-to-pane-viewer-4562");
});
const fetched = [];
let fetchPlan = {};
g.fetch = async (url) => {
  const name = decodeURIComponent(String(url).split("/api/ui/knowledge/")[1].split("?")[0]);
  fetched.push(name);
  const v = fetchPlan[name];
  if (v === "throw") throw new Error("net");
  return { ok: v === 200, status: v ?? 404 };
};
await tK("K4 서버에 묻고 기억한다 — 200=있음 · 404=없음(기억) · 5xx·끊김=기억 안 함(다음에 다시) · 같은 이름은 한 번만", async () => {
  fetchPlan = { "yes-kn-name-one": 200, "no-kn-name-two": 404, "err-kn-name-three": 500, "net-kn-name-four": "throw" };
  fetched.length = 0;
  await Promise.all([learnKnowledge(["yes-kn-name-one", "no-kn-name-two", "err-kn-name-three", "net-kn-name-four"]), learnKnowledge(["yes-kn-name-one"])]);
  assert.deepEqual(fetched.filter((n) => n === "yes-kn-name-one").length, 1, "같은 이름을 두 번 묻지 않는다");
  assert.equal(isKnowledgeLink("yes-kn-name-one"), true);
  assert.equal(isKnowledgeLink("no-kn-name-two"), false);
  fetched.length = 0;
  await learnKnowledge(["yes-kn-name-one", "no-kn-name-two", "err-kn-name-three", "net-kn-name-four"]);
  assert.deepEqual(fetched.sort(), ["err-kn-name-three", "net-kn-name-four"], "답을 못 받은 것만 다시 묻는다");
});
await tK("K5 확인된 이름은 linkMatches 에 든다 — 확인 전엔 안 든다(가짜 밑줄 없음)", async () => {
  fetchPlan = { "yes-kn-name-one": 200, "no-kn-name-two": 404 };
  await learnKnowledge(["yes-kn-name-one", "no-kn-name-two"]);
  assert.deepEqual(urls("산출지식 yes-kn-name-one 참고"), ["yes-kn-name-one"]);
  assert.deepEqual(urls("no-kn-name-two · never-asked-name-x"), []);
  assert.deepEqual(urls("/w/project/1/yes-kn-name-one.md"), ["/w/project/1/yes-kn-name-one.md"], "경로 속 이름은 경로의 몫");
});
t("K6 누르면 곁칸 웹 칸으로 `#/k/<이름>` — 답이 없으면 새 탭", () => {
  reset();
  openLinkFromTerminal("yes-kn-name-one");
  assert.equal(posted.length, 1);
  assert.equal(posted[0].type, "lively:open-in-pane");
  assert.equal(posted[0].url, "https://gw.test/ui/#/k/yes-kn-name-one");
  answer({ type: "lively:open-in-pane:ok" });
  tick(400);
  assert.deepEqual(opened, []);
  reset();
  openLinkFromTerminal("yes-kn-name-one");
  tick(400);
  assert.deepEqual(opened, ["https://gw.test/ui/#/k/yes-kn-name-one"]);
});

await tK("K7 멎은 요청 — 1.5초 상한에서 끝나고(밑줄 답이 막히지 않는다), 기억하지 않아 다음에 다시 묻는다(리뷰 차단 지적)", async () => {
  const savedFetch = g.fetch;
  let asked = 0;
  g.fetch = () => { asked++; return new Promise(() => {}); };   // 영영 답이 없다
  timers = [];
  let done = false;
  const p = learnKnowledge(["stuck-kn-name-five"]).then(() => { done = true; });
  await Promise.resolve();
  assert.equal(done, false);
  tick(1500);                       // 상한
  await p;
  assert.equal(done, true);
  assert.equal(isKnowledgeLink("stuck-kn-name-five"), false);
  g.fetch = savedFetch;
  fetchPlan = { "stuck-kn-name-five": 200 };
  await learnKnowledge(["stuck-kn-name-five"]);
  assert.equal(isKnowledgeLink("stuck-kn-name-five"), true, "다음 호버엔 다시 물어 알아낸다");
  assert.equal(asked, 1);
});
await tK("K8 «없다» 는 60초만 믿는다 — 그 뒤 호버는 다시 묻는다(이름을 먼저 말하고 문서를 나중에 쓰는 판)", async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  fetchPlan = { "later-kn-name-six": 404 };
  await learnKnowledge(["later-kn-name-six"]);
  assert.equal(isKnowledgeLink("later-kn-name-six"), false);
  fetchPlan = { "later-kn-name-six": 200 };
  fetched.length = 0;
  now += 30_000;
  await learnKnowledge(["later-kn-name-six"]);
  assert.deepEqual(fetched, [], "60초 안엔 다시 묻지 않는다");
  now += 31_000;
  await learnKnowledge(["later-kn-name-six"]);
  assert.deepEqual(fetched, ["later-kn-name-six"]);
  assert.equal(isKnowledgeLink("later-kn-name-six"), true);
  Date.now = realNow;
});

console.log(`\n${pass} passed`);
