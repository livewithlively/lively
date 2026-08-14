import { strict as assert } from "node:assert";
import test from "node:test";
import { installTenantSlugResolver, roots, sharedRoot } from "./catalog.js";

// ── ★★ 루트는 상수가 아니라 호출 시점 값이다 ────────────────────────────────
// 종전엔 `export const ROOTS` 라 모듈 로드 때 env 한 번 읽고 끝이었다 — 즉 "프로세스 하나 =
//  워크스페이스 하나" 가정이 상수에 굳어 있었다. 게이트웨이 하나가 여러 워크스페이스를 서비스하면
//  파일 탐색기·세션 생성·디스크 가드가 전부 **첫 로드 시점 테넌트**의 경로를 본다 = 남의 파일이 보인다.

test("★ 템플릿이 없으면 종전과 완전히 같다(OSS 무회귀)", () => {
  const saved = { t: process.env.LIVELY_TENANT_ROOT_TEMPLATE, s: process.env.TERMINAL_ROOT_SHARED };
  delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  installTenantSlugResolver(() => "acme");     // 슬러그가 있어도 템플릿이 없으면 무시한다
  try {
    assert.equal(sharedRoot().base, "/srv/ws");
  } finally {
    installTenantSlugResolver(() => null);
    if (saved.t === undefined) delete process.env.LIVELY_TENANT_ROOT_TEMPLATE; else process.env.LIVELY_TENANT_ROOT_TEMPLATE = saved.t;
    if (saved.s === undefined) delete process.env.TERMINAL_ROOT_SHARED; else process.env.TERMINAL_ROOT_SHARED = saved.s;
  }
});

test("★★ 템플릿 + 컨텍스트가 있으면 테넌트 경로를 준다", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/var/lib/lvly/tenants/{slug}/work";
  installTenantSlugResolver(() => "acme-1a2b");
  try {
    assert.equal(sharedRoot().base, "/var/lib/lvly/tenants/acme-1a2b/work/shared");
    assert.equal(roots().find((r) => r.key === "personal")!.base, "/var/lib/lvly/tenants/acme-1a2b/work/personal");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  }
});

// ★★★ 같은 프로세스에서 테넌트가 바뀌면 경로도 바뀌어야 한다 — 이게 상수를 없앤 이유 전부다.
test("★★★ 요청마다 다른 테넌트면 다른 경로다(값이 굳지 않는다)", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/t/{slug}";
  let who = "a";
  installTenantSlugResolver(() => who);
  try {
    assert.equal(sharedRoot().base, "/t/a/shared");
    who = "b";
    assert.equal(sharedRoot().base, "/t/b/shared", "값이 굳었다 — 남의 파일을 보게 된다");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
  }
});

// ★ 슬러그는 경로에 들어간다. 형식을 못 믿을 때는 **테넌트 경로를 쓰지 않는다** — 폴백이 아니라
//  무시다. 이상한 슬러그로 경로를 만들면 그게 곧 경로 탈출이다.
test("★ 안전하지 않은 슬러그는 테넌트 경로를 만들지 않는다", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/t/{slug}";
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  try {
    for (const bad of ["../etc", "a/b", "A-UP", "", "a b", ".hidden"]) {
      installTenantSlugResolver(() => bad);
      assert.equal(sharedRoot().base, "/srv/ws", `허용되면 안 됨: ${bad}`);
    }
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
    delete process.env.TERMINAL_ROOT_SHARED;
  }
});

// ★ 템플릿에 {slug} 가 없으면 모든 테넌트가 **같은 디렉터리**를 쓴다 — 그건 격리가 0 이다.
test("★ {slug} 없는 템플릿은 무시한다(전 테넌트 공유가 되면 안 된다)", () => {
  process.env.LIVELY_TENANT_ROOT_TEMPLATE = "/var/lib/lvly/work";
  process.env.TERMINAL_ROOT_SHARED = "/srv/ws";
  installTenantSlugResolver(() => "acme");
  try {
    assert.equal(sharedRoot().base, "/srv/ws");
  } finally {
    installTenantSlugResolver(() => null);
    delete process.env.LIVELY_TENANT_ROOT_TEMPLATE;
    delete process.env.TERMINAL_ROOT_SHARED;
  }
});
