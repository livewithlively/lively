// 공유폴더 pull 훅의 '쓰기 자격 게이트' e2e (#905 P1-②) — 가짜 게이트웨이 + 진짜 훅 프로세스로 검증.
//  실행: node kit/hooks/project-pull-gate.test.mjs
//
//  왜 e2e 인가: 이 게이트가 막는 사고는 **파일이 실제로 덮어써지는 것**이다. 소스에 syncMode 가 '있는지'는
//   seed-content.test.ts 가 보지만, 그게 실제로 쓰기를 막는지는 훅을 돌려 파일을 봐야만 안다.
//  검증 대상 = kit/hooks/examples/*.org-hook.mjs (SoT). default-content.ts 와의 바이트 일치는 seed-content.test.ts 가 강제.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = {
  "project-pull": path.join(here, "examples", "project-pull.org-hook.mjs"),
  "project-pull-turn": path.join(here, "examples", "project-pull-turn.org-hook.mjs"),
};
const PROJECT_ID = 905;

let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// 서버가 내려주는 공유폴더 내용 — 실제 사고 형태 그대로(AGENTS.md digest + CLAUDE.md 한 줄 import).
const SERVER_FILES = {
  "AGENTS.md": "# 서버가 만든 프로젝트 digest\n",
  "CLAUDE.md": "@AGENTS.md\n",
  "docs/spec.md": "서버 문서\n",
};
// 사용자가 자기 폴더에 갖고 있던 것 — 덮어써지면 그게 바로 그 사고.
const USER_CLAUDE_MD = "# 내 프로젝트\n\n내가 손으로 쓴 규칙 — 절대 날아가면 안 된다.\n";

