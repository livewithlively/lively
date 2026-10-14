// 셸 작업 폴더의 공개범위 판정(#4687) — 셸이 뜨는 순간 작업 폴더 아래까지 공개범위를 판정한다.
//
// 왜: 셸은 작업 폴더 **아래 전부**를 파일로 본다. 그래서 링크·MCP·REST 의 판정(sharedFolderGate)과 같은 기준을
//  셸을 띄우는 두 자리 — 세션 만들기(createSession)와 중앙 위탁 워커(spawnTaskSession) — 의 작업 폴더에도 건다
//  (shared-folder-store.ts 머리말 «이 잠금의 한계»). 결정: 2026-10-14, 태스크 #4687.
//
// 사양 엣지 표(행 = 시험 하나 이상). 판정 결과: 연다 · 403(폴더는 보이지만 아래에 못 보는 곳) · 404(폴더 자체가 안 보임)
//   E1  맨 위 · 못 보는 곳 없음(두 집합 빈 것)                         → 연다
//   E2  맨 위 · 숨은 프로젝트 project/12                               → 403
//   E3  project · 숨은 project/12                                       → 403
//   E4  project/12(숨은 그 폴더)                                        → 404
//   E5  project/12/docs(숨은 폴더 안)                                   → 404
//   E6  project/34 · 숨은 project/12                                    → 연다
//   E7  이름 겹침 경계(양쪽 방향) project/123 · project/1 · 숨은 project/12 → 연다
//   E8  legacy-project · DB 값 project/7                                → 403 (반대 방향도)
//   E9  legacy-project/7/docs · DB 값 project/7                         → 404
//   E10 영업 · 막힌 공유 폴더 영업/계약                                  → 403
//   E11 영업/계약 · 그 안                                               → 404
//   E12 이름 겹침 경계(양쪽 방향) 영업/계약서 · 영업/계 · 막힌 영업/계약   → 연다
//   E13 위로 새는 경로(영업/../.. · a/../b)                             → 404 (resolveRootPath 는 a/../b 를 b 로 풀지만 판정은 막는다)
//   E14 같은 폴더의 다른 표기(/project/12 · project\12 · ./project//12)  → 404
//   E15 더 깊게 적힌 숨은 폴더 project/a/b — 그 안 · 그 자신 · 그 위      → 404 · 404 · 403
//   E16 판정기 «아래까지» 는 자기가 보일 때만 참(숨은 폴더 안은 아래가 비어도 거짓)
//   E17 personal 자리                                                   → 판정 없이 연다(판정기에 묻지도 않는다 · DB 를 타지 않는다)
//   E18 모르는 자리(예: 앞으로 생길 apps)                               → 400 — 규칙을 정하기 전까지 띄우지 않는다
//   E19 내부 신원(viewer 없음) · shared 맨 위                            → 연다(DB 를 타지 않는다)
//   E20 createSession — 작업 폴더를 정한 뒤 · 폴더를 만들기 전 판정, 능력이 없으면(노드) 건너뜀
//   E21 spawnTaskSession(중앙 위탁 워커) — 같은 자리 규칙(createSession 을 안 타는 두 번째 문)
//   E22 게이트웨이가 능력을 viewerOf 로 꽂는다(이름 배선은 scripts/gateway-capabilities-wired.test.mjs)
// 실행: npm run build && node --test dist/v6/shared-folder-session-cwd.test.js
import { strict as assert } from "node:assert";
import test from "node:test";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gateFromSets, sessionCwdRefusal, assertSessionCwdVisibleTo, type SharedFolderGate } from "./shared-folder-store.js";

const S = (...xs: string[]): Set<string> => new Set(xs);

/** 표의 한 행 — 숨은 프로젝트 폴더·막힌 ACL 경로로 판정기를 만들고 공유 자리 셸을 물어 «연다/403/404» 로 답한다. */
function verdict(subpath: string, opts: { hidden?: Set<string>; blocked?: Set<string> } = {}): "연다" | 403 | 404 {
  const blocked = opts.blocked ?? S();
  //  막힌 것은 곧 잠긴 것이다(locked ⊇ blocked) — locked 는 배지용이라 판정에 쓰이지 않는다.
  const gate = gateFromSets({ hiddenFolders: opts.hidden ?? S(), locked: blocked, blocked });
  const e = sessionCwdRefusal(gate, "shared", subpath);
  if (!e) return "연다";
  assert.ok(e.status === 403 || e.status === 404, `뜻밖의 상태 ${e.status}`);
  return e.status as 403 | 404;
}

test("E1 못 보는 곳이 없으면 맨 위에서도 연다 — 잠금을 안 쓰는 워크스페이스는 지금과 같다", () => {
  assert.equal(verdict(""), "연다");
  assert.equal(verdict("project"), "연다");
});

