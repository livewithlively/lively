#!/usr/bin/env node
// 설치 직후 조직 자산 미리 받기 사양테스트(#5013) — preloadHarnessAssets 를 **진짜 받기 스크립트**(sync-harness-assets)로 돌린다.
//  왜: codex·cursor 등은 스킬 목록을 대화 시작 때 한 번만 읽어, 대화 시작 훅이 받은 스킬이 다음 대화부터 보였다
//  → 설치 직후 첫 대화에 라이블리 스킬이 없었다. 설치가 그 훅을 미리 한 번 돌리는지를 디스크·스텁 요청으로 본다.
//  샌드박스 HOME(LIVELY_HOME) + 127.0.0.1 스텁 게이트웨이 — 실 홈·네트워크 무접촉.
//  실행: node scripts/run-tests.mjs install-asset-preload
//  엣지 표(E1~E7, 사양 문서): ①두 하네스 모두 받음 ②받은 목록에 두 몫이 다 남음 ③게이트웨이 500 ④받기 스크립트 부재
//   ⑤빈 하네스 목록 ⑥셸의 옛 토큰보다 파일 토큰 ⑦끝나지 않는 스크립트는 상한에서 끊음. (E8 설치 흐름 배선은 lively.test.mjs ③.)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "install-preload-test-"));
const HOME = join(SANDBOX, "home");
const LV = join(HOME, ".lively");

// CLI 는 HOME·호스트 효과 모드를 **import 시점에** 정한다 → import 전에 샌드박스로 돌린다.
//  자식(받기 스크립트)은 이 env 를 물려받는다 — 루프백 스텁만 열리는 sandbox 모드.
Object.assign(process.env, offlineLivelyEnv(), {
  LIVELY_HOME: HOME, HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", CLAUDECODE: "",
});
const { preloadHarnessAssets } = await import(pathToFileURL(join(HERE, "lively.mjs")));

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

let ASSET_STATUS = 200;
// E2 용 문 — 자산 응답을 붙잡아 두었다가 **두 번째 요청이 오면 둘 다 한꺼번에** 푼다(1초가 지나면 혼자라도 푼다).
//  차례로 받으면 요청이 하나씩만 와서 1초씩 기다릴 뿐이고, 동시에 띄우면 두 스크립트가 같은 순간에 받은 목록을 읽고 써서
//  한쪽 몫이 지워진다. 문이 없으면 두 요청이 우연히 안 겹쳐 동시 실행도 통과한다(변이 실측).
let HOLD = false;
const held = [];
const releaseHeld = () => { for (const f of held.splice(0)) f(); };
const hits = [];   // { url, auth }
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const skill = (id) => ({ id, kind: "skill", description: `${id} 설명`, body: `# ${id}\n본문`, content_hash: hash(id), frontmatter: {} });
const server = createServer((req, res) => {
  hits.push({ url: req.url, auth: String(req.headers.authorization || "") });
  if (req.method === "POST") req.resume();
  if (req.url.startsWith("/api/ui/org/runner/assets")) {
    if (ASSET_STATUS !== 200) { res.writeHead(ASSET_STATUS).end(); return; }
    const h = new URL(req.url, "http://x").searchParams.get("harness");
    const send = () => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ assets: [skill(`liv-${h}`)] }));
    if (!HOLD) { send(); return; }
    held.push(send);
    if (held.length >= 2) releaseHeld(); else setTimeout(releaseHeld, 1000);
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url.includes("harness-local-pref") ? JSON.stringify({ disabled: [] }) : "{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

// 설치기가 놓는 그대로 — 훅은 ~/.lively/hooks 에 평평하게, host-effects 는 ~/.lively/lib(kit-manifest LIB_FILES).
function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(LV, "hooks"), { recursive: true });
  mkdirSync(join(LV, "lib"), { recursive: true });
  for (const f of ["sync-harness-assets.mjs", "harness-registry.mjs", "host-effects-port.mjs"]) copyFileSync(join(KIT, "hooks", f), join(LV, "hooks", f));
  copyFileSync(join(KIT, "setup", "host-effects.mjs"), join(LV, "lib", "host-effects.mjs"));
  writeFileSync(join(LV, "token"), "file-token\n");
  writeFileSync(join(LV, "gateway-url"), GW + "\n");
  hits.length = 0;
  ASSET_STATUS = 200;
  HOLD = false;
}
const assetHits = () => hits.filter((x) => x.url.startsWith("/api/ui/org/runner/assets"));
const manifest = () => { try { return JSON.parse(readFileSync(join(LV, "managed-harness-assets.json"), "utf8")); } catch { return {}; } };
const cursorSkill = () => join(HOME, ".cursor", "skills", "liv-cursor", "SKILL.md");
const codexSkill = () => join(HOME, ".codex", "skills", "liv-codex", "SKILL.md");

