// 세션에 붙은 앱 알리기 훅 (#4225, 사양 표 S4) — **훅 프로세스를 실제로 스폰해** 부작용으로 검증한다.
//  ① stdout 에 무엇을 주입했나 ② 가짜 게이트웨이에 **어떤 요청이 몇 번** 갔나(헤더 포함).
//
// ⚠ 훅을 import 하지 않는다 — 모듈 최상단 IIFE 가 끝나며 process.exit(0) 을 부른다(session-name-ask.test.mjs 머리말).
//
// 이 훅이 틀렸을 때 나는 일:
//  🔴 목록이 그대로인데 매 턴 주입 → 턴마다 같은 안내가 맥락을 갉아먹는다.
//  🔴 조회 실패를 «아무것도 안 붙음» 으로 읽음 → 게이트웨이가 한 번 흔들리면 AI 에게 «앱이 떨어졌다» 고 거짓말한다.
//  🔴 사람이 아닌 세션(위탁·상시)에도 조회 → 배치마다 쓸데없는 왕복.
//
// 실행: node kit/hooks/session-apps-inject.test.mjs
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sandboxEnv } from "../testlib/os-sandbox.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "session-apps-inject.org-hook.mjs");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// ── 가짜 게이트웨이 — 응답을 대본으로 바꿔 끼우고, 받은 요청을 남긴다 ──
let reply = { status: 200, body: { apps: [] } };
const seen = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization || "", session: req.headers["x-lively-session"] || "" });
  res.writeHead(reply.status, { "content-type": "application/json" });
  res.end(JSON.stringify(reply.body));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "apps-inject-"));
const home = path.join(tmp, "home");
await fsp.mkdir(home, { recursive: true });

async function run(sid, env = {}) {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, ...sandboxEnv({ home, tmp }), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", LIVELY_TASK_WS: "",
      LIVELY_SESSION_KIND: "human", LIVELY_TOKEN: "tok-alice", LIVELY_GATEWAY_URL: base, LIVELY_SESSION_ID: sid, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ prompt: "이번 주 만난 사람 기록해 줘" }));
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "훅은 어떤 경우에도 exit 0 이어야 한다(프롬프트를 막지 않는다)");
  if (!out.trim()) return null;
  const j = JSON.parse(out);
  return String(j?.hookSpecificOutput?.additionalContext ?? "");
}

const CRM = { app_id: "crm", title: "컨택 관리", has_ui: true, tables: [{ name: "contacts", columns: [{ name: "name" }, { name: "org" }] }] };

try {
  const sid = `box-appsinj-${process.pid}`;
  // S4-1 첫 턴 · 붙은 앱 없음 → 주입 없음(요청은 한 번 간다 — 배선 확인)
  reply = { status: 200, body: { apps: [] } };
  seen.length = 0;
  assert.equal(await run(sid), null);
  assert.equal(seen.length, 1, "조회가 게이트웨이에 닿지 않았다 — 아래 단언이 전부 vacuous 해진다");
  ok("S4-1 붙은 앱 없음 → 침묵(조회는 1번 닿았다)");

  // S4-8 조회에 세션 헤더·토큰을 싣는다 · 경로는 그 세션
  assert.equal(seen[0].session, sid);
  assert.equal(seen[0].auth, "Bearer tok-alice");
  assert.equal(seen[0].url, `/api/ui/terminal/sessions/${sid}/apps`);
  ok("S4-8 세션 헤더·Bearer·그 세션의 경로");

  // S4-2 붙은 앱이 생겼다 → 한 번 주입(제목·app_id·테이블·store_*)
  reply = { status: 200, body: { apps: [CRM] } };
  const t2 = await run(sid);
  assert.ok(t2, "붙은 앱이 생겼는데 주입이 없다");
  for (const want of ["컨택 관리", "app_id: crm", "contacts", "store_insert"]) assert.ok(t2.includes(want), `주입에 «${want}» 가 없다`);
  ok("S4-2 붙음 → 주입(제목·app_id·테이블·쓰는 법)");

  // S4-3 다음 턴 목록 그대로 → 침묵
  assert.equal(await run(sid), null);
  ok("S4-3 목록 그대로 → 침묵");

  // S4-5 조회 실패(500) → 침묵, 기억은 그대로(아래 S4-4 가 «떨어졌다» 를 여전히 감지해야 한다)
  reply = { status: 500, body: { error: "boom" } };
  assert.equal(await run(sid), null);
  ok("S4-5 조회 실패 → 침묵(«떨어졌다» 고 거짓말하지 않는다)");

  // S4-4 뗌 → «떨어졌다» 주입
  reply = { status: 200, body: { apps: [] } };
  const t4 = await run(sid);
  assert.ok(t4 && t4.includes("컨택 관리") && t4.includes("떨어졌습니다"), "뗐는데 알리지 않았다(또는 실패 턴에 기억을 잃었다)");
  ok("S4-4 뗌 → «떨어졌다» 주입 — 실패 턴을 사이에 둬도 변화를 잡는다");

  // S4-6 사람 세션이 아님 → 조회도 안 한다
  seen.length = 0;
  reply = { status: 200, body: { apps: [CRM] } };
  assert.equal(await run(`${sid}-task`, { LIVELY_SESSION_KIND: "task" }), null);
  assert.equal(seen.length, 0);
  ok("S4-6 위탁 세션 → 조회 0건");

  // S4-7 LIVELY_SESSION_ID 없음 → 조회도 안 한다
  assert.equal(await run("", {}), null);
  assert.equal(seen.length, 0);
  ok("S4-7 세션 id 없음 → 조회 0건");

  // 대조군 — 같은 조건에서 사람 세션·새 세션 id 면 주입된다(위 두 침묵이 관측 장치 고장이 아님)
  assert.ok(await run(`${sid}-ctl`));
  assert.equal(seen.length, 1);
  ok("대조군 — 새 사람 세션에선 주입된다");

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(tmp, { recursive: true, force: true });
}