// ── 가짜 게이트웨이 ──
async function startGateway() {
  const newest = Date.now();
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
      const files = Object.entries(SERVER_FILES).map(([p, body]) => ({
        path: p, mtime: newest, size: Buffer.byteLength(body),
      }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files, newest, count: files.length, truncated: false }));
      return;
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file`) {
      const body = SERVER_FILES[u.searchParams.get("path")];
      if (body === undefined) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(body);
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

// 훅을 진짜 프로세스로 실행(stdin 에 이벤트 JSON). 훅 불변식상 항상 exit 0.
async function runHook(hookPath, cwd, base) {
  const child = spawn(process.execPath, [hookPath], {
    cwd,
    env: { ...process.env, ...offlineLivelyEnv(), LIVELY_TOKEN: "test-token", LIVELY_GATEWAY_URL: base, LIVELY_HOME: cwd },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ cwd }));
  const code = await new Promise((r) => child.on("exit", r));
  assert.equal(code, 0, `훅은 절대 세션을 막지 않는다(exit 0) — 실제 ${code}`);
}

// 마커를 심은 폴더를 만든다. dirRel 로 '라이블리 소유 꼴'과 '사용자 폴더 꼴'을 구분한다.
async function mkProjectDir(root, dirRel, marker) {
  const dir = path.join(root, dirRel);
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  return dir;
}

const readOrNull = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };

async function main() {
  const { server, base } = await startGateway();
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-pullgate-"));
  try {
    for (const [id, hookPath] of Object.entries(HOOKS)) {
      // ── 🔴 핵심: 사용자 자기 폴더(마커에 sync 키 없음 = 구 마커) → 아무것도 안 쓴다 ──
      //  `lively init` 이 sync 를 안 적었거나 구 버전 마커여도, 라이블리가 만들지 않은 폴더면 fail-safe.
      {
        const dir = await mkProjectDir(root, `${id}/usercode`, { project_id: PROJECT_ID });
        const claude = path.join(dir, "CLAUDE.md");
        await fsp.writeFile(claude, USER_CLAUDE_MD);
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(claude), USER_CLAUDE_MD, `[${id}] 사용자 CLAUDE.md 가 덮어써짐 — 무음 파괴 재발`);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), null, `[${id}] 사용자 폴더에 서버 AGENTS.md 를 새로 씀`);
        assert.equal(readOrNull(path.join(dir, "docs", "spec.md")), null, `[${id}] 사용자 폴더에 서버 문서를 씀`);
        ok(`[${id}] 사용자 폴더 + sync 키 없는 마커 → 아무것도 안 씀(폴더소유권 fail-safe)`);
      }

      // ── 무회귀: work.mjs 폴더(~/lively/projects/<id>)는 sync 키가 없어도 그대로 pull ──
      //  기존 멤버 설치의 마커엔 sync 가 없다. 여기서 pull 이 죽으면 그 멤버의 공유폴더 동기화가 조용히 끊긴다.
      {
        const dir = await mkProjectDir(root, `${id}/home/lively/projects/${PROJECT_ID}`, { project_id: PROJECT_ID });
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), SERVER_FILES["AGENTS.md"], `[${id}] 라이블리 폴더인데 pull 이 안 됨(회귀)`);
        assert.equal(readOrNull(path.join(dir, "docs", "spec.md")), SERVER_FILES["docs/spec.md"], `[${id}] 하위 문서 pull 누락`);
        const marker = JSON.parse(readOrNull(path.join(dir, ".lively", "project.json")));
        assert.ok(marker.last_pull > 0, `[${id}] pull 후 last_pull 이 갱신돼야 함`);
        ok(`[${id}] work.mjs 폴더(~/lively/projects/<id>) + sync 키 없는 구 마커 → 종전대로 pull(무회귀)`);
      }

      // ── 🔴 폴백을 넓히면 걸리는 흔한 사용자 경로: ~/projects/<id> 는 라이블리 폴더가 아니다 ──
      //  'parent 가 projects 면 소유'로 판정했다면 여기서 사용자 파일이 날아간다. grandparent='lively' 요구가 그걸 막는다.
      {
        const dir = await mkProjectDir(root, `${id}/home3/projects/${PROJECT_ID}`, { project_id: PROJECT_ID });
        const claude = path.join(dir, "CLAUDE.md");
        await fsp.writeFile(claude, USER_CLAUDE_MD);
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(claude), USER_CLAUDE_MD, `[${id}] ~/projects/<id>(사용자 코드 관례 경로)가 라이블리 폴더로 오인돼 덮어써짐`);
        ok(`[${id}] ~/projects/<id> (lively 조부모 아님) → 안 씀(폴백 과확장 방지)`);
      }

      // ── 박스 폴더(<shared>/project/<folder>)는 폴백 대상이 **아니다** — 서버 백필이 sync 를 stamp 하는 게 정답 경로 ──
      //  박스 folder 는 임의 문자열이라(실측: 'project/관리탭 수정') 구조로 소유를 알 수 없다. 폴백으로 넓히면
      //  사용자의 project/ 하위 폴더가 걸린다 → 여기선 거부가 정상. 대신 백필이 stamp 하면 아래처럼 pull 된다.
      {
        const dir = await mkProjectDir(root, `${id}/workspace/project/${PROJECT_ID}`, { project_id: PROJECT_ID });
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), null,
          `[${id}] 박스 꼴을 구조로 소유 판정하면 안 됨(사용자 project/ 폴더가 같이 걸린다) — 백필이 담당`);
        // 백필이 stamp 한 뒤엔 pull 된다(서버 backfillMarkerSync 와 동일한 결과를 손으로 재현).
        const mf = path.join(dir, ".lively", "project.json");
        const m = JSON.parse(readOrNull(mf)); m.sync = "pull";
        await fsp.writeFile(mf, JSON.stringify(m, null, 2) + "\n");
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), SERVER_FILES["AGENTS.md"],
          `[${id}] 백필로 sync:"pull" 이 stamp 된 박스 폴더는 pull 돼야 함(무회귀의 실제 경로)`);
        ok(`[${id}] 박스 폴더는 구조 폴백 대상 아님 → 서버 백필의 sync stamp 로 pull(무회귀)`);
      }

      // ── 명시 sync:"none" 은 라이블리 소유 폴더에서도 이긴다(사람이 끈 건 꺼진 것) ──
      {
        const dir = await mkProjectDir(root, `${id}/home2/lively/projects/${PROJECT_ID}`, { project_id: PROJECT_ID, sync: "none" });
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), null, `[${id}] sync:"none" 인데 pull 함 — 명시 모드가 무시됨`);
        ok(`[${id}] sync:"none" 은 라이블리 폴더에서도 pull 안 함(명시가 폴백을 이긴다)`);
      }

      // ── 명시 sync:"pull" 은 사용자 폴더에서도 받는다(옵트인) — 게이트가 '항상 거부'가 아님을 증명 ──
      {
        const dir = await mkProjectDir(root, `${id}/optin`, { project_id: PROJECT_ID, sync: "pull" });
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), SERVER_FILES["AGENTS.md"], `[${id}] sync:"pull" 옵트인인데 pull 안 됨`);
        ok(`[${id}] sync:"pull" 명시 → 사용자 폴더에서도 pull(옵트인 동작)`);
      }

      // ── sync:"both"(C3 양방향)도 내려받기는 한다 — up-sync 는 C3 소관, down 은 여기서 끊기면 안 된다 ──
      {
        const dir = await mkProjectDir(root, `${id}/bidi`, { project_id: PROJECT_ID, sync: "both" });
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(path.join(dir, "AGENTS.md")), SERVER_FILES["AGENTS.md"], `[${id}] sync:"both" 인데 down-sync 가 안 됨`);
        ok(`[${id}] sync:"both" → down-sync 수행(up 은 C3)`);
      }

      // ── #1856 세션 폴더 리다이렉트 — cwd 가 세션 폴더인 세션에서도 프로젝트 폴더로 pull 이 가야 한다 ──
      //  cwd 가 프로젝트 폴더 → 세션 폴더로 바뀌면서(#1719) 이 탐색이 세션 마커(sync:"none")에서 멈춰
      //  **문서 싱크가 통째로 죽어 있었다**. 세션 마커의 project_dir 로 갈아타는 것이 그 복구다.
      {
        // E6 — 갈아타서 프로젝트 폴더에 받는다. 세션 폴더에는 아무것도 쓰지 않는다(sync:"none" 의 뜻).
        const proj = await mkProjectDir(root, `${id}/sd6/proj`, { project_id: PROJECT_ID, sync: "pull" });
        const sess = await mkProjectDir(root, `${id}/sd6/sess`, { kind: "session", session_id: "box-x", project_id: PROJECT_ID, project_dir: proj, sync: "none" });
        await runHook(hookPath, sess, base);
        assert.equal(readOrNull(path.join(proj, "AGENTS.md")), SERVER_FILES["AGENTS.md"], `[${id}] 세션 폴더 세션에서 프로젝트 폴더로 pull 이 안 됨(#1856 회귀)`);
        assert.equal(readOrNull(path.join(proj, "docs", "spec.md")), SERVER_FILES["docs/spec.md"], `[${id}] 하위 문서 pull 누락`);
        assert.equal(readOrNull(path.join(sess, "AGENTS.md")), null, `[${id}] 세션 폴더에 서버 파일을 쏟았다(sync:"none" 위반)`);
        ok(`[${id}] 세션 폴더 마커 → project_dir 로 갈아타 pull(#1856)`);
      }
      {
        // E7 — 이 컴퓨터에 프로젝트 폴더가 없다(project_dir 부재) → 아무 데도 안 쓴다.
        const sess = await mkProjectDir(root, `${id}/sd7/sess`, { kind: "session", project_id: PROJECT_ID, project_dir: null, sync: "none" });
        await runHook(hookPath, sess, base);
        assert.equal(readOrNull(path.join(sess, "AGENTS.md")), null, `[${id}] project_dir 이 없는데 세션 폴더에 받았다`);
        ok(`[${id}] 세션 마커 + project_dir 부재 → no-op`);
      }
      {
        // E8 — 폴더는 있는데 마커가 없다 = 싱크 대상이 아니다(fail-safe). 넓히면 남의 폴더를 덮는다.
        const proj = path.join(root, `${id}/sd8/proj`);
        await fsp.mkdir(proj, { recursive: true });
        const claude = path.join(proj, "CLAUDE.md");
        await fsp.writeFile(claude, USER_CLAUDE_MD);
        const sess = await mkProjectDir(root, `${id}/sd8/sess`, { kind: "session", project_id: PROJECT_ID, project_dir: proj, sync: "none" });
        await runHook(hookPath, sess, base);
        assert.equal(readOrNull(path.join(proj, "AGENTS.md")), null, `[${id}] 마커 없는 폴더에 서버 파일을 썼다(fail-safe 위반)`);
        assert.equal(readOrNull(claude), USER_CLAUDE_MD, `[${id}] 마커 없는 폴더의 사용자 파일이 덮어써짐`);
        ok(`[${id}] 세션 마커 + 대상 폴더에 마커 없음 → no-op(fail-safe)`);
      }
      {
        // E10 — 갈아탄 마커도 세션 마커면 잘못된 상태다. 한 번만 따라가고 멈춘다.
        const proj = await mkProjectDir(root, `${id}/sd10/proj`, { kind: "session", project_id: PROJECT_ID, project_dir: null, sync: "none" });
        const sess = await mkProjectDir(root, `${id}/sd10/sess`, { kind: "session", project_id: PROJECT_ID, project_dir: proj, sync: "none" });
        await runHook(hookPath, sess, base);
        assert.equal(readOrNull(path.join(proj, "AGENTS.md")), null, `[${id}] 세션 마커가 세션 마커를 가리키는데 받았다`);
        ok(`[${id}] 갈아탄 마커도 kind:"session" → no-op`);
      }

      // ── 알 수 없는 sync 값은 폴백 규칙으로 — 오타가 fail-open 되면 안 된다 ──
      {
        const dir = await mkProjectDir(root, `${id}/typo`, { project_id: PROJECT_ID, sync: "PULL-ALL" });
        const claude = path.join(dir, "CLAUDE.md");
        await fsp.writeFile(claude, USER_CLAUDE_MD);
        await runHook(hookPath, dir, base);
        assert.equal(readOrNull(claude), USER_CLAUDE_MD, `[${id}] 알 수 없는 sync 값이 fail-open 됨`);
        ok(`[${id}] 알 수 없는 sync 값 → 폴더소유권 폴백(사용자 폴더면 거부)`);
      }
    }
    console.log(`\n${pass} passed`);
  } finally {
    server.close();
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

await main();
