// 앱 주소(#4480 v2-1) 화면 쪽 순수 조각(web/lib/app-address.ts) — 컴파일된 모듈(public/app/lib/app-address.js)을 돌린다.
//  빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 앱 주소 iframe 이 화면 키 · 탐침을 서버와 다른 이름으로 보내 엉뚱한 화면이 뜨거나(embedNext),
//   앞단의 로그인 신호가 아닌 메시지에 반응해 앱이 아무 때나 srcdoc 으로 바뀌거나(appAuthSignal), 쿠키 막힘 기록이
//   다른 브라우저 · 오래된 기록에도 걸려 앱 주소를 영영 안 쓰게 된다(addrBlockValid).
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(root, "public/app/lib/app-address.js");
if (!existsSync(mod)) { console.log("app-address-web: 빌드 없음(public/app/lib/app-address.js) — 건너뜀"); process.exit(0); }
const F = await import(mod);
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// W1 embedNext — 서버 parseAppPath 와 같은 이름(page · __lively_probe=1)
assert.equal(F.embedNext(), "/");
assert.equal(F.embedNext("settings"), "/?page=settings");
assert.equal(F.embedNext(undefined, true), "/?__lively_probe=1");
assert.equal(F.embedNext("a b&c", true), "/?page=a+b%26c&__lively_probe=1", "값은 인코딩");
assert.equal(F.embedNext("", false), "/", "빈 화면 키는 안 싣는다");
ok("W1 embedNext — 화면 키 · 탐침 · 인코딩");

// W2 appAuthSignal — 셋만 뜻이 있다
for (const st of ["login-required", "code-invalid", "cookie-blocked"]) assert.equal(F.appAuthSignal({ type: "lively:app-auth", status: st }), st);
for (const bad of [null, "x", { type: "lively:app-auth" }, { type: "lively:app-auth", status: "other" }, { type: "other", status: "cookie-blocked" }, { jsonrpc: "2.0", method: "ui/initialize" }]) {
  assert.equal(F.appAuthSignal(bad), null, JSON.stringify(bad));
}
ok("W2 appAuthSignal — 셋만 · 나머지 null");

// W3 addrBlockValid — 같은 UA · 7일 안만(경계: 7일 직전 됨 · 정확히 7일 안 됨) · 깨진 값 · 미래 시각 아님
const DAY = 864e5, NOW = 1_800_000_000_000, UA = "Safari/605";
const rec = (ua, at) => JSON.stringify({ ua, at });
assert.equal(F.addrBlockValid(rec(UA, NOW - DAY), UA, NOW), true);
assert.equal(F.addrBlockValid(rec(UA, NOW - 7 * DAY + 1), UA, NOW), true, "7일 직전은 유효");
assert.equal(F.addrBlockValid(rec(UA, NOW - 7 * DAY), UA, NOW), false, "정확히 7일은 지남");
assert.equal(F.addrBlockValid(rec("Chrome/140", NOW - DAY), UA, NOW), false, "다른 브라우저(UA)");
assert.equal(F.addrBlockValid(rec(UA, NOW + DAY), UA, NOW), false, "미래 시각은 깨진 기록");
for (const bad of [null, "", "{", "null", rec(UA, "x")]) assert.equal(F.addrBlockValid(bad, UA, NOW), false, String(bad));
ok("W3 addrBlockValid — UA · 7일 경계 · 깨진 값");

// W4 appGrantReturn(#4482) — 동의 경유에서 돌아갈 곳은 «지금 워크스페이스의 그 앱 주소» 를 여기서 만든다(링크가 주는 주소를 받지 않는다)
//  격리 리뷰 1: 종전엔 링크의 back 을 «앱 id 로 시작하나» 만 봐서 `<같은 앱 id>-<남의 워크스페이스>.lvly.app` 으로 보낼 수 있었다.
{
  const D = "lvly.app", S = "lively-46e3";
  assert.equal(F.appGrantReturn("talk", "pub", "/c/1?x=2#t", S, D), "https://talk-lively-46e3.lvly.app/c/1?x=2#t");
  assert.equal(F.appGrantReturn("talk", "pub", null, S, D), "https://talk-lively-46e3.lvly.app/", "next 없으면 /");
  assert.equal(F.appGrantReturn("talk", "draft", "/", S, D), "https://talk-lively-46e3-draft.lvly.app/", "초안 주소");
  assert.equal(F.appGrantReturn("Talk", "pub", "/", "Lively-46E3", "LVLY.app"), "https://talk-lively-46e3.lvly.app/", "소문자로");
  //  워크스페이스는 늘 지금 것 — 남의 슬러그는 인자로만 들어올 수 있고(셸이 state.me 에서 준다), 그 슬러그 그대로 쓴다
  assert.equal(F.appGrantReturn("talk", "pub", "/", "evilws-9f0a", D), "https://talk-evilws-9f0a.lvly.app/", "받은 슬러그 그대로(셸이 지금 워크스페이스를 준다)");
  for (const [args, why] of [
    [["talk", "pub", "/", "", D], "슬러그 없음(앱 주소 꺼짐 · 셀프호스트)"], [["talk", "pub", "/", S, ""], "앱 도메인 없음"],
    [["t", "pub", "/", S, D], "앱 id 꼴(2자 미만)"], [["ta lk", "pub", "/", S, D], "앱 id 꼴(공백)"], [["talk", "pub", "/", "a.b", D], "슬러그 꼴(점)"],
    [["talk", "pub", "/", S, "lvly.app/x"], "도메인 꼴"], [["a".repeat(32), "draft", "/", "s".repeat(31), D], "63자 넘는 칸"],
    [["xn--abc", "pub", "/", S, D], "IDNA 자리(xn--)"],
  ]) assert.equal(F.appGrantReturn(...args), null, why);
  for (const [next, why] of [["//evil.example/", "// 로 시작"], ["evil", "/ 로 시작 안 함"], ["/a b", "공백"], ["/a\\b", "역슬래시"], ["/" + "a".repeat(2048), "2,048자 넘음"]]) {
    assert.equal(F.appGrantReturn("talk", "pub", next, S, D), null, why);
  }
  ok("W4 appGrantReturn — 지금 워크스페이스의 그 앱 주소 · 꼴 · 안전한 상대 경로만");
}
//  배선 — 셸의 동의 경유가 링크의 back 을 읽지 않고, 슬러그를 지금 워크스페이스(state.me.workspace_registry.current)에서 받는다
{
  const { readFileSync } = await import("node:fs");
  const main = readFileSync(join(root, "web/v2/main.ts"), "utf8");
  const grant = main.slice(main.indexOf("page === 'app-grant'"), main.indexOf("isWikiListRoute(tab.route)"));
  assert.ok(grant.length > 0 && !/params\.get\('back'\)/.test(grant), "동의 경유가 링크의 back 을 읽지 않는다");
  const callLine = grant.split("\n").find((l) => l.includes("appGrantReturn(appId")) || "";
  assert.ok(callLine.includes("workspace_registry?.current") && callLine.includes("app_domain"), "슬러그는 지금 워크스페이스(state.me.workspace_registry.current)에서");
  ok("W4b 배선 — back 을 안 읽고 지금 워크스페이스로 만든다");
}

console.log(`\n${pass} passed`);
