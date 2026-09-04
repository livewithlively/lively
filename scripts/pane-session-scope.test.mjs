// #1819 — "곁칸에서 한 조작은 그 세션 밖으로 새지 않는다" + "끼워 넣은 판은 기억하지도 기억되지도 않는다".
//  사양·엣지 표(E1~E22)는 스크래치패드 spec.md — 아래 이름의 번호가 그 행이다(행 하나도 안 빠지게).
//
// ⚠ 왜 소스 텍스트까지 보나: 이 규칙은 **값 쪽엔 이미 제대로 있었다**(주소는 세션마다 따로 저장). 그런데도
//  기능은 샜다 — 알리는 통로가 `document` 였기 때문이다. 세션 탭마다 곁칸이 한 벌씩 살아 있으므로 문서에
//  뿌린 신호는 전부가 받는다. 실측(2026-08-21 dev): 미리보기로 주소를 **한 번** 열었더니 두 세션 탭의 웹 칸이
//  같이 갈아입고 저장값에 `{ "box-yoon-ac089022": …, "box-yoon-467c134d": … }` 로 두 열쇠가 다 물들었다.
//  저장 코드는 멀쩡했으니 값만 보는 테스트로는 영영 안 잡힌다. 그래서 '누가 어디에 대고 알리는가'를 못 박는다.
//  (같은 규율: scripts/session-open-restore.test.mjs · desktop/main/browser-surface.test.mjs)
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

const { normWebUrl } = await import(join(root, "public/app/v2/web-url.js"));
const { isEmbedded, EMBEDDED } = await import(join(root, "public/app/v2/embed.js"));

const PARTS = read("web/v2/panes-parts.ts");
const PANES = read("web/v2/panes.ts");
const TABS = read("web/v2/tabs.ts");
const FILES = read("web/v2/panes-files.ts");   // 자료 칸 — 파일을 누르면 여기서 뷰어를 부른다
//  신호를 **쏘는 자리**는 panes-kit 의 openInViewerPart 하나다(#762) — 자료 칸도 우클릭 메뉴도 그 통로만 쓴다.
//  잎 모듈에 둔 이유: panes-parts 가 panes-files 를 값으로 가져오므로 그 반대 방향은 순환이 된다.
const KIT = read("web/v2/panes-kit.ts");

/** 함수 하나만 잘라 본다 — 고정 길이로 자르면 그 함수가 자랐을 때 단언이 구간 밖으로 밀려 거짓 실패한다. */
function slice(src, from, to) {
  const a = src.indexOf(from);
  assert.ok(a >= 0, `구간 시작을 못 찾았다: ${from}`);
  const b = src.indexOf(to, a + 1);
  assert.ok(b > a, `구간 끝을 못 찾았다: ${to}`);
  return src.slice(a, b);
}
// ⚠ 끝 앵커는 **웹 칸 다음 함수**다 — stage 에서 editorPart 가 viewerPart 로 바뀌어 한 번 거짓 실패했다(2026-08-21).
const WEB_PART = () => slice(PARTS, "function webPart(", "\nfunction viewerPart(");
const VIEWER_PART = () => slice(PARTS, "function viewerPart(", "\nfunction appsPart(");

// ══ 주소 만들기 — 실제로 불러서 본다(순수 모듈이라 그대로 검증된다) ═══════════════════
const LIVE = "https://dev.lvly.io";

ok(normWebUrl(`${LIVE}/preview/x-1841/ui/`, LIVE) === `${LIVE}/preview/x-1841/ui/?embed=1`,
  "E9 우리 화면을 칸에 실으면 끼워 넣은 판 표가 붙는다 — 없으면 안쪽이 바깥 화면을 복제한다");

ok(normWebUrl(`${LIVE}/ui/?embed=0`, LIVE) === `${LIVE}/ui/?embed=0`,
  "E10 이미 표가 있으면 그 뜻을 뺏지 않는다(덮어쓰기 금지)");

ok(normWebUrl("https://docs.example.com/a?b=1", LIVE) === "https://docs.example.com/a?b=1",
  "E11 남의 화면은 한 글자도 안 건드린다");

ok(normWebUrl("빈 화면 고치는 법", LIVE) === "https://www.google.com/search?q=" + encodeURIComponent("빈 화면 고치는 법"),
  "E12 주소가 아니면 검색으로 — 막다른 입력칸을 만들지 않는다");

