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
const { pathLinkTarget, linkMatches, urlAtColumn, urlAtCell, urlSpansAt, isPathLink, shortLink, openPathFromTerminal } = m;
for (const f of [pathLinkTarget, linkMatches, urlAtColumn, urlAtCell, urlSpansAt, isPathLink, shortLink, openPathFromTerminal]) assert.equal(typeof f, "function");

const LIB = process.env.PATH_OPEN_SRC || join(root, "web/lib/path-open.ts");
const out = mkdtempSync(join(tmpdir(), "path-open-"));
execFileSync(join(root, "node_modules/.bin/tsc"), [LIB, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const { pathOpenPlan } = await import(join(out, path.basename(LIB).replace(/\.ts$/, ".js")));

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

console.log(`\n${pass} passed`);
