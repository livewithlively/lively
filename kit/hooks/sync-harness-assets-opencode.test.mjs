#!/usr/bin/env node
// 조직 자산 materialize 사양테스트(opencode) — #1519. codex 판(sync-harness-assets-codex.test.mjs)과 같은 구조:
//  로컬 스텁 게이트웨이 + 샌드박스 HOME, 러너를 **실제로 돌려** 산출 파일을 본다(네트워크·실 홈 미접촉).
//  실행: node kit/hooks/sync-harness-assets-opencode.test.mjs   (npm test 체인에 자동 포함)
//
//  ⭐ 왜 이 테스트인가 — **실기기에서 실제로 터진 결함을 고정한다.**
//   claude 서브에이전트 frontmatter(`color: "green"` · `model: "sonnet"` · `tools: ["Read","Grep"]`)를 그대로
//   옮겼더니 opencode 가 `Configuration is invalid` 로 거부했고, 그러자 **그 파일 하나 때문에 스킬 25개가
//   0개로 사라졌다**(설정 로드가 통째로 실패). codex 는 잘못된 자산이 그 자산만 죽이는데, opencode 는
//   **피해가 다른 자산으로 번진다** — 그래서 "위험한 키가 안 실린다"를 명시적으로 단언한다(O3).
//
//  엣지: O1 배치 3종 · O2 스킬은 오픈표준 그대로 · O3 서브에이전트에 위험 키 부재 · O4 커맨드 동일 ·
//        O5 XDG_CONFIG_HOME 존중 · O6 실제 opencode 가 있으면 **그 설정을 읽는지**까지(없으면 skip)
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-opencode-test-"));
const HOME = join(SANDBOX, "home");
const OC = join(HOME, ".config", "opencode");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const skip = (n, why) => { console.log(`skip ${n} — ${why}`); };

// ⓪ 배선 단언 — 실 홈 무접촉(관측 장치 없이 통과하는 vacuous test 방지).
//  ⚠ **실행 환경의 XDG 경로도 함께 본다.** 종전엔 `~/.config/opencode` 만 봐서, XDG_CONFIG_HOME 이 설정된
//   환경에서 테스트가 그 아래를 오염시켜도 지문이 통과했다(실측 — 이 지문의 사각지대였다).
const REAL_OCS = [join(homedir(), ".config", "opencode")];
if (process.env.XDG_CONFIG_HOME) REAL_OCS.push(join(process.env.XDG_CONFIG_HOME, "opencode"));
const fingerprint = () => REAL_OCS.map((p) => (existsSync(p) ? String(statSync(p).mtimeMs) : "(none)")).join("|");
const REAL_BEFORE = fingerprint();

// ── 게이트웨이 스텁 ─────────────────────────────────────────────────────────
let ASSETS = [];
const hits = [];                        // 배선 단언용 — 러너가 실제로 우리 스텁을 불렀나
const server = createServer((req, res) => {
  hits.push(req.url.split("?")[0]);
  if (req.url.startsWith("/api/ui/org/runner/assets")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ assets: ASSETS }));
    return;
  }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url.includes("harness-local-pref") ? JSON.stringify({ disabled: [] }) : "{}");
  if (req.method === "POST") req.resume();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const asset = (kind, id, body, extra = {}) => ({
  id, kind, description: `${id} 설명`, body, content_hash: hash(body + id),
  frontmatter: extra.frontmatter ?? {}, ...extra,
});

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "token"), "test-token\n");
  writeFileSync(join(HOME, ".lively", "gateway-url"), GW + "\n");
}
// ⚠ spawnSync 금지 — 스텁이 이 프로세스 안에서 도므로 동기 대기 중엔 응답을 못 한다(codex 판과 같은 함정).
function sync(env = {}) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--harness", "opencode"],
      // ⚠ XDG_CONFIG_HOME 를 **명시적으로 비운다.** LIVELY_HOME 은 HOME 만 리다이렉트하므로, 실행 환경에
      //  XDG_CONFIG_HOME 이 설정돼 있으면(CI 가 그렇다) 러너가 샌드박스 **밖**에 쓴다 — 실제로 ⓪ 지문이
      //  "샌드박스 계약 파손"으로 이 사고를 잡았다. 테스트가 개발자 실 홈을 오염시키면 안 된다.
      { env: { ...process.env, LIVELY_HOME: HOME, XDG_CONFIG_HOME: "", ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err }));
  });
}
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const frontmatter = (text) => {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text || "");
  return m ? m[1] : null;
};

