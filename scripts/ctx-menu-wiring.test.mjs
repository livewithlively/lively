// #3784 — 우클릭 메뉴 배선 테스트. 「어느 화면에 표(data-ctx)가 있고, 그 표를 받는 제공자가 있나」를 소스에서 못 박는다.
//  왜 소스 텍스트인가: 이 기능은 값이 아니라 **배선**이다 — 표는 달았는데 제공자가 없으면 우클릭해도 브라우저 메뉴만
//  뜨고, 콘솔에 아무것도 안 남는다(조용한 실패). 화면을 눌러 보지 않으면 리뷰로도 안 잡힌다.
//  엔진 자체(showCtxMenu)는 DOM 이 필요해 여기서 돌리지 않는다 — tidyRows 만 순수 로직이라 문자열로 확인한다.
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// ── 모든 web/**/*.ts 를 모은다 ──
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) { if (f !== "standalone") walk(p, out); }
    else if (p.endsWith(".ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const files = walk(join(root, "web"));
const ALL = files.map((p) => [p.slice(root.length + 1), readFileSync(p, "utf8")]);
const src = Object.fromEntries(ALL);

// E1. 표(data-ctx)로 쓰인 종류 전부에 제공자(registerCtx)가 있다 — 빠진 표는 조용히 죽는 우클릭이다.
const kinds = new Set();
for (const [, s] of ALL) {
  for (const m of s.matchAll(/'data-ctx':\s*'([a-z-]+)'/g)) kinds.add(m[1]);
  for (const m of s.matchAll(/dataset\.ctx\s*=\s*'([a-z-]+)'/g)) kinds.add(m[1]);
  for (const m of s.matchAll(/'data-ctx':\s*isFolder \? '([a-z-]+)' : '([a-z-]+)'/g)) { kinds.add(m[1]); kinds.add(m[2]); }
}
ok(kinds.size >= 12, `E1a 표 종류 ${kinds.size}종(세션·프로젝트·앱·알림·위키·보드…)`);
const registered = new Set();
for (const [, s] of ALL) for (const m of s.matchAll(/registerCtx\('([a-z-]+)'/g)) registered.add(m[1]);
for (const k of kinds) ok(registered.has(k), `E1b data-ctx="${k}" 를 받는 registerCtx 가 있다`);

// E2. 여섯 화면 전부에 표가 달렸다.
ok(/'data-ctx-surface':\s*'home'/.test(src["web/v2/views.ts"]), "E2 홈 — 표면");
ok(/'data-ctx':\s*'app'/.test(src["web/v2/views.ts"]), "E2 홈 — 최근 앱 타일");
ok(/'data-ctx-surface':\s*'inbox'/.test(src["web/v2/views.ts"]) && /'data-ctx':\s*'session'/.test(src["web/v2/views.ts"]), "E2 확인할 것 — 표면 + 세션 행");
ok(/'data-ctx':\s*'noti'/.test(src["web/v2/notifications.ts"]), "E2 확인할 것 — 알림 행");
ok(/'data-ctx':\s*'session'/.test(src["web/session-chat.ts"]) && /head\.dataset\.sid = t\.id/.test(src["web/session-chat.ts"]), "E2 AI 세션 — 머리줄(대상이 바뀌면 sid 도 바뀐다)");
ok(/door\.dataset\.ctx = 'project'/.test(src["web/v2/panes.ts"]) && /bindCtxSurface\(wrap/.test(src["web/v2/panes.ts"]), "E2 프로젝트 — 문패 + 곁칸 표면");
ok(/'data-ctx':\s*'project'/.test(src["web/v2/side.ts"]) === false && /row\.dataset\.ctx = 'project'/.test(src["web/v2/side.ts"]), "E2 사이드바 — 프로젝트 행(인라인 메뉴는 걷었다)");
ok(/'data-ctx':\s*'session'/.test(src["web/v2/side.ts"]) && /'data-ctx':\s*'inst'/.test(src["web/v2/side.ts"]), "E2 사이드바 — 세션 행 + 열린 앱 행");
ok(/'data-ctx':\s*'wikicat'/.test(src["web/v2/side.ts"]), "E2 위키 — 사이드바 분류");
ok(/'data-ctx':\s*'wikidoc'/.test(src["web/wiki-side.ts"]) && /'wikidoc'/.test(src["web/wiki-table.ts"]) && /'data-ctx':\s*'wikipage'/.test(src["web/wiki-doc.ts"]), "E2 위키 — 트리 행·표 행·문서 본문");
ok(/'data-ctx':\s*'pboard'/.test(src["web/projects/rows.ts"]) && /'data-ctx':\s*'ptask'/.test(src["web/projects/rows.ts"]), "E2 프로젝트 보드 — 프로젝트 행·작업 행");
ok(/bindCtx\(para/.test(src["web/liv.ts"]) && /bindCtxSurface\(wrapEl/.test(src["web/liv.ts"]), "E2 리브 — 제안 문단 + 표면");
ok(/bindCtx\(box/.test(src["web/chat-view.ts"]) && /bindCtx\(ask/.test(src["web/chat-view.ts"]), "E2 대화창 — AI 의 답 + 내 말");

// E3. 곁칸 부품 — 지식·할 일·보관·미리보기·앱·웹·뷰어.
const P = src["web/v2/panes-parts.ts"];
ok((P.match(/bindCtx\(/g) || []).length >= 6, "E3 곁칸 부품 bindCtx 6곳 이상(지식·할 일·미리보기·앱·웹·뷰어)");
ok(/'pn-arow'[^\n]*'data-ctx':\s*'session'/.test(P), "E3 보관한 세션 행 = 세션 표");

// E4. 배선은 bubble 단계 — 제 메뉴를 가진 자리(자료 칸·레일 독·곁칸 탭)가 먼저 받고 preventDefault 하면 비켜 준다.
const R = src["web/v2/ctx-registry.ts"];
ok(/root\.addEventListener\('contextmenu', onCtx\);/.test(R), "E4a contextmenu 는 bubble(capture 아님)");
ok(/if \(e\.defaultPrevented \|\| e\.shiftKey\) return;/.test(R), "E4b 이미 처리된 이벤트·⇧우클릭은 비켜 준다");
ok(/EDIT_SEL/.test(R) && /input, textarea/.test(R), "E4c 글 치는 칸은 브라우저 메뉴");
ok(/if \(!got\) return;/.test(R), "E4d 할 말이 없으면 preventDefault 하지 않는다(브라우저 메뉴)");

// E5. 종전 호출자(자료 칸·레일·곁칸 탭)는 손대지 않고 엔진만 바뀌었다.
ok(/export function ctxMenu\(x: number, y: number, rows: CtxRow\[\], opts\?: CtxOpts\): void \{\s*showCtxMenu\(x, y, rows, opts\);/.test(src["web/v2/panes-kit.ts"]), "E5a panes-kit.ctxMenu → showCtxMenu 위임");
ok(/ctxMenu\(e\.clientX, e\.clientY, rows\)/.test(src["web/v2/panes-files.ts"]), "E5b 자료 칸 우클릭 그대로");
ok(/dockMenu\(e\.clientX, e\.clientY/.test(src["web/v2/rail.ts"]), "E5c 레일 독 우클릭 그대로");

// E6. 셸 부팅·클래식 부팅 둘 다 배선을 건다(액자 안은 다른 문서다).
ok(/mountCtxMenus\(root, \{ longPress: true, menuKey: true \}\)/.test(src["web/v2/main.ts"]) && /mountCtxShell\(\{/.test(src["web/v2/main.ts"]), "E6a 셸 부팅");
ok(/mountClassicCtx\(\);/.test(src["web/main.ts"]) && /mountCtxMenus\(document\.body/.test(src["web/classic-ctx.ts"]), "E6b 클래식 부팅");
ok(/'lively:open-route'/.test(src["web/v2/main.ts"]) && /'lively:open-route'/.test(src["web/v2/ctx-registry.ts"]), "E6c 액자 → 셸 「새 탭에서 열기」 통로");

// E7. 스타일 — 새 시트가 index.html 에 걸렸고, #v2-root 밖(body)에 뜨는 아이콘의 획 규칙이 있다(#2016 §8 함정).
const HTML = read("public/index.html");
ok(HTML.includes('styles/49-v2-ctx.css'), "E7a 49-v2-ctx.css 링크");
ok(/\.pn-ctx-svg \{[^}]*fill: none;[^}]*stroke: currentColor/.test(read("public/styles/49-v2-ctx.css")), "E7b body 밑 아이콘 획 규칙");

// E8. 공통 행의 중복 제거 — 세션 행은 링크이기도 해서 「새 탭에서 열기」가 두 번 서지 않게 이름으로 거른다.
ok(/const seen = new Set<string>\(\);/.test(R) && /const fresh = add\.filter\(\(r\) => r\.sep \|\| !seen\.has\(r\.label\)\)/.test(R) && /if \(item\) put\(item\.rows\);\s*if \(surface\) put\(surface\.rows\);/.test(R), "E8 세 겹(항목·표면·공통) 이름 중복 제거 — 앞 겹이 이긴다");
ok(/const sidFromId = id\.startsWith\('sess:'\) \? id\.slice\(5\) : '';/.test(src["web/v2/ctx-shell.ts"]), "E8b 열린 앱 행 — 'sess:' id 로 세션 메뉴를 붙인다(route 는 홈 목록만 채운다)");

// E9. 엔진 — 구분선 정리(앞·뒤·연속) 규칙이 tidyRows 에 있다.
const M = src["web/v2/ctx-menu.ts"];
ok(/export function tidyRows/.test(M) && /while \(out\.length && out\[out\.length - 1\]\.sep\) out\.pop\(\);/.test(M), "E9 tidyRows 구분선 정리");
ok(/case 'ArrowDown'/.test(M) && /case 'ArrowRight'/.test(M) && /case 'Escape'|e\.key === 'Escape'/.test(M), "E9 키보드(↑↓ → Esc)");

// E10. 터미널(별 문서) — 셸 배선이 못 오는 iframe 안에 같은 문법의 메뉴. 복사는 Cmd+C 와 같은 길(선택→copyText / 앱 드래그 선택→^C 브리지 1회).
const T = read("web/standalone/terminal.ts");
ok(/wireTermCtxMenu\(host\);/.test(T) && /function wireTermCtxMenu\(host: HTMLElement\)/.test(T), "E10a 터미널 우클릭 배선");
ok(/if \(e\.shiftKey \|\| IS_MOBILE\) return;/.test(T), "E10b ⇧우클릭·모바일은 브라우저 메뉴");
ok(/if \(sel\) \{ copyText\(sel, false, true\); return; \}\s*if \(appSel\) \{ clearAppSelect\(\); armClipboardPromise\(\); sendInput\('\\x03'\); armBridgeMissHint\(\); \}/.test(T), "E10c 복사 = Cmd+C 와 같은 길(앱 선택 없으면 ^C 안 보냄) — 판정은 메뉴를 띄운 순간의 것");
// 우클릭의 누름·뗌을 xterm 에 안 넘긴다 — 넘기면 앱 선택(appDragSelect)이 «제자리 클릭» 으로 풀리고 셸 화면은 rightClickSelectsWord 로 선택이 갈린다(원준님 실측).
ok(/const eat = \(e: MouseEvent\): void => \{ if \(e\.button === 2 && !e\.shiftKey && !IS_MOBILE\) \{ e\.stopPropagation\(\); e\.preventDefault\(\); \} \};\s*host\.addEventListener\('mousedown', eat, true\);\s*host\.addEventListener\('mouseup', eat, true\);/.test(T), "E10f 우클릭 누름·뗌은 capture 에서 삼킨다(xterm·앱에 안 간다)");
ok(/const appSelSeen = mouseOn && appDragSelect;/.test(T) && !/if \(appDragSelect\) \{ clearAppSelect\(\); armClipboardPromise\(\); sendInput\('\\x03'\); armBridgeMissHint\(\); \}\s*\} \},/.test(T), "E10g [복사] 는 띄운 순간의 appSel 을 쓴다(누를 때 다시 읽지 않는다)");
// 여러 줄 드래그 뒤 단어 위에서 우클릭 → [복사 3자](원준님 실측, #3778): xterm 이 element 의 contextmenu 에서 rightClickSelectsWord 로
//  커서 밑 단어를 선택했고, 우리 bubble 리스너는 그 뒤에 돌아 그 단어를 읽었다. 옵션을 끄고, contextmenu 를 capture 에서 받고,
//  웹 선택·앱 선택이 둘 다 있으면 더 최근 것을 고른다.
ok(/rightClickSelectsWord: false,/.test(T) && !/rightClickSelectsWord: true/.test(T), "E10h xterm 우클릭 단어 선택 끔(메뉴가 우클릭의 주인)");
ok(/\], '터미널'\);\s*\}, true\);/.test(T), "E10i contextmenu 는 capture 에서 받는다(xterm 의 rightClickHandler 보다 먼저)");
ok(/const appSel = appSelSeen && \(!xsel \|\| appSelectAt >= xtermSelAt\);\s*const sel = appSel \? '' : xsel;/.test(T) && /term\.onSelectionChange\(\(\) => \{ xtermSelAt = Date\.now\(\); \}\)/.test(T), "E10j 웹 선택·앱 선택이 둘 다면 더 최근 것을 복사한다");
ok(/off: !canCopy/.test(T), "E10d 선택이 없으면 복사 행이 꺼진다");
ok(read("public/terminal.html").includes(".tctx {") && read("scripts/build-standalone.mjs").includes('"ctx-lite.ts"'), "E10e 터미널 메뉴 CSS + 번들 스탬프 입력");
console.log(`\n${pass} passed`);
