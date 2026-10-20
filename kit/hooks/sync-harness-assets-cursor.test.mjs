#!/usr/bin/env node
// 조직 자산 materialize 사양테스트(cursor) — #4927. grok/antigravity 판과 같은 구조:
//  로컬 스텁 게이트웨이 + 샌드박스 HOME(LIVELY_HOME), 러너를 **실제로 돌려** 산출 파일을 본다(네트워크·실 홈 미접촉).
//  실행: node scripts/run-tests.mjs sync-harness-assets-cursor
//  엣지 표: 스크래치패드 spec.md §D(D1~D4) — 케이스 이름의 [D#] 가 그 행 번호다.
//   Cursor 실측(번들 2026.10.19): 서브에이전트 frontmatter 는 단순 key:value(모르는 키 무시 — 그래도 이식 최소셋 규칙) ·
//   커맨드는 **frontmatter 를 해석하지 않는다**(전문이 프롬프트·첫 줄이 제목) · 스킬은 claude 와 같은 오픈표준.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-cursor-test-"));
const HOME = join(SANDBOX, "home");
const ROOT = join(HOME, ".cursor");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const eq = (n, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(n) : bad(n, `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`));

// ⓪ 실 ~/.cursor 무접촉(관측 장치 없이 통과하는 vacuous test 방지).
const REAL = join(homedir(), ".cursor");
const fingerprint = () => (existsSync(REAL) ? String(statSync(REAL).mtimeMs) : "(none)");
const REAL_BEFORE = fingerprint();

let ASSETS = [];
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url);
  if (req.url.startsWith("/api/ui/org/runner/assets")) { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ assets: ASSETS })); return; }
  res.writeHead(200, { "content-type": "application/json" });
  res.end(req.url.includes("harness-local-pref") ? JSON.stringify({ disabled: [] }) : "{}");
  if (req.method === "POST") req.resume();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;
const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const asset = (kind, id, body, extra = {}) => ({ id, kind, description: `${id} 설명`, body, content_hash: hash(body + id + JSON.stringify(extra)), frontmatter: extra.frontmatter ?? {}, ...extra });

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "token"), "test-token\n");
  writeFileSync(join(HOME, ".lively", "gateway-url"), GW + "\n");
}
// ⚠ spawnSync 금지 — 스텁이 이 프로세스 안에서 도므로 동기 대기 중엔 응답을 못 한다(codex·grok 판과 같은 함정).
function sync() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--harness", "cursor"], { env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: HOME, CLAUDECODE: "" }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "", out = "";
    p.stdout.on("data", (d) => { out += d; });
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err, stdout: out }));
  });
}
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
const frontmatter = (text) => { const m = /^---\n([\s\S]*?)\n---\n/.exec(text || ""); return m ? m[1] : null; };

try {
  freshHome();
  ASSETS = [
    asset("skill", "org-skill", "# 스킬 본문\n내용"),
    asset("subagent", "diff-reviewer", "리뷰어다.\n한글과 \"인용부호\"도 있다.", { frontmatter: { name: "diff-reviewer", color: "green", model: "sonnet", tools: ["Read", "Grep", "Bash"] } }),
    asset("command", "org-cmd", "이 프롬프트를 실행하라.\n$ARGUMENTS", { frontmatter: { "argument-hint": "<파일>", "allowed-tools": "Bash" } }),
    { ...asset("command", "bare-cmd", "첫 줄이 제목이다.\n둘째 줄 $1"), description: "" },
  ];
  const r = await sync();
  hits.some((h) => h.startsWith("/api/ui/org/runner/assets?harness=cursor"))
    ? ok("D0 러너가 스텁 게이트웨이를 cursor 로 실제 호출") : bad("D0 배선", `스텁 미호출 — 아래 단언은 무의미하다 ${JSON.stringify(hits)}`);
  // cursor 는 자산 재로드 신호가 없다(reloadAssets:false) — claude 형 reloadSkills JSON 이 새면 어댑터 맥락에 섞인다.
  eq("D0b 러너 stdout 무출력(claude 재로드 봉투 없음)", String(r.stdout).trim(), "");

  // [D4] 스킬 — claude 와 같은 오픈표준 파일, 자리는 ~/.cursor/skills(compat 의 ~/.claude/skills 사본을 이긴다 — 실측).
  const skill = read(join(ROOT, "skills", "org-skill", "SKILL.md"));
  skill && /^---\n/.test(skill) && /^name:/m.test(frontmatter(skill) || "") && skill.includes("# 스킬 본문")
    ? ok("D4[D4] 스킬 → ~/.cursor/skills/<id>/SKILL.md") : bad("D4[D4] 스킬", String(skill).slice(0, 80));

  // [D1] 서브에이전트 — name·description·본문만(claude 의 color·model·tools 누출 금지).
  const agent = read(join(ROOT, "agents", "diff-reviewer.md"));
  const fm = frontmatter(agent);
  if (!agent || !fm) bad("D1[D1] 서브에이전트 → ~/.cursor/agents/<id>.md", String(agent).slice(0, 80));
  else {
    eq("D1a[D1] color·model·tools 미누출", ["color", "model", "tools"].filter((k) => new RegExp(`^${k}:`, "m").test(fm)), []);
    eq("D1b[D1] name·description 실림 · 본문 보존", [/^name:/m.test(fm), /^description:/m.test(fm), agent.includes("리뷰어다.")], [true, true, true]);
  }

  // [D2] 커맨드 — 첫 줄 = 설명(제목) · YAML 없음 · 본문 그대로($ARGUMENTS 보존).
  const cmd = read(join(ROOT, "commands", "org-cmd.md"));
  if (!cmd) bad("D2[D2] 커맨드 → ~/.cursor/commands/<id>.md", "파일 없음");
  else {
    const first = cmd.split("\n")[0];
    eq("D2a[D2] 첫 줄 = 설명", first, "org-cmd 설명");
    eq("D2b[D2] YAML·claude 전용 키 없음", [cmd.startsWith("---"), /argument-hint|allowed-tools/.test(cmd)], [false, false]);
    eq("D2c[D2] 본문 보존", cmd.includes("이 프롬프트를 실행하라.\n$ARGUMENTS"), true);
  }
  // [D3] 설명이 빈 커맨드 — 첫 줄 = 본문 첫 줄(provenance 주석이 제목이 되면 안 된다).
  const bare = read(join(ROOT, "commands", "bare-cmd.md"));
  eq("D3[D3] 설명 없음 → 첫 줄 = 본문 첫 줄", bare ? bare.split("\n")[0] : null, "첫 줄이 제목이다.");

  eq("D9 실 ~/.cursor 무접촉", fingerprint(), REAL_BEFORE);
} finally {
  server.close();
  rmSync(SANDBOX, { recursive: true, force: true });
}

console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets-cursor: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