test("★ E2·E3 숨은 프로젝트가 있으면 맨 위·project/ 에서는 안 연다(403) — 이 판정의 본체", () => {
  const hidden = S("project/12");
  assert.equal(verdict("", { hidden }), 403);
  assert.equal(verdict("project", { hidden }), 403);
});

test("★ E4·E5 숨은 프로젝트 폴더 자체나 그 안에서는 404 — 있다는 것도 알리지 않는다", () => {
  const hidden = S("project/12");
  assert.equal(verdict("project/12", { hidden }), 404);
  assert.equal(verdict("project/12/docs", { hidden }), 404);
});

test("E6·E7 다른 프로젝트 폴더는 그대로 연다 — 이름 앞부분만 겹치는 형제도(양쪽 방향)", () => {
  const hidden = S("project/12");
  assert.equal(verdict("project/34", { hidden }), "연다");
  assert.equal(verdict("project/123", { hidden }), "연다", "고른 폴더가 숨은 폴더보다 긴 쪽");
  assert.equal(verdict("project/1", { hidden }), "연다", "고른 폴더가 숨은 폴더 이름의 앞부분인 쪽 — project/1 아래에 project/12 는 없다");
  assert.equal(verdict("영업", { hidden }), "연다");
});

test("E8·E9 완료 프로젝트 폴더는 project/ · legacy-project/ 어느 이름으로 적혀 있어도 같은 폴더다", () => {
  assert.equal(verdict("legacy-project", { hidden: S("project/7") }), 403);
  assert.equal(verdict("project", { hidden: S("legacy-project/7") }), 403);
  assert.equal(verdict("legacy-project/7/docs", { hidden: S("project/7") }), 404);
  assert.equal(verdict("legacy-project/8", { hidden: S("project/7") }), "연다");
});

test("★ E10·E11·E12 막힌 공유 폴더 — 위에서는 403 · 그 폴더와 그 안은 404 · 이름이 겹치는 옆 폴더는 연다", () => {
  const blocked = S("영업/계약");
  assert.equal(verdict("", { blocked }), 403);
  assert.equal(verdict("영업", { blocked }), 403);
  assert.equal(verdict("영업/계약", { blocked }), 404);
  assert.equal(verdict("영업/계약/하위", { blocked }), 404);
  assert.equal(verdict("영업/계약서", { blocked }), "연다", "고른 폴더가 막힌 폴더보다 긴 쪽");
  assert.equal(verdict("영업/계", { blocked }), "연다", "고른 폴더가 막힌 폴더 이름의 앞부분인 쪽");
  assert.equal(verdict("영업/공개", { blocked }), "연다");
});

test("E13 위로 새는 경로는 열지 않는다 — 정규화가 새면 판정이 통째로 무너진다", () => {
  assert.equal(verdict("영업/../.."), 404);
  assert.equal(verdict("a/../b"), 404, "자리 해석은 a/../b 를 b 로 풀지만, 판정은 `..` 이 든 경로를 받지 않는다(안전한 쪽)");
});

test("E14 같은 폴더의 다른 표기도 같은 판정을 받는다", () => {
  const hidden = S("project/12");
  for (const spelled of ["/project/12", "project\\12", "./project//12", "project/12/"]) {
    assert.equal(verdict(spelled, { hidden }), 404, `표기 ${JSON.stringify(spelled)}`);
  }
});

test("★ E15 더 깊게 적힌 숨은 폴더 — 그 안 · 그 자신은 404, 그 위는 403 (두 조각을 가정하지 않는다)", () => {
  const hidden = S("project/a/b");
  assert.equal(verdict("project/a/b/c", { hidden }), 404);
  assert.equal(verdict("project/a/b", { hidden }), 404);
  assert.equal(verdict("project/a", { hidden }), 403);
  assert.equal(verdict("project/a/bc", { hidden }), "연다", "이름 겹침 경계");
});

test("E16 판정기의 «아래까지» 는 자기가 보일 때만 참이다 — 숨은 폴더 안은 아래가 비어도 거짓", () => {
  const gate = gateFromSets({ hiddenFolders: S("project/12"), locked: S(), blocked: S() });
  assert.equal(gate.subtreeOk("project/12/docs"), false);
  assert.equal(gate.subtreeOk("project/34"), true);
});

/** 판정기를 몇 번 물었는지 센다 — «묻지도 않는다» 를 부작용으로 잰다. */
function countingGate(): { gate: SharedFolderGate; calls: () => number } {
  let n = 0;
  return {
    gate: { ok: () => { n++; return false; }, restricted: () => { n++; return false; }, subtreeOk: () => { n++; return false; } },
    calls: () => n,
  };
}