ok(normWebUrl("docs.google.com/x", LIVE) === "https://docs.google.com/x",
  "E13 스킴이 없으면 붙인다");

{
  // E14 파싱이 안 되는 글자 — 예외로 칸을 죽이지 않고 있는 그대로 싣는다.
  const weird = "https://[not a url";
  let out, threw = false;
  try { out = normWebUrl(weird, LIVE); } catch (_) { threw = true; }
  ok(!threw && out === weird, "E14 파싱이 안 되면 그대로 싣는다(예외로 칸이 죽지 않는다)");
  ok(normWebUrl("", LIVE) === "" && normWebUrl("   ", LIVE) === "", "E14 빈 글자는 아무 데도 안 간다");
}

ok(isEmbedded("") === false && isEmbedded("?a=1") === false,
  "E15 표가 없으면 끼워 넣은 판이 아니다 — 기본값은 '평소대로 기억한다'");
ok(EMBEDDED === false,
  "E15 표를 읽을 수 없는 판(브라우저 밖)에서도 조용히 '아니다'로 — 예외로 앱이 죽지 않는다");

ok(isEmbedded("?embed=1") === true && isEmbedded("?x=2&embed=1") === true,
  "E16 표가 있으면 끼워 넣은 판이다");

ok(isEmbedded("?embed=0") === false && isEmbedded("?embed=x") === false && isEmbedded("?embed") === false,
  "E17 표는 정확히 1 일 때만 — 값이 있다는 이유로 끼워 넣은 판이 되면 안 된다");

