#!/usr/bin/env node
// 조직 자산 materialize 사양테스트(grok) — #1701. codex/opencode/antigravity 판과 같은 구조:
//  로컬 스텁 게이트웨이 + 샌드박스 HOME(LIVELY_HOME), 러너를 **실제로 돌려** 산출 파일을 본다(네트워크·실 홈 미접촉).
//  실행: node kit/hooks/sync-harness-assets-grok.test.mjs   (npm test 체인에 자동 포함)
//
//  엣지: G0 배선(스텁 실호출) · G1 스킬 오픈표준 그대로(~/.grok/skills) · G2 서브에이전트 = agents/<id>.md
//        **이식 최소셋만**(claude 의 model·tools 미누출 — grok 파서는 관용이지만 런타임 의미 미실측, #1701 §2-5) ·
//        G3 커맨드 = commands/<id>.md(claude 레거시 레이아웃 그대로 — frontmatter 해석 실측 확인) ·
//        G4 회수(멤버 것 보존) · G5 GROK_HOME 격리(LIVELY_HOME 이 이긴다) · ⓪ 실 ~/.grok 무접촉(이 머신엔 실설치가 있다).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-grok-test-"));
const HOME = join(SANDBOX, "home");
const ROOT = join(HOME, ".grok");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// ⓪ 배선 단언 — 실 ~/.grok 무접촉(관측 장치 없이 통과하는 vacuous test 방지).
const REAL = join(homedir(), ".grok");
const fingerprint = () => (existsSync(REAL) ? String(statSync(REAL).mtimeMs) : "(none)");
const REAL_BEFORE = fingerprint();

