// #5583 — AI 가 준 **자료 링크**(우리 화면 `/ui/#/f?…` · `#/k/…`)를 새 탭이 아니라 곁칸에서 연다.
//  원준 2026-11-22: «자료를 링크로 줄 때 새 탭에서 열려서 세션이랑 한 번에 보기 힘듦 — 경로로 주는 것 눌렀을 때처럼 곁칸에서 보이게».
//
//  판정 사본 둘(web/lib/ui-link.ts 정본 · web/standalone/ui-link.ts 터미널 번들 사본)이 같은 표를 지나야 한다.
//
//  | #   | 링크                                                         | 여기          | 결과                          |
//  |-----|--------------------------------------------------------------|---------------|-------------------------------|
//  | U1  | 게이트웨이/ui/#/f?root=shared&path=project%2F12%2Fa.md(인코딩) | 터미널 문서    | file project/12/a.md          |
//  | U2  | #/f?root=shared&path=project/12/dir/b.HWP(상대 · 대문자 확장자) | 셸            | file                          |
//  | U3  | 폴더(확장자 없음) project/12/dir                               | 셸            | web                           |
//  | U4  | 공유 폴더지만 프로젝트 밖 team/a.md                             | 셸            | web                           |
//  | U5  | 개인 폴더 root=personal                                        | 셸            | web                           |
//  | U6  | 지식 #/k/<이름>                                                | 터미널 문서    | web                           |
//  | U7  | 다른 우리 화면(#/projects/12 · #/s/… · #/k 이름 없음 · #/f root 없음) | 셸   | null(종전 규칙)               |
//  | U8  | 다른 출처                                                      | 셸            | null                          |
//  | U9  | 같은 출처 다른 경로(/preview/<id>/ui/)                          | 셸(/ui/)      | null                          |
//  | U10 | 위험·이상한 경로(.. · 빈 마디 · project/0)                       | 셸            | web(파일로 안 연다)            |
//  | U11 | /ui/index.html#/f… · path 앞 '/' · 한글·빈칸·괄호 든 이름         | 셸            | file(그대로 풀어서)            |
//  | U12 | 깨진 주소                                                       | 셸            | null                          |
//
//  터미널(실제 openLinkFromTerminal — 가짜 부모 프레임·가짜 시계):
//   T1 프로젝트 자료 파일 링크 → 경로와 같은 알림(open-file-in-pane, 판정 실어서) · 셸이 열면 새 탭 없음
//   T2 ★ 셸이 못 연다(남의 프로젝트) → 곁칸 웹 칸에 그 #/f 를 **한 번** — 다시 경로 알림으로 돌지 않는다(무한 되돌이 금지)
//   T3 지식 링크 · 폴더 링크 → 곁칸 웹 칸(open-in-pane) · 받으면 새 탭 없음
//   T4 다른 우리 화면(#/projects/12)은 종전대로 브라우저 새 탭
//   T5 우클릭 [링크 열기] 힌트도 같은 판정(파일 = 뷰어 탭 · 그 밖 자료 = 웹 탭) — 배선
//  대화창 ↔ 곁칸(같은 문서 — DOM 이벤트) 배선:
//   W1 대화창은 목록의 링크 맨클릭에서 uiPaneLink → PANE_LINK_EVENT 를 띄우고, **받았을 때만** 기본 이동을 막는다 · 꾸밈키 클릭은 안 건드린다
//   W2 곁칸은 자기 wrap 에서 받는다 — 파일은 planPathOpen(경로와 같은 길), 못 열면·그 밖은 웹 칸 · handled 를 켠다
//   W3 이벤트 이름은 lib 상수 하나(문자열 복제 없음)
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path, { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const compile = (src) => {
  const out = mkdtempSync(join(tmpdir(), "ui-link-"));
  execFileSync(join(root, "node_modules/.bin/tsc"), [src, "--outDir", out, "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
  return join(out, path.basename(src).replace(/\.ts$/, ".js"));
};
const COPIES = {
  lib: await import(compile(process.env.UI_LINK_LIB || join(root, "web/lib/ui-link.ts"))),
  standalone: await import(compile(process.env.UI_LINK_STANDALONE || join(root, "web/standalone/ui-link.ts"))),
};

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };

const GW = "https://gw.test";
const TERM = GW + "/ui/terminal.html?session=s1";
const SHELL = GW + "/ui/";
const enc = encodeURIComponent;

for (const [name, { uiPaneLink, PANE_LINK_EVENT }] of Object.entries(COPIES)) {
  const at = (href, here = SHELL) => uiPaneLink(href, here);
  t(`[${name}] U1 file_url 꼴(인코딩된 path) — 터미널 문서에서도 프로젝트 자료 파일`, () => {
    const href = GW + "/ui/#/f?root=shared&path=" + enc("project/12/a.md");
    assert.deepEqual(at(href, TERM), { kind: "file", path: "project/12/a.md", url: href });
  });
  t(`[${name}] U2 상대 주소 · 대문자 확장자`, () => {
    assert.deepEqual(at("#/f?root=shared&path=project/12/dir/b.HWP"), { kind: "file", path: "project/12/dir/b.HWP", url: SHELL + "#/f?root=shared&path=project/12/dir/b.HWP" });
  });
  t(`[${name}] U3 폴더(확장자 없음) → 웹 칸`, () => {
    assert.deepEqual(at("#/f?root=shared&path=project/12/dir"), { kind: "web", url: SHELL + "#/f?root=shared&path=project/12/dir" });
  });
  t(`[${name}] U4 공유 폴더지만 프로젝트 밖 → 웹 칸`, () => {
    assert.equal(at("#/f?root=shared&path=team/a.md").kind, "web");
  });
  t(`[${name}] U5 개인 폴더 → 웹 칸`, () => {
    assert.equal(at("#/f?root=personal&path=a.md").kind, "web");
  });
  t(`[${name}] U6 지식 → 웹 칸`, () => {
    assert.deepEqual(at(GW + "/ui/#/k/terminal-path-link-to-pane-viewer-4562", TERM), { kind: "web", url: GW + "/ui/#/k/terminal-path-link-to-pane-viewer-4562" });
  });
  t(`[${name}] U7 다른 우리 화면은 곁칸 몫이 아니다(종전 규칙)`, () => {
    for (const h of ["#/projects/12", "#/s/box-x", "#/k", "#/k/", "#/f?path=project/12/a.md", "#/", "", GW + "/ui/"]) assert.equal(at(h), null, h);
  });
  t(`[${name}] U8 다른 출처`, () => {
    assert.equal(at("https://other.test/ui/#/f?root=shared&path=project/12/a.md"), null);
  });
  t(`[${name}] U9 같은 출처 다른 경로(미리보기의 셸 · API)`, () => {
    assert.equal(at(GW + "/preview/abc/ui/#/f?root=shared&path=project/12/a.md"), null);
    assert.equal(at(GW + "/api/ui/v6/projects/12/file?path=a.md"), null);
  });
  t(`[${name}] U10 위험·이상한 경로는 파일로 안 연다(웹 칸 — 화면이 거른다)`, () => {
    for (const p of ["project/12/../x.md", "project/12//a.md", "project/12/./a.md", "project/0/a.md"]) assert.equal(at("#/f?root=shared&path=" + enc(p)).kind, "web", p);
  });
  t(`[${name}] U11 index.html · 앞 '/' · 한글·빈칸·괄호 든 이름`, () => {
    assert.equal(at(GW + "/ui/index.html#/f?root=shared&path=project/12/a.md").path, "project/12/a.md");
    assert.equal(at("#/f?root=shared&path=" + enc("/project/12/a.md")).path, "project/12/a.md");
    assert.equal(at("#/f?root=shared&path=" + enc("project/12/데모 덱/시안(1).html")).path, "project/12/데모 덱/시안(1).html");
  });
  t(`[${name}] U12 깨진 주소`, () => {
    assert.equal(at("http://["), null);
    assert.equal(uiPaneLink("#/f?root=shared&path=project/12/a.md", "not a url"), null);
  });
  t(`[${name}] 이벤트 이름 상수`, () => { assert.equal(PANE_LINK_EVENT, "lively:pane-link"); });
}

// ── T. 터미널 — 실제 openLinkFromTerminal ─────────────────────────────────
const m = await importTerminalModule();
const { openLinkFromTerminal } = m;
const g = globalThis;
const listeners = new Set();
g.addEventListener = (type, fn) => { if (type === "message") listeners.add(fn); };
g.removeEventListener = (type, fn) => { if (type === "message") listeners.delete(fn); };
let timers = [];
g.setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
const tick = (ms) => { const due = timers.filter((x) => x.ms <= ms); timers = timers.filter((x) => x.ms > ms); due.forEach((x) => x.fn()); };
let opened = [];
g.open = (u) => { opened.push(u); return null; };
Object.defineProperty(g, "location", { value: { origin: GW, href: TERM, pathname: "/ui/terminal.html", search: "?session=s1", protocol: "https:", host: "gw.test" }, configurable: true, writable: true });
const posted = [];
const parent = { postMessage: (d) => posted.push(d), location: { hash: "" } };
g.parent = parent;
const answer = (data, source = parent) => [...listeners].forEach((fn) => fn({ origin: GW, source, data }));
const reset = () => { posted.length = 0; opened = []; timers = []; listeners.clear(); parent.location.hash = ""; };
const fileMsgs = () => posted.filter((d) => d.type === "lively:open-file-in-pane");
const webMsgs = () => posted.filter((d) => d.type === "lively:open-in-pane").map((d) => d.url);
const FILE = GW + "/ui/#/f?root=shared&path=" + enc("project/12/a.md");

t("T1 프로젝트 자료 파일 링크 → 경로와 같은 알림 · 셸이 열면 새 탭 없음", () => {
  reset();
  openLinkFromTerminal(FILE);
  assert.equal(fileMsgs().length, 1);
  assert.equal(fileMsgs()[0].path, "project/12/a.md");
  assert.deepEqual(fileMsgs()[0].target, { kind: "project", id: 12, rel: "a.md" });
  answer({ type: "lively:open-file-in-pane:ok", path: "project/12/a.md", handled: true });
  tick(10000);
  assert.deepEqual(opened, []);
  assert.deepEqual(webMsgs(), []);
});
t("T2 ★ 셸이 못 연다(남의 프로젝트) → 곁칸 웹 칸에 #/f 를 한 번 — 경로 알림으로 되돌아가지 않는다", () => {
  reset();
  openLinkFromTerminal(FILE);
  answer({ type: "lively:open-file-in-pane:ok", path: "project/12/a.md", handled: false });
  assert.deepEqual(webMsgs(), [FILE]);
  answer({ type: "lively:open-in-pane:ok" });
  tick(10000);
  assert.equal(fileMsgs().length, 1, "경로 알림은 처음 한 번뿐");
  assert.deepEqual(webMsgs(), [FILE]);
  assert.deepEqual(opened, []);
});
t("T3 지식 링크 · 폴더 링크 → 곁칸 웹 칸 · 받으면 새 탭 없음", () => {
  for (const href of [GW + "/ui/#/k/some-know-ledge", GW + "/ui/#/f?root=shared&path=" + enc("project/12/dir")]) {
    reset();
    openLinkFromTerminal(href);
    assert.deepEqual(webMsgs(), [href], href);
    assert.equal(fileMsgs().length, 0);
    answer({ type: "lively:open-in-pane:ok" });
    tick(10000);
    assert.deepEqual(opened, [], href);
  }
});
t("T4 다른 우리 화면(#/projects/12)은 종전대로 브라우저 새 탭", () => {
  reset();
  openLinkFromTerminal(GW + "/ui/#/projects/12");
  tick(10000);
  assert.deepEqual(opened, [GW + "/ui/#/projects/12"]);
  assert.equal(posted.length, 0);
});

const src = (p) => readFileSync(join(root, p), "utf8");
t("T5 우클릭 [링크 열기] 힌트도 같은 판정 — 자료 파일은 뷰어 탭, 그 밖 자료는 웹 탭", () => {
  const term = src("web/standalone/terminal.ts");
  assert.match(term, /const paneOf = url \? uiPaneLink\(url, location\.href\) : null;/);
  assert.match(term, /paneOf \? \(paneOf\.kind === 'file' && pathLinkTarget\(paneOf\.path\) \? 'file' : 'pane'\) : linkTargetHere\(url\)/);
  //  열기 쪽 — 자료 링크 판정이 «우리 화면 = 새 탭»(linkTargetHere) 보다 먼저 선다
  const open = term.slice(term.indexOf("export function openLinkFromTerminal"), term.indexOf("export function openLinkFromTerminal") + 3000);
  assert.ok(open.indexOf("uiPaneLink(uri, location.href)") > 0 && open.indexOf("uiPaneLink(uri, location.href)") < open.indexOf("linkTargetHere(uri)"));
});

t("W1 대화창 — 목록 링크 맨클릭에서 곁칸에 묻고, 받았을 때만 기본 이동을 막는다", () => {
  const cv = src("web/chat-view.ts");
  assert.match(cv, /import \{ PANE_LINK_EVENT, uiPaneLink, webPaneLink \} from '\.\/lib\/ui-link\.js';/);
  const i = cv.indexOf("list.addEventListener('click', (e: MouseEvent) => {\n    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;");
  assert.ok(i > 0, "꾸밈키 클릭은 건드리지 않는다");
  const body = cv.slice(i, i + 700);
  assert.match(body, /const href = a\.getAttribute\('href'\) \|\| '';\n\s+const link = uiPaneLink\(href, location\.href\) \|\| webPaneLink\(href, location\.href\);/);
  assert.match(body, /a\.dispatchEvent\(new CustomEvent\(PANE_LINK_EVENT, \{ bubbles: true, detail \}\)\);\n\s+if \(detail\.handled\) e\.preventDefault\(\);/);
});
t("W2 곁칸 — 자기 wrap 에서 받는다 · 파일은 경로와 같은 길 · 못 열면·그 밖은 웹 칸 · handled 를 켠다", () => {
  const pn = src("web/v2/panes.ts");
  assert.match(pn, /wrap\.addEventListener\(PANE_LINK_EVENT, onPaneLink\);/);
  const i = pn.indexOf("const onPaneLink = (e: Event): void => {");
  assert.ok(i > 0);
  const body = pn.slice(i, i + 1400);
  assert.match(body, /if \(!d \|\| d\.handled \|\| !link\) return;/);
  //  #5699 남의 사이트는 칸에 넣을 수 있을 때(데스크톱 webview)만 받는다 — handled 를 켜기 **전에** 거른다
  const gate = body.indexOf("if (cross && !hasBrowserSurface()) return;");
  assert.ok(gate > 0 && gate < body.indexOf("d.handled = true;"), "못 넣는 남의 사이트는 handled 를 안 켜야 종전 이동이 산다");
  assert.match(body, /planPathOpen\(\{ path: link\.path, target: \{ kind: 'project', id: Number\(m\[1\]\), rel: m\[2\] \} \}\)/);
  assert.match(body, /if \(run\) \{ window\.setTimeout\(run, 0\); return; \}/);
  assert.match(body, /openInWebPart\(ctx, link\.url\); addTab\('side', 'web'\);/);
});
// ── #5699 대화창의 남의 사이트·미리보기 링크 → 곁칸 웹 칸 후보(webPaneLink, 정본 web/lib 만 — 터미널은 linkOpenTarget) ──
{
  const { webPaneLink } = COPIES.lib;
  t("X1 남의 사이트 http·https → web(곁칸이 넣을 수 있나는 곁칸이 정한다)", () => {
    assert.deepEqual(webPaneLink("https://example.com/docs?a=1", SHELL), { kind: "web", url: "https://example.com/docs?a=1" });
    assert.deepEqual(webPaneLink("http://127.0.0.1:3000/", SHELL), { kind: "web", url: "http://127.0.0.1:3000/" });
  });
  t("X2 같은 출처 미리보기 → web · 그 밖 같은 출처(우리 화면 · api)는 null(종전)", () => {
    assert.deepEqual(webPaneLink("/preview/p1/ui/", SHELL), { kind: "web", url: GW + "/preview/p1/ui/" });
    assert.equal(webPaneLink("#/projects/12", SHELL), null);
    assert.equal(webPaneLink(GW + "/api/ui/me", SHELL), null);
  });
  t("X3 http(s) 아닌 스킴 · 깨진 주소 → null", () => {
    for (const h of ["mailto:a@b.c", "javascript:alert(1)", "file:///etc/passwd", "http://["]) assert.equal(webPaneLink(h, SHELL), null, h);
  });
}

t("W3 이벤트 이름은 lib 상수 하나 — 대화창·곁칸에 문자열 복제 없음", () => {
  for (const p of ["web/chat-view.ts", "web/v2/panes.ts"]) assert.doesNotMatch(src(p), /'lively:pane-link'/, p);
});

console.log(`\nui-pane-link: ${pass} passed`);
