// #1541 — Cmd/Ctrl+클릭 링크 열기의 판정부(urlAtColumn) + 배선.
//  왜 표로 못박나: 실측 사슬이 길었다 — 트래킹 pane(claude TUI)에선 클릭이 pty 로 가서 TUI 의 확인창이 뜨고,
//  OK 는 서버 안 open(1)이라 사용자 브라우저엔 아무 일도 없다. 그래서 modifier 클릭은 xterm 전에 가로채
//  클라이언트가 여는데, "어느 글자가 URL 인가"의 판정이 틀리면 빈 자리 클릭이 엉뚱한 링크를 연다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { importTerminalModule } from "./standalone-terminal-env.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = readFileSync(join(root, "web/standalone/terminal.ts"), "utf8");
const { urlAtColumn, urlAtCell, cellRow, linkOpenTarget, ctxCopyPlan, shortLink } = await importTerminalModule();
for (const f of [urlAtColumn, urlAtCell, cellRow, linkOpenTarget, ctxCopyPlan, shortLink]) assert.equal(typeof f, "function");

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };

const LINE = "AAA https://dev.lvly.io/ui/#/k/foo-1541 BBB";
t("U1 URL 글자 위 = 그 URL (시작·중간·끝)", () => {
  assert.equal(urlAtColumn(LINE, 4), "https://dev.lvly.io/ui/#/k/foo-1541");
  assert.equal(urlAtColumn(LINE, 20), "https://dev.lvly.io/ui/#/k/foo-1541");
  assert.equal(urlAtColumn(LINE, 38), "https://dev.lvly.io/ui/#/k/foo-1541");
});
t("U2 URL 밖(앞말·뒷말·경계 뒤) = null — 빈 자리 클릭이 링크를 열면 안 된다", () => {
  assert.equal(urlAtColumn(LINE, 0), null);
  assert.equal(urlAtColumn(LINE, 3), null);
  assert.equal(urlAtColumn(LINE, 39), null);
  assert.equal(urlAtColumn(LINE, 42), null);
});
t("U3 문장부호 꼬리를 URL 에 넣지 않는다(문장 속 링크)", () => {
  assert.equal(urlAtColumn("보세요: https://a.io/x. 그리고", 10), "https://a.io/x");
  assert.equal(urlAtColumn("(https://a.io/x)", 3), "https://a.io/x");
});
t("U4 한 줄에 URL 둘 — 클릭한 쪽이 열린다", () => {
  const two = "https://a.io/1 사이 https://b.io/2";
  assert.equal(urlAtColumn(two, 2), "https://a.io/1");
  assert.equal(urlAtColumn(two, 25), "https://b.io/2");
});
t("U5 비-URL·빈 줄 = null (throw 없음)", () => {
  assert.equal(urlAtColumn("no links here", 5), null);
  assert.equal(urlAtColumn("", 0), null);
});
t("U6 ★ 스킴 없는 링크(실측: TUI 가 developer.apple.com/… 로 찍는다) — 열 때 https:// 보정", () => {
  const line = "가서 developer.apple.com/account/resources/certificates 를 여세요";
  assert.equal(urlAtColumn(line, 10), "https://developer.apple.com/account/resources/certificates");
  assert.equal(urlAtColumn("www.apple.com 참고", 3), "https://www.apple.com");
  assert.equal(urlAtColumn("호스트만: apple.com/kr", 7), "https://apple.com/kr");
});
t("U7 스킴 없는 형태의 오탐 경계 — 경로 없는 점-이름·파일 경로는 링크가 아니다", () => {
  assert.equal(urlAtColumn("package.json 을 여세요", 4), null, "경로(/) 없는 점-이름");
  assert.equal(urlAtColumn("src/foo.ts 수정", 4), null, "일반 파일 경로(호스트 형태 아님)");
  assert.equal(urlAtColumn("버전 1.2.3/4 확인", 4), null, "숫자.숫자/… 는 TLD 가 아니다");
});
t("W1 배선 — 판정은 mousedown 에서(press 가 pty 로 새면 TUI 확인창이 뜬다), down/up/click 캡처 셋이 한 판정을 공유", () => {
  assert.match(src, /pendingLink = wantsLink \? linkAtEvent\(ev\) : null/, "mousedown 에서 링크를 판정하지 않는다");
  assert.match(src, /return urlAtCell\(rows, soft, y - from, col, term\.cols\);/, "판정이 urlAtCell(여러 행 잇기)을 안 쓴다");
  assert.match(src, /rows\.push\(l \? cellRow\(l, term\.cols\) : ''\);\s*soft\.push\(!!\(l && l\.isWrapped\)\);/, "행을 칸 정렬로 펴지 않거나 감싸인 행(isWrapped)을 안 넘긴다");
  // 캡처(true) 3종 — 버블 단계면 xterm 이 먼저 먹는다
  for (const evName of ["mousedown", "mouseup", "click"]) {
    assert.match(src, new RegExp(`addEventListener\\('${evName}',[\\s\\S]{0,700}?\\}, true\\);`), `${evName} 이 캡처가 아니다`);
  }
});
t("W2 배선 — 맨클릭은 '트래킹 pane × URL 위'로 좁힌다(TUI 마우스 입력·셸 드래그 선택 보존), modifier 는 항상", () => {
  assert.match(src, /\(ev\.metaKey \|\| ev\.ctrlKey\) \|\| mouseTracked\(\)/, "맨클릭 경로가 트래킹 판정을 안 탄다");
  assert.match(src, /mouseTrackingMode/, "트래킹 판정이 xterm modes 를 안 본다");
  assert.match(src, /linkHandler: \{ activate:/, "OSC 8 하이퍼링크(linkHandler)가 없다 — TUI 가 심은 실제 URI 링크가 죽은 링크가 된다");
  assert.match(src, /if \(pendingLink \|\| \(ev\.metaKey \|\| ev\.ctrlKey\)\)/, "맨클릭이 URL 밖에서도 삼켜진다(TUI 입력이 죽는다) — URL 위일 때만 삼켜야 한다");
  assert.match(src, /url && url === pendingLink/, "드래그(다른 자리에서 뗌)를 클릭으로 오인한다");
});

// ── #4083 A. 어디서 여나(linkOpenTarget) — 원준님 2026-09-19 «브라우저가 있다면 새 탭에서» ──
//  종전엔 AI 가 준 `<게이트웨이>/ui/#/…` 링크가 셸의 해시를 바꿔 보던 세션 화면을 떠나게 했다.
const HERE = "https://gw.test/ui/terminal.html?session=box-1";
const B = { href: HERE, framed: true, desktop: false };   // 브라우저, 셸 안 터미널
const D = { href: HERE, framed: true, desktop: true };    // 데스크톱 앱, 셸 안 터미널
const UI = "https://gw.test/ui/#/f?root=shared&path=project%2F4076%2Fa.html";
t("A1 ★ 브라우저 · 셸 안 · 같은 게이트웨이 /ui/ 화면 링크 = 새 탭(보던 세션 화면을 떠나지 않는다)", () => {
  assert.equal(linkOpenTarget(UI, B), "tab");
});
t("A2 데스크톱 앱 · 셸 안 · /ui/ 화면 링크 = 셸 안 이동(앱엔 브라우저 탭이 없다 — window.open 이면 앱 창이 하나 더)", () => {
  assert.equal(linkOpenTarget(UI, D), "shell");
});
t("A3 셸 밖(단독 터미널 창) = 새 창 — 바꿀 부모 해시가 없다(앱이어도)", () => {
  assert.equal(linkOpenTarget(UI, { ...D, framed: false }), "tab");
});
t("A4 그리드 터미널(terminal-grid.html)도 같은 /ui/ 로 본다", () => {
  assert.equal(linkOpenTarget("https://gw.test/ui/#/projects/12", { ...D, href: "https://gw.test/ui/terminal-grid.html" }), "shell");
});
t("A5~A7 해시 없는 /ui/ · 같은 출처 다른 경로 · 다른 게이트웨이의 /ui/ = 새 창", () => {
  assert.equal(linkOpenTarget("https://gw.test/ui/", D), "tab");
  assert.equal(linkOpenTarget("https://gw.test/api/ui/me", D), "tab");
  assert.equal(linkOpenTarget("https://other.test/ui/#/x", D), "tab");
});
t("A8 미리보기는 셸 안이면 곁칸 — 브라우저·앱 모두(원준 2026-08-21, 종전 유지)", () => {
  assert.equal(linkOpenTarget("https://gw.test/preview/p1/ui/#/k/x", B), "pane");
  assert.equal(linkOpenTarget("https://gw.test/preview/p1/ui/#/k/x", D), "pane");
});
t("A9 아티팩트는 셸 안이면 곁칸으로 넘긴다(브라우저에서 칸에 넣을지는 부모가 CSP 로 정한다)", () => {
  assert.equal(linkOpenTarget("https://claude.ai/code/artifact/abc", B), "pane");
});
t("A10·A11 셸 밖 미리보기 · 아티팩트 아닌 claude.ai = 새 창", () => {
  assert.equal(linkOpenTarget("https://gw.test/preview/p1/ui/", { ...B, framed: false }), "tab");
  assert.equal(linkOpenTarget("https://claude.ai/new", B), "tab");
});
t("A12 파싱 불가 주소 = throw 없이 새 창(종전 catch 폴백과 같은 결과)", () => {
  assert.equal(linkOpenTarget("http://[", B), "tab");
});

// ── #4083 B. 우클릭 [복사]가 무엇을 잡나(ctxCopyPlan) — 원준님 «드래그 안 해 놓은 링크는 복사 대상으로 안 잡힌다» ──
const L = "https://gw.test/ui/#/projects/4083";
t("B1 ★ 선택 없음 + 링크 위 = [복사]가 그 링크를 잡는다 · 같은 걸 두 줄로 안 준다 · [링크 열기]=그 링크", () => {
  assert.deepEqual(ctxCopyPlan("", false, L), { copy: "link", linkRow: false, openUrl: L });
});
t("B2 웹 선택 + 링크 위 = 선택이 우선(#3778) · 링크는 [링크 복사] 줄로", () => {
  assert.deepEqual(ctxCopyPlan("여러 줄\n드래그", false, L), { copy: "sel", linkRow: true, openUrl: L });
});
t("B3 앱(Claude) 선택 + 링크 위 = 앱 선택 복사(^C 브리지) · 링크는 따로", () => {
  assert.deepEqual(ctxCopyPlan("", true, L), { copy: "app", linkRow: true, openUrl: L });
});
t("B4 아무것도 없음 = [복사] 꺼짐, 링크 줄 없음", () => {
  assert.deepEqual(ctxCopyPlan("", false, ""), { copy: null, linkRow: false, openUrl: "" });
});
t("B5·B6 URL 하나인 선택이면 [링크 열기]가 그 URL · 아니면 없음(종전 «선택한 주소 열기»)", () => {
  assert.deepEqual(ctxCopyPlan("  https://a.io/x  ", false, ""), { copy: "sel", linkRow: false, openUrl: "https://a.io/x" });
  assert.deepEqual(ctxCopyPlan("see https://a.io/x", false, ""), { copy: "sel", linkRow: false, openUrl: "" });
});
t("B7 URL 선택 + 다른 링크 위 = [링크 열기]는 커서 밑 링크(방금 가리킨 것)", () => {
  assert.equal(ctxCopyPlan("https://a.io/x", false, L).openUrl, L);
});
t("B8 공백만 선택 = 종전처럼 선택으로 본다(링크 없음)", () => {
  assert.deepEqual(ctxCopyPlan("   ", false, ""), { copy: "sel", linkRow: false, openUrl: "" });
});

// ── #4083 C. 메뉴 힌트 주소(shortLink) — 메뉴 폭(320px) 안에서 이름을 밀어내지 않게 ──
t("C1~C4 스킴 떼기 · 26자 경계 · 넘으면 25자+… · 빈 값", () => {
  assert.equal(shortLink("https://a.io/x"), "a.io/x");
  const exact = "a".repeat(26);
  assert.equal(shortLink("http://" + exact), exact, "정확히 26자는 자르지 않는다");
  const long = shortLink("https://" + "b".repeat(27));
  assert.equal(long, "b".repeat(25) + "…");
  assert.equal(shortLink(""), "");
});

// ── #4083 D. 여러 줄로 쪼개진 링크(urlAtCell) — 원준님 «화면이 작아서 두세 줄로 보이면 복사·클릭이 문제» ──
//  Claude Code 2.1.277 은 Ink 의 wrap-ansi `{trim:false, hard:true}` 로 **제가** 줄을 끊는다(번들 실측) — 폭보다 긴 토큰은
//  폭에서 잘려 다음 행 들여쓰기 뒤로 이어지고 isWrapped 가 아니다. 아래 claudeWrap 이 그 모양을 그대로 만든다.
const claudeWrap = (token, cols, indent = 2, margin = 0) => {
  const w = cols - indent - margin, out = [];
  for (let i = 0; i < token.length; i += w) out.push(" ".repeat(indent) + token.slice(i, i + w));
  return out;
};
const NO = (n) => Array(n).fill(false);
const GOV = "https://lively-46e3.app.lvly.io/ui/#/f?root=shared&path=project%2F4076%2FGovTech_%EA%B0%9C%EB%B0%9C%EB%B3%B4%EA%B3%A0%EC%84%9C_%EA%B2%80%ED%86%A0%ED%8C%901.html";
t("D1 셸 자동 줄바꿈(isWrapped) 2행 — 어느 행을 눌러도 전체 URL(종전 유지)", () => {
  const U = "https://a.io/" + "x".repeat(30);   // 43자, 폭 20 → 20 + 20 + 3
  const rows = [U.slice(0, 20), U.slice(20, 40), U.slice(40)];
  const soft = [false, true, true];
  assert.equal(urlAtCell(rows, soft, 0, 3, 20), U);
  assert.equal(urlAtCell(rows, soft, 2, 1, 20), U);
});
t("D2 ★ Claude 2행(앞 행 폭 꽉 · 뒤 행 들여쓰기 2) — 어느 행을 눌러도 전체 URL", () => {
  const rows = claudeWrap(GOV, 100);   // 158자 → 98 + 60
  assert.equal(rows.length, 2);
  assert.equal(urlAtCell(rows, NO(2), 0, 10, 100), GOV, "첫 행 조각만 열린다");
  assert.equal(urlAtCell(rows, NO(2), 1, 30, 100), GOV, "둘째 행 조각은 스킴이 없어 아예 링크로 안 잡힌다");
});
t("D3 ★ Claude 3행(가운데 행 통째 URL) — 셋째 행을 눌러도 전체 URL", () => {
  const rows = ["", "● 파일은 여기:", ...claudeWrap(GOV, 70), "", "  다음 문단"];
  assert.equal(rows.length, 7);   // 68 + 68 + 22
  assert.equal(urlAtCell(rows, NO(7), 4, 5, 70), GOV);
  assert.equal(urlAtCell(rows, NO(7), 3, 40, 70), GOV);
});
t("D4 괄호로 감싼 (https://…) 가 쪼개져도 괄호 뺀 URL", () => {
  const rows = claudeWrap("(" + GOV + ")", 90);
  assert.equal(urlAtCell(rows, NO(rows.length), rows.length - 1, 3, 90), GOV);
});
t("D5 보통 줄바꿈이 폭을 꽉 채운 행 끝의 짧은 URL — 다음 행 낱말을 붙이지 않는다(토큰이 폭보다 짧다)", () => {
  const head = "  see the doc at ";
  const r0 = head + "x".repeat(80 - head.length - 17) + " https://a.io/abc";
  assert.equal(r0.length, 80);
  const rows = [r0, "  output and more words"];
  assert.equal(urlAtCell(rows, NO(2), 0, 70, 80), "https://a.io/abc");
});
t("D6 앞 행 끝이 산문 낱말(폭 꽉) + 다음 행 맨 앞 bare host — 합치지 않는다", () => {
  const r0 = "  " + "word ".repeat(15) + "visit the site";
  const rows = [r0.slice(0, 80).padEnd(80, "e"), "  lively.io/x for more"];
  assert.equal(rows[0].length, 80);
  assert.equal(urlAtCell(rows, NO(2), 1, 4, 80), "https://lively.io/x");
});
t("D7 다음 행 첫 덩어리가 URL 글자가 아니면(· PDF) 잇지 않는다", () => {
  const rows = [...claudeWrap("https://a.io/" + "p".repeat(65), 80), "  · PDF"];
  assert.equal(rows.length, 2);
  assert.equal(urlAtCell(rows, NO(2), 0, 5, 80), "https://a.io/" + "p".repeat(65));
});
t("D8 들여쓰기 경계 — 8칸이면 잇고 9칸이면 잇지 않는다", () => {
  const T = "https://a.io/" + "q".repeat(150);
  const r8 = claudeWrap(T, 100, 8);
  assert.equal(urlAtCell(r8, NO(r8.length), 1, 20, 100), T);
  const r9 = claudeWrap(T, 100, 9);
  assert.notEqual(urlAtCell(r9, NO(r9.length), 0, 20, 100), T);
});
t("D9 오른쪽 여백 경계 — 폭−1 에서 끝난 행은 잇고, 폭−2 면 잇지 않는다", () => {
  const m1 = claudeWrap(GOV, 100, 2, 1);
  assert.equal(urlAtCell(m1, NO(m1.length), 0, 10, 100), GOV);
  const m2 = claudeWrap(GOV, 100, 2, 2);
  assert.notEqual(urlAtCell(m2, NO(m2.length), 0, 10, 100), GOV);
});
t("D10 ★ 한글 뒤 URL — 칸 index 로 누른 자리가 정확하다(시작·끝 칸 · 바로 밖)", () => {
  const row = "링\0크\0: https://a.io/x";   // '링'·'크' 는 2칸씩 → 'h' 는 6번 칸, 끝 'x' 는 19번 칸
  assert.equal(urlAtCell([row], [false], 0, 6, 80), "https://a.io/x");
  assert.equal(urlAtCell([row], [false], 0, 19, 80), "https://a.io/x");
  assert.equal(urlAtCell([row], [false], 0, 5, 80), null);
  assert.equal(urlAtCell([row], [false], 0, 20, 80), null);
});
t("D11 URL 속 한글(넓은 글자 뒤 칸 '\\0')은 제거되고 한글은 그대로", () => {
  assert.equal(urlAtCell(["https://a.io/한\0글\0"], [false], 0, 5, 80), "https://a.io/한글");
});
t("D12 이어지는 행의 들여쓰기 칸을 누르면 링크가 아니다", () => {
  const rows = claudeWrap(GOV, 100);
  assert.equal(urlAtCell(rows, NO(2), 1, 0, 100), null);
  assert.equal(urlAtCell(rows, NO(2), 1, 1, 100), null);
});
t("D13 빈 입력·범위 밖 행·창 첫 행이 soft — null 이고 throw 없음", () => {
  assert.equal(urlAtCell([], [], 0, 0, 80), null);
  assert.equal(urlAtCell(["https://a.io/x"], [false], 5, 0, 80), null);
  assert.equal(urlAtCell(["https://a.io/x"], [true], 0, 3, 80), "https://a.io/x");
});
t("D14 cellRow — 넓은 글자 뒤 칸 '\\0' · 빈 칸 ' ' · 여러 코드 단위 글자 '\\u0001' · 끝 공백 제거 · 폭에서 멈춤", () => {
  const cells = [["링", 2], ["", 0], ["a", 1], ["", 1], ["😀", 2], ["", 0], ["b", 1], [" ", 1], ["", 1], ["z", 1]];
  const line = { getCell: (x) => (x < cells.length ? { getChars: () => cells[x][0], getWidth: () => cells[x][1] } : undefined) };
  assert.equal(cellRow(line, 9), "링\0a \u0001\0b");
  assert.equal(cellRow(line, 99), "링\0a \u0001\0b  z");
});

// ── #4083 배선 — 위 판정들이 실제 경로에 물려 있나(관측 장치가 죽어 있으면 위 표는 통과하면서 아무것도 못 본다) ──
t("W3 클릭 열기와 우클릭이 **같은** 커서 밑 링크 판정(linkAtPoint)을 쓴다", () => {
  assert.match(src, /const linkAtEvent = \(ev: MouseEvent\): string \| null => linkAtPoint\(host, ev\.clientX, ev\.clientY\);/);
  assert.match(src, /const link = linkAtPoint\(host, e\.clientX, e\.clientY\) \|\| '';\s*const plan = ctxCopyPlan\(sel, appSel, link\);/);
});
t("W4 [복사]·[링크 복사]·[링크 열기] 가 plan 을 따른다 — 링크 복사는 제스처 안 동기 복사, 열기는 같은 열기 규칙", () => {
  assert.match(src, /else if \(plan\.copy === 'link'\) copyText\(link, false, true\);/);
  assert.match(src, /\.\.\.\(plan\.linkRow \? \[\{ label: '링크 복사', hint: shortLink\(link\), run: \(\) => copyText\(link, false, true\) \}\] : \[\]\)/);
  assert.match(src, /\.\.\.\(url \? \[\{ label: '링크 열기', hint: openHint, run: \(\) => openLinkFromTerminal\(url\) \}\] : \[\]\)/);
});
t("W5 여는 곳은 한 판정 — 열기(openLinkFromTerminal)가 linkOpenTarget 을 탄다 · 앱 판정은 부모 프레임의 다리까지 본다", () => {
  assert.match(src, /const where = linkTargetHere\(uri\);/);
  assert.match(src, /return linkOpenTarget\(uri, \{ href: location\.href, framed: window\.parent !== window, desktop: inDesktopApp\(\) \}\);/);
  assert.match(src, /for \(const w of \[window, window\.parent, window\.top\]\)/, "preload 는 최상위 프레임에만 돈다 — 셸 iframe 안 터미널엔 다리가 없다");
});

console.log(`\n${pass} passed`);
