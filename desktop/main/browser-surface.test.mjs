// 브라우저 서피스 (#1829 · browser-surface.mjs) — 판정 + **배선**.
//  실행: node desktop/main/browser-surface.test.mjs (러너가 desktop/**/*.test.mjs 를 자동 수집한다)
//
// 사양·엣지 표는 스크래치패드 spec.md — 이름의 A1·B4… 는 그 표의 행 번호다(행 하나도 안 빠지게).
//
// ⚠ 왜 배선까지 보나: 이 기능의 위험은 판정이 아니라 **순서와 강제**에 있고, 둘 다 순수 함수로는 안 잡힌다.
//   · webview 분기가 웹 UI 규칙보다 **뒤에** 오면 서피스가 첫 이동에서 통째로 시스템 브라우저로 튄다(기능 사망).
//   · will-attach-webview 가 없으면 `webviewTag: true` 한 줄이 XSS→RCE 승격 통로가 된다(보안 사고).
//  main.mjs 를 읽어서 잡는다 — desktop-core.test.mjs H3 과 같은 규율.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BROWSER_SURFACE_VERSION, BROWSER_SURFACE_PARTITION, WEBVIEW_FORCED_PREFS, WEBVIEW_DROPPED_PREFS, OCCLUDED_WINDOW_SWITCH,
  DRM_HANDOFF_HOSTS, hostMatches, surfaceNavTarget, cleanUserAgent, webviewAttachDecision,
  SURFACE_ALLOWED_PERMISSIONS, surfacePermissionAllowed,
  SURFACE_POPUP_LIMIT, SURFACE_POPUP_MIN_SIZE, SURFACE_OPEN_MIN_GAP_MS, SURFACE_OPEN_PER_MINUTE,
  surfaceWindowOpenTarget, surfacePopupWindowSpec, surfacePopupWebPreferences, surfaceOpenGate, surfacePopupTitle,
} from "./browser-surface.mjs";

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };
const MAIN = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
const PRELOAD = readFileSync(fileURLToPath(new URL("../preload/web.cjs", import.meta.url)), "utf8");
const WEBSURF = readFileSync(fileURLToPath(new URL("../../web/v2/browser-surface.ts", import.meta.url)), "utf8");

// ── A. 이동 판정 — 여긴 남의 사이트를 **보는 게 목적**이다(웹 UI 규칙과 정반대) ──────────────────
t("A1·A2·A3 임의 http(s) 는 allow — 그게 이 기능의 존재 이유다(유튜브 포함)", () => {
  assert.equal(surfaceNavTarget("https://github.com/"), "allow");            // A1 XFO deny 사이트
  assert.equal(surfaceNavTarget("http://localhost:3000/"), "allow");          // A2 사내·로컬
  assert.equal(surfaceNavTarget("https://www.youtube.com/watch?v=x"), "allow"); // A3
  // ★ 유튜브를 DRM 목록에 넣으면 멀쩡히 재생되는 걸 밖으로 쫓아낸다(실측: EME 미사용, readyState 4 로 재생).
  assert.ok(!hostMatches("www.youtube.com", DRM_HANDOFF_HOSTS), "유튜브가 DRM 핸드오프 목록에 있다");
});

t("A4·A5 Widevine 유료 스트리밍은 밖으로 — 안에서 열면 검은 화면만 보고 이유를 모른다", () => {
  assert.equal(surfaceNavTarget("https://www.netflix.com/kr/"), "external");  // A4
  assert.equal(surfaceNavTarget("https://open.spotify.com/"), "external");    // A5
  assert.equal(surfaceNavTarget("https://www.wavve.com/"), "external");
  assert.ok(DRM_HANDOFF_HOSTS.includes("netflix.com"), "목록의 근거 = 앱에 CDM 이 없다는 실측");
});

t("A6·A7·A8 스킴 — mailto/tel 은 OS 로, 그 외 비 http(s)·부재는 거부", () => {
  assert.equal(surfaceNavTarget("mailto:a@b.c"), "external");                 // A6
  assert.equal(surfaceNavTarget("tel:+8210"), "external");                    // A6
  for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "about:blank", "chrome://settings"])
    assert.equal(surfaceNavTarget(bad), "deny", String(bad));                 // A7
  for (const none of ["", null, undefined])
    assert.equal(surfaceNavTarget(none), "deny", String(none));               // A8 부재
});

// ── B. 호스트 경계 — 단순 접미 비교면 남의 도메인이 걸린다 ─────────────────────────────────
t("B1~B7 호스트 매칭이 **도메인 경계**를 지킨다", () => {
  assert.equal(hostMatches("netflix.com", ["netflix.com"]), true);             // B1
  assert.equal(hostMatches("www.netflix.com", ["netflix.com"]), true);         // B2
  assert.equal(hostMatches("netflix.com.", ["netflix.com"]), true);            // B3 루트 표기
  assert.equal(hostMatches("NETFLIX.com", ["netflix.com"]), true, "대소문자를 안 내린다");
  assert.equal(hostMatches("notnetflix.com", ["netflix.com"]), false);         // B4 ★ 접미 오탐
  assert.equal(hostMatches("netflix.com.evil.kr", ["netflix.com"]), false);    // B5 ★ 접두 오탐
  assert.equal(hostMatches("", ["netflix.com"]), false);                       // B6
  assert.equal(hostMatches("a.com", null), false);                             // B7 부재 인자
  assert.equal(hostMatches(null, ["a.com"]), false);
});

