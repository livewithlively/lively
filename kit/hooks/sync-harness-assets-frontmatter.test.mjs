#!/usr/bin/env node
// 조직 자산 materialize 사양테스트 — **body 에 frontmatter 가 들어온 자산**(claude 하네스).
//  실행: node kit/hooks/sync-harness-assets-frontmatter.test.mjs
//  구조는 codex/opencode/antigravity 판과 같다: 로컬 스텁 게이트웨이 + 샌드박스 HOME(LIVELY_HOME),
//  러너를 **실제로 돌려** 산출 파일을 본다(네트워크·실 홈 미접촉).
//
// 왜 이 파일이 있나 — 2026-08-20 실측: 조직 자산 65개 중 8개가 body 에 파일 전문(frontmatter 포함)을 담고
//  있었다. composeFile 은 description 컬럼·frontmatter 필드로 frontmatter 를 **직접 만들어** 붙이므로,
//  그대로 심으면 frontmatter 두 벌인 파일이 되고 둘째 블록이 **본문 첫 단락으로 새어든다**
//  (스킬 설명이 YAML 로 시작한다). 반대 방향의 회귀도 같이 막는다 — 본문이 `---` 수평선으로 시작하는
//  정상 마크다운을 frontmatter 로 오인해 잘라먹으면 안 된다.
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

const RUNNER = join(dirname(fileURLToPath(import.meta.url)), "sync-harness-assets.mjs");
const SANDBOX = mkdtempSync(join(tmpdir(), "sync-fm-test-"));
const HOME = join(SANDBOX, "home");
const CLAUDE = join(HOME, ".claude");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// ⓪ 배선 단언 — 실 ~/.claude 무접촉(이 머신엔 실제 claude 설치가 있다).
const REAL = join(homedir(), ".claude");
const fingerprint = () => (existsSync(REAL) ? String(statSync(REAL).mtimeMs) : "(none)");
const REAL_BEFORE = fingerprint();

let ASSETS = [];
const hits = [];
const server = createServer((req, res) => {
  hits.push(req.url.split("?")[0]);
  res.writeHead(200, { "content-type": "application/json" });
  if (req.url.startsWith("/api/ui/org/runner/assets")) return res.end(JSON.stringify({ assets: ASSETS }));
  res.end(req.url.includes("harness-local-pref") ? JSON.stringify({ disabled: [] }) : "{}");
  if (req.method === "POST") req.resume();
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;

const hash = (s) => createHash("sha256").update(String(s)).digest("hex");
const asset = (kind, id, body, extra = {}) => ({
  id, kind, description: `${id} 의 정본 설명`, body, content_hash: hash(body + id),
  frontmatter: extra.frontmatter ?? {}, ...extra,
});

function freshHome() {
  rmSync(HOME, { recursive: true, force: true });
  mkdirSync(join(HOME, ".lively"), { recursive: true });
  writeFileSync(join(HOME, ".lively", "token"), "test-token\n");
  writeFileSync(join(HOME, ".lively", "gateway-url"), GW + "\n");
}
// ⚠ spawnSync 금지 — 스텁이 이 프로세스 안에서 도므로 동기 대기 중엔 응답을 못 한다.
function sync() {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [RUNNER, "--harness", "claude"],
      { env: { ...process.env, LIVELY_HOME: HOME, CLAUDE_CONFIG_DIR: CLAUDE }, stdio: ["ignore", "pipe", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => { err += d; });
    p.on("close", (status) => resolve({ status, stderr: err }));
  });
}
const read = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);
// 파일 안의 `---\n…\n---` 블록 개수 — 두 벌이면 둘째가 본문으로 새어든 상태다.
const fmBlocks = (t) => (String(t || "").match(/^---[ \t]*$/gm) || []).length / 2;

