#!/usr/bin/env node
// 조직 자산 materialize 사양테스트(codex) — "스킬·서브에이전트·슬래시커맨드가 두 하네스에 같은 수준으로 배포된다"
//  ([[delivery-install-invariants]] ②)를 실제 러너를 돌려 고정한다. 엣지 표는 프로젝트 #1475 사양의 A1~A7.
//  오프라인: 게이트웨이는 **로컬 스텁 서버**로 세운다(네트워크·실 게이트웨이 미접촉).
//  샌드박스 HOME(LIVELY_HOME) 안에서만 쓴다 — 실 ~/.codex 무접촉은 ⓪ 이 지문으로 못박는다.
//  실행: node kit/hooks/sync-harness-assets-codex.test.mjs   (npm test 체인에 자동 포함)
//
//  왜: codex 는 서브에이전트가 **md 가 아니라 TOML**이고 슬래시커맨드 자리가 **prompts** 다. 포맷 변환이 조용히
//   틀리면 결과는 "파일은 있는데 하네스가 안 읽는다" — 아무 에러도 안 나고 조직 자산만 통째로 증발한다.
//   그래서 단언은 "파일이 생겼나"가 아니라 **"그 하네스가 읽을 수 있는 형태인가"**(A3: 값 라운드트립)까지 본다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-codex-test-"));
const HOME = join(SANDBOX, "home");
const CODEX = join(HOME, ".codex");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const digest = (p) => { try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return "(none)"; } };

// ⓪ 배선 단언 — 실 홈 무접촉(관측 장치 없이 통과하는 vacuous test 방지). 실 스킬 디렉터리 지문을 남긴다.
const REAL_SKILLS = join(homedir(), ".codex", "skills");
const REAL_BEFORE = existsSync(REAL_SKILLS) ? String(statSync(REAL_SKILLS).mtimeMs) : "(none)";

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
  // 관측 push·로컬 토글 계획 — 이 테스트의 관심 밖(러너가 fail-soft 로 넘어간다).
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
// ⚠ spawnSync 를 쓰면 안 된다 — 게이트웨이 스텁이 **이 프로세스 안에서** 돌기 때문에, 동기 대기 중엔
//  이벤트 루프가 멈춰 서버가 응답을 못 한다. 러너는 fetch 타임아웃 뒤 fail-open 으로 조용히 끝나고,
//  테스트는 "파일이 안 생겼다"만 보게 된다(원인은 러너가 아니라 테스트 하네스다). 반드시 비동기로 기다린다.
function sync() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--harness", "codex"],
      { env: { ...process.env, LIVELY_HOME: HOME }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err }));
  });
}
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
// TOML basic 문자열은 JSON 문자열과 escape 규칙이 호환된다 → 값 라운드트립으로 "하네스가 읽을 수 있나"를 본다.
function tomlValue(toml, key) {
  const m = new RegExp(`^${key} = (".*")$`, "m").exec(toml || "");
  if (!m) return undefined;
  try { return JSON.parse(m[1]); } catch { return null; }   // null = 파싱 불가(= 하네스도 못 읽는다)
}

