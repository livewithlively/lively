#!/usr/bin/env node
// 조직 하네스 자산 받기(sync-harness-assets)의 다중 워크스페이스 동작 사양테스트.
//  받기 스크립트를 설치 자리(~/.lively/hooks)에 놓고 자식 프로세스로 **실제로 돌려** 디스크·받은 목록·스텁 요청을 본다.
//  샌드박스 HOME(LIVELY_HOME) + 127.0.0.1 스텁 게이트웨이 — 실 홈·네트워크 무접촉.
//  실행: node scripts/run-tests.mjs sync-harness-assets-workspaces
//  W1~W13 은 사양 행위 1~13 에 하나씩 대응한다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const KIT = join(HERE, "..");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-ws-test-"));
const HOME = join(SANDBOX, "home");
const LV = join(HOME, ".lively");
const MANIFEST = join(LV, "managed-harness-assets.json");
const PRIMARY = "primary";

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const skill = (id, body = `# ${id}\n본문`) => ({ id, kind: "skill", description: `${id} 설명`, body, content_hash: hash(id + body), frontmatter: {} });

// 스텁 상태 — 워크스페이스별 자산 목록·응답 코드, 내 워크스페이스 목록.
let ASSETS = {};          // slug → assets[]
let ASSET_STATUS = {};    // slug → http status (기본 200)
let WS = null;            // GET /api/ui/me/workspaces 본문
let WS_STATUS = 200;
let SESS_WS = null;       // 세션 맵 흉내 — 워크스페이스 헤더 없이 세션 헤더만 온 요청을 이 워크스페이스로 본다(없으면 primary)
const hits = [];          // { method, url, ws(헤더 원문|null), session(헤더 원문|null) }
const server = createServer((req, res) => {
  const wsHdr = req.headers["x-lively-workspace"];
  const sessHdr = req.headers["x-lively-session"];
  hits.push({ method: req.method, url: req.url, ws: wsHdr === undefined ? null : String(wsHdr), session: sessHdr === undefined ? null : String(sessHdr) });
  if (req.method === "POST") req.resume();
  const json = (code, body) => res.writeHead(code, { "content-type": "application/json" }).end(JSON.stringify(body));
  if (req.method === "GET" && req.url.startsWith("/api/ui/org/runner/assets")) {
    const slug = wsHdr ? String(wsHdr) : (sessHdr && SESS_WS) || PRIMARY;
    const st = ASSET_STATUS[slug] ?? 200;
    if (st !== 200) { res.writeHead(st).end(); return; }
    json(200, { assets: ASSETS[slug] || [] });
    return;
  }
  if (req.method === "GET" && req.url.split("?")[0] === "/api/ui/me/workspaces") {
    if (WS_STATUS !== 200) { res.writeHead(WS_STATUS).end(); return; }
    json(200, { ...(WS || { mode: "single", workspaces: [] }), current: wsHdr ? String(wsHdr) : (sessHdr && SESS_WS) || PRIMARY });
    return;
  }
  json(200, req.url.includes("harness-local-pref") ? { disabled: [] } : {});
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

const registry = (...slugs) => ({ mode: "registry", workspaces: slugs.map((slug) => ({ slug, state: "active" })) });

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(LV, "hooks"), { recursive: true });
  mkdirSync(join(LV, "lib"), { recursive: true });
  for (const f of ["sync-harness-assets.mjs", "harness-registry.mjs", "host-effects-port.mjs", "record-scope.mjs", "stdio-launch.mjs"]) copyFileSync(join(KIT, "hooks", f), join(LV, "hooks", f));
  copyFileSync(join(KIT, "setup", "host-effects.mjs"), join(LV, "lib", "host-effects.mjs"));
  writeFileSync(join(LV, "token"), "test-token\n");
  writeFileSync(join(LV, "gateway-url"), GW + "\n");
  hits.length = 0;
  ASSETS = {};
  ASSET_STATUS = {};
  WS = null;
  WS_STATUS = 200;
  SESS_WS = null;
}

let sessSeq = 0;
// ⚠ spawnSync 금지 — 스텁이 이 프로세스 안에서 돌아 동기 대기 중엔 응답을 못 한다.
//  sessionWs=null 이면 primary 세션(LVLY_TENANT_SLUG 를 지운다). 실행 전 요청 기록을 비워 그 실행 몫만 남긴다.
function sync(sessionWs) {
  hits.length = 0;
  const env = {
    ...process.env, ...offlineLivelyEnv(),
    LIVELY_HOME: HOME, HOME, USERPROFILE: HOME, CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
    LIVELY_HOST_EFFECTS: "deny", LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox", CLAUDECODE: "",
    LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: GW, LIVELY_SESSION_ID: `sess-ws-test-${++sessSeq}`,
  };
  delete env.LVLY_TENANT_SLUG;
  if (sessionWs) env.LVLY_TENANT_SLUG = sessionWs;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [join(LV, "hooks", "sync-harness-assets.mjs"), "--harness", "claude", "--preload"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err }));
  });
}