// ── C. UA — 보험이지 지금 고장난 것을 고치는 게 아니다 ────────────────────────────────────
t("C1~C6 UA 는 Electron·앱이름 토큰만 뗀다 — 나머지는 한 글자도 안 건드린다", () => {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Lively/0.1.0 Chrome/150.0.7871.224 Electron/43.4.1 Safari/537.36";
  const out = cleanUserAgent(ua, "Lively");                                    // C1
  assert.equal(out, "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.7871.224 Safari/537.36");
  assert.ok(!/Electron/i.test(out) && !/Lively/i.test(out));
  assert.match(out, /Chrome\/150\.0\.7871\.224/);                              // C2 ★ 과삭제 금지
  assert.match(out, /AppleWebKit\/537\.36 \(KHTML, like Gecko\)/, "괄호 안 토큰까지 건드렸다");
  assert.equal(cleanUserAgent("A/1 Electron/2 B/3", ""), "A/1 B/3");           // C3 ★ 이름 부재
  assert.equal(cleanUserAgent("A/1 Electron/2 B/3", null), "A/1 B/3");         // C4 ★ 이름 부재
  assert.equal(cleanUserAgent("Live/9 Lively/0.1.0 X/1", "Lively"), "Live/9 X/1"); // C5 ★ 이름이 다른 토큰의 접두
  assert.equal(cleanUserAgent("", "Lively"), "");                              // C6
  // C7 ★ 매칭은 **토큰 머리에 고정**돼야 한다. 부분일치면 이름을 품은 남의 토큰까지 지운다 —
  //  UA 는 사이트가 브라우저·OS 를 판정하는 근거라 한 토큰만 잘못 지워도 엉뚱한 페이지가 나간다.
  assert.equal(cleanUserAgent("SuperLively/9 Lively/0.1.0 X/1", "Lively"), "SuperLively/9 X/1");
  assert.equal(cleanUserAgent("MyElectronShell/2 Electron/43.4.1 X/1", ""), "MyElectronShell/2 X/1");
});

// ── D. 부착 판정 ─────────────────────────────────────────────────────────────────────
t("D1~D4 열 수 없는 주소는 **붙이기 전에** 막는다 — 붙은 뒤 막으면 이유 없는 빈 화면이 남는다", () => {
  assert.deepEqual(webviewAttachDecision({ src: "https://github.com/" }), { allow: true, external: false });  // D1
  assert.deepEqual(webviewAttachDecision({ src: "https://netflix.com/" }), { allow: false, external: true }); // D2
  assert.deepEqual(webviewAttachDecision({ src: "javascript:1" }), { allow: false, external: false });        // D3
  for (const p of [{}, { src: "" }, { src: "about:blank" }, null, undefined])                                 // D4 부재
    assert.deepEqual(webviewAttachDecision(p), { allow: true, external: false }, JSON.stringify(p));
});

// ── E. 권한 ─────────────────────────────────────────────────────────────────────────
t("E1·E2 권한은 기본 전부 거부 — 남의 사이트가 카메라·마이크·위치를 조용히 얻으면 안 된다", () => {
  assert.deepEqual([...SURFACE_ALLOWED_PERMISSIONS], [], "허용 목록이 비어 있지 않다 — 넓힌 근거를 확인하라"); // E1
  for (const p of ["media", "geolocation", "notifications", "midi", "clipboard-read", "display-capture", "", null])
    assert.equal(surfacePermissionAllowed(p), false, String(p));               // E2
});

t("E3 강제 설정이 격리를 실제로 닫는다 + 중첩 서피스를 막는다", () => {
  for (const [k, v] of [["nodeIntegration", false], ["nodeIntegrationInSubFrames", false], ["contextIsolation", true],
    ["sandbox", true], ["webSecurity", true], ["allowRunningInsecureContent", false], ["webviewTag", false]])
    assert.equal(WEBVIEW_FORCED_PREFS[k], v, k);
  // ★ 새 창 여부는 페이지(webview 의 allowpopups 속성)가 아니라 메인 처리기가 정한다(#5025). 속성이 없으면 Electron 이
  //  window.open 을 처리기에 넘기기도 전에 null 로 끝낸다 — 구글 팝업 로그인이 «눌러도 반응 없음» 이던 원인.
  assert.equal(WEBVIEW_FORCED_PREFS.disablePopups, false, "★ 새 창이 처리기까지 안 온다 — 팝업 로그인이 반응 없이 죽는다");
  assert.ok(WEBVIEW_DROPPED_PREFS.includes("preload"), "★ preload 를 지우지 않으면 토큰 주입 preload 가 남의 사이트에서 돈다");
  assert.ok(Object.isFrozen(WEBVIEW_FORCED_PREFS), "얼지 않은 정책은 호출부가 조용히 고칠 수 있다");
  assert.match(BROWSER_SURFACE_PARTITION, /^persist:/, "세션이 안 남으면 로그인이 매번 풀린다");
  assert.ok(BROWSER_SURFACE_PARTITION.length > "persist:".length, "빈 파티션은 우리 토큰이 있는 기본 저장소다");
});

// ── F. 배선 — 이 기능의 진짜 위험 ────────────────────────────────────────────────────
t("F1·F2 ★ 서피스(webview 게스트 + 그 팝업 창)가 웹 UI 이동 규칙에 걸리면 안 된다 (분기가 먼저 + 조기 return)", () => {
  const hook = MAIN.indexOf('app.on("web-contents-created"');
  assert.ok(hook >= 0, "web-contents-created 훅이 없다");
  const seg = MAIN.slice(hook);
  const guest = seg.indexOf("if (isSurfaceContents(wc))");
  const webRule = seg.indexOf("openTargetFor(url, state.gatewayUrl)");
  assert.ok(guest >= 0, "★ 서피스를 가르지 않는다 — 서피스·팝업이 첫 이동에서 시스템 브라우저로 튄다");
  assert.ok(webRule >= 0, "웹 UI 규칙이 사라졌다");
  assert.ok(guest < webRule, "★ F1 분기가 웹 UI 규칙보다 뒤에 있다 — 서피스가 죽는다");
  // ⚠ 분기 **블록 자체**의 끝을 본다. 분기~웹 UI 규칙 사이엔 부착 훅이 있고 거기에도 `return;` 이 있어서, 그 구간에서
  //  `return;` 을 찾으면 분기의 return 을 지워도 초록이었다(#5025 mutation 이 잡았다). 같은 들여쓰기의 닫는 괄호까지 자른다.
  const close = seg.indexOf("\n  }\n", guest);
  assert.ok(close > guest && close < webRule, "서피스 분기의 끝을 못 찾는다");
  const block = seg.slice(guest, close + 5);
  assert.match(block, /\n    return;\n  }\n$/, "★ F2 서피스 분기가 조기 return 하지 않는다 — 웹 UI 규칙까지 흘러 서피스가 죽는다");
  assert.match(block, /surfaceNavTarget\(url\)/, "서피스 이동에 서피스 규칙(정반대 규칙)을 안 쓴다");
});

