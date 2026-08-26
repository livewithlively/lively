#!/usr/bin/env node
// `lively status/doctor` 의 **조직 자산 슬러그 충돌** 계약 — 실행: node kit/cli/status-asset-collision.test.mjs
//  실제 홈 무접촉(LIVELY_HOME 샌드박스 + 닫힌 PATH). 게이트웨이는 로컬 스텁(네트워크 0).
//
// 왜 이 파일이 있나 — 2026-08-20 실측: 조직 스킬 51개의 **원저자 머신**에서 doctor 가
//  "조직 자산(claude) ✗ 14/65 · 새 세션을 한 번 켜세요" 를 냈다. 실제로는 그 51개가 그 사람의 로컬 원본이고
//  sync 는 비파괴 정책(멤버 파일 보존)으로 일부러 비켜선 것이라, 세션을 몇 번 켜도 영원히 안 깔린다 —
//  즉 진단이 **없는 고장을 만들고 헛다리 조치를 안내**했다. 충돌분은 결손이 아니다.
import { execFile } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { closedPath, writeStubBin } from "../testlib/os-sandbox.mjs";

const pExecFile = promisify(execFile);
const CLI = join(fileURLToPath(import.meta.url), "..", "lively.mjs");
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "lively-collide-")));

let pass = 0, fail = 0;
const check = (n, cond, why) => { if (cond) { pass++; console.log(`ok  ${n}`); } else { fail++; console.error(`FAIL ${n} — ${why || "조건 불만족"}`); } };