try {
  // E1 — 두 하네스 모두 그 자리에 스킬이 놓이고, 게이트웨이가 하네스마다 요청을 받는다.
  {
    freshHome();
    const r = await preloadHarnessAssets(["cursor", "codex"]);
    const asked = assetHits().map((x) => new URL(x.url, "http://x").searchParams.get("harness")).sort();
    // 배선 단언 — 스텁이 안 불렸으면 아래 파일 단언은 아무것도 안 본다.
    eq("E1 배선 — 받기 요청이 하네스마다 1번씩 나감", asked, ["codex", "cursor"]);
    eq("E1 두 자리에 스킬 파일", [existsSync(cursorSkill()), existsSync(codexSkill())], [true, true]);
    eq("E1 결과 — 하네스별 스킬 수", r.map((x) => [x.harness, x.skills]), [["cursor", 1], ["codex", 1]]);
  }
  // E2 — 받은 목록(공유 파일)에 두 하네스 몫이 다 남는다(동시에 쓰면 한쪽이 지워진다).
  {
    freshHome();
    HOLD = true;
    await preloadHarnessAssets(["cursor", "codex"]);
    const m = manifest();
    eq("E2 받은 목록에 두 몫", [Object.keys(m.cursor || {}), Object.keys(m.codex || {})], [["liv-cursor"], ["liv-codex"]]);
  }
  // E3 — 게이트웨이가 500 이어도 예외 없이 끝나고 아무것도 안 놓인다.
  {
    freshHome();
    ASSET_STATUS = 500;
    let r, threw = null;
    try { r = await preloadHarnessAssets(["cursor"]); } catch (e) { threw = e; }
    eq("E3 예외 없음 + 요청은 나감", [threw, assetHits().length], [null, 1]);
    eq("E3 파일 없음 · 스킬 0", [existsSync(cursorSkill()), r?.[0]?.skills], [false, 0]);
  }
  // E4 — 받기 스크립트가 없으면(구 번들 등) 아무것도 띄우지 않는다.
  {
    freshHome();
    rmSync(join(LV, "hooks", "sync-harness-assets.mjs"));
    const r = await preloadHarnessAssets(["cursor"]);
    eq("E4 스크립트 부재 → 빈 결과 · 요청 0", [r, assetHits().length], [[], 0]);
  }
  // E5 — 하네스가 없으면 아무것도 안 한다.
  {
    freshHome();
    const r = await preloadHarnessAssets([]);
    eq("E5 빈 목록 → 빈 결과 · 요청 0", [r, assetHits().length], [[], 0]);
  }
  // E6 — 셸에 남은 옛 토큰이 아니라 파일 토큰으로 받는다. 라이블리가 띄운 창(LIVELY_SESSION_ID)이면 받기 스크립트가
  //  env 를 먼저 보므로, 설치가 토큰을 명시로 넘기지 않으면 옛 토큰이 나간다 — 그 조합을 세운다.
  {
    freshHome();
    const saved = { t: process.env.LIVELY_TOKEN, s: process.env.LIVELY_SESSION_ID };
    process.env.LIVELY_TOKEN = "stale-env-token";
    process.env.LIVELY_SESSION_ID = "sess-preload-test";
    try { await preloadHarnessAssets(["cursor"]); }
    finally { process.env.LIVELY_TOKEN = saved.t ?? ""; process.env.LIVELY_SESSION_ID = saved.s ?? ""; }
    eq("E6 Bearer = 파일 토큰", assetHits().map((x) => x.auth), ["Bearer file-token"]);
  }
  // E7 — 끝나지 않는 스크립트는 상한에서 끊고 다음 하네스로 넘어간다(설치를 붙잡지 않는다).
  {
    freshHome();
    writeFileSync(join(LV, "hooks", "sync-harness-assets.mjs"), "setInterval(() => {}, 1000);\n");
    const t0 = Date.now();
    const r = await preloadHarnessAssets(["cursor", "codex"], { timeoutMs: 400 });
    const ms = Date.now() - t0;
    eq("E7 둘 다 상한에서 끊김", r.map((x) => [x.harness, !!x.timedOut]), [["cursor", true], ["codex", true]]);
    ms < 3000 ? ok(`E7 상한 근처에서 끝남 (${ms}ms)`) : bad("E7 소요", `${ms}ms — 상한 400ms×2 를 크게 넘김`);
  }
} finally {
  server.close();
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} install-asset-preload: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
