#!/usr/bin/env node
// scripts/route-collision.test.mjs — **한 주소에 주인이 둘이면 진 쪽은 말없이 죽는다** (#4114).
//
// 실측 고장(2026-09-21, 상민 신고): 세션 화면 곁칸 [자료] 의 [새 폴더]·우클릭 [이름 바꾸기] 가
// «아무 일도 안 일어남» 으로 죽어 있었다. 화면 로직은 멀쩡했고 원인은 **주소 다툼**이었다:
//   · capabilities/projects-v6.ts  project_rename_v6 → POST /api/ui/v6/projects/:id/rename  {name}       (프로젝트 개명)
//   · project/project-routes.ts    파일 이름 변경     → POST /api/ui/v6/projects/:id/rename  {path,name}   (파일 개명)
// express 는 먼저 등록된 쪽만 부른다(registerWebUi 의 restMounts 가 registerProjectV6Routes 보다 먼저 돈다).
// 그래서 파일 이름 변경 요청이 **프로젝트 개명**으로 들어갔고, 사람이 지은 이름은 못 덮는 규약 덕에
// 200 {applied:false,reason:"taken"} 으로 조용히 끝났다 — 화면엔 오류조차 안 떴다. 이름이 **자동으로 붙은**
// 프로젝트였다면 그 자리에서 프로젝트 이름이 조용히 바뀐다. 이 결함은 «안 된다» 로도 «남의 것을 고친다» 로도 나타난다.
//
// 성질상 눈으로는 못 잡는다 — 두 등록이 다른 파일에 살고, 충돌해도 부팅은 멀쩡하고, 진 쪽은 아무 말이 없다.
// 그래서 소스에서 **등록되는 주소를 전부 모아** 같은 (메서드, 경로) 가 둘 이상인지 본다.
//
// 예외는 한 종류뿐 — **EE 미탑재 폴백**(핸들러가 `eeRequired`). 능력이 탑재되면 그쪽이 가져가고, 없으면
// 404 JSON 으로 «이건 Enterprise 기능» 을 알리려고 일부러 같은 자리에 둔 것이다(src/index.ts — `ee()`·
// `registry.has()` 가 없을 때만 등록). 경로 화이트리스트가 아니라 **핸들러의 구조**로 거른다(목록은 썩는다).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const rel = (f) => path.relative(ROOT, f);

/** 파라미터 **이름**은 주소의 정체가 아니다 — express 에게 `:id` 와 `:name` 은 같은 자리다. */
const norm = (p) => p.replace(/:[A-Za-z_]\w*/g, ":p").replace(/\/+$/, "") || "/";

/** 순수 판정 — 모은 라우트에서 «주인이 둘» 인 자리를 고른다. EE 폴백만 예외. */
export function findCollisions(routes) {
  const byKey = new Map();
  for (const r of routes) {
    const k = `${r.method} ${norm(r.path)}`;
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(r);
  }
  const out = [];
  for (const [key, list] of byKey) {
    const real = list.filter((r) => r.handler !== "eeRequired");
    if (real.length >= 2) out.push({ key, routes: real });
  }
  return out;
}

function tsFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...tsFiles(p));
    else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") && !e.name.endsWith(".d.ts")) out.push(p);
  }
  return out;
}
const FILES = tsFiles(SRC);

/** `${prefix}` 로 붙이는 자리(mountProjectRoutes) — 실제로 넘기는 값으로 펼친다. 하나도 못 찾으면 알려진 값으로. */
function prefixes() {
  const found = new Set();
  for (const f of FILES) for (const m of readFileSync(f, "utf8").matchAll(/\bprefix:\s*"(\/[^"]+)"/g)) found.add(m[1]);
  return found.size ? [...found] : ["/api/ui/v6/projects"];
}