freshHome();
ASSETS = [
  // 실측된 결함 형태 — body 가 파일 전문(frontmatter 포함)이다.
  asset("skill", "fm-in-body", '---\nname: fm-in-body\ndescription: "body 안의 낡은 설명"\n---\n\n# 제목\n본문 첫 문장.'),
  // 정상형 — 대조군.
  asset("skill", "plain", "# 제목\n본문 첫 문장."),
  // 회귀 방어 — 본문이 수평선으로 시작하는 정상 마크다운(frontmatter 아님).
  asset("skill", "hr-first", "---\n\n# 제목\n수평선으로 시작한다."),
  // 서브에이전트도 같은 경로(composeFile 공통)를 탄다.
  asset("subagent", "agent-fm", "---\nname: agent-fm\n---\n\n리뷰어다."),
  // BOM + CRLF — 실제로 올라오는 파일은 편집기·OS 를 거치므로 이 둘이 섞인다.
  asset("skill", "crlf-fm", "\uFEFF---\r\nname: crlf-fm\r\n---\r\n\r\n# 제목\r\nCRLF 본문."),
  // 오탐 방어 — 수평선으로 시작하고, 콜론 꼴 산문(맨 URL 도 `^키:` 에 걸린다)을 지나 두 번째 수평선을 만나는 본문.
  asset("skill", "hr-prose", "---\n\nhttps://example.com 를 본다.\nTODO: 고칠 것\n\n---\n\n# 제목\n본문."),
];
await sync();

hits.some((h) => h.includes("/runner/assets"))
  ? ok("⓪ 러너가 스텁 게이트웨이를 실제로 호출") : bad("⓪ 배선", "스텁 미호출 — 아래 단언은 무의미하다");

{
  const f = read(join(CLAUDE, "skills", "fm-in-body", "SKILL.md"));
  if (!f) bad("① body 의 frontmatter 를 벗긴다", "파일 없음");
  else {
    fmBlocks(f) === 1 ? ok("① frontmatter 는 한 벌이다") : bad("① frontmatter 한 벌", `${fmBlocks(f)} 벌: ${f.slice(0, 160)}`);
    /<!-- .*-->\n\n# 제목/s.test(f) ? ok("①b 본문이 `# 제목` 으로 시작한다(YAML 누출 없음)") : bad("①b 본문 시작", f.slice(0, 200));
    f.includes("body 안의 낡은 설명")
      ? bad("①c 정본은 컬럼 — body 사본 설명이 남지 않는다", "낡은 설명이 파일에 남았다")
      : ok("①c 정본은 컬럼 — body 사본 설명이 남지 않는다");
    /^description: "fm-in-body 의 정본 설명"$/m.test(f)
      ? ok("①d description 은 컬럼값이 실린다") : bad("①d description 컬럼값", f.slice(0, 200));
  }
}
{
  const f = read(join(CLAUDE, "skills", "plain", "SKILL.md"));
  f && fmBlocks(f) === 1 && f.includes("# 제목") ? ok("② 정상형은 그대로 심긴다") : bad("② 정상형", String(f).slice(0, 160));
}
{
  const f = read(join(CLAUDE, "skills", "hr-first", "SKILL.md"));
  // 수평선은 본문의 일부다 — 잘라내면 문서가 깨진다(오탐 회귀 방어).
  f && f.includes("수평선으로 시작한다") && /-->\n\n---\n/.test(f)
    ? ok("③ 수평선으로 시작하는 본문은 보존된다") : bad("③ 수평선 보존", String(f).slice(0, 200));
}
{
  const f = read(join(CLAUDE, "skills", "crlf-fm", "SKILL.md"));
  f && fmBlocks(f) === 1 && f.includes("CRLF 본문.") && !f.includes("name: crlf-fm\r")
    ? ok("③b BOM·CRLF 도 벗긴다") : bad("③b BOM·CRLF", String(f).slice(0, 200));
}
{
  const f = read(join(CLAUDE, "skills", "hr-prose", "SKILL.md"));
  // 블록 안에 콜론 줄이 있어도 **첫 비공백 줄**이 key: 꼴이 아니면 frontmatter 가 아니다 — 잘라내면 본문이 사라진다.
  f && f.includes("https://example.com") && f.includes("TODO: 고칠 것")
    ? ok("③c 수평선+콜론 산문은 frontmatter 로 오인하지 않는다") : bad("③c 오탐 방어", String(f).slice(0, 240));
}
{
  const f = read(join(CLAUDE, "agents", "agent-fm.md"));
  f && fmBlocks(f) === 1 && f.includes("리뷰어다.") ? ok("④ 서브에이전트도 같은 정규화를 받는다") : bad("④ 서브에이전트", String(f).slice(0, 160));
}

fingerprint() === REAL_BEFORE ? ok("⑤ 실 ~/.claude 무접촉") : bad("⑤ 실 홈 무접촉", "실 홈이 변했다");

server.close();
rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n${fail ? "✗" : "✓"} sync-harness-assets(frontmatter): ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