// 서버 자산 = 스킬 2 + 서브에이전트 1. 로컬에 어느 것을 미리 놔두느냐로 충돌 수를 만든다.
const SERVER = [{ id: "a0", kind: "skill" }, { id: "a1", kind: "skill" }, { id: "sub0", kind: "subagent" }];
const srv = createServer((req, res) => {
  const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith("/api/ui/org/runtime-config")) return send({ kit_version: "test", hooks: {} });
  if (req.url.startsWith("/api/ui/org/runner/assets")) {
    const h = new URL(req.url, "http://x").searchParams.get("harness") || "claude";
    return send({ assets: h === "claude" ? SERVER : [] });
  }
  if (req.url.startsWith("/api/ui/me/profile")) return send({ id: "tester", display_name: "테스터" });
  send({});
});
await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${srv.address().port}`;

// mine = 매니페스트에 넣을 id(라이블리가 심은 것) · local = 디스크에 미리 놔둘 [kind, id](그 사람 본인 자산)
function mkCase(name, { mine = [], local = [] } = {}) {
  const home = join(BOX, name), bin = join(home, "stub-bin"), ccd = join(home, "claude-cfg");
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, ".lively"), { recursive: true });
  writeFileSync(join(home, ".lively", "gateway-url"), GW + "\n");
  writeFileSync(join(home, ".lively", "token"), "t\n");
  writeFileSync(join(home, ".lively", "managed-harness-assets.json"),
    JSON.stringify({ claude: Object.fromEntries(mine.map((id) => [id, { kind: "skill" }])) }));
  for (const [kind, id] of local) {
    if (kind === "skill") { mkdirSync(join(ccd, "skills", id), { recursive: true }); writeFileSync(join(ccd, "skills", id, "SKILL.md"), "---\nname: x\n---\n"); }
    else { mkdirSync(join(ccd, "agents"), { recursive: true }); writeFileSync(join(ccd, "agents", `${id}.md`), "---\nname: x\n---\n"); }
  }
  writeStubBin(bin, "claude", 'process.exit(0);');   // 설치된 것처럼만(자산 축을 켜려면 installed 가 필요)
  return { home, bin, ccd };
}

// 배치표(harness-registry)를 못 읽는 설치본 재현 — CLI 사본만 있는 디렉터리에서 실행하면 `../hooks/…` 가 없다.
//  이 경로가 collision=null(판정 불가)이고, 그 때 진단이 무슨 말을 하는지가 계약이다.
const CLI_NOLIB = (() => {
  const d = join(BOX, "nolib");
  mkdirSync(d, { recursive: true });
  const dst = join(d, "lively.mjs");
  copyFileSync(CLI, dst);
  return dst;
})();

async function run(c, cmd, cli = CLI) {
  const env = {
    ...process.env, PATH: closedPath(c.bin), LIVELY_HOME: c.home, CLAUDE_CONFIG_DIR: c.ccd,
    LIVELY_GATEWAY_URL: "", LIVELY_TOKEN: "", NO_COLOR: "1",
  };
  const r = await pExecFile(process.execPath, [cli, cmd, "--json"], { cwd: c.home, env, timeout: 30_000 })
    .catch((e) => ({ stdout: e.stdout ?? "", stderr: e.stderr ?? String(e.message) }));
  try { return JSON.parse(r.stdout); }
  catch { throw new Error(`${cmd} --json 파싱 실패: ${String(r.stdout).slice(0, 200)} / ${String(r.stderr).slice(-300)}`); }
}
const assetCheck = (d) => (d.checks || []).find((x) => x.name === "조직 자산(claude)");

try {
  // ── C1 전량 충돌 — 로컬 3개가 다 그 사람 것. 결손 0이므로 doctor 는 통과해야 한다 ──
  {
    const c = mkCase("all-collide", { mine: [], local: [["skill", "a0"], ["skill", "a1"], ["subagent", "sub0"]] });
    const a = (await run(c, "status")).harness.claude.assets;
    check("C1 충돌 3건을 센다", a && a.local === 0 && a.server === 3 && a.collision === 3, JSON.stringify(a));
    const chk = assetCheck(await run(c, "doctor"));
    check("C1b doctor 통과 — 충돌은 고장이 아니다", chk && chk.pass === true, JSON.stringify(chk));
    check("C1c 문구에 사실이 남는다", chk && /3건.*미배포/.test(chk.detail), JSON.stringify(chk));
  }

  // ── C2 진짜 결손 — 로컬에 아무것도 없음. 종전 그대로 ✗ 여야 한다(경보를 죽이면 안 된다) ──
  {
    const c = mkCase("real-gap");
    const a = (await run(c, "status")).harness.claude.assets;
    check("C2 결손이면 충돌 0", a && a.local === 0 && a.server === 3 && a.collision === 0, JSON.stringify(a));
    const chk = assetCheck(await run(c, "doctor"));
    check("C2b doctor ✗ 유지", chk && chk.pass === false, JSON.stringify(chk));
  }

  // ── C3 섞임 — 1개는 라이블리가 심었고(매니페스트) 1개는 충돌, 1개는 진짜 결손 → 여전히 ✗ ──
  {
    const c = mkCase("mixed", { mine: ["a0"], local: [["skill", "a0"], ["skill", "a1"]] });
    const a = (await run(c, "status")).harness.claude.assets;
    check("C3 managed 는 충돌로 이중계산하지 않는다", a && a.local === 1 && a.collision === 1, JSON.stringify(a));
    const chk = assetCheck(await run(c, "doctor"));
    check("C3b 결손 1건 남으면 ✗", chk && chk.pass === false, JSON.stringify(chk));
  }

  // ── C4 배치표 미가용 — 충돌인지 결손인지 못 가린다. 경보는 유지하되 그 불확실성을 문구에 적어야 한다 ──
  {
    const c = mkCase("no-registry", { mine: [], local: [["skill", "a0"], ["skill", "a1"], ["subagent", "sub0"]] });
    const a = (await run(c, "status", CLI_NOLIB)).harness.claude.assets;
    check("C4 판정 불가면 collision=null(0 으로 단정하지 않는다)", a && a.collision === null, JSON.stringify(a));
    const chk = assetCheck(await run(c, "doctor", CLI_NOLIB));
    check("C4b 경보 유지 — 모르는 걸 정상이라 우기지 않는다", chk && chk.pass === false, JSON.stringify(chk));
    check("C4c 문구가 불확실성을 밝힌다", chk && /확인 못 했습니다/.test(chk.detail), JSON.stringify(chk));
  }

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
} finally {
  srv.close();
  rmSync(BOX, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