// ── O1~O4 — 세 종류를 배포하고 자리·형식을 본다 ─────────────────────────────
freshHome();
ASSETS = [
  asset("skill", "org-skill", "# 스킬 본문\n내용"),
  // claude 에서 온 그대로의 frontmatter — 여기 있는 색·모델·툴이 **넘어가면 안 된다**.
  asset("subagent", "diff-reviewer", "리뷰어다.\n한글과 \"인용부호\"도 있다.",
    { frontmatter: { name: "diff-reviewer", color: "green", model: "sonnet", tools: ["Read", "Grep", "Bash"] } }),
  asset("command", "org-cmd", "이 프롬프트를 실행하라.\n$ARGUMENTS",
    { frontmatter: { "argument-hint": "<파일>", "allowed-tools": ["Bash"] } }),
];
let r = await sync();
{
  hits.some((h) => h.includes("/runner/assets"))
    ? ok("O0 러너가 스텁 게이트웨이를 실제로 호출") : bad("O0 배선", "스텁 미호출 — 아래 단언은 무의미하다");

  // O1/O2 — 스킬은 오픈표준이라 claude 와 같은 파일. 경로는 단수 `skill/`.
  const skill = read(join(OC, "skill", "org-skill", "SKILL.md"));
  skill && /^---\n/.test(skill) && skill.includes("# 스킬 본문")
    ? ok("O1 스킬 → ~/.config/opencode/skill/<id>/SKILL.md (오픈표준 그대로)")
    : bad("O1 스킬", String(skill).slice(0, 80));

  // ⭐ O3 — 서브에이전트: 본문·설명은 옮기되 **claude 전용 키는 절대 안 실린다**.
  //  이게 깨지면 opencode 가 설정 로드에 실패하고 **스킬까지 통째로 사라진다**(실기기 실측).
  const agent = read(join(OC, "agent", "diff-reviewer.md"));
  const fm = frontmatter(agent);
  if (!agent || !fm) bad("O3 서브에이전트 → agent/<id>.md", String(agent).slice(0, 80));
  else {
    const leaked = ["color", "model", "tools", "name"].filter((k) => new RegExp(`^${k}:`, "m").test(fm));
    leaked.length
      ? bad("O3 서브에이전트에 claude 전용 키가 안 실린다", `누출: ${leaked.join(",")} — opencode 설정이 무효가 되고 스킬까지 사라진다`)
      : ok("O3 서브에이전트에 claude 전용 키가 안 실린다(color·model·tools·name)");
    /^description:/m.test(fm) && /^mode: "subagent"$/m.test(fm)
      ? ok("O3b 서브에이전트에 description·mode 는 실린다") : bad("O3b description·mode", fm.slice(0, 120));
    agent.includes("리뷰어다.") ? ok("O3c 본문이 보존된다") : bad("O3c 본문 보존", agent.slice(0, 80));
  }

  // O4 — 커맨드도 같은 이유로 description 만.
  const cmd = read(join(OC, "command", "org-cmd.md"));
  const cfm = frontmatter(cmd);
  if (!cmd || !cfm) bad("O4 커맨드 → command/<id>.md", String(cmd).slice(0, 80));
  else {
    const leaked = ["argument-hint", "allowed-tools"].filter((k) => new RegExp(`^${k}:`, "m").test(cfm));
    leaked.length ? bad("O4 커맨드에 opencode 스키마 밖 키가 안 실린다", `누출: ${leaked.join(",")}`)
      : ok("O4 커맨드에 opencode 스키마 밖 키가 안 실린다");
    cmd.includes("$ARGUMENTS") ? ok("O4b 커맨드 본문 보존") : bad("O4b 본문 보존", cmd.slice(0, 80));
  }
}