t("F3·F4 ★ webviewTag 를 켠 자리마다 부착 훅이 격리를 강제한다", () => {
  assert.match(MAIN, /webviewTag: true/, "앱 창에 webviewTag 를 안 켰다 — 서피스를 만들 수 없다");
  const at = MAIN.indexOf('wc.on("will-attach-webview"');
  assert.ok(at >= 0, "★ F3 부착 훅이 없다 — webviewTag:true 한 줄이 XSS→RCE 승격 통로가 된다");
  // ⚠ 고정 길이로 자르지 않는다 — 훅이 자라면 뒤쪽 단언(특히 «없어야 한다» 단언)이 조용히 공허해진다(F7 의 교훈).
  //  훅 리스너가 닫히는 줄(`  });` — 훅과 같은 들여쓰기)까지 자른다.
  const close = MAIN.indexOf("\n  });\n", at);
  assert.ok(close > at, "부착 훅의 끝을 못 찾는다");
  const seg = MAIN.slice(at, close + 6);
  assert.match(seg, /webviewAttachDecision\(params\)/, "부착 허용 판정을 안 쓴다");
  assert.match(seg, /e\.preventDefault\(\)/, "거부해도 실제로 막지 않는다");
  assert.match(seg, /for \(const k of WEBVIEW_DROPPED_PREFS\) delete webPreferences\[k\]/, "★ F4 preload 를 지우지 않는다");
  assert.match(seg, /Object\.assign\(webPreferences, WEBVIEW_FORCED_PREFS\)/, "★ F4 격리 설정을 강제하지 않는다 — 페이지가 정하게 된다");
  // ★ 반드시 webPreferences 쪽이어야 한다 — params.partition 은 Electron 이 무시한다(실측 43.4.1:
  //  params 로 넣으면 게스트가 페이지가 적은 파티션에 붙어 UA·권한 핸들러가 전부 안 걸린다 = 격리 무력화).
  //  코드만 읽으면 둘 다 "파티션을 정하는 줄" 로 보여서 이 단언이 유일한 방어선이다.
  assert.match(seg, /webPreferences\.partition = BROWSER_SURFACE_PARTITION/, "★ F4 파티션을 강제하지 않는다 — 우리 토큰 저장소와 섞인다");
  assert.ok(!/params\.partition = /.test(seg), "★ params.partition 은 Electron 이 무시한다 — 격리된 줄 알고 안 된다");
  // ★ allowpopups 도 같은 함정이다 — Electron 은 이 훅 **전에** webPreferences.disablePopups 를 계산해 둔다
  //  (v43.3.0 guest-view-manager.ts makeWebPreferences). params 에 적는 줄은 막는 것처럼 보이지만 아무것도 안 한다.
  //  새 창은 WEBVIEW_FORCED_PREFS.disablePopups(=false · E3)로 처리기까지 오게 하고, 처리기(F9)가 정한다.
  assert.ok(!/params\.allowpopups\s*=/.test(seg), "★ params.allowpopups 는 Electron 이 무시한다 — 막은 줄 알고 안 된다");
  assert.ok(!/webPreferences\.disablePopups\s*=/.test(seg),
    "★ 강제 설정 뒤에 disablePopups 를 다시 덮어쓴다 — 새 창이 처리기에 안 와 팝업 로그인이 다시 죽는다");
  assert.ok(seg.indexOf("Object.assign(webPreferences, WEBVIEW_FORCED_PREFS)") > seg.indexOf("delete webPreferences[k]"),
    "강제 설정이 지우기보다 먼저다 — 지우기가 강제값을 지울 수 있다");
  assert.match(MAIN, /setPermissionRequestHandler\(\(_wc, permission, cb\) => cb\(surfacePermissionAllowed\(permission\)\)\)/, "권한 요청을 서피스 정책에 안 건다");
  assert.match(MAIN, /setPermissionCheckHandler\(\(_wc, permission\) => surfacePermissionAllowed\(permission\)\)/, "권한 조회를 서피스 정책에 안 건다");
  assert.match(MAIN, /setUserAgent\(cleanUserAgent\(s\.getUserAgent\(\), app\.getName\(\)\)\)/, "서피스 세션 UA 를 안 정리한다");
});