const skillFile = (id) => join(HOME, ".claude", "skills", id, "SKILL.md");
const onDisk = (...ids) => ids.map((id) => existsSync(skillFile(id)));
const readSkill = (id) => { try { return readFileSync(skillFile(id), "utf8"); } catch { return ""; } };
const manifestRaw = () => { try { return readFileSync(MANIFEST, "utf8"); } catch { return null; } };
const claudeList = () => { try { return JSON.parse(manifestRaw()).claude || {}; } catch { return {}; } };
const listed = () => Object.keys(claudeList()).sort();
const assetHits = () => hits.filter((h) => h.method === "GET" && h.url.startsWith("/api/ui/org/runner/assets"));
// 다른 워크스페이스 요청 = primary 가 아닌 워크스페이스 헤더를 실은 자산 요청(세션이 primary 인 시나리오에서만 쓴다).
const otherAssetHits = () => assetHits().filter((h) => h.ws !== null && h.ws !== PRIMARY);
const sessionAssetHits = () => assetHits().filter((h) => h.ws === null || h.ws === PRIMARY);
const wsListHits = () => hits.filter((h) => h.method === "GET" && h.url.split("?")[0] === "/api/ui/me/workspaces").length;
const wsOf = (h) => h.ws ?? PRIMARY;

try {
  // W1 — 세션 워크스페이스(primary) 자산에 더해 내가 속한 다른 워크스페이스 자산도 디스크에 놓인다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-one")], "team-a": [skill("h-one")] };
    const r = await sync(null);
    eq("W1 배선 — 내 워크스페이스 목록을 묻고 team-a 자산을 요청", [wsListHits() > 0, otherAssetHits().map(wsOf)], [true, ["team-a"]]);
    eq("W1 두 워크스페이스 스킬이 모두 디스크에", onDisk("p-one", "h-one"), [true, true]);
    eq("W1 종료 코드 0", r.status, 0);
  }
  // W2 — 다른 워크스페이스 요청에는 x-lively-workspace=<slug> 를 싣고 x-lively-session 은 싣지 않는다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a", "team-b");
    ASSETS = { [PRIMARY]: [skill("p-two")], "team-a": [skill("a-two")], "team-b": [skill("b-two")] };
    await sync(null);
    const others = otherAssetHits();
    eq("W2 배선 — 두 워크스페이스 각각에 요청", others.map(wsOf).sort(), ["team-a", "team-b"]);
    eq("W2 다른 워크스페이스 요청에 세션 헤더 없음", others.map((h) => h.session), [null, null]);
    eq("W2 배선 — 세션 워크스페이스 요청도 나감", sessionAssetHits().length > 0, true);
  }
  // W3 — team-a 세션 → primary 세션 → team-a 세션을 오가도 두 워크스페이스 자산이 계속 남는다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-three")], "team-a": [skill("h-three")] };
    const seen = [];
    for (const s of ["team-a", null, "team-a"]) {
      await sync(s);
      seen.push([s ?? PRIMARY, assetHits().length > 0, ...onDisk("p-three", "h-three"), listed().join(",")]);
    }
    eq("W3 세 번 모두 요청이 나가고 두 스킬·두 목록 항목 유지", seen, [
      ["team-a", true, true, true, "h-three,p-three"],
      [PRIMARY, true, true, true, "h-three,p-three"],
      ["team-a", true, true, true, "h-three,p-three"],
    ]);
  }
  // W4 — 받은 목록의 각 항목에 주인 워크스페이스 ws 가 적힌다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a", "team-b");
    ASSETS = { "team-a": [skill("h-four")], "team-b": [skill("t-four")] };
    await sync("team-a");
    const m = claudeList();
    eq("W4 배선 — 두 워크스페이스 자산 요청", [...new Set(assetHits().map(wsOf))].filter((s) => s !== PRIMARY).sort(), ["team-a", "team-b"]);
    eq("W4 항목별 ws", [m["h-four"]?.ws, m["t-four"]?.ws], ["team-a", "team-b"]);
  }
  // W5 — 종전 형식(ws 없음) 항목을 다른 워크스페이스가 원하면 지우지 않고 그 소유로 넘기며 최신 내용으로 덮는다.
  {
    freshHome();
    const legacyPath = skillFile("legacy-x");
    mkdirSync(dirname(legacyPath), { recursive: true });
    writeFileSync(legacyPath, "---\nname: legacy-x\n---\n\n# legacy-x\n옛 본문\n");
    writeFileSync(MANIFEST, JSON.stringify({ claude: { "legacy-x": { kind: "skill", hash: "old", file: legacyPath } } }, null, 2));
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-five")], "team-a": [skill("legacy-x", "# legacy-x\n새 본문")] };
    await sync(null);
    const e = claudeList()["legacy-x"] || {};
    eq("W5 배선 — team-a 자산 요청", otherAssetHits().map(wsOf), ["team-a"]);
    eq("W5 파일 유지 · 새 본문으로 덮음", [existsSync(legacyPath), readSkill("legacy-x").includes("새 본문"), readSkill("legacy-x").includes("옛 본문")], [true, true, false]);
    eq("W5 목록 항목이 team-a 소유 · 해시 갱신", [e.ws, e.hash !== "old" && !!e.hash], ["team-a", true]);
  }
  // W6 — 한 워크스페이스의 자산 목록 요청이 500 이면 그 워크스페이스 소유 자산을 그대로 둔다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-six")], "team-a": [skill("h-six")] };
    await sync(null);
    const before = claudeList()["h-six"];
    ASSET_STATUS = { "team-a": 500 };
    await sync(null);
    eq("W6 배선 — 두 번째 실행에서 team-a 요청이 나감(500)", otherAssetHits().map(wsOf), ["team-a"]);
    eq("W6 team-a 스킬 디스크·목록 유지", [onDisk("h-six")[0], JSON.stringify(claudeList()["h-six"]) === JSON.stringify(before) && !!before], [true, true]);
  }
  // W7 — 내 워크스페이스 목록 요청이 실패하면 세션 워크스페이스만 받고, 다른 워크스페이스 자산은 요청도 회수도 안 한다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-seven")], "team-a": [skill("h-seven")] };
    await sync(null);
    const before = claudeList()["h-seven"];
    WS_STATUS = 500;
    ASSETS = { [PRIMARY]: [skill("p-seven"), skill("p-seven-b")], "team-a": [skill("h-seven")] };
    await sync(null);
    eq("W7 배선 — 목록 요청이 나갔고 세션 자산 요청도 나감", [wsListHits() > 0, sessionAssetHits().length > 0], [true, true]);
    eq("W7 다른 워크스페이스 자산 요청 0", otherAssetHits().length, 0);
    eq("W7 세션 자산은 새로 받음 · team-a 스킬 디스크·목록 유지",
      [onDisk("p-seven-b")[0], onDisk("h-seven")[0], JSON.stringify(claudeList()["h-seven"]) === JSON.stringify(before) && !!before], [true, true, true]);
  }
  // W8 — 내가 워크스페이스에서 빠지면 그 워크스페이스 소유 자산을 디스크·목록에서 회수한다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-eight")], "team-a": [skill("h-eight")] };
    await sync(null);
    const had = onDisk("h-eight")[0];
    WS = registry(PRIMARY);
    await sync(null);
    eq("W8 배선 — 첫 실행에 h-eight 가 놓였고 둘째 실행이 목록을 물음", [had, wsListHits() > 0], [true, true]);
    eq("W8 h-eight 디스크·목록에서 회수 · p-eight 유지", [onDisk("h-eight", "p-eight"), listed()], [[false, true], ["p-eight"]]);
  }
  // W9 — 워크스페이스가 자산을 거두면 다른 워크스페이스(primary) 세션의 받기에서도 회수된다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-nine")], "team-a": [skill("h-nine-a"), skill("h-nine-b")] };
    await sync(null);
    const had = onDisk("h-nine-b")[0];
    ASSETS = { [PRIMARY]: [skill("p-nine")], "team-a": [skill("h-nine-a")] };
    await sync(null);
    eq("W9 배선 — 첫 실행에 h-nine-b 가 놓였고 둘째 실행이 team-a 를 물음", [had, otherAssetHits().map(wsOf)], [true, ["team-a"]]);
    eq("W9 거둔 h-nine-b 회수 · 나머지 유지", [onDisk("h-nine-b", "h-nine-a", "p-nine"), listed()], [[false, true, true], ["h-nine-a", "p-nine"]]);
  }
  // W10 — 같은 id 가 두 워크스페이스에 있으면 세션 워크스페이스 판이 자리를 갖고, 다른 쪽은 stderr 로 생략을 알린다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a", "team-b");
    ASSETS = { "team-a": [skill("dup-zq", "# dup-zq\n세션판 본문")], "team-b": [skill("dup-zq", "# dup-zq\n다른판 본문")] };
    const r = await sync("team-a");
    eq("W10 배선 — team-b 자산도 요청", assetHits().map(wsOf).includes("team-b"), true);
    eq("W10 디스크는 세션판 · 목록 ws=team-a", [readSkill("dup-zq").includes("세션판 본문"), readSkill("dup-zq").includes("다른판 본문"), claudeList()["dup-zq"]?.ws], [true, false, "team-a"]);
    eq("W10 stderr 에 그 id 를 담은 생략 알림", r.stderr.includes("dup-zq"), true);
  }
  // W11 — registry 모드가 아닌 게이트웨이(single)에서는 세션 워크스페이스 자산만 받는다.
  {
    freshHome();
    WS = { mode: "single", workspaces: [{ slug: "team-a", state: "active" }] };
    ASSETS = { [PRIMARY]: [skill("p-eleven")], "team-a": [skill("h-eleven")] };
    await sync(null);
    eq("W11 배선 — 세션 자산 요청은 나감 · 스킬 놓임", [sessionAssetHits().length > 0, onDisk("p-eleven")[0]], [true, true]);
    eq("W11 추가 자산 요청 0 · team-a 스킬 없음", [otherAssetHits().length, onDisk("h-eleven")[0]], [0, false]);
  }
  // W12 — primary 만 속한 사람은 다른 워크스페이스 자산을 요청하지도 받지도 않는다.
  {
    freshHome();
    WS = registry(PRIMARY);
    ASSETS = { [PRIMARY]: [skill("p-twelve")], "team-a": [skill("h-twelve")] };
    await sync(null);
    eq("W12 배선 — 세션 자산 요청은 나감 · 스킬 놓임", [sessionAssetHits().length > 0, onDisk("p-twelve")[0]], [true, true]);
    eq("W12 다른 워크스페이스 요청 0 · 목록은 p-twelve 만", [otherAssetHits().length, onDisk("h-twelve")[0], listed()], [0, false, ["p-twelve"]]);
  }
  // W13 — 세션 워크스페이스 자산 요청이 실패하면 아무것도 바꾸지 않는다(다른 워크스페이스가 거둔 자산도 그대로).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p-thirteen")], "team-a": [skill("h-thirteen")] };
    await sync(null);
    const before = { m: manifestRaw(), p: readSkill("p-thirteen"), h: readSkill("h-thirteen") };
    ASSET_STATUS = { [PRIMARY]: 500 };
    ASSETS = { [PRIMARY]: [], "team-a": [] };
    const r = await sync(null);
    eq("W13 배선 — 첫 실행에 두 스킬이 놓였고 둘째 실행이 세션 자산을 요청(500)", [!!before.p && !!before.h, sessionAssetHits().length > 0], [true, true]);
    eq("W13 받은 목록·두 스킬 파일 그대로", [manifestRaw() === before.m, readSkill("p-thirteen") === before.p, readSkill("h-thirteen") === before.h], [true, true, true]);
    eq("W13 종료 코드 0", r.status, 0);
  }

  // W14 — 주인 워크스페이스 목록을 못 받은 자산은, 세션 워크스페이스가 같은 id 를 원해도 자리를 내주지도 덮이지도 않는다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [], "team-a": [skill("dup14", "# team-a 판")] };
    await sync(null);
    ASSETS[PRIMARY] = [skill("dup14", "# primary 판")];
    ASSET_STATUS["team-a"] = 500;
    await sync(null);
    eq("W14 보류된 자산은 그대로 — 내용·주인", [readSkill("dup14").includes("# team-a 판"), claudeList().dup14?.ws], [true, "team-a"]);
  }
  // W15 — 다른 워크스페이스 자산과 같은 이름의 멤버 본인 파일은 덮지 않는다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [], "team-a": [skill("mine15")] };
    mkdirSync(dirname(skillFile("mine15")), { recursive: true });
    writeFileSync(skillFile("mine15"), "내 스킬\n");
    await sync(null);
    eq("W15 멤버 파일 보존 · 받은 목록에 없음", [readSkill("mine15"), "mine15" in claudeList()], ["내 스킬\n", false]);
  }
  // W16 — 같은 id 가 워크스페이스마다 종류가 다르면(skill → command) 옛 자리의 사본을 거둔다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("rv16")], "team-a": [] };
    await sync(null);
    ASSETS = { [PRIMARY]: [], "team-a": [{ ...skill("rv16"), kind: "command" }] };
    await sync(null);
    const cmd = join(HOME, ".claude", "commands", "rv16.md");
    eq("W16 command 로 놓이고 옛 skill 사본은 회수", [existsSync(cmd), onDisk("rv16")[0], claudeList().rv16?.file === cmd], [true, false, true]);
  }
  // W17 — 짝훅이 걸린 다른 워크스페이스 자산은 그 워크스페이스 세션에서만 깔린다(다른 세션에선 통제 훅이 안 돈다).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [], "team-a": [{ ...skill("guard17"), paired_hook_id: "guard17-hook" }] };
    await sync(null);
    const inPrimary = onDisk("guard17")[0];
    await sync("team-a");
    const inOffice = onDisk("guard17")[0];
    await sync(null);
    eq("W17 primary 세션 없음 → team-a 세션 있음 → primary 세션 회수", [inPrimary, inOffice, onDisk("guard17")[0]], [false, true, false]);
  }
  // W18 — 세션 워크스페이스는 게이트웨이가 세션 신호로 판정한 값(current)을 따른다(env 가 비어 있어도).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    SESS_WS = "team-a";
    ASSETS = { [PRIMARY]: [skill("p18")], "team-a": [skill("h18")] };
    const r = await sync(null);
    eq("W18 주인 라벨이 실제 워크스페이스", [claudeList().h18?.ws, claudeList().p18?.ws, r.stderr.includes("생략")], ["team-a", PRIMARY, false]);
  }

  // W19 — 짝훅 자산은 주인 워크스페이스 목록을 못 받은 다른 세션에서도 남겨 두지 않는다(통제 훅이 안 도는 자리).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [], "team-a": [{ ...skill("guard19"), paired_hook_id: "guard19-hook" }] };
    await sync("team-a");
    const before = onDisk("guard19")[0];
    ASSET_STATUS["team-a"] = 500;
    await sync(null);
    eq("W19 team-a 목록 실패 중 primary 세션 → 짝훅 자산 회수", [before, onDisk("guard19")[0]], [true, false]);
  }
  // W20 — 세션 맵으로만 소속이 정해지는 세션에서 판정값을 못 받으면 회수하지 않는다(라벨이 추정일 뿐이다).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [skill("p20")], "team-a": [skill("h20")] };
    await sync(null);
    SESS_WS = "team-a";
    WS_STATUS = 500;
    ASSETS[PRIMARY] = [skill("p20", "# p20 갱신판")];
    ASSETS["team-a"] = [skill("h20", "# h20 갱신판")];
    const r = await sync(null);
    eq("W20 primary 자산 보존", onDisk("p20", "h20"), [true, true]);
    eq("W20 세션 몫 갱신은 그대로 · 생략 알림 없음", [readSkill("h20").includes("# h20 갱신판"), r.stderr.includes("생략")], [true, false]);
  }

  // W21 — 추정 라벨 세션이라도 세션 목록에 없는 짝훅 자산은 남기지 않는다(주인 세션인지 가릴 수 없다).
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [{ ...skill("guard21"), paired_hook_id: "guard21-hook" }], "team-a": [skill("h21")] };
    await sync(null);
    const before = onDisk("guard21")[0];
    SESS_WS = "team-a";
    WS_STATUS = 500;
    await sync(null);
    eq("W21 추정 라벨 세션에서 primary 짝훅 자산 회수 · 세션 몫 유지", [before, onDisk("guard21")[0], onDisk("h21")[0]], [true, false, true]);
  }

  // W22 — 추정 라벨 세션이라도 세션 목록에 있는 짝훅 자산은 남고, 이미 적힌 주인은 바뀌지 않는다.
  {
    freshHome();
    WS = registry(PRIMARY, "team-a");
    ASSETS = { [PRIMARY]: [], "team-a": [{ ...skill("guard22"), paired_hook_id: "guard22-hook" }] };
    await sync("team-a");
    SESS_WS = "team-a";
    WS_STATUS = 500;
    await sync(null);
    eq("W22 세션 목록의 짝훅 자산 유지 · 주인 team-a", [onDisk("guard22")[0], claudeList().guard22?.ws, claudeList().guard22?.paired], [true, "team-a", true]);
  }
} finally {
  server.close();
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets-workspaces: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
