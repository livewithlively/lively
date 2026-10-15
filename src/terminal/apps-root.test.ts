import { strict as assert } from "node:assert";
import test from "node:test";
import os from "node:os";
import path from "node:path";
import { readFileSync } from "node:fs";

// 앱 폴더 자리(#4673) — 사양 표 G1~G6. 자리 목록(roots) · 격리 자리 해석(resolveRootPath) · 세션 · 탐색기 배선.
process.env.LIVELY_SHARED_DIR = "/work/shared";   // profiles 의 격리 공유 자리(모듈을 읽을 때 한 번 읽는다)
const { roots, installTenantSlugResolver, APPS_ROOT_KEY } = await import("./catalog.js");
const { resolveRootPath } = await import("./profiles.js");
const { sessionCwdRefusal, gateFromSets } = await import("../v6/shared-folder-store.js");
type LivelyUser = import("../context.js").LivelyUser;

const ME = { userId: "m1", email: "m1@x", scopes: [], projects: [] } as unknown as LivelyUser;
function withEnv(env: Record<string, string | undefined>, fn: () => Promise<void> | void): Promise<void> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; }
  return Promise.resolve().then(fn).finally(() => {
    for (const k of Object.keys(saved)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
}

test("G1 템플릿 없음 — apps 자리(기본 ~/apps · TERMINAL_ROOT_APPS) · 세션 안 엶 · 격리 기준 LIVELY_APPS_DIR(기본 /srv/lively/apps)", async () => {
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: undefined, LIVELY_TENANCY_MODE: undefined, TERMINAL_ROOT_APPS: undefined, LIVELY_APPS_DIR: undefined }, () => {
    const a = roots().find((r) => r.key === APPS_ROOT_KEY)!;
    assert.ok(a, "자리 목록에 apps 가 없다");
    assert.equal(a.base, path.join(os.homedir(), "apps"));
    assert.equal(a.isolatedBase, "/srv/lively/apps");
    assert.equal(a.session, false);
    assert.equal(a.perUser, undefined, "앱 폴더는 사람마다 갈리는 자리가 아니다");
  });
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: undefined, LIVELY_TENANCY_MODE: undefined, TERMINAL_ROOT_APPS: "/data/apps", LIVELY_APPS_DIR: "/srv/x/apps" }, () => {
    const a = roots().find((r) => r.key === APPS_ROOT_KEY)!;
    assert.equal(a.base, "/data/apps");
    assert.equal(a.isolatedBase, "/srv/x/apps");
  });
  //  종전 두 자리는 그대로(무회귀) — 세션을 여는 자리다.
  assert.deepEqual(roots().filter((r) => r.session !== false).map((r) => r.key), ["shared", "personal"]);
});

test("G2 템플릿 + 테넌트 — apps = <테넌트>/apps · 격리 기준도 같은 경로 · LIVELY_APPS_DIR 은 보지 않는다", async () => {
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: "/lvly/tenants/{slug}", LIVELY_APPS_DIR: "/srv/shared-by-all/apps" }, () => {
    installTenantSlugResolver(() => "lively-46e3");
    try {
      const a = roots().find((r) => r.key === APPS_ROOT_KEY)!;
      assert.equal(a.base, "/lvly/tenants/lively-46e3/apps");
      assert.equal(a.isolatedBase, "/lvly/tenants/lively-46e3/apps");
      installTenantSlugResolver(() => "acme-1a2b");
      assert.equal(roots().find((r) => r.key === APPS_ROOT_KEY)!.base, "/lvly/tenants/acme-1a2b/apps", "테넌트마다 다른 앱 폴더");
    } finally { installTenantSlugResolver(() => null); }
  });
});

test("G3 격리 해석 — apps 는 그 자리의 격리 기준 · shared 는 종전 LIVELY_SHARED_DIR(무회귀)", async () => {
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: "/lvly/tenants/{slug}" }, async () => {
    installTenantSlugResolver(() => "lively-46e3");
    try {
      assert.equal((await resolveRootPath(ME, "apps", "crm/a.txt", "box_m1")).abs, "/lvly/tenants/lively-46e3/apps/crm/a.txt");
      assert.equal((await resolveRootPath(ME, "shared", "project/1", "box_m1")).abs, "/work/shared/project/1");
      assert.equal((await resolveRootPath(ME, "personal", "x", "box_m1")).abs, "/home/box_m1/box/x");
    } finally { installTenantSlugResolver(() => null); }
  });
});

