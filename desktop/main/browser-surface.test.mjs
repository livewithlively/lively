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
  BROWSER_SURFACE_VERSION, BROWSER_SURFACE_PARTITION, WEBVIEW_FORCED_PREFS, WEBVIEW_DROPPED_PREFS,
  DRM_HANDOFF_HOSTS, hostMatches, surfaceNavTarget, cleanUserAgent, webviewAttachDecision,
  SURFACE_ALLOWED_PERMISSIONS, surfacePermissionAllowed,
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
  assert.ok(WEBVIEW_DROPPED_PREFS.includes("preload"), "★ preload 를 지우지 않으면 토큰 주입 preload 가 남의 사이트에서 돈다");
  assert.ok(Object.isFrozen(WEBVIEW_FORCED_PREFS), "얼지 않은 정책은 호출부가 조용히 고칠 수 있다");
  assert.match(BROWSER_SURFACE_PARTITION, /^persist:/, "세션이 안 남으면 로그인이 매번 풀린다");
  assert.ok(BROWSER_SURFACE_PARTITION.length > "persist:".length, "빈 파티션은 우리 토큰이 있는 기본 저장소다");
});

// ── F. 배선 — 이 기능의 진짜 위험 ────────────────────────────────────────────────────
t("F1·F2 ★ webview 게스트가 웹 UI 이동 규칙에 걸리면 안 된다 (분기가 먼저 + 조기 return)", () => {
  const hook = MAIN.indexOf('app.on("web-contents-created"');
  assert.ok(hook >= 0, "web-contents-created 훅이 없다");
  const seg = MAIN.slice(hook);
  const guest = seg.indexOf('getType() === "webview"');
  const webRule = seg.indexOf("openTargetFor(url, state.gatewayUrl)");
  assert.ok(guest >= 0, "★ webview 게스트를 가르지 않는다 — 서피스가 첫 이동에서 시스템 브라우저로 튄다");
  assert.ok(webRule >= 0, "웹 UI 규칙이 사라졌다");
  assert.ok(guest < webRule, "★ F1 분기가 웹 UI 규칙보다 뒤에 있다 — 서피스가 죽는다");
  const branch = seg.slice(guest, webRule);
  assert.match(branch, /\n\s*return;\n/, "★ F2 게스트 분기가 조기 return 하지 않는다");
  assert.match(branch, /surfaceNavTarget\(url\)/, "게스트 이동에 서피스 규칙(정반대 규칙)을 안 쓴다");
});

t("F3·F4 ★ webviewTag 를 켠 자리마다 부착 훅이 격리를 강제한다", () => {
  assert.match(MAIN, /webviewTag: true/, "앱 창에 webviewTag 를 안 켰다 — 서피스를 만들 수 없다");
  const at = MAIN.indexOf('wc.on("will-attach-webview"');
  assert.ok(at >= 0, "★ F3 부착 훅이 없다 — webviewTag:true 한 줄이 XSS→RCE 승격 통로가 된다");
  const seg = MAIN.slice(at, at + 1600);
  assert.match(seg, /webviewAttachDecision\(params\)/, "부착 허용 판정을 안 쓴다");
  assert.match(seg, /e\.preventDefault\(\)/, "거부해도 실제로 막지 않는다");
  assert.match(seg, /for \(const k of WEBVIEW_DROPPED_PREFS\) delete webPreferences\[k\]/, "★ F4 preload 를 지우지 않는다");
  assert.match(seg, /Object\.assign\(webPreferences, WEBVIEW_FORCED_PREFS\)/, "★ F4 격리 설정을 강제하지 않는다 — 페이지가 정하게 된다");
  // ★ 반드시 webPreferences 쪽이어야 한다 — params.partition 은 Electron 이 무시한다(실측 43.4.1:
  //  params 로 넣으면 게스트가 페이지가 적은 파티션에 붙어 UA·권한 핸들러가 전부 안 걸린다 = 격리 무력화).
  //  코드만 읽으면 둘 다 "파티션을 정하는 줄" 로 보여서 이 단언이 유일한 방어선이다.
  assert.match(seg, /webPreferences\.partition = BROWSER_SURFACE_PARTITION/, "★ F4 파티션을 강제하지 않는다 — 우리 토큰 저장소와 섞인다");
  assert.ok(!/params\.partition = /.test(seg), "★ params.partition 은 Electron 이 무시한다 — 격리된 줄 알고 안 된다");
  assert.match(seg, /params\.allowpopups = false/, "팝업을 막지 않는다");
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
  const end = pane.indexOf("function editorPart(", at + 1);
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

console.log(`\n${pass} passed`);