/** 소스에서 등록되는 주소를 모은다 — ① capability 의 REST 마운트 ② 손으로 건 express 라우트. */
function collectRoutes() {
  const routes = [];
  const PREFIX = prefixes();
  for (const f of FILES) {
    const s = readFileSync(f, "utf8");
    for (const m of s.matchAll(/method:\s*"(GET|POST|PUT|DELETE|PATCH)"\s*,\s*paths:\s*\[([^\]]*)\]/g)) {
      for (const q of m[2].match(/"([^"]+)"/g) || []) routes.push({ method: m[1], path: q.slice(1, -1), file: f, kind: "capability", handler: "" });
    }
    for (const m of s.matchAll(/\bapp\.(get|post|put|delete|patch)\(\s*(`[^`]*`|"[^"]*"|'[^']*')\s*,\s*([A-Za-z_$][\w$]*)?/g)) {
      const raw = m[2].slice(1, -1);
      const expanded = raw.includes("${prefix}") ? PREFIX.map((p) => raw.replace("${prefix}", p)) : [raw];
      for (const p of expanded) {
        if (!p.startsWith("/") || p.includes("${")) continue;   // 변수로 만든 주소는 이 잣대 밖(판정 불가)
        routes.push({ method: m[1].toUpperCase(), path: p, file: f, kind: "express", handler: m[3] || "" });
      }
    }
  }
  return routes;
}

// ── 판정기 자신이 살아 있나 — 심어 둔 충돌을 실제로 집어내는지 먼저 본다 ────────────────────
//  («충돌 0건» 은 정규식이 죽어도 초록이다. 그 거짓 초록을 막는 자리다.)
test("판정기 — 파라미터 이름만 다른 같은 자리를 충돌로 집는다 · EE 폴백은 봐준다", () => {
  const planted = [
    { method: "POST", path: "/api/ui/v6/projects/:id/rename", file: "a.ts", kind: "capability", handler: "" },
    { method: "POST", path: "/api/ui/v6/projects/:pid/rename", file: "b.ts", kind: "express", handler: "auth" },
    { method: "GET", path: "/api/ui/only-one", file: "c.ts", kind: "express", handler: "auth" },
    { method: "POST", path: "/api/ui/v6/projects/:id/file/rename", file: "b.ts", kind: "express", handler: "auth" },
  ];
  const hit = findCollisions(planted);
  assert.equal(hit.length, 1, "파라미터 이름만 다른 같은 자리를 못 집었다");
  assert.equal(hit[0].key, "POST /api/ui/v6/projects/:p/rename");

  // 메서드가 다르면 다른 자리다(과잉 검출 방지)
  assert.equal(findCollisions([
    { method: "GET", path: "/x/:a", file: "a.ts", kind: "capability", handler: "" },
    { method: "POST", path: "/x/:b", file: "b.ts", kind: "express", handler: "auth" },
  ]).length, 0, "메서드가 다른데 충돌로 셌다");

  // EE 미탑재 폴백은 «능력이 없을 때만» 서는 자리 — 봐준다
  assert.equal(findCollisions([
    { method: "GET", path: "/api/ui/audit-export/plan", file: "ee.ts", kind: "express", handler: "auth" },
    { method: "GET", path: "/api/ui/audit-export/plan", file: "index.ts", kind: "express", handler: "eeRequired" },
  ]).length, 0, "EE 폴백을 충돌로 셌다");

  // 폴백이 아닌 셋이 겹치면 둘만 남기고 넘어가지 않는다
  assert.equal(findCollisions([
    { method: "GET", path: "/x", file: "a.ts", kind: "express", handler: "auth" },
    { method: "GET", path: "/x", file: "b.ts", kind: "express", handler: "eeRequired" },
    { method: "GET", path: "/x", file: "c.ts", kind: "express", handler: "auth" },
  ])[0].routes.length, 2, "폴백을 뺀 실제 주인만 세야 한다");
});

test("수집기 — 소스에서 주소를 실제로 긁어 온다(정규식이 죽으면 이 테스트가 먼저 빨개진다)", () => {
  const routes = collectRoutes();
  assert.ok(routes.length > 300, `주소를 못 모았다(${routes.length}건) — 수집 정규식이 깨졌는지 보라`);
  assert.ok(routes.some((r) => r.kind === "capability"), "capability REST 마운트를 하나도 못 모았다");
  assert.ok(routes.some((r) => r.kind === "express"), "손으로 건 express 라우트를 하나도 못 모았다");
  // `${prefix}` 보간이 실제로 펼쳐졌나 — 안 펼쳐지면 파일 라우트 전부가 판정에서 빠진다(조용한 구멍).
  assert.ok(routes.some((r) => r.path === "/api/ui/v6/projects/:id/file/rename"),
    "`${prefix}` 를 실제 주소로 못 펼쳤다 — 프로젝트 파일 라우트가 통째로 판정 밖이다");
  assert.ok(prefixes().includes("/api/ui/v6/projects"), "prefix 를 소스에서 못 읽었다");
});

test("★ 같은 (메서드, 경로) 에 주인이 둘 이상인 자리가 없다", () => {
  const bad = findCollisions(collectRoutes());
  const report = bad.map((b) => `${b.key}\n` + b.routes.map((r) => `      · ${r.kind.padEnd(10)} ${r.path}  (${rel(r.file)})`).join("\n"));
  assert.equal(bad.length, 0,
    "같은 주소에 핸들러가 둘 이상이다 — express 는 먼저 등록된 쪽만 부르고 나머지는 조용히 죽는다(#4114):\n    " + report.join("\n    "));
});

test("#4114 — 파일 이름 변경은 프로젝트 개명과 다른 자리에 살고, 부르는 쪽도 그 자리를 본다", () => {
  const fileRoutes = readFileSync(path.join(SRC, "project/project-routes.ts"), "utf8");
  assert.match(fileRoutes, /app\.post\(`\$\{prefix\}\/:id\/file\/rename`/, "파일 이름 변경 라우트가 `${prefix}/:id/file/rename` 이 아니다");
  assert.doesNotMatch(fileRoutes, /app\.post\(`\$\{prefix\}\/:id\/rename`/, "파일 라우트가 프로젝트 개명 주소로 되돌아갔다");

  // 서버만 옮기고 화면을 안 고치면 화면은 여전히 프로젝트 개명으로 쏜다 — 양쪽을 함께 못박는다.
  for (const [f, needle] of [
    ["web/v2/panes-files.ts", "pUrl('/file/rename')"],
    ["web/projects/files-cards.ts", "B + id + '/file/rename'"],
  ]) assert.ok(readFileSync(path.join(ROOT, f), "utf8").includes(needle), `${f} 가 ${needle} 을 안 쓴다`);

  // 배포 전에 열려 있던 낡은 탭은 옛 주소로 계속 쏜다 — 그때 프로젝트가 개명되지 않게 능력 쪽이 막는다.
  const cap = readFileSync(path.join(SRC, "capabilities/projects-v6.ts"), "utf8");
  assert.match(cap, /typeof b\.path === "string"[\s\S]{0,400}?HttpError\(400/,
    "project_rename_v6 의 REST parse 가 파일 이름 변경 모양({path,name})을 안 막는다");
});