// ── A1·A2·A4·A5 — 세 종류를 한 번에 배포하고 각 자리·형식을 본다 ────────────
const SUBAGENT_BODY = '리뷰어다.\n"인용부호"와 백슬래시\\ 와 한글, 그리고 삼중따옴표 """ 도 본문에 있다.';
freshHome();
ASSETS = [
  asset("skill", "org-skill", "# 스킬 본문\n내용"),
  asset("subagent", "diff-reviewer", SUBAGENT_BODY, { frontmatter: { name: "diff-reviewer", model: "sonnet", tools: ["Read", "Grep"] } }),
  asset("command", "org-cmd", "이 프롬프트를 실행하라.\n$ARGUMENTS"),
];
let r = await sync();
{
  const skill = read(join(CODEX, "skills", "org-skill", "SKILL.md"));
  // A1 — 스킬은 오픈표준이라 claude 와 같은 파일(frontmatter + 본문).
  skill && /^---\n/.test(skill) && skill.includes("# 스킬 본문")
    ? ok("A1 스킬 → ~/.codex/skills/<id>/SKILL.md (frontmatter 유지)") : bad("A1 스킬", String(skill).slice(0, 80));

  // A2 — 서브에이전트는 TOML 로 변환되고 필수 3키가 옮겨진다.
  const toml = read(join(CODEX, "agents", "diff-reviewer.toml"));
  const name = tomlValue(toml, "name"), desc = tomlValue(toml, "description"), di = tomlValue(toml, "developer_instructions");
  name === "diff-reviewer" && desc === "diff-reviewer 설명" && di === SUBAGENT_BODY
    ? ok("A2 서브에이전트 → ~/.codex/agents/<id>.toml (name·description·developer_instructions)")
    : bad("A2 서브에이전트", `name=${JSON.stringify(name)} desc=${JSON.stringify(desc)} di=${di === SUBAGENT_BODY}`);

  // A3 — 따옴표·개행·한글·삼중따옴표가 들어가도 값이 **원문 그대로** 복원된다(= 파일이 안 깨졌다).
  //  multi-line `"""` 로 썼다면 본문의 `"""` 가 문자열을 조기 종료시켜 여기서 깨진다.
  di === SUBAGENT_BODY && !/\n/.test(new RegExp(`developer_instructions = (".*")$`, "m").exec(toml || "")?.[1] || "\n")
    ? ok("A3 특수문자 본문 라운드트립(값 보존 · 한 줄 escape)") : bad("A3 라운드트립", "본문이 원문과 다르거나 여러 줄로 샜다");

  // A5 — 하네스 고유 필드(model·tools)는 옮기지 않는다. "sonnet" 은 codex 에서 무효 모델이라 넣으면 에이전트가 안 뜬다.
  toml && !/^model = /m.test(toml) && !/tools/.test(toml)
    ? ok("A5 하네스 고유 필드(model·tools) 미이식") : bad("A5 필드 이식", "model/tools 가 새어 들어갔다");

  // A4 — 슬래시커맨드는 codex 커스텀 프롬프트 자리로, 하네스가 못 읽는 frontmatter 없이.
  const cmd = read(join(CODEX, "prompts", "org-cmd.md"));
  cmd && !/^---/.test(cmd) && cmd.includes("이 프롬프트를 실행하라.")
    ? ok("A4 슬래시커맨드 → ~/.codex/prompts/<id>.md (frontmatter 없음)") : bad("A4 커맨드", String(cmd).slice(0, 80));
}

// ── 배선 단언 — 러너가 실제로 스텁을 불렀나(안 불렀으면 위 단언은 전부 무의미) ──
hits.includes("/api/ui/org/runner/assets")
  ? ok("배선: 러너가 게이트웨이 자산 엔드포인트를 호출") : bad("배선", `호출 없음(hits=${hits.join(",")}) exit=${r.status}`);

// ── A6 — 중앙에서 회수하면(desired 에서 빠지면) 그 파일이 지워진다 ───────────
{
  ASSETS = [asset("skill", "org-skill", "# 스킬 본문\n내용")];   // subagent·command 회수
  await sync();
  const goneAgent = !existsSync(join(CODEX, "agents", "diff-reviewer.toml"));
  const gonePrompt = !existsSync(join(CODEX, "prompts", "org-cmd.md"));
  const keptSkill = existsSync(join(CODEX, "skills", "org-skill", "SKILL.md"));
  goneAgent && gonePrompt && keptSkill
    ? ok("A6 회수 → agents/prompts 파일 삭제, 남은 자산은 유지")
    : bad("A6 회수", `agent제거=${goneAgent} prompt제거=${gonePrompt} skill유지=${keptSkill}`);
}

// ── A7 — 멤버 본인 파일과 id 가 겹치면 멤버 파일을 보존하고 배포를 생략한다 ──
{
  freshHome();
  mkdirSync(join(CODEX, "agents"), { recursive: true });
  const mine = join(CODEX, "agents", "diff-reviewer.toml");
  writeFileSync(mine, 'name = "내 것"\n');
  const before = digest(mine);
  ASSETS = [asset("subagent", "diff-reviewer", "조직 본문", { frontmatter: { name: "diff-reviewer" } })];
  await sync();
  digest(mine) === before ? ok("A7 id 충돌 → 멤버 파일 보존(배포 생략)") : bad("A7 충돌", "멤버 파일을 덮어썼다");
}

// ⓪ 재검
const realAfter = existsSync(REAL_SKILLS) ? String(statSync(REAL_SKILLS).mtimeMs) : "(none)";
realAfter === REAL_BEFORE ? ok("⓪ 실 ~/.codex 무접촉") : bad("⓪ 샌드박스 계약", "실 홈이 변경됐다");

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