// ── O5 — **격리 우선**: LIVELY_HOME 이 있으면 XDG_CONFIG_HOME 을 따르지 않는다.
//  (XDG 존중 자체는 레지스트리 단위 케이스 C11 이 검증한다 — 거긴 LIVELY_HOME 이 없는 실사용 조건이다.)
//  이게 깨지면 테스트·샌드박스가 **실 환경을 오염시킨다** — 실제로 그 사고를 겪고 넣은 케이스다.
{
  freshHome();
  const XDG = join(SANDBOX, "xdg-should-be-ignored");
  ASSETS = [asset("skill", "iso-skill", "# 격리")];
  await sync({ XDG_CONFIG_HOME: XDG });
  const inSandbox = existsSync(join(OC, "skill", "iso-skill", "SKILL.md"));
  const leaked = existsSync(join(XDG, "opencode"));
  (inSandbox && !leaked)
    ? ok("O5 LIVELY_HOME 격리가 XDG_CONFIG_HOME 보다 우선한다")
    : bad("O5 격리 우선", `샌드박스=${inSandbox} XDG누출=${leaked} — 격리가 새면 테스트가 실 환경을 오염시킨다`);
}

// ── O6 — 실제 opencode 가 있으면 **그 설정을 읽는지**까지 확인(없으면 skip; codex 판과 같은 규율) ──
//  "파일이 생겼다"와 "하네스가 읽는다"는 다른 문제이고, 이번 결함이 정확히 그 틈이었다.
{
  // ⚠ probe 도 env 를 격리한다 — `opencode --version` 조차 설정 디렉터리를 만들 수 있어서, 상속 env 로 부르면
  //  **실행 환경의** XDG_CONFIG_HOME 아래에 흔적을 남긴다(테스트가 개발자 환경을 오염시키는 형태).
  const isolated = { ...process.env, HOME: SANDBOX, XDG_CONFIG_HOME: "" };
  const probe = spawnSync("opencode", ["--version"], { env: isolated, encoding: "utf8", timeout: 15000 });
  if (probe.status !== 0) skip("O6 실제 opencode 로 설정 유효성 확인", "opencode 미설치");
  else {
    freshHome();
    ASSETS = [
      asset("skill", "probe-skill", "# 프로브 스킬"),
      asset("subagent", "probe-agent", "프로브 에이전트 본문",
        { frontmatter: { color: "green", model: "sonnet", tools: ["Read"] } }),
    ];
    await sync();
    const g = spawnSync("opencode", ["debug", "agent", "probe-agent"],
      { env: { ...process.env, HOME, XDG_CONFIG_HOME: "" }, encoding: "utf8", timeout: 30000, cwd: SANDBOX });
    const out = `${g.stdout || ""}${g.stderr || ""}`;
    /Configuration is invalid|ConfigInvalidError/i.test(out)
      ? bad("O6 실제 opencode 가 우리 자산을 유효한 설정으로 읽는다", `설정 거부됨: ${out.split("\n").slice(0, 3).join(" / ")}`)
      : (/"mode":\s*"subagent"|probe-agent/.test(out)
        ? ok("O6 실제 opencode 가 우리 자산을 유효한 설정으로 읽는다")
        : skip("O6 실제 opencode 로 설정 유효성 확인", `출력 형태 미상: ${out.slice(0, 80)}`));
  }
}

// ⓪ 재검 — 실 홈을 안 건드렸나.
{
  const after = fingerprint();
  after === REAL_BEFORE ? ok("⓪ 실 설정 디렉터리 무접촉(~/.config + XDG 둘 다)")
    : bad("⓪ 실 홈 무접촉", `샌드박스 계약 파손: ${REAL_OCS.join(", ")}`);
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets(opencode): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