test("G4 비격리 해석 — apps 는 자리 base", async () => {
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: undefined, LIVELY_TENANCY_MODE: undefined, TERMINAL_ROOT_APPS: "/data/apps" }, async () => {
    assert.equal((await resolveRootPath(ME, "apps", "crm/a.txt", null)).abs, "/data/apps/crm/a.txt");
  });
});

test("G5 apps 에서 .. 로 나가면 거절", async () => {
  await withEnv({ LIVELY_TENANT_ROOT_TEMPLATE: undefined, LIVELY_TENANCY_MODE: undefined, TERMINAL_ROOT_APPS: "/data/apps" }, async () => {
    await assert.rejects(() => resolveRootPath(ME, "apps", "../shared/x", null), (e: { status?: number }) => e.status === 400);
  });
});

test("G6 apps 자리에서는 세션을 열지 않는다 — 판정 400 · 세션 만들기 폼 목록에서도 빠진다", () => {
  const open = gateFromSets({ hiddenFolders: new Set(), locked: new Set(), blocked: new Set() });
  assert.equal(sessionCwdRefusal(open, "apps", "crm")?.status, 400);
  assert.equal(sessionCwdRefusal(open, "apps", "")?.status, 400);
  const routes = readFileSync("src/terminal/routes.ts", "utf8");
  assert.match(routes, /roots: roots\(\)\.filter\(\(r\) => r\.session !== false\)\.map\(/, "★ 세션 만들기 폼에 세션을 열지 않는 자리(apps)를 싣는다");
});

// ── 탐색기 배선(DB · 파일시스템 바운드라 소스에서 못박는다 — source-original-route.test 선례) ─────────────
const TF = readFileSync("src/terminal/terminal-files.ts", "utf8");
function routeBody(head: string): string {
  const a = TF.indexOf(head);
  assert.ok(a >= 0, `라우트가 없다: ${head}`);
  const b = TF.indexOf("\n  app.", a + head.length);
  return TF.slice(a, b > 0 ? b : TF.length);
}

test("G7 탐색기 root=apps — 동의한 앱만 보이는 게이트 · 신원 없으면 아무 앱도 안 보인다", () => {
  const g = TF.slice(TF.indexOf("const browseGate = async"), TF.indexOf("const assertBrowseWritable"));
  assert.match(g, /if \(root !== APPS_ROOT_KEY\) return null;/);
  assert.match(g, /readableAppFoldersFor\(\{ member: viewer, scopes: /, "★ 앱 폴더 목록을 동의로 거르지 않는다 — 누구나 모든 앱 폴더를 본다");
  assert.match(g, /viewer \? await readableAppFoldersFor\(.*?\) : new Set<string>\(\)/, "신원 없는 요청에 앱 폴더를 연다");
  assert.match(g, /first === "" \|\| readable\.has\(first\)/);
});

test("G8 탐색기 root=apps — 웹 쓰기(폴더 만들기 · 이름 바꾸기 · 지우기 · 올리기)는 판정보다 먼저 403", () => {
  for (const head of ['app.post("/api/ui/terminal/browse/mkdir"', 'app.post("/api/ui/terminal/browse/rename"', 'app.delete("/api/ui/terminal/browse"', 'app.put("/api/ui/terminal/browse/file"']) {
    const r = routeBody(head);
    assert.ok(r.includes("assertBrowseWritable(req);"), `★ 앱 폴더에 웹으로 쓴다: ${head}`);
    assert.ok(r.indexOf("assertBrowseWritable(req);") < r.indexOf("resolveBrowse("), `쓰기 거절이 경로 해소보다 늦다: ${head}`);
  }
  assert.match(TF, /const assertBrowseWritable = \(req: express\.Request\): void => \{\s*if \(String\(req\.query\.root \?\? ""\) === APPS_ROOT_KEY\) throw new HttpError\(403/);
});

test("G9 탐색기 root=apps — 봉쇄는 그 앱 폴더로(자리 맨 위가 아니라)", () => {
  const r = TF.slice(TF.indexOf("async function resolveBrowse("), TF.indexOf("// 생성폼 폴더 탐색 + 공유 폴더 브라우저"));
  assert.match(r, /assertJailed\(appSeg \? path\.join\(base, appSeg\) : base, abs, osUser\)/, "★ 앱 폴더 안 링크로 다른 앱 폴더를 읽는다");
});