// ══ 신호가 도는 울타리 — 곁칸 한 벌 안 ═══════════════════════════════════════════
{
  const send = slice(PARTS, "export function openInWebPart(", "\nfunction webPart(");
  ok(/ctx\.paneRoot\(\)\.dispatchEvent\(/.test(send),
    "E1 밖에서 웹 칸을 부르는 통로가 **이 곁칸**에 대고 알린다");
  ok(!/document\.dispatchEvent\(/.test(send),
    "E1 ★ document 로 뿌리면 열려 있는 모든 세션 탭의 웹 칸이 같이 갈아입는다 — 실제로 그렇게 샜다");

  const web = WEB_PART();
  ok(/paneRoot\(\)[\s\S]{0,200}addEventListener\(WEB_OPEN_EVT/.test(web),
    "E2 웹 칸이 이 곁칸에서 듣는다");
  ok(!/document\.addEventListener\(WEB_OPEN_EVT/.test(web),
    "E2 ★ document 에서 들으면 남의 탭이 연 주소까지 받는다");
  ok(/removeEventListener\(WEB_OPEN_EVT/.test(web) && !/document\.removeEventListener\(WEB_OPEN_EVT/.test(web),
    "E3 달았던 그 자리에서 끊는다 — 엉뚱한 데서 끊으면 죽은 칸이 계속 신호를 받는다");
}

{
  ok(/wrap\.addEventListener\('pn:open-web'/.test(PANES),
    "E4 셸도 이 곁칸에서 듣는다");
  ok(!/document\.addEventListener\('pn:open-web'/.test(PANES),
    "E4 ★ document 면 미리보기 한 번에 모든 세션 탭에 웹 칸이 켜진다");
  ok(/wrap\.removeEventListener\('pn:open-web'/.test(PANES),
    "E5 떠날 때 같은 자리에서 끊는다");
}

// ══ 터미널이 넘겨 오는 링크 — 내 탭의 프레임에서 온 것만 ══════════════════════════
{
  const msg = slice(PANES, "const onMsg = (e: MessageEvent)", "window.addEventListener('message', onMsg)");
  ok(/ownsFrame\(e\.source\)/.test(msg), "E6 보낸 프레임이 내 탭 안의 것인지 가린다");
  ok(msg.indexOf("ownsFrame(e.source)") < msg.indexOf("openInWebPart("),
    "E7 ★ 소유 확인이 여는 것보다 **앞**이다 — 뒤면 이미 다 열린 뒤라 가린 의미가 없다");
  const owns = slice(PANES, "const ownsFrame = (", "const onMsg = (e: MessageEvent)");
  ok(/v2-tabpane/.test(owns), "E6 소유는 그 곁칸이 사는 탭을 기준으로 가린다");
  ok(/if \(!scope\) return true;/.test(owns),
    "E8 탭이 없는 단독 판에서는 종전대로 받는다 — 가릴 것이 없는 판에서 기능을 죽이지 않는다");
}

// ══ 끼워 넣은 판은 기억되지 않는다 — 네 저장처 모두 ════════════════════════════════
{
  const save = slice(TABS, "function save(): void {", "function activate(");
  ok(/if \(EMBEDDED\) return;/.test(save), "E18 탭을 저장하지 않는다 — 바깥 사람의 탭 목록을 덮어쓴다");
  ok(/EMBEDDED \? null :/.test(TABS), "E19 탭을 복원하지 않는다 — 보려던 화면 대신 바깥 화면이 뜬다");

  const lay = slice(PANES, "function saveLayout(): void {", "\n  function");
  ok(/if \(EMBEDDED\) return;/.test(lay), "E20 배치를 저장하지 않는다");

  ok(/if \(EMBEDDED\) return;/.test(WEB_PART()), "E21 웹 칸 주소를 저장하지 않는다");

  const viewer = slice(PARTS, "const remember = (p2: string)", "const remembered = (");
  ok(/if \(EMBEDDED\) return;/.test(viewer), "E22 뷰어가 펴 둔 파일을 기억하지 않는다");
}


// ══ 뷰어 칸도 같은 규율 — 자료에서 [뷰어에서 보기] 는 **그 곁칸**의 뷰어만 연다 (2026-08-21 추가) ══════
//  웹 칸과 판박이 구조였고, 판박이로 새고 있었다: window 로 쏘고 window 에서 들어서 열려 있는 모든 세션 탭의
//  뷰어가 같은 파일을 함께 열고 각자 자기 열쇠에 그 파일을 기억했다.
{
  ok(/ctx\.paneRoot\(\)\.dispatchEvent\(new CustomEvent\(VIEWER_EVT/.test(KIT),
    "E23 뷰어를 부르는 통로(openInViewerPart)가 **이 곁칸**에 대고 알린다");
  ok(!/window\.dispatchEvent\(new CustomEvent\(VIEWER_EVT/.test(KIT) && !/window\.dispatchEvent\(new CustomEvent\('pn-viewer-open'/.test(KIT + FILES),
    "E23 ★ window 로 쏘면 모든 세션 탭의 뷰어가 같은 파일을 연다 — 웹 칸과 같은 뿌리");
  ok(/openInViewerPart\(ctx, f\.path\)/.test(FILES) && !/dispatchEvent\(new CustomEvent\('pn-viewer-open'/.test(FILES),
    "E24 자료 칸은 그 통로만 쓴다 — 사본을 두면 한쪽만 고쳐져 규율이 갈라진다");
  ok(/localStorage\.setItem\(ED_PATH_KEY/.test(KIT) && /if \(!EMBEDDED\)/.test(KIT),
    "E24 ★ 펴 둔 파일은 이 세션 열쇠에만 적는다(끼워 넣은 판에서는 아예 안 적는다 — 바깥 사람 것을 덮는다)");

  const viewer = VIEWER_PART();
  ok(/paneRoot\(\)[\s\S]{0,120}addEventListener\(VIEWER_EVT/.test(viewer) && !/window\.addEventListener\(VIEWER_EVT/.test(viewer),
    "E25 뷰어 칸이 이 곁칸에서 듣는다");
  ok(/paneRoot\(\)\.removeEventListener\(VIEWER_EVT/.test(viewer) && !/window\.removeEventListener\(VIEWER_EVT/.test(viewer),
    "E25 달았던 그 자리에서 끊는다");
}


// ══ 웹 칸 무대 — 프레임에 크기를 주는가 (2026-08-23 회귀) ═══════════════════════════
//  iframe·webview 는 대체 요소라 크기를 안 주면 300×150px 로 앉는다. position:absolute 로 바꾸는 순간
//  flex 가 손을 떼므로 이 규칙이 유일한 크기 근거다 — 앱(webview)은 인라인 style 을 쓰지 않아 여기에만 걸린다.
{
  const CSS = read("public/styles/42-v2-panes.css");
  const rule = (CSS.match(/\.pn-webstage > \.pn-webframe \{[^}]*\}/) || [""])[0];
  ok(/width:\s*100%/.test(rule) && /height:\s*100%/.test(rule),
    "E26 무대 안 프레임은 폭·높이를 갖는다 — 없으면 칸이 아무리 커도 페이지가 150px 만 그려진다");
}

console.log(`\n# ${pass} passed`);