// ── 게이트웨이 스텁 ─────────────────────────────────────────────────────────
let ASSETS = [];
const hits = [];
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
    const p = spawn(process.execPath, [RUNNER, "--harness", "grok"],
      { env: { ...process.env, LIVELY_HOME: HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

// ── G0~G3 — 세 종류를 배포하고 자리·형식을 본다 ─────────────────────────────
freshHome();
ASSETS = [
  asset("skill", "org-skill", "# 스킬 본문\n내용"),
  // claude 에서 온 그대로의 frontmatter — model·tools 는 파서가 받아줘도(관용 실측) 런타임 의미가 미실측이라
  //  넘어가면 안 된다(codex·opencode·antigravity 와 같은 이식 최소셋 규칙 — grok-agent 컴포저가 거른다).
  asset("subagent", "diff-reviewer", "리뷰어다.\n한글과 \"인용부호\"도 있다.",
    { frontmatter: { name: "diff-reviewer", color: "green", model: "sonnet", tools: ["Read", "Grep", "Bash"] } }),
  // 커맨드는 claude 레거시 레이아웃 그대로(frontmatter 해석 실측 확인 — description 이 슬래시 메뉴에 뜬다).
  asset("command", "org-cmd", "이 프롬프트를 실행하라.\n$ARGUMENTS",
    { frontmatter: { "argument-hint": "<파일>" } }),
];
await sync();
{
  hits.some((h) => h.includes("/runner/assets"))
    ? ok("G0 러너가 스텁 게이트웨이를 실제로 호출") : bad("G0 배선", "스텁 미호출 — 아래 단언은 무의미하다");

  // G1 — 스킬은 오픈표준이라 claude 와 같은 파일. 자리는 ~/.grok/skills/ (compat 의 ~/.claude/skills 사본과
  //  동명이어도 네이티브가 이긴다 — #1701 실측 — 그래서 여기가 정본 자리다).
  const skill = read(join(ROOT, "skills", "org-skill", "SKILL.md"));
  skill && /^---\n/.test(skill) && skill.includes("# 스킬 본문")
    ? ok("G1 스킬 → ~/.grok/skills/<id>/SKILL.md (오픈표준 그대로)")
    : bad("G1 스킬", String(skill).slice(0, 80));

  // ⭐ G2 — 서브에이전트는 flat md(agents/<id>.md — antigravity 의 디렉터리형과 다르다). 이식 최소셋만.
  const agent = read(join(ROOT, "agents", "diff-reviewer.md"));
  const fm = frontmatter(agent);
  if (!agent || !fm) bad("G2 서브에이전트 → agents/<id>.md", String(agent).slice(0, 80));
  else {
    const leaked = ["color", "model", "tools"].filter((k) => new RegExp(`^${k}:`, "m").test(fm));
    leaked.length
      ? bad("G2 서브에이전트에 미확인 키가 안 실린다", `누출: ${leaked.join(",")}`)
      : ok("G2 서브에이전트에 미확인 키가 안 실린다(color·model·tools)");
    /^name:/m.test(fm) && /^description:/m.test(fm)
      ? ok("G2b 서브에이전트에 name·description 은 실린다(이식 최소셋)") : bad("G2b name·description", fm.slice(0, 120));
    agent.includes("리뷰어다.") ? ok("G2c 본문이 보존된다") : bad("G2c 본문 보존", agent.slice(0, 80));
  }

  // G3 — 커맨드 = commands/<id>.md (claude 레거시 레이아웃 — grok 이 frontmatter 를 해석한다, 실측).
  const cmd = read(join(ROOT, "commands", "org-cmd.md"));
  const cfm = frontmatter(cmd);
  if (!cmd || !cfm) bad("G3 커맨드 → commands/<id>.md", String(cmd).slice(0, 80));
  else {
    /^description:/m.test(cfm) ? ok("G3 커맨드 frontmatter 에 description(슬래시 메뉴 표기)") : bad("G3 description", cfm.slice(0, 120));
    cmd.includes("$ARGUMENTS") ? ok("G3b 커맨드 본문 보존") : bad("G3b 본문 보존", cmd.slice(0, 80));
  }
}

// ── G4 회수(prune) — 중앙이 뺀 자산은 grok 디스크에서도 사라진다. **멤버 본인 것은 보존.** ──
{
  freshHome();
  ASSETS = [asset("skill", "gone-skill", "# 사라질 것"), asset("command", "gone-cmd", "사라질 커맨드")];
  await sync();
  const both = existsSync(join(ROOT, "skills", "gone-skill", "SKILL.md")) && existsSync(join(ROOT, "commands", "gone-cmd.md"));
  // 멤버가 직접 만든 것 — 매니페스트 밖이므로 회수 대상이 아니다.
  mkdirSync(join(ROOT, "skills", "my-own"), { recursive: true });
  writeFileSync(join(ROOT, "skills", "my-own", "SKILL.md"), "---\nname: my-own\ndescription: 내 것\n---\n본문\n");
  mkdirSync(join(ROOT, "commands"), { recursive: true });
  writeFileSync(join(ROOT, "commands", "my-cmd.md"), "---\ndescription: 내 커맨드\n---\n본문\n");

  ASSETS = [];   // 중앙이 전부 뺐다
  await sync();
  const gone = !existsSync(join(ROOT, "skills", "gone-skill", "SKILL.md")) && !existsSync(join(ROOT, "commands", "gone-cmd.md"));
  const mine = existsSync(join(ROOT, "skills", "my-own", "SKILL.md")) && existsSync(join(ROOT, "commands", "my-cmd.md"));
  (both && gone && mine)
    ? ok("G4 회수 — 중앙이 뺀 자산만 제거, 멤버 본인 스킬·커맨드는 보존")
    : bad("G4 회수", `초기배포=${both} 제거=${gone} 멤버보존=${mine}`);
}

// ── G5 GROK_HOME 격리 — LIVELY_HOME(샌드박스)이 설정되면 GROK_HOME 을 따르지 않는다(레지스트리 계약).
//  안 그러면 개발자 실환경의 GROK_HOME 이 테스트 격리를 뚫어 **실 grok 홈에 자산을 쓴다**(opencode XDG 실사고와 동형).
{
  freshHome();
  const DECOY = join(SANDBOX, "decoy-grok-home");
  ASSETS = [asset("skill", "iso-skill", "# 격리 확인")];
  await sync({ GROK_HOME: DECOY });
  const inHome = existsSync(join(ROOT, "skills", "iso-skill", "SKILL.md"));
  const inDecoy = existsSync(DECOY);
  (inHome && !inDecoy)
    ? ok("G5 GROK_HOME 격리 — LIVELY_HOME 아래에만 쓰고 GROK_HOME 미끼는 무접촉")
    : bad("G5 GROK_HOME 격리", `home=${inHome} decoy=${inDecoy}`);
}

// ⓪ 재검 — 실 ~/.grok 를 안 건드렸나.
{
  fingerprint() === REAL_BEFORE ? ok("⓪ 실 ~/.grok 무접촉")
    : bad("⓪ 실 홈 무접촉", "샌드박스 계약 파손 — 실 ~/.grok 가 변경됨");
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets(grok): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
