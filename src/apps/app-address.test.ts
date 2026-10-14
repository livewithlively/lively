// 앱 주소 규칙(#4480 v2-1) — 사양 표 A 의 행마다 하나. 실행: npm run build && node dist/apps/app-address.test.js
//  이게 틀리면: 앱 주소가 DNS 한 칸(63자)을 넘거나 IDNA 자리에 걸려 브라우저가 못 여는 주소를 화면이 iframe 에 싣고(빈 화면),
//   앱 안 경로 검사가 «//남의주소» 를 통과시켜 로그인 뒤 다른 사이트로 보내는 열린 리다이렉트가 된다.
import assert from "node:assert/strict";
import { appDomain, appDomainEnabledFor, appDomainFor, appHost, appHostLabel, appOrigin, parseAppPath, safeAppNext } from "./app-address.js";

let pass = 0;
const ok = (n: string) => { pass++; console.log(`ok  ${n}`); };

// ── 도메인 스위치 ──
{
  assert.equal(appDomain({}), null, "비어 있으면 꺼짐");
  assert.equal(appDomain({ LIVELY_APP_DOMAIN: "" }), null, "빈 문자열도 꺼짐");
  assert.equal(appDomain({ LIVELY_APP_DOMAIN: "  LVLY.App. " }), "lvly.app", "공백·대문자·끝 점 정리");
  for (const bad of ["lvly", "lvly..app", "-x.app", "a_b.app", "https://lvly.app", "lvly.app/x", "*.lvly.app"]) {
    assert.equal(appDomain({ LIVELY_APP_DOMAIN: bad }), null, `꼴이 틀리면 꺼짐: ${bad}`);
  }
  ok("A1 도메인 — 비면 꺼짐 · 정리 · 이상한 꼴은 꺼짐");
}

// ── 워크스페이스 단위 스위치(LIVELY_APP_DOMAIN_TENANTS) — 우리 워크스페이스에서 먼저 실측 → 전체로 ──
{
  const on = { LIVELY_APP_DOMAIN: "lvly.app" } as NodeJS.ProcessEnv;
  assert.equal(appDomainFor("lively-46e3", on), "lvly.app", "목록이 없으면 전부");
  assert.equal(appDomainFor("lively-46e3", { ...on, LIVELY_APP_DOMAIN_TENANTS: "*" }), "lvly.app", "* 면 전부");
  const only = { ...on, LIVELY_APP_DOMAIN_TENANTS: " Lively-46e3 , dabetai-ca21 " } as NodeJS.ProcessEnv;
  assert.equal(appDomainFor("lively-46e3", only), "lvly.app", "목록 안(공백·대소문자 정리)");
  assert.equal(appDomainFor("dabetai-ca21", only), "lvly.app", "목록 안 둘째");
  assert.equal(appDomainFor("maruru-9f0a", only), null, "목록 밖은 꺼짐");
  assert.equal(appDomainFor("46e3", only), null, "꼬리만 같은 슬러그는 목록 밖(통째로 같아야 한다)");
  assert.equal(appDomainFor(null, only), null, "워크스페이스 모르면 꺼짐");
  assert.equal(appDomainFor("lively-46e3", { LIVELY_APP_DOMAIN_TENANTS: "lively-46e3" } as NodeJS.ProcessEnv), null, "도메인이 없으면 목록이 있어도 꺼짐");
  assert.equal(appDomainEnabledFor("x", { LIVELY_APP_DOMAIN_TENANTS: "" } as NodeJS.ProcessEnv), true, "빈 목록 = 전부");
  ok("A1b 워크스페이스 단위 스위치 — 목록 없음·* = 전부 · 목록 안만 · 통째 일치 · 도메인 없으면 꺼짐");
}

