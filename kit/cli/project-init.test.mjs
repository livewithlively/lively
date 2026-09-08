#!/usr/bin/env node
// lively_local_project_init (#905 C2a) — 판정 순서 ①~⑥ + 안전 계약 e2e.
//  실행: node kit/cli/project-init.test.mjs   (npm test 체인)
//  가짜 게이트웨이(실 HTTP) + 진짜 git 레포 + 진짜 파일시스템. 실제 ~/.lively·중앙 무접촉.
//
//  이 테스트가 지키는 것(깨지면 그대로 사고):
//   🔴 마커 sync 는 반드시 "none" — 사용자 폴더에 서버 공유파일이 내려와 CLAUDE.md 를 덮는 사고(#905 §2)를 막는 유일한 값.
//   🔴 후보가 0개거나 여럿이면 **절대 create 하지 않는다** — 마커는 동기화되지 않아 두 번째 멤버에겐 항상 미스라,
//      create 폴백은 '중복 프로젝트 양산'이 기본 동작이 된다.
//   🔴 중앙 생성은 롤백이 없다 → 마커를 못 쓰는 폴더면 **생성 전에** 중단(고아 프로젝트 방지).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";  // ⚠ 절대경로 동적 import 는 반드시 file:// URL 로 — 윈도우는 "d:" 를 프로토콜로 읽는다(#1510)
import { WIN } from "../testlib/os-sandbox.mjs";

const HERE = path.join(fileURLToPath(import.meta.url), "..");

let pass = 0;
const ok = (n) => { pass++; console.error(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 요청을 전부 기록해 '무엇을 보냈나'까지 검증한다. ──
const seen = { findByOrigin: [], created: [], bindings: [] };
let CANDIDATES = [];     // find-by-origin 이 돌려줄 후보(케이스마다 교체)
let nextProjectId = 700;

const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://x");
    const j = body ? JSON.parse(body) : {};
    const send = (o) => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
    if (u.pathname === "/api/ui/v6/projects/find-by-origin") {
      seen.findByOrigin.push(j);
      // 실서버와 같은 shape — total/active_total 은 상한(CAP)에 안 잘린 '진짜 개수'다.
      const act = CANDIDATES.filter((c) => c.status !== "done");
      return send({ origin_key: j.git_url ? "github.com/o/r" : null, candidates: CANDIDATES.slice(0, 20),
        total: CANDIDATES.length, active_total: act.length, discriminating: act.length === 1,
        truncated: CANDIDATES.length > 20, note: "" });
    }
    if (u.pathname === "/api/ui/v6/projects" && req.method === "POST") {
      seen.created.push(j);
      return send({ project: { id: nextProjectId++, name: j.name } });
    }
    const bind = u.pathname.match(/^\/api\/ui\/v6\/projects\/(\d+)\/folder-binding$/);
    if (bind) { seen.bindings.push({ id: Number(bind[1]), ...j }); return send({ bound: { project_id: Number(bind[1]), ...j } }); }
    const get = u.pathname.match(/^\/api\/ui\/v6\/projects\/(\d+)$/);
    if (get) return send({ project: { id: Number(get[1]), name: "기존 프로젝트" } });
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
// ⚠ **실 HOME 을 보지 않게** LIVELY_HOME 도 샌드박스로 돌린다(#2617). 이 파일은 인프로세스 테스트라
//  lively-mcp-local.mjs 가 이 프로세스의 env·홈을 그대로 읽는데, 그 모듈의 gateway() 는 **파일 우선**이다
//  (#916 이 token() 에 세운 '파일이 SoT' 판정을 주소에도 적용 — env 는 셸·tmux 가 굳혀 물려주는 캐시라
//   둘이 갈리면 파일이 맞다). 그래서 LIVELY_HOME 을 안 바꾸면 실 `~/.lively/gateway-url` 이 아래 픽스처
//  주소를 이겨 **테스트가 실 게이트웨이로 나간다** — 실측 2026-09-03: HostEffects 가
//  `https://<실 게이트웨이>/api/ui/v6/projects/find-by-origin` 을 차단해서야 드러났다(가드가 없었다면 조용히 나갔다).
//  ⚠ 아래 import 보다 **먼저** 세워야 한다 — 그 모듈은 LIVELY_HOME 을 로드 시점에 굳힌다.
process.env.LIVELY_HOME = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-init-home-"));
process.env.LIVELY_GATEWAY_URL = `http://127.0.0.1:${server.address().port}`;
process.env.LIVELY_TOKEN = "test-token";

const { TOOLS, makeCtx } = await import(pathToFileURL(path.join(HERE, "lively-mcp-local.mjs")));
const tool = TOOLS.find((t) => t.name === "lively_local_project_init");
assert.ok(tool, "lively_local_project_init 툴이 등록돼야 함");

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-init-"));
const call = async (dir, args = {}) => {
  const out = await tool.handler(args, makeCtx(dir));
  return JSON.parse(out.content[0].text);
};
// git 레포인 폴더(origin 지정). **realpath 로 돌려준다** — 툴이 경로를 realpath 로 정규화하므로
//  (심링크가 달라도 같은 폴더면 같은 바인딩) 기대값도 같은 정본이어야 한다. macOS 는 /var→/private/var.
async function mkRepo(name, originUrl) {
  const dir = path.join(root, name);
  await fsp.mkdir(dir, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: dir });
  if (originUrl) execFileSync("git", ["remote", "add", "origin", originUrl], { cwd: dir });
  return fs.realpathSync(dir);
}
const markerOf = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, ".lively", "project.json"), "utf8")); } catch { return null; } };

