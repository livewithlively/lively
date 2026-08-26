// 클라우드 로그인 e2e (#2044) — `lively login --cloud` 를 **실 프로세스 + 실 HTTP** 로 태운다.
//
// 왜 실 왕복인가: 이 경로의 값어치는 "주소를 한 글자도 안 넣었는데 게이트웨이와 자격이 생긴다"이고,
//  그건 프로세스 경계(인자 파싱 → 폴 루프 → 저장)를 다 지나야 참이 된다. 순수 단위로는 그 문장을 못 만든다.
//  스텁은 CP 의 **계약만** 흉내낸다(같은 경로·같은 상태코드) — 진짜 CP 는 lvly-cloud 유닛·야간 E2E 가 본다.
//
// 사양 엣지 표(spec-funnel.md)에서 이 파일이 덮는 행:
//   C1 주소 없이 로그인이 끝난다(핵심) · C2 개시자 바인딩(verifier 불일치는 못 받는다) ·
//   C3 대기→승인 폴 루프 · C4 거부 · C5 클라우드가 아닌 주소 · C6 실 홈 무접촉
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sandboxEnv, pathWith } from "../testlib/os-sandbox.mjs";
import assert from "node:assert/strict";

const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");
const TOKEN = "lvk_stub_2044";
let pass = 0;
const t = async (name, fn) => { await fn(); pass++; console.log(`ok  ${name}`); };

/**
 * 스텁 클라우드 — CP 계약만. `behavior` 로 시나리오를 가른다.
 *  자기 자신이 게이트웨이 역할도 한다(발급한 토큰을 CLI 가 저장 전에 검증하므로 그 왕복까지 봐야 한다).
 */
function stubCloud(behavior = {}) {
  const { approveAfter = 1, deny = false, notCloud = false } = behavior;
  const flows = new Map();
  const hits = { start: 0, poll: 0, profile: 0, verifierMismatch: 0 };
  const json = (res, code, body) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const read = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });

  const server = createServer(async (req, res) => {
    let body = {};
    if (req.method === "POST") { try { body = JSON.parse((await read(req)) || "{}"); } catch { body = {}; } }
    // '라이블리 클라우드가 아닌 주소' 시나리오 — 자가호스팅 게이트웨이엔 이 경로가 없다.
    if (notCloud) return json(res, 404, { error: "not_found" });

    if (req.url === "/cli/device/start") {
      hits.start++;
      if (!/^[A-Za-z0-9_-]{16,}$/.test(String(body.code_challenge || ""))) return json(res, 400, { error: "bad_challenge" });
      const dc = "dev_" + Math.random().toString(36).slice(2);
      flows.set(dc, { challenge: body.code_challenge, polls: 0 });
      return json(res, 200, {
        device_code: dc, user_code: "ABCD1234",
        verification_uri: `${self()}/link`, verification_uri_complete: `${self()}/link?code=ABCD-1234`,
        expires_in: 900, interval: 1,
      });
    }
    if (req.url === "/cli/device/poll") {
      hits.poll++;
      const f = flows.get(String(body.device_code || ""));
      if (!f) return json(res, 401, { error: "invalid_verifier" });
      // ★ 개시자 바인딩 — CLI 가 실제로 verifier 를 보내고 그게 challenge 와 맞아야 한다.
      const got = createHash("sha256").update(String(body.code_verifier || "")).digest("base64url");
      if (got !== f.challenge) { hits.verifierMismatch++; return json(res, 401, { error: "invalid_verifier" }); }
      if (deny) return json(res, 403, { error: "access_denied" });
      f.polls++;
      if (f.polls <= approveAfter) return json(res, 202, { error: "authorization_pending", interval: 1 });
      return json(res, 200, { gateway_url: self(), token: TOKEN, workspace: "Acme", scopes: ["items", "context"] });
    }
    if (req.url === "/api/ui/me/profile") {
      hits.profile++;
      if ((req.headers.authorization || "") !== `Bearer ${TOKEN}`) return json(res, 401, { error: "bad token" });
      return json(res, 200, { id: "yoon", display_name: "윤상민", email: "yoon@lvly.io" });
    }
    json(res, 404, { error: "not_found" });
  });
  const self = () => `http://127.0.0.1:${server.address().port}`;
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ url: self(), hits, close: () => server.close() })));
}

/**
 * CLI 를 격리 홈으로 띄운다 — 실 홈(~/.lively)은 절대 안 건드린다.
 *  ★ PATH 를 **닫는다**(빈 dir 하나만): 로그인 뒤 afterLogin 이 MCP 를 등록하려 `claude` 를 찾는데,
 *   안 가리면 이 머신의 진짜 claude·codex 프로필을 만진다(kit/cli/cli-spawn-harness-sandbox 가 강제하는 관례).
 *   여기서 검증하려는 건 로그인 왕복이지 하네스 배선이 아니다 — 없으면 CLI 가 조용히 건너뛴다.
 */
