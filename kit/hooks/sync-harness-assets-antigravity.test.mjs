#!/usr/bin/env node
// 조직 자산 materialize 사양테스트(antigravity) — #1689. codex/opencode 판과 같은 구조:
//  로컬 스텁 게이트웨이 + 샌드박스 HOME(LIVELY_HOME), 러너를 **실제로 돌려** 산출 파일을 본다(네트워크·실 홈 미접촉).
//  실행: node kit/hooks/sync-harness-assets-antigravity.test.mjs   (npm test 체인에 자동 포함)
//
//  엣지: A0 배선(스텁 실호출) · A1 스킬 오픈표준 그대로 · A2 서브에이전트 = **디렉터리형 + agent.md**(dirFile 축)
//        + claude 전용 키 미누출 · A3 커맨드 = workflows/<id>.md + 스키마 밖 키 미누출 · A4 회수(멤버 것 보존) ·
//        ⓪ 실 ~/.gemini 무접촉(이 머신엔 실제 agy 설치가 있다).
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-agy-test-"));
const HOME = join(SANDBOX, "home");
const ROOT = join(HOME, ".gemini", "config");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// ⓪ 배선 단언 — 실 ~/.gemini 무접촉(관측 장치 없이 통과하는 vacuous test 방지).
const REAL = join(homedir(), ".gemini");
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
    const p = spawn(process.execPath, [RUNNER, "--harness", "antigravity"],
      { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, ...env }, stdio: ["ignore", "pipe", "pipe"] });
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

// ── A0~A3 — 세 종류를 배포하고 자리·형식을 본다 ─────────────────────────────
freshHome();
ASSETS = [
  asset("skill", "org-skill", "# 스킬 본문\n내용"),
  // claude 에서 온 그대로의 frontmatter — 스키마 미확인 키(색·모델·툴)는 넘어가면 안 된다(#1689 §7).
  asset("subagent", "diff-reviewer", "리뷰어다.\n한글과 \"인용부호\"도 있다.",
    { frontmatter: { name: "diff-reviewer", color: "green", model: "sonnet", tools: ["Read", "Grep", "Bash"] } }),
  asset("command", "org-cmd", "이 프롬프트를 실행하라.\n$ARGUMENTS",
    { frontmatter: { "argument-hint": "<파일>", "allowed-tools": ["Bash"] } }),
];
await sync();
{
  hits.some((h) => h.includes("/runner/assets"))
    ? ok("A0 러너가 스텁 게이트웨이를 실제로 호출") : bad("A0 배선", "스텁 미호출 — 아래 단언은 무의미하다");

  // A1 — 스킬은 오픈표준이라 claude 와 같은 파일. 자리는 ~/.gemini/config/skills/.
  const skill = read(join(ROOT, "skills", "org-skill", "SKILL.md"));
  skill && /^---\n/.test(skill) && skill.includes("# 스킬 본문")
    ? ok("A1 스킬 → ~/.gemini/config/skills/<id>/SKILL.md (오픈표준 그대로)")
    : bad("A1 스킬", String(skill).slice(0, 80));

  // ⭐ A2 — 서브에이전트는 **디렉터리형인데 엔트리 파일이 agent.md** 다(dirFile 축 — SKILL.md 하드코딩이면 빗나간다).
  const agent = read(join(ROOT, "agents", "diff-reviewer", "agent.md"));
  const fm = frontmatter(agent);
  if (!agent || !fm) bad("A2 서브에이전트 → agents/<id>/agent.md", String(agent).slice(0, 80));
  else {
    const leaked = ["color", "model", "tools"].filter((k) => new RegExp(`^${k}:`, "m").test(fm));
    leaked.length
      ? bad("A2 서브에이전트에 미확인 키가 안 실린다", `누출: ${leaked.join(",")}`)
      : ok("A2 서브에이전트에 미확인 키가 안 실린다(color·model·tools)");
    /^name:/m.test(fm) && /^description:/m.test(fm)
      ? ok("A2b 서브에이전트에 name·description 은 실린다(#1689 실측 안전셋)") : bad("A2b name·description", fm.slice(0, 120));
    agent.includes("리뷰어다.") ? ok("A2c 본문이 보존된다") : bad("A2c 본문 보존", agent.slice(0, 80));
  }

  // A3 — 커맨드 등가 = workflows/<id>.md, description 만(argument-hint 류는 미지원 — 프롬프트로 새면 안 된다).
  const wf = read(join(ROOT, "workflows", "org-cmd.md"));
  const wfm = frontmatter(wf);
  if (!wf || !wfm) bad("A3 커맨드 → workflows/<id>.md", String(wf).slice(0, 80));
  else {
    const leaked = ["argument-hint", "allowed-tools"].filter((k) => new RegExp(`^${k}:`, "m").test(wfm));
    leaked.length ? bad("A3 워크플로우에 스키마 밖 키가 안 실린다", `누출: ${leaked.join(",")}`)
      : ok("A3 워크플로우에 스키마 밖 키가 안 실린다");
    wf.includes("$ARGUMENTS") ? ok("A3b 워크플로우 본문 보존") : bad("A3b 본문 보존", wf.slice(0, 80));
  }
}

// ── A4 회수(prune) — 중앙이 뺀 자산은 antigravity 디스크에서도 사라진다. **멤버 본인 것은 보존.** ──
//  화이트리스트에 workflows 디렉터리명이 빠지면 조용히 안 돈다(assetDirNames 파생이 그걸 막는다 — F1 케이스와 짝).
{
  freshHome();
  ASSETS = [asset("skill", "gone-skill", "# 사라질 것"), asset("command", "gone-wf", "사라질 워크플로우")];
  await sync();
  const both = existsSync(join(ROOT, "skills", "gone-skill", "SKILL.md")) && existsSync(join(ROOT, "workflows", "gone-wf.md"));
  // 멤버가 직접 만든 것 — 매니페스트 밖이므로 회수 대상이 아니다.
  mkdirSync(join(ROOT, "skills", "my-own"), { recursive: true });
  writeFileSync(join(ROOT, "skills", "my-own", "SKILL.md"), "---\nname: my-own\ndescription: 내 것\n---\n본문\n");
  writeFileSync(join(ROOT, "workflows", "my-wf.md"), "---\ndescription: 내 워크플로우\n---\n본문\n");

  ASSETS = [];   // 중앙이 전부 뺐다
  await sync();
  const gone = !existsSync(join(ROOT, "skills", "gone-skill", "SKILL.md")) && !existsSync(join(ROOT, "workflows", "gone-wf.md"));
  const mine = existsSync(join(ROOT, "skills", "my-own", "SKILL.md")) && existsSync(join(ROOT, "workflows", "my-wf.md"));
  (both && gone && mine)
    ? ok("A4 회수 — 중앙이 뺀 자산만 제거, 멤버 본인 스킬·워크플로우는 보존")
    : bad("A4 회수", `초기배포=${both} 제거=${gone} 멤버보존=${mine}`);
}

// ⓪ 재검 — 실 ~/.gemini 를 안 건드렸나.
{
  fingerprint() === REAL_BEFORE ? ok("⓪ 실 ~/.gemini 무접촉")
    : bad("⓪ 실 홈 무접촉", "샌드박스 계약 파손 — 실 ~/.gemini 가 변경됨");
}

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets(antigravity): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