try {
  // ── ③ 결정적 일치 1건 → bind 제안. **auto 는 아무것도 바꾸지 않는다.** ──
  {
    CANDIDATES = [{ project_id: 905, name: "프로젝트 CLI", status: "in_progress", via: "repo", repo: "context-ontology" }];
    const dir = await mkRepo("one-match", "git@github.com:o/r.git");
    const r = await call(dir);
    assert.equal(r.status, "suggestion");
    assert.equal(r.dry_run, true);
    assert.equal(r.suggestion.action, "bind");
    assert.equal(r.suggestion.project_id, 905);
    assert.equal(markerOf(dir), null, "auto 는 마커를 쓰면 안 된다(무변경)");
    assert.equal(seen.created.length, 0, "auto 는 프로젝트를 만들면 안 된다");
    ok("③ origin 결정적 일치 1건 → bind 제안 · auto 는 무변경(마커·생성 0)");
  }

  // ── 🔴 ⑥ 후보 0건 → **create 아님, 사람에게 묻기** (중복 양산 차단의 핵심) ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("no-match", "git@github.com:o/other.git");
    const r = await call(dir);
    assert.equal(r.suggestion.action, "ask_user", `후보 0건에 create 하면 중복 양산 — 실제: ${r.suggestion.action}`);
    assert.match(r.suggestion.next, /임의로 create 하지 마세요/);
    assert.equal(seen.created.length, 0);
    ok("🔴 후보 0건 → ask_user(create 아님) — '못 찾음'은 '없음'이 아니다");
  }

  // ── ⑥ 후보 여럿 → 사람에게 묻기(코드가 못 고른다) ──
  {
    CANDIDATES = [
      { project_id: 1, name: "A", status: "in_progress", via: "repo", repo: "r" },
      { project_id: 2, name: "B", status: "todo", via: "binding", repo: null },
    ];
    const dir = await mkRepo("multi", "git@github.com:o/r.git");
    const r = await call(dir);
    assert.equal(r.suggestion.action, "ask_user");
    assert.equal(r.active_candidates.length, 2);
    ok("⑥ 활성 후보 2건 → ask_user(코드가 임의 선택하지 않음)");
  }

  // ── ⑤ done 은 활성에서 제외 — 끝난 프로젝트에 새 작업을 붙이지 않는다 ──
  {
    CANDIDATES = [
      { project_id: 9, name: "끝난 것", status: "done", via: "repo", repo: "r" },
      { project_id: 10, name: "사는 것", status: "in_progress", via: "repo", repo: "r" },
    ];
    const dir = await mkRepo("done-mix", "git@github.com:o/r.git");
    const r = await call(dir);
    assert.equal(r.active_candidates.length, 1, "done 은 활성에서 빠져야 함");
    assert.equal(r.suggestion.action, "bind");
    assert.equal(r.suggestion.project_id, 10);
    assert.equal(r.candidates.length, 2, "후보 목록 자체엔 done 도 보여준다(사람 판단용)");
    ok("⑤ status=done 후보는 활성에서 제외(목록엔 노출) → 남은 1건으로 bind 제안");
  }

  // ── 🔴 모노레포: 한 origin 에 프로젝트 수십 개 — origin 은 판별력이 없다(실측: 우리 레포 활성 37개) ──
  //  후보를 통째로 뱉으면 사람도 LLM 도 못 읽는다. '못 고른다'를 명시하고 사용자에게 묻는 게 정답.
  {
    CANDIDATES = Array.from({ length: 37 }, (_, i) => ({ project_id: 100 + i, name: `P${i}`, status: "in_progress", via: "repo", repo: "monorepo" }));
    const dir = await mkRepo("monorepo", "git@github.com:o/mono.git");
    const r = await call(dir);
    assert.equal(r.suggestion.action, "ask_user");
    assert.equal(r.origin_discriminates, false, "레포를 여럿이 공유하면 origin 은 판별력이 없다");
    assert.equal(r.active_total, 37, "서버가 센 진짜 개수를 그대로 전달해야 함(잘린 목록 길이가 아니라)");
    assert.ok(r.candidates.length <= 20, `후보는 상한으로 잘려야 함 — 실제 ${r.candidates.length}`);
    assert.equal(r.truncated, true);
    assert.match(r.suggestion.why, /특정할 수 없습니다/);
    assert.match(r.suggestion.next, /나열이 의미 없습니다/);
    assert.equal(seen.created.length, 0);
    ok("🔴 모노레포(활성 37) → origin 판별불가 명시 · 후보 상한 · 나열 대신 사용자에게 묻기");
  }

  // ── ① 이미 프로젝트인 폴더 → 무변경 ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("already", "git@github.com:o/r.git");
    await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
    await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify({ project_id: 42, sync: "none" }) + "\n");
    const r = await call(dir, { mode: "create", name: "새로" });
    assert.equal(r.status, "already_project");
    assert.equal(r.project_id, 42);
    assert.equal(r.same_folder, true);
    assert.equal(seen.created.length, 0, "이미 프로젝트인데 새로 만들면 안 된다");
    ok("① 이미 프로젝트인 폴더 → already_project(mode=create 여도 생성 안 함)");
  }

  // ── ① 상위가 프로젝트 = 중첩 → 거부(pull 훅이 가장 가까운 마커를 집으므로 중첩은 사고) ──
  {
    const parent = await mkRepo("nest", "git@github.com:o/r.git");
    await fsp.mkdir(path.join(parent, ".lively"), { recursive: true });
    await fsp.writeFile(path.join(parent, ".lively", "project.json"), JSON.stringify({ project_id: 7, sync: "pull" }) + "\n");
    const child = path.join(parent, "sub", "deep");
    await fsp.mkdir(child, { recursive: true });
    const r = await call(child, { mode: "create", name: "중첩" });
    assert.equal(r.status, "already_project");
    assert.equal(r.same_folder, false);
    assert.equal(markerOf(child), null, "중첩 마커를 심으면 안 된다");
    assert.equal(seen.created.length, 0);
    ok("① 상위가 프로젝트면 중첩 거부(자식에 마커 미생성)");
  }

  // ── 🔴 create: 마커 sync 는 반드시 "none" (사용자 파일 보호의 유일한 값) ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("create-me", "https://github.com/o/fresh.git");
    const r = await call(dir, { mode: "create", name: "내 앱" });
    assert.equal(r.status, "created");
    assert.equal(seen.created.at(-1).name, "내 앱");
    assert.equal(seen.created.at(-1).list_id, undefined, "list_id 는 추측하지 않는다(미지정 → 미분류)");
    const m = markerOf(dir);
    assert.equal(m.project_id, r.project_id);
    assert.equal(m.sync, "none", `🔴 사용자 폴더 마커의 sync 는 반드시 "none" — 실제: ${m.sync}`);
    assert.equal(r.sync, "none");
    // 바인딩이 중앙에 기록됐나 + sync/origin 동반
    const b = seen.bindings.at(-1);
    assert.equal(b.id, r.project_id);
    assert.equal(b.abs_path, dir);
    assert.equal(b.sync, "none");
    assert.equal(b.git_url, "https://github.com/o/fresh.git");
    ok('🔴 create → 마커 sync:"none" + 폴더 바인딩 중앙 등록(경로·sync·origin 동반)');
  }

  // ── 마커 read→merge→write — 다른 writer 의 키를 지우지 않는다(마커 writer 5개) ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("merge-marker", "https://github.com/o/m.git");
    await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
    // project_id 없는 마커(=①이 프로젝트로 안 봄) + 남의 키
    await fsp.writeFile(path.join(dir, ".lively", "project.json"), JSON.stringify({ provisioned: [{ name: "x" }], last_pull: 5 }) + "\n");
    const r = await call(dir, { mode: "create", name: "머지" });
    const m = markerOf(dir);
    assert.equal(m.project_id, r.project_id);
    assert.equal(m.sync, "none");
    assert.deepEqual(m.provisioned, [{ name: "x" }], "남의 키(provisioned) 보존");
    assert.equal(m.last_pull, 5, "남의 키(last_pull) 보존");
    ok("마커 read→merge→write — 다른 writer 의 키 보존(통째 덮어쓰기 금지)");
  }

  // ── bind: 기존 프로젝트에 붙이고 마커는 역시 none ──
  {
    CANDIDATES = [{ project_id: 905, name: "프로젝트 CLI", status: "in_progress", via: "repo", repo: "r" }];
    const dir = await mkRepo("bind-me", "git@github.com:o/r.git");
    const before = seen.created.length;
    const r = await call(dir, { mode: "bind", project_id: 905 });
    assert.equal(r.status, "bound");
    assert.equal(r.project_id, 905);
    assert.equal(seen.created.length, before, "bind 는 프로젝트를 만들지 않는다");
    assert.equal(markerOf(dir).sync, "none");
    ok("bind → 기존 프로젝트 연결 · 생성 0 · 마커 sync:\"none\"");
  }

  // ── 🔴 시크릿: origin 에 박힌 토큰은 게이트웨이로 나가지 않는다 ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("secret", "https://ghp_supersecrettoken@github.com/o/s.git");
    await call(dir);
    const sent = seen.findByOrigin.at(-1).git_url;
    assert.ok(!sent.includes("ghp_supersecrettoken"), `origin 의 토큰이 게이트웨이로 전송됨: ${sent}`);
    assert.equal(sent, "https://github.com/o/s.git");
    ok("🔴 origin 의 자격(PAT)은 벗겨서 전송 — 시크릿 미유출");
  }

  // ── git 레포가 아닌 폴더 → 결정적 신원 없음 → 묻기(그래도 create 아님) ──
  {
    CANDIDATES = [];
    await fsp.mkdir(path.join(root, "not-a-repo"), { recursive: true });
    const dir = fs.realpathSync(path.join(root, "not-a-repo"));
    const r = await call(dir);
    assert.equal(r.git_url, null);
    assert.equal(r.suggestion.action, "ask_user");
    ok("git 레포 아님 → 신원 없음 → ask_user");
  }

  // ── 🔴 롤백 없음 대비: 마커를 못 쓰는 폴더면 **중앙 생성 전에** 중단(고아 프로젝트 방지) ──
  {
    CANDIDATES = [];
    const dir = await mkRepo("readonly", "https://github.com/o/ro.git");
    const before = seen.created.length;
    fs.chmodSync(dir, 0o500); // 쓰기 불가
    // ⚠ 윈도우에선 chmod 가 '쓰기 불가'를 만들지 못한다(POSIX mode 비트가 없다 — NTFS ACL 이라야 한다).
    //  전제가 안 서면 이 케이스는 '쓸 수 있는 폴더'를 검사하는 셈이라 아무것도 못 잡는다(#1510).
    if (WIN) { console.error("skip 🔴 마커 쓰기 사전점검 — 윈도우는 chmod 로 쓰기금지를 만들 수 없다(ACL)"); }
    else try {
      await assert.rejects(() => call(dir, { mode: "create", name: "고아" }), /마커를 쓸 수 없습니다/);
      assert.equal(seen.created.length, before, "🔴 마커를 못 쓰는데 중앙에 프로젝트를 만들면 고아가 된다(롤백 없음)");
      ok("🔴 마커 쓰기 사전점검 실패 → 중앙 생성 안 함(고아 프로젝트 방지)");
    } finally { fs.chmodSync(dir, 0o700); }
  }

  console.error(`\nPASS — ${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
