#!/usr/bin/env node
// `lively` 의 프로젝트 표면 (#905 C5) — status 섹션 + init 명령. 진짜 CLI 프로세스 + 픽스처 게이트웨이.
//  실행: node kit/cli/project-status.test.mjs   (npm test 체인)
//  실제 ~/.lively 무접촉(LIVELY_HOME 샌드박스). 네트워크는 127.0.0.1 픽스처뿐.
//
//  ⚠ CLI 는 **반드시 비동기(execFile)** 로 — 픽스처가 이 프로세스에서 도니까 동기로 막으면 자식 fetch 가
//   전부 타임아웃해 '조용한 무동작'이 되고, 무동작을 기대하는 테스트가 공허하게 통과한다(lively.test.mjs 의 교훈).
//
//  이 섹션의 존재 이유 = **sync 모드를 사람 눈에 보이게 하는 것**(#905 P1-②). 그래서 여기 계약의 핵심은
//   "모드를 정확히 보여주는가"와 "모르는 걸 아는 척하지 않는가" 두 가지다.
import { createServer } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, realpathSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { pathWith, writeNoopBin } from "../testlib/os-sandbox.mjs";   // 스텁은 윈도우에서도 실행 가능해야 한다(#1510)

const pExecFile = promisify(execFile);
const HERE = join(fileURLToPath(import.meta.url), "..");
const CLI = join(HERE, "lively.mjs");

let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };
const check = (n, cond, why) => (cond ? ok(n) : bad(n, why || "조건 불만족"));

// realpath — CLI 는 process.cwd() 를 쓰고 macOS 는 /var → /private/var 로 정규화한다. 기대값도 같은 정본이어야.
const BOX = realpathSync(mkdtempSync(join(tmpdir(), "lively-pstatus-")));
const HOME = join(BOX, "home");
mkdirSync(join(HOME, ".lively"), { recursive: true });