t("F5 ★ 능력은 preload 가 자칭하지 않는다 — 메인이 출처를 보고 준 값을 그대로 전한다", () => {
  assert.match(MAIN, /browserSurface: ok \? \{ version: BROWSER_SURFACE_VERSION \} : null/,
    "★ 게이트웨이 출처가 아닐 때도 능력을 알려 주면 남의 사이트가 우리 앱 능력을 안다");
  assert.match(PRELOAD, /browserSurface: boot\.browserSurface \|\| null/,
    "★ preload 가 능력을 스스로 만들면 메인의 출처 판정이 무의미해진다");
  assert.ok(!/browserSurface:\s*\{/.test(PRELOAD), "preload 가 능력 객체를 직접 지어내고 있다");
  assert.equal(typeof BROWSER_SURFACE_VERSION, "number");
});

t("F6 웹은 **기능 감지**로 능력을 본다 — 플랫폼·UA 추측 금지", () => {
  assert.match(WEBSURF, /livelyDesktop/, "웹이 데스크톱 다리를 안 본다");
  assert.match(WEBSURF, /browserSurface/, "웹이 능력 키를 안 본다");
  assert.ok(!/navigator\.userAgent/.test(WEBSURF), "★ 웹이 UA 로 데스크톱을 추측한다 — 구 앱 + 새 웹 조합에서 어긋난다");
  assert.ok(!/livelyDesktop\.platform\s*===/.test(WEBSURF), "★ 플랫폼으로 능력을 추측한다");
  assert.match(WEBSURF, /'webview'/, "폴백만 있고 실제 서피스를 안 만든다");
});

t("F7 ★ 세션 곁칸 '웹' 도 능력이 있으면 서피스로 그린다 — 원래 신고가 난 자리다", () => {
  const pane = readFileSync(fileURLToPath(new URL("../../web/v2/panes-parts.ts", import.meta.url)), "utf8");
  const at = pane.indexOf("function webPart(");
  assert.ok(at >= 0, "웹 칸이 없다");
  // ⚠ 고정 길이로 자르지 않는다 — 그 함수는 자란다(#1819 로 세션 연동·⌘R 이 붙어 2200자를 넘겼고
  //  안내문 단언이 구간 밖으로 밀려나 거짓 실패했다). **다음 함수 선언 직전까지** 자른다.
  // ⚠ 뒤 함수를 **이름으로** 잡지도 않는다 — 그 이름이 바뀌면 앵커가 사라져 거짓 실패한다
  //  (실측: editorPart 가 viewerPart 로 개명되자 이 단언이 통째로 깨졌다, #1819). 구조로 잡는다.
  const rest = pane.slice(at + 1);
  const nextFn = rest.search(/\nfunction \w+\(/);
  const end = nextFn < 0 ? -1 : at + 1 + nextFn;
  assert.ok(end > at, "웹 칸 뒤에 함수가 없다 — 구간을 못 자른다");
  const seg = pane.slice(at, end);
  assert.match(seg, /hasBrowserSurface\(\)/, "★ 능력 감지를 안 한다 — 데스크톱에서도 iframe 이라 막힌 사이트가 그대로 막힌다");
  assert.match(seg, /el\('webview', \{ class: 'pn-webframe' \}\)/, "★ 능력이 있어도 webview 로 안 그린다");
  // src 는 프로퍼티 대입이 아니라 **속성**으로 — webview 는 부착 전 프로퍼티 대입이 안 먹는다
  //  ⚠ `frame.src` 형태만 보면 `(frame as any).src = u` 를 놓친다 — **어떤 형태의 `.src` 대입도** 잡는다.
  assert.ok(!/\.src\s*=[^=]/.test(seg), "★ .src 프로퍼티 대입 — webview 는 부착 전 대입이 안 먹는다");
  assert.match(seg, /frame\.setAttribute\('src', /, "속성으로 안 넣는다");
  // 데스크톱에선 "막혀서 빈 화면" 안내가 거짓말이 된다
  assert.match(seg, /live \? null : el\('p', \{ class: 'pn-web-note/, "★ 서피스에서도 '막혔다' 안내를 띄운다 — 거짓 안내다");
  // ★ #1819 가 들여온 reload() 는 iframe 전용이다 — webview 엔 contentWindow 가 없어 `?.` 가 조용히 빠지고
  //  그대로 return 된다. 즉 '다시 불러오기'가 **아무 일도 안 한다**(무동작은 오동작보다 찾기 어렵다).
  assert.match(seg, /if \(live\) \{ try \{ \(frame as any\)\.reload\(\); return; \}/, "★ reload 에 webview 분기가 없다");
});

// main.mjs 의 최상위 함수 하나를 잘라 온다 — 고정 길이가 아니라 **그 함수가 닫히는 줄(맨 앞 `}`)까지**(F7 의 교훈).
function fnBody(name) {
  const at = MAIN.indexOf(`\nfunction ${name}(`);
  assert.ok(at >= 0, `${name} 가 없다`);
  const end = MAIN.indexOf("\n}\n", at);
  assert.ok(end > at, `${name} 의 끝을 못 찾는다`);
  return MAIN.slice(at, end + 2);
}

t("F8 ★ 팝업 창도 서피스로 친다 — 세션으로 가른다(팝업은 getType 이 'window' 라 webview 판정만으론 웹 UI 규칙에 걸린다)", () => {
  const body = fnBody("isSurfaceContents");
  assert.match(body, /wc\.getType\(\) === "webview"\) return true/, "게스트를 서피스로 안 친다");
  assert.match(body, /wc\.session === browserSurfaceSession\(\)/,
    "★ 팝업을 세션으로 안 가른다 — 구글 로그인 창이 웹 UI 규칙에 걸려 첫 이동에서 시스템 브라우저로 튄다");
  // 세션이 없으면 서피스도 없다 — 웹 UI 창이 생길 때마다 서피스 세션(확장 재로드 포함)을 깨우면 안 된다
  assert.match(body, /surfaceSessionReady && wc\.session === browserSurfaceSession\(\)/, "★ 웹 UI 창마다 서피스 세션을 깨운다");
});

t("F9 ★ 서피스의 새 창 처리기 — 판정 표 → 팝업 차단 대신 문(포커스·빈도) → popup 이면 우리가 짓는 창(opener 유지)", () => {
  const hook = MAIN.indexOf('app.on("web-contents-created"');
  const seg = MAIN.slice(hook);
  const at = seg.indexOf("if (isSurfaceContents(wc))");
  const branch = seg.slice(at, seg.indexOf("\n  }\n", at) + 5);   // 분기 블록만(F2 와 같은 자르기)
  assert.match(branch, /setWindowOpenHandler\(\(\{ url, disposition, features \}\) =>/,
    "★ disposition·features 를 안 받는다 — 스크립트 팝업과 Shift+클릭·탭을 못 가른다");
  assert.match(branch, /surfaceWindowOpenTarget\(\{ url, disposition, features, openPopups: surfacePopups\.size \}\)/,
    "★ 판정 표를 안 쓰거나 **우리가 지은** 팝업 수를 안 넘긴다(상한 무력)");
  const deny = branch.indexOf('if (t === "deny") return { action: "deny" };');
  const gate = branch.indexOf("surfaceOpenGate({ hostFocused: !!owner && owner.isFocused(), recent: surfaceOpens.get(wc), now: Date.now() })");
  const save = branch.indexOf("surfaceOpens.set(wc, gate.recent);");
  const blocked = branch.indexOf('if (!gate.ok) return { action: "deny" };');
  const popup = branch.indexOf('if (t === "popup")');
  const ext = branch.indexOf("shell.openExternal(url);");
  assert.ok(gate >= 0, "★ 문(주인 창 포커스·빈도)이 없다 — 광고 페이지가 창·시스템 브라우저 탭을 쏟는다");
  assert.ok(save > gate && blocked > save, "★ 빈도 기록을 안 남기거나 문이 막아도 연다");
  assert.ok(deny >= 0 && deny < gate, "거부할 것까지 빈도 기록을 먹는다");
  assert.ok(popup > blocked && ext > blocked, "★ 문보다 먼저 연다 — 문이 아무것도 안 막는다");
  const ret = branch.slice(popup, ext);
  assert.match(ret, /action: "allow"/, "★ 팝업을 앱 안 창으로 안 연다 — opener 가 끊겨 팝업 로그인이 결과를 못 돌려받는다");
  assert.match(ret, /overrideBrowserWindowOptions: \{ webPreferences: surfacePopupWebPreferences\(\) \}/,
    "★ 팝업 webContents 격리를 메인이 안 정한다 — 페이지 기능 문자열이 정하게 된다");
  assert.match(ret, /createWindow: \(options\) => createSurfacePopup\(wc, url, options\)/,
    "★ 창을 Electron 기본(페이지 기능 문자열 섞기)으로 짓는다 — 닫기 없는 모달·숨은 창이 가능하다");
});

t("F10 ★ 팝업 창은 우리가 짓는다 — 설정은 spec·주인·webContents 셋뿐 · 우리 집합에 등록 · 제목에 실제 호스트", () => {
  const body = fnBody("createSurfacePopup");
  // new BrowserWindow 에 들어가는 건 정확히 셋 — 그 사이에 다른 키(modal·alwaysOnTop…)를 끼우면 빨간불
  assert.match(body, /new BrowserWindow\(\{\n    \.\.\.surfacePopupWindowSpec\(options, area\),\n    \.\.\.\(owner \? \{ parent: owner \} : \{\}\),\n    \.\.\.\(guest \? \{ webContents: guest \} : \{ webPreferences: surfacePopupWebPreferences\(\) \}\),\n  \}\);/,
    "★ 창 설정이 spec·주인·webContents 말고 다른 것을 받는다(또는 순서가 바뀌어 spec 이 덮인다)");
  assert.match(body, /const owner = surfaceOwnerWindow\(opener\)/, "주인 창을 안 찾는다");
  assert.match(body, /screen\.getDisplayMatching\(owner\.getBounds\(\)\)/, "주인 창이 있는 화면의 작업 영역을 안 쓴다");
  assert.match(body, /surfacePopups\.add\(win\)/, "★ 지은 창을 안 센다 — 상한이 무력");
  assert.match(body, /win\.on\("closed", \(\) => surfacePopups\.delete\(win\)\)/, "★ 닫힌 창을 안 뺀다 — 상한이 영영 찬다");
  assert.match(body, /win\.on\("page-title-updated", \(e, title\) => \{ e\.preventDefault\(\); win\.setTitle\(surfacePopupTitle\(win\.webContents\.getURL\(\), title\)\); \}\)/,
    "★ 제목에 실제 호스트를 안 붙인다 — 주소줄 없는 창에서 남의 페이지가 어디인지 안 보인다");
  assert.match(body, /did-navigate/, "다른 호스트로 넘어가도 제목이 옛 호스트를 말한다");
  assert.match(body, /if \(!guest\) void win\.loadURL\(url\)/, "opener 없이 지은 창이 빈 창으로 남는다(또는 opener 창을 다시 싣는다)");
  assert.match(body, /return win\.webContents;/, "Electron 이 넘긴 webContents 를 안 돌려준다");
  const owner = fnBody("surfaceOwnerWindow");
  assert.match(owner, /BrowserWindow\.fromWebContents\(wc\.hostWebContents \|\| wc\)/, "게스트의 앱 창에서 주인을 안 찾는다");
});

t("F11 팝업 수 = 우리가 지은 창의 집합 — 페이지가 정하는 값(show 등)으로 세지 않는다", () => {
  assert.match(MAIN, /\nconst surfacePopups = new Set\(\);\n/, "지은 창 집합이 없다");
  assert.ok(!/isVisible\(\)/.test(fnBody("createSurfacePopup")) && !/function openSurfacePopups/.test(MAIN),
    "★ 보임 여부로 센다 — show=no 로 연 숨은 창이 상한을 피한다");
});

// ── G. 가려진 창(다른 데스크톱 공간 · 전체 화면 앱 뒤)도 숨김으로 치지 않는다 — AI 가 그동안 연 페이지가 그려지고 찍히게(#4993) ──
t("G1 스위치 이름은 Chromium 의 그것 그대로", () => {
  assert.equal(OCCLUDED_WINDOW_SWITCH, "disable-backgrounding-occluded-windows");
});

t("G2 ★ 앱이 준비되기 전에 건다 — whenReady 뒤에 걸면 안 먹는다(Chromium 이 이미 떴다)", () => {
  const at = MAIN.indexOf("app.commandLine.appendSwitch(OCCLUDED_WINDOW_SWITCH)");
  assert.ok(at >= 0, "★ 스위치를 안 건다 — 사람이 다른 공간에 있는 동안 새로 연 페이지가 안 그려져 화면 찍기가 끝나지 않는다");
  const lock = MAIN.indexOf("app.requestSingleInstanceLock()");
  const ready = MAIN.indexOf("app.whenReady()");
  assert.ok(lock >= 0 && ready >= 0, "수명 블록(단일 인스턴스 · whenReady)이 사라졌다");
  assert.ok(at < lock && at < ready, "★ 스위치가 준비 이후에 걸린다 — 안 먹는다");
});

// ── H. 새 창 판정 (#5025) — 스크립트 팝업만 앱 안 창으로(opener 유지 → 팝업 로그인), 그 밖은 밖으로 ─────────
const POP = "new-window";
const FEAT = "width=500,height=600,left=100,top=100";
const GSI = "https://accounts.google.com/gsi/select?client_id=x&ux_mode=popup";
const open = (o) => surfaceWindowOpenTarget({ disposition: POP, features: FEAT, ...o });

t("H1·H2 스크립트 팝업 http(s) 는 앱 안 창 — 구글 팝업 로그인 · 사내·로컬 콜백", () => {
  assert.equal(open({ url: GSI }), "popup");                                                         // H1
  assert.equal(open({ url: "http://localhost:3000/cb", features: "popup" }), "popup");               // H2
});

t("H3 ★ 빈 창 먼저 열고 주소는 나중에 — 팝업으로 받는다(막으면 그 모양의 로그인이 죽는다)", () => {
  for (const url of ["about:blank", "about:blank#x", "about:blank?x", "ABOUT:BLANK", "", "  ", null, undefined])
    assert.equal(open({ url }), "popup", String(url));
});

t("H4·H5 팝업이어도 DRM 은 밖으로 · mailto/tel 은 OS 로", () => {
  assert.equal(open({ url: "https://www.netflix.com/" }), "external");                              // H4
  assert.equal(open({ url: "mailto:a@b.c" }), "external");                                          // H5
  assert.equal(open({ url: "tel:+8210" }), "external");
});

t("H6 ★ 팝업이어도 열 수 없는 스킴은 거부 — 빈 창만 예외다(about: 전체가 아니다)", () => {
  for (const url of ["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "chrome://settings",
    "blob:https://x.com/uuid", "about:srcdoc", "about:blankx"])
    assert.equal(open({ url }), "deny", url);
});

t("H7·H21 ★ 열린 팝업 상한 — 정책값 4 · 바로 아래는 열고 상한부터는 막는다", () => {
  assert.equal(SURFACE_POPUP_LIMIT, 4, "H21 상한 정책값이 바뀌었다 — 사양(spec-5025)과 같이 고칠 것");
  assert.equal(open({ url: GSI, openPopups: SURFACE_POPUP_LIMIT - 1 }), "popup");
  assert.equal(open({ url: GSI, openPopups: SURFACE_POPUP_LIMIT }), "deny");
  assert.equal(open({ url: GSI, openPopups: SURFACE_POPUP_LIMIT + 3 }), "deny");
  assert.equal(open({ url: "about:blank", openPopups: SURFACE_POPUP_LIMIT }), "deny", "빈 창도 상한");
});

t("H8~H10 탭 성격은 시스템 브라우저 — 빈 창·열 수 없는 건 거부", () => {
  for (const d of ["foreground-tab", "background-tab"])
    assert.equal(surfaceWindowOpenTarget({ url: "https://github.com/", disposition: d, features: "" }), "external", d); // H8
  for (const url of ["about:blank", "", null])
    assert.equal(surfaceWindowOpenTarget({ url, disposition: "foreground-tab" }), "deny", String(url));                  // H9
  assert.equal(surfaceWindowOpenTarget({ url: "mailto:a@b.c", disposition: "foreground-tab" }), "external");              // H10
  assert.equal(surfaceWindowOpenTarget({ url: "javascript:1", disposition: "foreground-tab" }), "deny");
  // 탭 성격은 기능 문자열이 있어도 앱 안으로 안 들인다 — 앱 안은 «팝업» 일 때만
  assert.equal(surfaceWindowOpenTarget({ url: GSI, disposition: "foreground-tab", features: FEAT }), "external");
});

t("H11 ★ 앱 안으로는 명시적 팝업만 — disposition 이 없거나 낯설면 밖으로", () => {
  for (const d of [undefined, null, "", "other", "default", "save-to-disk", "NEW-WINDOW", "new_window"])
    assert.equal(surfaceWindowOpenTarget({ url: GSI, disposition: d, features: FEAT }), "external", String(d));
});

t("H12·H13 인자 부재 — 죽지 않고 거부 / 열린 수 부재·NaN 은 0 으로", () => {
  assert.equal(surfaceWindowOpenTarget(), "deny");                                                  // H12
  assert.equal(surfaceWindowOpenTarget({}), "deny");
  assert.equal(open({ url: GSI, openPopups: undefined }), "popup");                                 // H13
  assert.equal(open({ url: GSI, openPopups: NaN }), "popup");
});

t("H20 ★ Shift+클릭(«new-window» 인데 기능 문자열 없음 — opener 없음)은 앱 안 창이 아니라 밖으로", () => {
  for (const features of ["", "  ", null, undefined]) {
    assert.equal(surfaceWindowOpenTarget({ url: GSI, disposition: POP, features }), "external", String(features));
    assert.equal(surfaceWindowOpenTarget({ url: "javascript:1", disposition: POP, features }), "deny", String(features));
    assert.equal(surfaceWindowOpenTarget({ url: "about:blank", disposition: POP, features }), "deny", String(features));
  }
});

// ── S. 팝업 창은 우리가 짓는다 — 페이지의 기능 문자열은 크기 말고 버린다 ─────────────────────────────
const AREA = { x: 100, y: 50, width: 1600, height: 900 };
// Electron 이 실제로 섞는 모양 그대로(v43.3.0 guest-window-manager.ts:49-55 · parse-features-string.ts) — 적대 페이지의 기능 문자열
const HOSTILE = { frame: false, modal: true, show: false, alwaysOnTop: true, skipTaskbar: true, closable: false, focusable: false,
  movable: false, minimizable: false, maximizable: false, fullscreenable: false, transparent: true, opacity: 0, hasShadow: false,
  enableLargerThanScreen: true, hiddenInMissionControl: true, thickFrame: false, titleBarStyle: "hidden", vibrancy: "hud",
  title: "Lively — 다시 로그인하세요", center: false, x: -32000, y: -32000, width: 100000, height: 100000, minWidth: 99999,
  tabbingIdentifier: "x", backgroundMaterial: "acrylic", roundedCorners: false, acceptFirstMouse: true };
const electronMerged = (parsed, override) => ({ show: true, width: 800, height: 600, ...parsed, ...override });
const SPEC_KEYS = new Set(["width", "height", "x", "y", "show", "frame", "thickFrame", "modal", "alwaysOnTop", "skipTaskbar",
  "closable", "movable", "resizable", "focusable", "minimizable", "maximizable", "fullscreenable", "transparent", "opacity",
  "hasShadow", "enableLargerThanScreen", "hiddenInMissionControl", "autoHideMenuBar", "backgroundColor"]);

t("S1 ★ 적대 기능 문자열을 섞어도 — 테두리·닫기·보임·비모달·맨 위 아님·작업표시줄·불투명", () => {
  const spec = surfacePopupWindowSpec(electronMerged(HOSTILE, { webPreferences: surfacePopupWebPreferences() }), AREA);
  for (const [k, v] of [["show", true], ["frame", true], ["thickFrame", true], ["modal", false], ["alwaysOnTop", false],
    ["skipTaskbar", false], ["closable", true], ["focusable", true], ["movable", true], ["resizable", true],
    ["minimizable", true], ["maximizable", true], ["transparent", false], ["opacity", 1], ["enableLargerThanScreen", false],
    ["hiddenInMissionControl", false]])
    assert.equal(spec[k], v, `★ ${k} 를 페이지가 정했다`);
  assert.ok(spec.x >= AREA.x && spec.y >= AREA.y && spec.x + spec.width <= AREA.x + AREA.width && spec.y + spec.height <= AREA.y + AREA.height,
    "★ 창이 작업 영역 밖으로 나간다(화면 밖·화면보다 큰 창)");
});

t("S2 ★ 기본 거부 — 결과 키는 고정 집합뿐(페이지의 titleBarStyle·vibrancy·title·center… 가 하나도 안 샌다)", () => {
  const spec = surfacePopupWindowSpec(electronMerged(HOSTILE, {}), AREA);
  for (const k of Object.keys(spec)) assert.ok(SPEC_KEYS.has(k), `★ 모르는 키 ${k} 가 창 설정에 실렸다`);
  assert.ok(!("webPreferences" in spec) && !("webContents" in spec) && !("parent" in spec), "spec 이 webContents·주인까지 정한다");
});

t("S3·S4 크기 — 작업 영역으로 줄이고 최소 크기로 키운다 · 경계 그대로", () => {
  const s1 = surfacePopupWindowSpec({ width: 100000, height: 5 }, AREA);
  assert.equal(s1.width, AREA.width);                                                               // S3
  assert.equal(s1.height, SURFACE_POPUP_MIN_SIZE.height);
  const s2 = surfacePopupWindowSpec({ width: "500", height: NaN }, AREA);
  assert.equal(s2.width, 800, "문자열 크기를 숫자로 믿었다");
  assert.equal(s2.height, 600, "NaN 크기를 믿었다");
  assert.equal(surfacePopupWindowSpec({ width: AREA.width, height: AREA.height }, AREA).width, AREA.width);          // S4 경계
  assert.equal(surfacePopupWindowSpec({ width: SURFACE_POPUP_MIN_SIZE.width - 1, height: 400 }, AREA).width, SURFACE_POPUP_MIN_SIZE.width);
  assert.equal(surfacePopupWindowSpec({ width: 500, height: 600 }, AREA).width, 500, "구글 팝업 크기를 바꿨다");
});

t("S5 위치 — 페이지 x·y 는 무시하고 작업 영역 가운데", () => {
  const s = surfacePopupWindowSpec({ width: 500, height: 600, x: 0, y: 0 }, AREA);
  assert.equal(s.x, AREA.x + (AREA.width - 500) / 2);
  assert.equal(s.y, AREA.y + (AREA.height - 600) / 2);
});

t("S6·S7 부재 — 영역 없거나 0 폭이면 기본 영역 · 요청 없으면 기본 크기 · 부를 때마다 새 객체", () => {
  for (const area of [undefined, null, { x: 0, y: 0, width: 0, height: 0 }]) {
    const s = surfacePopupWindowSpec({ width: 500, height: 600 }, area);
    assert.ok(s.width === 500 && s.height === 600 && Number.isFinite(s.x) && Number.isFinite(s.y), JSON.stringify(area));
  }
  const d = surfacePopupWindowSpec(null, AREA);
  assert.equal(d.width, 800);
  assert.equal(d.height, 600);
  assert.notEqual(surfacePopupWindowSpec({}, AREA), surfacePopupWindowSpec({}, AREA), "S7 같은 객체를 돌려 쓴다");
});

// ── W. 팝업 webContents 의 격리 ──────────────────────────────────────────────────────────
t("W1 팝업 격리 = 웹 칸과 같음 · 서피스 파티션 · preload 키 없음 · 새 객체 · 고쳐도 상수 그대로", () => {
  const a = surfacePopupWebPreferences(), b = surfacePopupWebPreferences();
  assert.notEqual(a, b, "같은 객체를 돌려 쓴다");
  assert.ok(!Object.isFrozen(a), "Electron 이 쓸 수 있어야 한다");
  assert.equal(a.partition, BROWSER_SURFACE_PARTITION,
    "★ 파티션이 없으면 opener 없이 지은 창이 기본 파티션(우리 토큰 저장소)에 남의 사이트를 띄운다");
  for (const [k, v] of Object.entries(WEBVIEW_FORCED_PREFS)) assert.equal(a[k], v, k);
  for (const k of WEBVIEW_DROPPED_PREFS) assert.ok(!(k in a), `★ ${k} 키가 있다`);
  a.nodeIntegration = true; a.preload = "/evil.js";
  assert.equal(WEBVIEW_FORCED_PREFS.nodeIntegration, false, "반환값을 고치니 상수가 바뀌었다");
  assert.ok(!("preload" in surfacePopupWebPreferences()), "앞서 고친 값이 다음 호출에 샜다");
});

// ── I. 새 창 문 — 크롬의 팝업 차단기 대신(주인 창 포커스 + 빈도) ─────────────────────────────
const T0 = 1_800_000_000_000;
t("I1·I2 주인 창 포커스가 없으면 안 연다(기록도 안 늘림) · 첫 번째는 연다", () => {
  assert.deepEqual(surfaceOpenGate({ hostFocused: false, recent: [], now: T0 }), { ok: false, recent: [] });   // I1
  const g = surfaceOpenGate({ hostFocused: true, recent: [], now: T0 });                                         // I2
  assert.equal(g.ok, true);
  assert.deepEqual(g.recent, [T0]);
});

t("I3 ★ 간격 경계 — 999ms 는 막고 정확히 1000ms 는 연다", () => {
  assert.equal(SURFACE_OPEN_MIN_GAP_MS, 1000, "간격 정책값이 바뀌었다 — 사양과 같이 고칠 것");
  assert.equal(surfaceOpenGate({ hostFocused: true, recent: [T0], now: T0 + 999 }).ok, false);
  assert.equal(surfaceOpenGate({ hostFocused: true, recent: [T0], now: T0 + 1000 }).ok, true);
});

t("I4 ★ 1분 상한 — 간격을 지켜도 6번째까지만", () => {
  assert.equal(SURFACE_OPEN_PER_MINUTE, 6, "분당 상한 정책값이 바뀌었다 — 사양과 같이 고칠 것");
  let recent = [], opened = 0;
  for (let i = 0; i < 10; i++) {
    const g = surfaceOpenGate({ hostFocused: true, recent, now: T0 + i * 2000 });
    recent = g.recent; if (g.ok) opened++;
  }
  assert.equal(opened, SURFACE_OPEN_PER_MINUTE);
});

t("I5 1분 지난 기록은 버린다 — 정확히 60000ms 전 기록도 버린다(경계)", () => {
  const full = Array.from({ length: 6 }, (_, i) => T0 + i * 1000);
  assert.equal(surfaceOpenGate({ hostFocused: true, recent: full, now: T0 + 59_999 }).ok, false, "1분 안인데 열었다");
  const g = surfaceOpenGate({ hostFocused: true, recent: full, now: T0 + 60_000 });
  assert.equal(g.ok, true, "1분 지난 첫 기록을 안 버렸다");
  assert.ok(!g.recent.includes(T0), "버린 기록이 남았다");
});

t("I6·I7 기록 부재·쓰레기·미래 시각은 버린다 — 죽지 않는다", () => {
  for (const recent of [undefined, null, "x", [null, "x", NaN, T0 + 5000]]) {
    const g = surfaceOpenGate({ hostFocused: true, recent, now: T0 });
    assert.equal(g.ok, true, JSON.stringify(recent));
    assert.deepEqual(g.recent, [T0], JSON.stringify(recent));
  }
  assert.equal(surfaceOpenGate().ok, false, "인자 없이 열었다");
});

// ── T. 팝업 제목 — 주소줄이 없으니 실제 호스트를 앞에 ───────────────────────────────────────
t("T1~T5 제목 = 실제 호스트 — 제목 없으면 호스트만 · http(s) 아니면 제목 그대로", () => {
  assert.equal(surfacePopupTitle("https://accounts.google.com/x", "로그인 - Google 계정"), "accounts.google.com — 로그인 - Google 계정"); // T1
  assert.equal(surfacePopupTitle("https://accounts.google.com/x", "  "), "accounts.google.com");                         // T2
  assert.equal(surfacePopupTitle("https://accounts.google.com/x", undefined), "accounts.google.com");
  for (const u of ["about:blank", "javascript:1", "::bad", "", null]) assert.equal(surfacePopupTitle(u, "제목"), "제목", String(u)); // T3
  assert.equal(surfacePopupTitle("https://a.com/", "a.com"), "a.com");                                                     // T4
  assert.equal(surfacePopupTitle("http://localhost:3000/cb", "콜백"), "localhost:3000 — 콜백");                              // T5
});

console.log(`\n${pass} passed`);