test("E17 personal 자리는 판정하지 않는다 — 판정기에 묻지도, DB 를 타지도 않는다", async () => {
  const { gate, calls } = countingGate();
  assert.equal(sessionCwdRefusal(gate, "personal", "liv"), null);
  assert.equal(calls(), 0, "personal 자리인데 판정기를 물었다");
  // 이 시험엔 DB 가 없다 — 본체가 DB 를 타면 여기서 던진다.
  await assertSessionCwdVisibleTo("member-a", "personal", "liv");
});

test("★ E18 모르는 자리는 규칙을 정하기 전까지 띄우지 않는다(400) — 조용히 통과시키지 않는다", async () => {
  const { gate, calls } = countingGate();
  assert.equal(sessionCwdRefusal(gate, "apps", "memo")?.status, 400);
  assert.equal(calls(), 0);
  await assert.rejects(assertSessionCwdVisibleTo("member-a", "apps", "memo"), (e: { status?: number }) => e.status === 400);
});

test("E19 내부 신원(viewer 없음)은 지금 판정처럼 통과한다 — DB 를 타지 않는다", async () => {
  await assertSessionCwdVisibleTo(null, "shared", "");
});

function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "web"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

/**
 * 셸을 띄우는 함수 본문에서 «작업 폴더를 정함 → 판정 → 폴더를 만듦» 순서와, 능력이 없으면 건너뛰는 꼴을 잰다.
 *  소스 글을 읽는 구조 단언이다(wired 가드와 같은 방식) — 순서가 바뀌거나 판정이 빠지면 빨간불이 된다.
 */
function assertGateOrder(file: string, fnHead: string, resolveCall: string, createCall: string, callArgs: string): void {
  const src = readSrc(file);
  const start = src.indexOf(fnHead);
  assert.ok(start >= 0, `${file}: ${fnHead} 를 찾지 못했다 — 이름이 바뀌었으면 이 시험을 같이 고쳐라`);
  const body = src.slice(start);
  const resolved = body.indexOf(resolveCall);
  const take = body.search(/const (\w+) = gatewayCapability\("assertSessionCwdVisible"\);/);
  const create = body.indexOf(createCall);
  assert.ok(resolved >= 0 && take >= 0 && create >= 0, `${file}: 자리를 못 찾았다(작업 폴더 ${resolved} · 판정 ${take} · 폴더 만들기 ${create})`);
  assert.ok(resolved < take && take < create, `${file}: 판정은 작업 폴더를 정한 뒤, 폴더를 만들기 전에 있어야 한다(거절한 자리에 빈 폴더를 남기지 않는다)`);
  const name = body.slice(take).match(/const (\w+) = gatewayCapability/)![1];
  assert.match(body.slice(take, create), new RegExp(`if \\(${name}\\) await ${name}\\(${callArgs}\\)`),
    `${file}: 능력이 없으면(노드) 건너뛰고, 있으면 고른 자리·경로 그대로 물어야 한다`);
}

test("★ E20 createSession 이 작업 폴더를 정한 뒤 · 폴더를 만들기 전에 판정하고, 능력이 없으면(노드) 건너뛴다", () => {
  assertGateOrder("src/terminal/sessions.ts", "export async function createSession(",
    "await resolveRootPath(user, rootKeyUsed, subpathUsed", "await memberMkdir(osUser, target)", "user, rootKeyUsed, subpathUsed");
});

test("★ E21 중앙 위탁 워커(spawnTaskSession)도 같은 순서로 판정한다 — createSession 을 안 타는 두 번째 문", () => {
  assertGateOrder("src/node/tasks.ts", "async function spawnTaskSessionUnguarded(",
    "await resolveRootPath(user, input.rootKey, sub", "await provisionTaskRepo(", "user, input.rootKey, sub");
  //  레포 준비가 없는 위탁도 작업 폴더를 만들기 전에 판정이 있어야 한다.
  const body = readSrc("src/node/tasks.ts");
  const fn = body.slice(body.indexOf("async function spawnTaskSessionUnguarded("));
  assert.ok(fn.search(/gatewayCapability\("assertSessionCwdVisible"\)/) < fn.indexOf("await prepareTaskDir("), "작업 폴더(prepareTaskDir)보다 판정이 먼저다");
});

test("E22 게이트웨이는 그 능력을 viewerOf 로 꽂는다 — 링크·MCP 와 같은 열람 신원", () => {
  const src = readSrc("src/index.ts");
  assert.match(src, /assertSessionCwdVisible:\s*\(user, rootKey, subpath\)\s*=>\s*assertSessionCwdVisibleTo\(viewerOf\(user\), rootKey, subpath\)/);
});