function runCli(args, home) {
  return new Promise((resolve) => {
    const env = {
      ...process.env, ...sandboxEnv({ home, tmp: home }),
      LIVELY_HOME: home, LIVELY_NO_BROWSER: "1", CI: "1",
      PATH: pathWith(join(home, "nobin"), ""),
      // 샌드박스는 네트워크를 막지만 **고포트 loopback 만** 예외로 연다(host-effects.sandboxNetworkAllowed).
      //  이 테스트의 스텁이 정확히 그것이다(listen(0) → 32768+). 바깥으로는 여전히 한 바이트도 못 나간다.
      LIVELY_HOST_EFFECTS_TEST_MODE: "sandbox",
    };
    delete env.LIVELY_TOKEN; delete env.LIVELY_GATEWAY_URL;
    execFile(process.execPath, [CLI, ...args], { env, timeout: 60_000 },
      (err, stdout, stderr) => resolve({ code: err?.code ?? 0, out: String(stdout) + String(stderr) }));
  });
}
const box = () => mkdtempSync(join(tmpdir(), "lively-cloud-"));
const saved = (home, f) => { try { return readFileSync(join(home, ".lively", f), "utf8").trim(); } catch { return null; } };

// ── C1 ★ 핵심 ───────────────────────────────────────────────────────────────
await t("C1 ★ 주소를 한 글자도 안 넣고 로그인이 끝난다 — 게이트웨이와 자격이 함께 생긴다", async () => {
  const cloud = await stubCloud();
  const home = box();
  try {
    const r = await runCli(["login", "--cloud", cloud.url], home);
    assert.equal(r.code, 0, r.out);
    assert.equal(saved(home, "gateway-url"), cloud.url, "게이트웨이가 저장되지 않았다 — 사람이 다시 주소를 물어보게 된다");
    assert.equal(saved(home, "token"), TOKEN);
    assert.match(r.out, /Acme/, "어느 워크스페이스인지 사람에게 말하지 않는다");
    assert.ok(cloud.hits.profile > 0, "저장 전에 자격을 검증하지 않았다");
  } finally { cloud.close(); rmSync(home, { recursive: true, force: true }); }
});

await t("C2 ★ 개시자 바인딩 — 폴에 verifier 를 싣고, 서버가 그걸로 대조한다", async () => {
  const cloud = await stubCloud();
  const home = box();
  try {
    await runCli(["login", "--cloud", cloud.url], home);
    assert.equal(cloud.hits.verifierMismatch, 0, "우리가 보낸 verifier 가 challenge 와 안 맞는다");
    assert.ok(cloud.hits.start === 1 && cloud.hits.poll >= 1);
  } finally { cloud.close(); rmSync(home, { recursive: true, force: true }); }
});

await t("C3 승인이 늦어도 기다린다(대기 응답을 실패로 읽지 않는다)", async () => {
  const cloud = await stubCloud({ approveAfter: 3 });
  const home = box();
  try {
    const r = await runCli(["login", "--cloud", cloud.url], home);
    assert.equal(r.code, 0, r.out);
    assert.ok(cloud.hits.poll >= 4, `폴이 ${cloud.hits.poll}회 — 기다리지 않고 끝냈다`);
    assert.equal(saved(home, "token"), TOKEN);
  } finally { cloud.close(); rmSync(home, { recursive: true, force: true }); }
});

await t("C4 거부하면 자격을 남기지 않고 멈춘다", async () => {
  const cloud = await stubCloud({ deny: true });
  const home = box();
  try {
    const r = await runCli(["login", "--cloud", cloud.url], home);
    assert.notEqual(r.code, 0, "거부됐는데 성공으로 끝났다");
    assert.equal(saved(home, "token"), null, "거부됐는데 토큰이 남았다");
  } finally { cloud.close(); rmSync(home, { recursive: true, force: true }); }
});

await t("C5 ★ 클라우드가 아닌 주소를 주면 **무엇을 대신 쓸지** 알려준다(막다른 길 금지)", async () => {
  const cloud = await stubCloud({ notCloud: true });
  const home = box();
  try {
    const r = await runCli(["login", "--cloud", cloud.url], home);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /--gateway/, "다음 행동(--gateway)을 안 알려준다");
    assert.equal(saved(home, "token"), null);
  } finally { cloud.close(); rmSync(home, { recursive: true, force: true }); }
});

await t("C6 ★ 값 없이 --cloud 만 줘도 된다 — 주소를 모르는 사람이 쓰는 경로다", async () => {
  // 기본 주소(app.lvly.io)로 나가면 안 되므로 네트워크는 태우지 않는다. 인자 파싱만 확인한다:
  //  값을 요구했다면 다음 토큰(setup)을 주소로 먹어 "주소 형식" 오류가 났을 것이다.
  const home = box();
  try {
    const r = await runCli(["login", "--cloud", "--json"], home);
    assert.doesNotMatch(r.out, /--json/, "다음 플래그를 주소로 삼켰다");
    assert.match(r.out, /app\.lvly\.io|연결하지 못했습니다|클라우드/, r.out.slice(0, 300));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

console.log(`\n${pass} passed`);
