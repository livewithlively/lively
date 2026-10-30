// server 실행기(#5053 앱 v2-42) 선언 검사 단위 시험 — 사양 엣지 표(spec-5053) B3 · 틀의 설치 검사와 이어진 모양. 부르기(DB · 함수)는 app-server-call.pg-test.
// 실행: npm run build && node --test dist/apps/app-mcp-server-executor.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { serverExecutor, registerServerExecutor } from "./app-mcp-server-executor.js";
import { appMcpExecutor, appMcpExecutorKinds } from "./app-mcp-executors.js";
import { assertAppMcpToolsInstallable, type AppMcpToolDecl } from "./app-mcp-decl.js";
import { HttpError } from "../http-error.js";

const decl = (run: Record<string, unknown>): AppMcpToolDecl => ({
  name: "ask_policy", description: "정책을 묻는다", input: { type: "object", properties: {} }, level: "L0", run: { kind: "server", ...run },
});
const withServer = { id: "wiki", title: "정책 위키", version: "0.1.0", web: { server: { start: "node server.js" } } };
const validate = (run: Record<string, unknown>, manifest: unknown = withServer): HttpError | null => {
  try { serverExecutor.validate!(decl(run), manifest); return null; } catch (e) { return e as HttpError; }
};

test("B3a 맞는 선언 — «POST /경로» · «/경로» · 서버를 선언한 판(web.server 객체 · true)", () => {
  assert.equal(validate({ route: "POST /api/tools/ask" }), null);
  assert.equal(validate({ route: "/api/tools/ask" }), null);
  assert.equal(validate({ route: "/api/tools/ask" }, { ...withServer, web: { server: true } }), null);
});

test("B3b run 의 모르는 칸은 400(오타가 곧 다른 뜻) — 칸 이름을 말한다", () => {
  const e = validate({ route: "/x", timeout_s: 60, mode: "job" });
  assert.ok(e instanceof HttpError && e.status === 400 && /모르는 칸/.test(e.message) && /timeout_s/.test(e.message) && /mode/.test(e.message), String(e?.message));
});

test("B3g background — true · false 는 받고, 그 밖(글자 «true» · 1 · null)은 400", () => {
  assert.equal(validate({ route: "/x", background: true }), null);
  assert.equal(validate({ route: "/x", background: false }), null);
  for (const v of ["true", 1, null]) {
    const e = validate({ route: "/x", background: v });
    assert.ok(e instanceof HttpError && e.status === 400 && /background/.test(e.message), `${JSON.stringify(v)} → ${e?.message}`);
  }
});

test("B3c 라우트가 없거나 틀리면 400 — 라우트 판정의 까닭 그대로", () => {
  for (const [route, re] of [[undefined, /필요합니다/], ["GET /x", /POST 로만/], ["/_lively/x", /라이블리 자리/], ["x", /\/ 로 시작/]] as const) {
    const e = validate(route === undefined ? {} : { route });
    assert.ok(e instanceof HttpError && e.status === 400 && re.test(e.message), `${String(route)} → ${e?.message}`);
  }
});

test("B3d ★ (새 조건) 그 판이 앱 서버를 선언하지 않았으면 400 — web 없음 · server 없음 · server false · 매니페스트 없음", () => {
  for (const m of [{ id: "wiki", title: "t", version: "1" }, { ...withServer, web: {} }, { ...withServer, web: { server: false } }, null]) {
    const e = validate({ route: "/api/tools/ask" }, m);
    assert.ok(e instanceof HttpError && e.status === 400 && /web\.server/.test(e.message), `${JSON.stringify(m)} → ${e?.message}`);
  }
});

test("B3e 틀의 설치 검사와 이어진다 — 등록하면 kind 'server' 를 받고(자리 [mcp_tools.<i>] 가 붙은 400) · 걷으면 모르는 실행기", async () => {
  const off = registerServerExecutor();
  try {
    assert.ok(appMcpExecutorKinds().includes("server") && appMcpExecutor("server") === serverExecutor);
    const ok = await assertAppMcpToolsInstallable({ ...withServer, mcp_tools: [{ name: "ask_policy", description: "정책을 묻는다", run: { kind: "server", route: "POST /api/tools/ask" } }] });
    assert.equal(ok.length, 1);
    assert.equal(ok[0]!.level, "L1", "level 을 안 적으면 L1(쓰는 도구)");
    const bad = await assertAppMcpToolsInstallable({ ...withServer, mcp_tools: [{ name: "ok_one", description: "d", run: { kind: "server", route: "/a" } }, { name: "bad_one", description: "d", run: { kind: "server", route: "GET /a" } }] })
      .then(() => null, (e: unknown) => e as HttpError);
    assert.ok(bad instanceof HttpError && bad.status === 400 && /\[mcp_tools\.1\]/.test(bad.message) && /POST 로만/.test(bad.message), String(bad?.message));
    const noServer = await assertAppMcpToolsInstallable({ id: "x", title: "x", version: "1", mcp_tools: [{ name: "q", description: "d", run: { kind: "server", route: "/a" } }] })
      .then(() => null, (e: unknown) => e as HttpError);
    assert.ok(noServer instanceof HttpError && /\[mcp_tools\.0\]/.test(noServer.message) && /web\.server/.test(noServer.message), String(noServer?.message));
  } finally { off(); }
  assert.ok(!appMcpExecutorKinds().includes("server"), "걷으면 등록부에서 빠진다");
  const after = await assertAppMcpToolsInstallable({ ...withServer, mcp_tools: [{ name: "q", description: "d", run: { kind: "server", route: "/a" } }] })
    .then(() => null, (e: unknown) => e as HttpError);
  assert.ok(after instanceof HttpError && /모르는 실행기/.test(after.message), String(after?.message));
});

test("B3f 같은 실행기를 두 번 등록하면 던진다(둘이 같은 선언을 다르게 실행하지 않게)", () => {
  const off = registerServerExecutor();
  try { assert.throws(() => registerServerExecutor(), /이미 등록/); } finally { off(); }
});

test("B3h 배선 — 코어가 뜰 때 server 실행기를 등록한다(index.ts · 이 한 줄이 없으면 설치가 «모르는 실행기» 400 · 도구 목록 0개)", () => {
  //  dist/apps/<이 파일>.js → 소스 src/index.ts(시험은 빌드한 뒤 돈다 · auth/http-auth-gate.test G4 와 같은 방식).
  const IDX = readFileSync(new URL("../../src/index.ts", import.meta.url), "utf8");
  assert.ok(IDX.length > 1000, "index.ts 를 읽지 못했다");
  assert.match(IDX, /^import \{ registerServerExecutor \} from "\.\/apps\/app-mcp-server-executor\.js";/m);
  assert.equal(IDX.match(/^registerServerExecutor\(\);/gm)?.length ?? 0, 1, "줄 맨 앞에서 한 번(주석 · 조건 안이 아니게)");
});