// ── 픽스처 게이트웨이 — 어떤 요청이 왔는지 기록한다("sync=none 이면 매니페스트를 안 부른다"를 증명하려면 필요). ──
const hits = [];
let CANDIDATES = [];
const SERVER_FILES = [
  { path: "doc.md", mtime: 1_700_000_000_000, size: 5 },
  { path: "sub/spec.md", mtime: 1_700_000_000_000, size: 7 },
];
const server = createServer((req, res) => {
  hits.push(req.url);
  const j = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
  if (req.url.startsWith("/api/ui/org/runtime-config")) return j({ kit_version: "v-test", hooks: { self_update: true } });
  if (req.url.startsWith("/api/ui/me/profile")) return j({ id: "yoon", display_name: "윤상민" });
  if (/\/api\/ui\/v6\/projects\/905\/shared\/manifest/.test(req.url)) return j({ files: SERVER_FILES, newest: 1_700_000_000_000, count: SERVER_FILES.length, truncated: false });
  if (/\/api\/ui\/v6\/projects\/905$/.test(req.url)) return j({ project: { id: 905, name: "프로젝트 관리 cli 만들기" } });
  if (req.url === "/api/ui/v6/projects/find-by-origin") return j({ origin_key: "github.com/o/r", candidates: CANDIDATES, total: CANDIDATES.length, active_total: CANDIDATES.filter((c) => c.status !== "done").length, discriminating: CANDIDATES.length === 1, truncated: false, note: "" });
  if (req.url === "/api/ui/v6/projects" && req.method === "POST") return j({ project: { id: 777, name: "새 플젝" } });
  if (/\/folder-binding$/.test(req.url)) return j({ bound: { project_id: 1, member_id: "yoon" } });
  res.writeHead(404); res.end("{}");
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const GW = `http://127.0.0.1:${server.address().port}`;
writeFileSync(join(HOME, ".lively", "gateway-url"), GW);
writeFileSync(join(HOME, ".lively", "token"), "lvk_test_token");

// ⚠ 스텁 `claude` — `lively status` 는 harness 프로브로 **실제 `claude mcp list`** 를 부른다(lively.mjs #1043:
//  등록된 MCP 서버를 전부 헬스체크 · MCP_TIMEOUT 3s · 하드백스톱 8s). 가리지 않으면 이 파일이
//  ① 머리 주석의 계약("네트워크는 127.0.0.1 픽스처뿐")을 깬다 — 사람의 로컬 MCP 등록(원격 커넥터 포함)에 실제로 붙는다.
//  ② 실행시간이 그 사람의 MCP 설정에 의존한다 — 실측 status 1회 ≈2.8s, 이 파일 혼자 36초로 유닛 체인 전체의 30%였다.
//  kit/cli/lively.test.mjs 의 newHome 과 같은 관례(스텁 bin 을 PATH 앞에). 이 파일의 계약은 프로젝트 섹션이라
//  harness 프로브 결과는 아무 단정도 하지 않는다 — 가려도 잃는 검증이 없다.
const STUB_BIN = join(BOX, "stub-bin");
mkdirSync(STUB_BIN, { recursive: true });
writeNoopBin(STUB_BIN, "claude");
const CHILD_ENV = {
  ...process.env,
  PATH: pathWith(STUB_BIN),
  LIVELY_HOME: HOME,
  // ⚠ 셸에 CLAUDE_CONFIG_DIR 이 있으면 CLI 가 **실제** 프로필 설정(.claude.json)을 읽는다 — 명시적으로 샌드박스로 덮는다.
  //  (LIVELY_HOME 이 CLI 의 HOME 을 대체하므로 HOME 쪽 후보는 이미 샌드박스다.)
  CLAUDE_CONFIG_DIR: join(HOME, ".claude"),
  LIVELY_GATEWAY_URL: GW,
  LIVELY_TOKEN: "lvk_test_token",
  NO_COLOR: "1",
};

const statusIn = async (cwd) => {
  const { stdout } = await pExecFile(process.execPath, [CLI, "status", "--json"], {
    cwd, env: CHILD_ENV, timeout: 30_000,
  });
  return JSON.parse(stdout);
};
const mkProj = (name, marker, files = {}) => {
  const dir = join(BOX, name);
  mkdirSync(join(dir, ".lively"), { recursive: true });
  if (marker) writeFileSync(join(dir, ".lively", "project.json"), JSON.stringify(marker, null, 2) + "\n");
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
};

try {
  // ── 프로젝트가 아니면 섹션 자체가 없다(렌더 게이트는 마커 유무 — 공짜) ──
  {
    const plain = join(BOX, "plain"); mkdirSync(plain, { recursive: true });
    const st = await statusIn(plain);
    check("프로젝트 아닌 폴더 → project 섹션 없음(null)", st.project === null, JSON.stringify(st.project));
  }

  // ── sync=pull — 모드·서버파일수·미반영수를 보여준다 ──
  {
    const dir = mkProj("pull-proj", { project_id: 905, sync: "pull", last_pull: 1_700_000_000_000 }, { "doc.md": "hello" });
    const st = await statusIn(dir);
    const p = st.project;
    check("sync=pull — 섹션에 모드·이름·폴더", p?.sync === "pull" && p?.id === 905 && p?.name === "프로젝트 관리 cli 만들기" && p?.dir === dir, JSON.stringify(p));
    check("sync=pull — 서버 파일 수", p?.shared?.server_count === 2, JSON.stringify(p?.shared));
    // doc.md 는 크기 5 로 일치 → 미반영 아님. sub/spec.md 는 로컬에 없음 → 미반영 1.
    check("sync=pull — 로컬 미반영 계산(크기·mtime diff)", p?.shared?.pending === 1, `pending=${p?.shared?.pending} (기대 1)`);
  }

  // ── 🔴 sync=none — 매니페스트를 **아예 안 부른다**(불필요 왕복 + '받는 줄' 오해 방지) ──
  {
    hits.length = 0;
    const dir = mkProj("none-proj", { project_id: 905, sync: "none" });
    const st = await statusIn(dir);
    check("sync=none — 모드 그대로 노출", st.project?.sync === "none", JSON.stringify(st.project));
    check("sync=none — shared 조회 안 함(null)", st.project?.shared === null, JSON.stringify(st.project?.shared));
    check("🔴 sync=none — 매니페스트 요청 자체가 없음", !hits.some((u) => u.includes("/shared/manifest")), hits.join(" "));
  }

  // ── 🔴 구 마커(sync 없음) — **모드를 단정하지 않는다**(null). ──
  //  그때 실제 판정은 pull 훅의 폴더소유권 폴백이라, 여기서 'pull' 이라 단정하면 사용자 폴더에서 거짓말이 된다.
  //  게이트를 보여주려고 만든 표면이 게이트를 오도하는 건 최악이다.
  {
    const dir = mkProj("legacy-proj", { project_id: 905 });
    const st = await statusIn(dir);
    check("🔴 구 마커 → sync=null(모드 단정 안 함 — 훅 폴백을 흉내내지 않는다)", st.project?.sync === null, JSON.stringify(st.project));
    check("구 마커여도 공유폴더 상태는 보여준다", st.project?.shared?.server_count === 2, JSON.stringify(st.project?.shared));
  }

  // ── 하위 디렉터리 — 상향탐색으로 상위 프로젝트를 찾는다(리더 40단계 계약) ──
  {
    const dir = mkProj("nested-proj", { project_id: 905, sync: "pull" });
    const deep = join(dir, "a", "b", "c");
    mkdirSync(deep, { recursive: true });
    const st = await statusIn(deep);
    check("하위 디렉터리 → 상향탐색으로 상위 프로젝트 인식(dir 은 프로젝트 루트)", st.project?.id === 905 && st.project?.dir === dir, JSON.stringify(st.project));
  }

  // ── 마커가 깨졌거나 project_id 가 없으면 프로젝트가 아니다(리더 전원 동일 규칙) ──
  {
    const dir = mkProj("broken-proj", null);
    writeFileSync(join(dir, ".lively", "project.json"), "{not json");
    const st = await statusIn(dir);
    check("파손 마커 → 프로젝트 아님(status 는 정상 동작)", st.project === null && st.account.authenticated === true, JSON.stringify(st.project));
  }
  {
    const dir = mkProj("noid-proj", { sync: "pull" });
    const st = await statusIn(dir);
    check("project_id 없는 마커 → 프로젝트 아님", st.project === null, JSON.stringify(st.project));
  }

  // ── 게이트웨이가 프로젝트를 모르면(삭제됨 등) status 는 죽지 않는다 ──
  {
    const dir = mkProj("gone-proj", { project_id: 999, sync: "pull" });
    const st = await statusIn(dir);
    check("없는 프로젝트 → 섹션은 뜨되 error 로 표기(status 는 유효)", st.project?.id === 999 && st.project?.error, JSON.stringify(st.project));
  }

  // ══ `lively init` (#905 C5) — 코어는 project-init.test.mjs 가 본다. 여기선 **CLI 계층**(인자 파싱·무변경 계약). ══
  // ⚠ 사람용 출력은 **stderr** 다(say) — stdout 은 --json 전용이라 깨끗해야 한다. 스트림을 헷갈리면
  //  "출력이 비었는데 테스트는 통과"하는 공허한 검증이 된다(실제로 여기서 한 번 걸렸다).
  const initIn = async (cwd, args) => {
    const { stdout, stderr } = await pExecFile(process.execPath, [CLI, "init", ...args], {
      cwd, env: CHILD_ENV, timeout: 30_000,
    });
    return args.includes("--json") ? stdout : stderr;
  };
  const mkRepo = (name) => {
    const dir = join(BOX, name); mkdirSync(dir, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:o/r.git"], { cwd: dir });
    return dir;
  };
  const markerOf = (dir) => { try { return JSON.parse(readFileSync(join(dir, ".lively", "project.json"), "utf8")); } catch { return null; } };

  {
    CANDIDATES = [];
    const dir = mkRepo("cli-auto");
    const out = await initIn(dir, ["--json"]);
    const r = JSON.parse(out);
    check("🔴 lively init(기본) → 제안만·무변경(마커 없음)", r.status === "suggestion" && r.dry_run === true && markerOf(dir) === null, out.slice(0, 120));
    check("lively init 기본 → 후보 0 이어도 ask_user(멋대로 create 안 함)", r.suggestion?.action === "ask_user", JSON.stringify(r.suggestion));
  }
  {
    CANDIDATES = [];
    const dir = mkRepo("cli-create");
    const r = JSON.parse(await initIn(dir, ["--create", "--name", "새 플젝", "--json"]));
    check("lively init --create → 생성·연결", r.status === "created" && r.project_id === 777, JSON.stringify(r).slice(0, 120));
    check("🔴 lively init --create → 마커 sync=\"none\"(사용자 파일 보호)", markerOf(dir)?.sync === "none", JSON.stringify(markerOf(dir)));
  }
  {
    CANDIDATES = [{ project_id: 905, name: "프로젝트 관리 cli 만들기", status: "in_progress", via: "repo", repo: "r" }];
    const dir = mkRepo("cli-bind");
    const r = JSON.parse(await initIn(dir, ["--bind", "905", "--json"]));
    check("lively init --bind <id> → 기존 프로젝트 연결(인자 파싱)", r.status === "bound" && r.project_id === 905, JSON.stringify(r).slice(0, 120));
    check("lively init --bind → 마커 sync=\"none\"", markerOf(dir)?.sync === "none", JSON.stringify(markerOf(dir)));
  }
  {
    CANDIDATES = [{ project_id: 905, name: "P", status: "in_progress", via: "repo", repo: "r" }];
    const dir = mkRepo("cli-suggest-bind");
    const out = await initIn(dir, []);
    check("lively init 사람용 출력 — 결정적 1건이면 --bind 를 권한다", /lively init --bind 905/.test(out), JSON.stringify(out));
  }

  console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
} finally {
  server.close();
  rmSync(BOX, { recursive: true, force: true });
}
process.exit(fail ? 1 : 0);