// ── 라벨 ──
{
  assert.equal(appHostLabel("lively-46e3", "deck-edit"), "deck-edit-lively-46e3");
  assert.equal(appHostLabel("lively-46e3", "deck-edit", "draft"), "deck-edit-lively-46e3-draft");
  assert.equal(appHostLabel("LIVELY-46E3", "Deck-Edit"), "deck-edit-lively-46e3", "소문자로");
  ok("A2 라벨 — 공개 · 초안 꼬리 · 소문자");
}
{
  // 63자 경계 — 앱 32 + 1 + 슬러그 30 = 63 은 되고, 64 는 안 된다(초안은 6자 더).
  const app32 = "a" + "b".repeat(31);
  const slug30 = "s" + "1".repeat(24) + "-46e3";
  assert.equal(app32.length, 32);
  assert.equal(slug30.length, 30);
  assert.equal(appHostLabel(slug30, app32)?.length, 63, "63자는 된다");
  assert.equal(appHostLabel(slug30 + "x", app32), null, "64자는 안 된다");
  assert.equal(appHostLabel(slug30, app32, "draft"), null, "초안 꼬리로 넘치면 안 된다");
  ok("A3 라벨 63자 경계 — 63 됨 · 64 안 됨 · 초안 꼬리로 넘침 안 됨");
}
{
  assert.equal(appHostLabel("lively-46e3", "xn--abc"), null, "xn-- 로 시작 안 됨");
  assert.equal(appHostLabel("lively-46e3", "ab--cd"), null, "3·4번째 -- 안 됨");
  assert.equal(appHostLabel("lively-46e3", "abc--d"), "abc--d-lively-46e3", "다른 자리의 -- 는 된다");
  ok("A4 IDNA 자리 — xn-- · 3·4번째 -- 는 주소 없음, 다른 자리는 됨");
}
{
  assert.equal(appHostLabel("lively-", "deck"), null, "하이픈으로 끝나는 라벨 안 됨");
  assert.equal(appHostLabel("lively-46e3", "d"), null, "앱 id 1자 안 됨(2~32)");
  assert.equal(appHostLabel("lively-46e3", "-deck"), null, "앱 id 하이픈 시작 안 됨");
  assert.equal(appHostLabel("lively_46e3", "deck"), null, "슬러그에 _ 안 됨");
  assert.equal(appHostLabel("", "deck"), null, "빈 슬러그 안 됨");
  assert.equal(appHostLabel("lively-46e3", "deck", "beta" as never), null, "모르는 판 안 됨");
  ok("A5 틀린 칸 — 하이픈 끝 · 짧은 id · 틀린 글자 · 빈 슬러그 · 모르는 판");
}

// ── 호스트 · 출처 ──
{
  assert.equal(appHost("lively-46e3", "deck-edit", "pub", "lvly.app"), "deck-edit-lively-46e3.lvly.app");
  assert.equal(appHost("lively-46e3", "deck-edit", "draft", "lvly.app"), "deck-edit-lively-46e3-draft.lvly.app");
  assert.equal(appHost("lively-46e3", "deck-edit", "pub", null), null, "도메인이 없으면 주소도 없다");
  assert.equal(appHost("lively-46e3", "xn--abc", "pub", "lvly.app"), null, "라벨이 없으면 주소도 없다");
  assert.equal(appOrigin("x-y.lvly.app"), "https://x-y.lvly.app");
  ok("A6 호스트 · 출처");
}

// ── 앱 안 경로(열린 리다이렉트 방지) ──
{
  assert.equal(safeAppNext(undefined), "/");
  assert.equal(safeAppNext(""), "/");
  assert.equal(safeAppNext("/"), "/");
  assert.equal(safeAppNext("/a/b?c=1#x"), "/a/b?c=1#x");
  ok("A7 앱 안 경로 — 비면 / · 상대 경로는 그대로");
}
{
  for (const bad of ["//evil.com", "/\\evil.com", "https://evil.com", "evil", "/a b", "/a\tb", "/a\nb", "/a\\b", "/\u0000", "/\u007f", 5, {}, ["/"]]) {
    assert.equal(safeAppNext(bad), null, `거부: ${JSON.stringify(bad)}`);
  }
  ok("A8 앱 안 경로 — // · /\\ · 절대주소 · 공백 · 제어문자 · 역슬래시 · 문자열 아님 거부");
}
{
  const at2048 = "/" + "a".repeat(2047);
  const at2049 = "/" + "a".repeat(2048);
  assert.equal(safeAppNext(at2048), at2048, "2,048자는 된다");
  assert.equal(safeAppNext(at2049), null, "2,049자는 안 된다");
  ok("A9 앱 안 경로 길이 경계 — 2,048 됨 · 2,049 안 됨");
}

// ── 앱 안 경로에서 화면 고르기 ──
{
  assert.deepEqual(parseAppPath("/"), { root: true, page: null, probe: false });
  assert.deepEqual(parseAppPath("/?page=settings&__lively_probe=1"), { root: true, page: "settings", probe: true });
  assert.deepEqual(parseAppPath("/?__lively_probe=0"), { root: true, page: null, probe: false }, "1 이 아니면 탐침 아님");
  assert.deepEqual(parseAppPath("/?__lively_probe=true"), { root: true, page: null, probe: false }, "1 만 탐침");
  assert.deepEqual(parseAppPath("/x"), { root: false, page: null, probe: false });
  assert.equal(parseAppPath("//evil"), null);
  assert.equal(parseAppPath(["/"]), null, "배열(쿼리 두 번)은 안 됨");
  ok("A10 앱 안 경로 해석 — 화면 키 · 탐침(1 만) · 맨 앞 여부 · 틀린 경로");
}

console.log(`\n${pass} passed`);
