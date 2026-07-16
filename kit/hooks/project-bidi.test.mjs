#!/usr/bin/env node
// 양방향 싱크 **루프** e2e (#905 C3) — 진짜 pull 훅 + 진짜 push 훅 + 한 개의 가짜 게이트웨이로 '턴'을 재현한다.
//  실행: node kit/hooks/project-bidi.test.mjs   (npm test 체인)
//
//  왜 이 파일이 따로 필요한가: pull 과 push 는 **서로의 부작용 위에서만** 옳다.
//   · pull 이 원장을 안 쓰면 push 는 삭제를 판정할 근거가 없다.
//   · pull 이 last_pull 을 잘못 올리면 push 의 충돌검사가 뚫려 **남의 최신본이 덮인다**.
//   · pull 이 로컬 편집을 덮으면 push 는 올릴 것이 애초에 사라진다.
//  훅을 따로 테스트하면 이 커플링이 안 보인다. 실행 순서는 실제와 같다: **매 턴 pull(UserPromptSubmit) → push(Stop)**.
//
//  가짜 게이트웨이는 서버 파일의 mtime 을 **쓰기 시각**으로 갱신한다(진짜 파일시스템과 동형) — 이게 없으면
//  last_pull 워터마크 계약을 검증할 수 없다.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PULL = path.join(here, "examples", "project-pull-turn.org-hook.mjs");
const PUSH = path.join(here, "examples", "project-push.org-hook.mjs");
const PROJECT_ID = 905;
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 서버측 공유폴더. mtime 은 서버 시계로 단조 증가시킨다(동시각 충돌 방지). ──
let SERVER = {};
let clock = 1_000_000;
const tick = () => (clock += 1000);
const putServer = (p, body) => { SERVER[p] = { body, mtime: tick() }; };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const files = () => Object.entries(SERVER).map(([p, v]) => ({ path: p, mtime: v.mtime, size: Buffer.byteLength(v.body) }));
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/shared/manifest`) {
      const fl = files();
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ files: fl, newest: Math.max(0, ...fl.map((f) => f.mtime)), count: fl.length, truncated: false }));
    }
    if (u.pathname === `/api/ui/v6/projects/${PROJECT_ID}/file`) {
      const p = u.searchParams.get("path");
      if (req.method === "PUT") {
        putServer(p, Buffer.concat(chunks).toString());
        res.writeHead(200, { "content-type": "application/json" });   // 진짜 라우트와 동형 — 결과 mtime/size 반환
        return res.end(JSON.stringify({ ok: true, mtime: SERVER[p].mtime, size: Buffer.byteLength(SERVER[p].body) }));
      }
      if (req.method === "DELETE") { delete SERVER[p]; res.writeHead(200); return res.end("{}"); }
      const v = SERVER[p];
      if (!v) { res.writeHead(404); return res.end(); }
      res.writeHead(200); return res.end(v.body);
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-bidi-"));
let seq = 0;
async function mkProj() {
  const dir = path.join(root, `p${++seq}`);
  await fsp.mkdir(path.join(dir, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".lively", "project.json"),
    JSON.stringify({ project_id: PROJECT_ID, sync: "both" }, null, 2) + "\n");
  return dir;
}
async function run(hook, dir) {
  const c = spawn(process.execPath, [hook], {
    cwd: dir, env: { ...process.env, LIVELY_TOKEN: "t", LIVELY_GATEWAY_URL: BASE, LIVELY_HOME: dir }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify({ cwd: dir }));
  assert.equal(await new Promise((r) => c.on("exit", r)), 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
// 한 턴 = pull(프롬프트 제출) → [사용자/에이전트 작업] → push(턴 끝). 실제 배선 순서 그대로.
async function turn(dir, work) {
  await run(PULL, dir);
  if (work) await work();
  await run(PUSH, dir);
}
const readOr = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return null; } };
const upOf = (dir) => { const s = readOr(path.join(dir, ".lively", "sync-up.json")); return s ? JSON.parse(s) : null; };
const conflictsOf = (dir) => (upOf(dir)?.conflicts || []);

try {
  // ── ① 기본 왕복 — 받고 · 고치고 · 올라가고 · 수렴한다(충돌 0) ──
  {
    SERVER = {}; putServer("doc.md", "서버 원본");
    const dir = await mkProj();
    await turn(dir);                                                   // 받기만
    assert.equal(readOr(path.join(dir, "doc.md")), "서버 원본", "① pull 이 안 됐다");

    await turn(dir, async () => fsp.writeFile(path.join(dir, "doc.md"), "내가 고친 본문"));
    assert.equal(SERVER["doc.md"].body, "내가 고친 본문", "① 로컬 편집이 중앙에 안 올라갔다 — up-sync 의 존재 이유");
    assert.deepEqual(conflictsOf(dir), [], "① 내 변경만 있었는데 충돌이 났다");

    await turn(dir);                                                   // 수렴 확인 — 되돌아오지 않는다
    assert.equal(readOr(path.join(dir, "doc.md")), "내가 고친 본문", "① 다음 턴 pull 이 내 변경을 되돌렸다");
    assert.deepEqual(conflictsOf(dir), [], "① 수렴 후에도 충돌이 남았다");
    ok("① 기본 왕복 — 서버→로컬 pull · 로컬 편집→중앙 push · 다음 턴에 되돌아오지 않고 수렴");
  }

  // ── ② 연속 편집 — 같은 파일을 턴마다 고쳐도 매번 올라간다(거짓 충돌 없음) ──
  //  워터마크(last_pull)가 우리 자신의 push 를 '남의 변경'으로 오인하면 두 번째 편집부터 영영 안 올라간다.
  {
    SERVER = {}; putServer("doc.md", "원본");
    const dir = await mkProj();
    await turn(dir);
    for (const body of ["1차 수정", "2차 수정", "3차 수정"]) {
      await turn(dir, async () => fsp.writeFile(path.join(dir, "doc.md"), body));
      assert.equal(SERVER["doc.md"].body, body, `② '${body}' 가 안 올라갔다 — 내 push 를 남의 변경으로 오인(워터마크 버그)`);
      assert.deepEqual(conflictsOf(dir), [], `② '${body}' 에서 거짓 충돌`);
    }
    ok("② 같은 파일 연속 편집 3회 → 매번 올라감(자기 push 를 남의 변경으로 오인하지 않음)");
  }

  // ── ③ 삭제 왕복 — 받은 문서를 로컬에서 지우면 중앙에서도 사라지고, 다시 안 내려온다 ──
  {
    SERVER = {}; putServer("지울문서.md", "받을 문서"); putServer("남길문서.md", "그대로");
    const dir = await mkProj();
    await turn(dir);
    assert.ok(readOr(path.join(dir, "지울문서.md")), "③ 사전조건: 받아야 한다");

    await turn(dir, async () => fsp.rm(path.join(dir, "지울문서.md")));
    assert.equal(SERVER["지울문서.md"], undefined, "③ 로컬 삭제가 중앙에 전파 안 됨(C3 삭제 전파의 본체)");
    assert.ok(SERVER["남길문서.md"], "③ 안 지운 문서까지 지웠다");

    await turn(dir);
    assert.equal(readOr(path.join(dir, "지울문서.md")), null, "③ 지운 문서가 다음 pull 로 되살아났다");
    ok("③ 삭제 왕복 — 로컬 삭제 → 중앙 삭제 → 다음 턴에 안 되살아남");
  }

  // ── 🔴 ④ 양쪽이 같은 파일을 고치면 → 어느 쪽도 안 잃고 충돌로 보고한다 ──
  //  ⚠ 충돌은 **pull 과 push 사이**에 남이 고쳐야 난다. 턴 시작 전에 서버가 바뀌면 그 턴의 pull 이 정상 배달하고
  //   내 편집은 '최신 서버본 위의 편집'이 되므로 올리는 게 맞다(그건 충돌이 아니다). 실제 레이스를 재현한다.
  {
    SERVER = {}; putServer("doc.md", "원본");
    const dir = await mkProj();
    await turn(dir);
    await turn(dir, async () => {
      await fsp.writeFile(path.join(dir, "doc.md"), "내가 로컬에서 고친 본문");
      putServer("doc.md", "남이 중앙에서 고친 본문");                   // 같은 턴에 남도 중앙에서 고쳤다
    });

    assert.equal(SERVER["doc.md"].body, "남이 중앙에서 고친 본문", "🔴 ④ 남의 최신본이 내 로컬본으로 덮였다");
    assert.equal(readOr(path.join(dir, "doc.md")), "내가 로컬에서 고친 본문", "④ 내 편집이 사라졌다");
    const c = conflictsOf(dir);
    assert.equal(c.length, 1, `④ 충돌이 보고돼야 한다 — 실제: ${JSON.stringify(c)}`);
    assert.equal(c[0].path, "doc.md");

    // 🔴 다음 턴에도 **pull 이 내 편집을 덮지 않는다**(pull 이 push 보다 먼저 도는 게 이 훅의 구조다).
    //  여기서 덮이면 사용자는 자기 편집이 사라진 걸 모른 채 충돌만 본다.
    await turn(dir);
    assert.equal(readOr(path.join(dir, "doc.md")), "내가 로컬에서 고친 본문", "🔴 ④ 다음 턴 pull 이 내 편집을 덮어 없앴다");
    assert.equal(SERVER["doc.md"].body, "남이 중앙에서 고친 본문", "🔴 ④ 다음 턴 push 가 남의 최신본을 덮었다(워터마크가 뚫림)");
    assert.equal(conflictsOf(dir).length, 1, "④ 충돌은 사람이 풀 때까지 계속 보여야 한다");
    ok("🔴 ④ 양쪽 다 변경 → 서버본·로컬본 **둘 다 보존** + 충돌 지속 보고(다음 턴에도 어느 쪽도 안 잃음)");
  }

  // ── ⑤ 충돌 해소 절차가 실제로 동작한다 — `lively status` 가 사람에게 안내하는 바로 그 순서 ──
  //  안내: `mv <파일> <파일>.mine` → 다음 턴에 서버본이 내려온다 → 합친 뒤 .mine 삭제.
  //  실행 못 할 지시를 화면에 띄우면 안 되므로 여기서 못 박는다.
  {
    SERVER = {}; putServer("doc.md", "원본");
    const dir = await mkProj();
    await turn(dir);
    await turn(dir, async () => {                                     // ④ 와 같은 레이스로 충돌을 만든다
      await fsp.writeFile(path.join(dir, "doc.md"), "내 편집");
      putServer("doc.md", "남이 고친 서버본");
    });
    assert.equal(conflictsOf(dir).length, 1, "⑤ 사전조건: 충돌 상태여야 한다");

    // 안내대로 이름을 바꾼다.
    await turn(dir, async () => fsp.rename(path.join(dir, "doc.md"), path.join(dir, "doc.md.mine")));
    // 다음 턴: 원래 경로가 비었으니 서버본이 내려오고, .mine 은 새 문서라 올라간다.
    await turn(dir);
    assert.equal(readOr(path.join(dir, "doc.md")), "남이 고친 서버본", "⑤ 이름을 바꿨는데 서버본이 안 내려왔다 — 안내가 거짓이 된다");
    assert.equal(readOr(path.join(dir, "doc.md.mine")), "내 편집", "⑤ 내 편집본이 사라졌다");
    assert.equal(SERVER["doc.md"].body, "남이 고친 서버본", "⑤ 서버본이 훼손됐다");
    assert.deepEqual(conflictsOf(dir), [], "⑤ 절차를 따랐는데 충돌이 안 풀렸다");
    ok("⑤ 충돌 해소 안내(`mv <파일> <파일>.mine`)가 실제로 동작 — 서버본 수신 + 내 본 보존 + 충돌 해소");
  }

  // ── 🔴 ⑥ 중앙에서 지운 문서를 로컬본으로 되살리지 않는다 ──
  {
    SERVER = {}; putServer("doc.md", "받을 문서");
    const dir = await mkProj();
    await turn(dir);
    delete SERVER["doc.md"];                                          // 남이 중앙에서 삭제(pull 은 삭제를 안 내린다)
    await turn(dir);
    assert.equal(SERVER["doc.md"], undefined, "🔴 ⑥ 중앙에서 지운 문서를 우리가 되살렸다");
    assert.equal(readOr(path.join(dir, "doc.md")), "받을 문서", "⑥ 로컬본은 함부로 지우지 않는다(사람이 판단할 몫)");
    assert.match(conflictsOf(dir)[0]?.why || "", /서버에서 사라짐/, "⑥ 되살리지 않았다면 이유를 보고해야 한다");
    ok("🔴 ⑥ 중앙 삭제 문서 → 되살리지 않음 · 로컬본 보존 · 사유 보고");
  }

  // ── 🔴 ⑦ 이미 파일이 있는 폴더를 바인딩(첫 싱크) — 같은 경로에 양쪽 다 파일이 있으면 **어느 쪽도 안 건드린다** ──
  //  이건 이 프로젝트의 목표 시나리오다(`lively init --bind` — 기존 로컬 폴더를 프로젝트로). 같은 경로에 두 판본이
  //  있는데 **공통 조상이 없다** → 어느 게 옳은지 알 방법이 없다. 받으면 사용자 파일이, 올리면 서버 문서가 사라진다.
  //  두 가지 오답을 다 막는다:
  //   ⓐ "크기 같고 로컬이 더 최신 ⟹ 이미 받은 것"이라 추측해 원장에 적기 → 원장이 거짓 → 사용자가 자기 파일을
  //      지우면 **남의 서버 문서가 지워진다**(0바이트·플레이스홀더는 크기 충돌이 흔하다).
  //   ⓑ 기준선을 세우려고 그냥 받기 → **사용자 파일이 백업도 없이 서버본으로 덮인다**.
  {
    SERVER = {}; putServer("TODO.md", "남이 쓴 서버 문서");
    const dir = await mkProj();
    const mine = path.join(dir, "TODO.md");
    await fsp.writeFile(mine, "내가 원래 쓰던 내용");                   // 길이가 서버본과 다르든 같든 결론은 같아야 한다
    const t = new Date(9_000_000_000);
    await fsp.utimes(mine, t, t);                                      // 서버보다 최신 = ⓐ 휴리스틱이 '동일'로 오판하던 조건

    await turn(dir);
    assert.equal(readOr(mine), "내가 원래 쓰던 내용", "🔴 ⑦-ⓑ 첫 싱크에서 사용자 파일이 서버본으로 덮였다(백업 없음)");
    assert.equal(SERVER["TODO.md"].body, "남이 쓴 서버 문서", "🔴 ⑦ 사용자 로컬본이 서버 문서를 덮었다");
    assert.equal(conflictsOf(dir).length, 1, "⑦ 공통 조상 없는 두 판본은 충돌로 보고돼야 한다(조용히 두면 아무도 모른다)");

    // ⓐ 의 핵심: 받은 적 없으므로 **원장에 없어야** 한다 → 사용자가 자기 파일을 지워도 서버는 안 지워진다.
    await turn(dir, async () => fsp.rm(mine));
    assert.ok(SERVER["TODO.md"] !== undefined,
      "🔴 ⑦-ⓐ 받은 적 없는 경로가 원장에 있어, 사용자가 자기 파일을 지우자 남의 서버 문서가 지워졌다(비가역)");
    ok("🔴 ⑦ 첫 싱크에 같은 경로 두 판본 → 양쪽 다 보존 + 충돌 보고 · 내 파일 지워도 서버 문서 안 지워짐");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
}
