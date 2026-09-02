// 매니지드 로그아웃이 CP 세션까지 끝내는가 (#2536) — 웹 모듈 계약 검증.
//
// 증상(장원준 2026-09-02): 매니지드에서 로그아웃 → 로그인 창 1~2초 → 자동 재로그인. 코어 로그아웃은 테넌트 세션만 끝내고
//  게이트를 띄웠고, 게이트는 CP 로 튕기고, CP 는 살아 있는 자기 세션(lvly_sid)으로 묻지 않고 재입장시켰다.
//
// 사양·엣지 표(spec-failfirst):
//  T1 CP 주소가 있고 호스트가 다르면 → CP 의 /auth/logout 으로, 돌아올 자리(to=현재 주소)를 들고 간다
//  T2 CP 주소가 서브패스(https://host/cp)면 그 아래 /auth/logout 이다 — 접두사를 잃으면 다른 문을 두드린다(#1541 계열)
//  T3 CP 주소가 없다(셀프호스팅) → null(종전 게이트)
//  T4 CP 주소가 같은 호스트다(리다이렉트 루프 방지 규칙과 동일) → null
//  T5 깨진 주소 → null(던지지 않는다 — 로그아웃은 끝까지 가야 한다)
//  C1 core.ts 의 logout 은 이 문을 지나야 한다 — 게이트만 띄우면 CP 가 도로 로그인시킨다
//  C2 main.ts(클래식 셸)에 **자기 로그아웃 경로가 따로 있으면 안 된다** — 문이 둘이면 하나만 고쳐지고 다른 하나는 도로 재로그인된다
//
// 웹 모듈은 src 테스트가 import 할 수 없어(별도 tsconfig·번들) 소스를 그 자리에서 transpile 해 data: URL 로 import 한다.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname;   // dist/auth → 레포 루트의 web/ (src 와 같은 깊이)
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");

async function loadPure<T>(rel: string): Promise<T> {
  const js = ts.transpileModule(readWeb(rel), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
  return (await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`)) as T;
}

test("T1 매니지드 — CP 의 로그아웃 문으로, 돌아올 자리를 들고", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string | null | undefined, here: string) => string | null }>("lib/logout-target.ts");
  const here = "https://acme.app.lvly.io/ui/#/s/box-a-1";
  const got = logoutRedirectTarget("https://app.lvly.io", here);
  assert.ok(got, "🔴 CP 주소가 있는데 문이 없다 — 게이트만 띄우면 CP 세션으로 도로 로그인된다");
  const u = new URL(got!);
  assert.equal(u.origin + u.pathname, "https://app.lvly.io/auth/logout");
  assert.equal(u.searchParams.get("to"), here, "재로그인 뒤 같은 자리로 돌아와야 한다");
});

test("T2 서브패스 CP — 접두사를 보존한다", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string, here: string) => string | null }>("lib/logout-target.ts");
  const got = logoutRedirectTarget("https://dev.lvly.io/preview/p1/", "https://acme.app.lvly.io/ui/");
  assert.ok(got);
  assert.equal(new URL(got!).pathname, "/preview/p1/auth/logout", "🔴 서브패스가 날아가면 다른 게이트웨이의 문을 두드린다");
});

test("T3·T4·T5 셀프호스팅·같은 호스트·깨진 주소 → null(종전 게이트)", async () => {
  const { logoutRedirectTarget } = await loadPure<{ logoutRedirectTarget: (u: string | null | undefined, here: string) => string | null }>("lib/logout-target.ts");
  const here = "https://olddev.lvly.io/ui/";
  assert.equal(logoutRedirectTarget(null, here), null, "T3 셀프호스팅");
  assert.equal(logoutRedirectTarget("", here), null, "T3 빈 값");
  assert.equal(logoutRedirectTarget("https://olddev.lvly.io", here), null, "🔴 T4 같은 호스트로 보내면 자기 자신에게 튕겨 루프다");
  assert.equal(logoutRedirectTarget("nope://[", here), null, "T5 깨진 주소는 던지지 않는다");
});

test("C1 core.ts 의 logout 은 CP 로그아웃 문을 지난다", () => {
  const core = readWeb("core.ts");
  const fn = core.slice(core.indexOf("async function logout("));
  assert.ok(fn.includes("logoutRedirectTarget("), "🔴 logout 이 게이트만 띄운다 — 매니지드에선 CP 세션으로 자동 재로그인된다");
  assert.ok(/location\.replace\(/.test(fn), "문이 있으면 그 문으로 **최상위 이동**해야 한다(fetch 로는 남의 오리진 쿠키를 못 지운다)");
  // C1b 떠나기로 정한 뒤 게이트가 로그인 문으로 덮어쓰면 안 된다 — 로그아웃 직후 배경 401 이 showGate 를 부르는 경합.
  assert.ok(/leavingToLogout\s*=\s*true/.test(fn), "🔴 로그아웃이 떠나는 깃발을 세우지 않는다 — 배경 401 의 게이트가 로그인 문으로 덮어쓴다");
  const gate = core.slice(core.indexOf("function showGate("), core.indexOf("async function logout("));
  assert.ok(/leavingToLogout/.test(gate), "🔴 게이트가 그 깃발을 보지 않는다");
});

test("C2 클래식 셸(main.ts)은 자기 로그아웃 경로를 갖지 않는다 — 문은 하나(core.logout)", () => {
  const main = readWeb("main.ts");
  assert.ok(!main.includes("fetch(apiUrl('/api/ui/logout')"), "🔴 main.ts 에 별도 로그아웃 fetch 가 있다 — 그 경로는 CP 세션을 남긴다");
  assert.ok(/\blogout\(\)/.test(main), "클래식 셸 버튼은 core 의 logout() 을 부른다");
});
