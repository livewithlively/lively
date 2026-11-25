#!/usr/bin/env node
// 세션이력 캡처 훅 (#905 C1 슬2c) — 가짜 게이트웨이 + 진짜 훅 프로세스 e2e.
//  실행: node kit/hooks/session-log-capture.test.mjs   (npm test 체인)
//
//  계약(대부분 "무엇을 안 하는가" — 대화 전문이 중앙에 나가므로):
//   🔴 capture.enabled 꺼짐 → 아무것도 안 보냄(조직이 켜야 캡처).
//   🔴 정책 밖 하네스 → 안 보냄.
//   🔴 로컬 오프셋 상태 파일 없음 — 서버 워터마크(GET)부터 트랜스크립트를 읽어 그 지점에 append.
//   🔴 session_id·transcript_path 없으면 no-op.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

//  SLC_HOOK — 고치기 전 훅(git show)으로 같은 시험을 돌려 빨간불을 보는 자리(fail-first). 평소엔 비워 둔다.
const HOOK = process.env.SLC_HOOK || path.join(fileURLToPath(import.meta.url), "..", "examples", "session-log-capture.org-hook.mjs");
let pass = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };

// ── 가짜 게이트웨이 — 세션별 워터마크 + 캡처 정책 + 받은 append 기록 ──
let SERVER = {};        // sessionId → { bytes, chunks: [{at, body}] }
let CAPTURE = { enabled: true, harnesses: ["claude"], scope: "main", store: "raw" };
let appends = [];
let requests = [];      // 모든 요청(GET watermark 포함) — 읽기전용은 «한 번도 안 부른다» 를 재기 위해
let POST_DELAY_MS = 0;  // ⑧ 뒤에서 올리는 판을 오래 살려 두는 자리(느린 회선 흉내)
let POST_FAIL = [];     // ⑧ 앞에서부터 하나씩 꺼내 그 상태로 POST 를 거절한다(예: [503] · [403, 403, …])
const server = http.createServer((req, res) => {
  const u = new URL(req.url, "http://x");
  requests.push({ method: req.method, path: u.pathname });
  const m = u.pathname.match(/^\/api\/ui\/v6\/sessions\/([^/]+)\/log(\/watermark)?$/);
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    if (!m) { res.writeHead(404); return res.end(); }
    const sid = decodeURIComponent(m[1]);
    const s = SERVER[sid] || (SERVER[sid] = { bytes: 0, chunks: [] });
    if (m[2] === "/watermark" && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ bytes: s.bytes, capture: CAPTURE }));
    }
    if (req.method === "POST") {   // append
      const at = Number(u.searchParams.get("at"));
      const body = Buffer.concat(chunks);
      const answer = () => {
        appends.push({ sid, at, len: body.length, harness: u.searchParams.get("harness"), node: u.searchParams.get("node"),
          execution: u.searchParams.get("execution"), headerSession: req.headers["x-lively-session"], body: body.length > 65536 ? "" : body.toString() });
        const st = POST_FAIL.length ? POST_FAIL.shift() : 0;   // 0 = 이번 것은 받는다
        if (st) { res.writeHead(st, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: "x" })); }
        if (at === s.bytes) { s.bytes += body.length; s.chunks.push({ at, body }); res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: true, verdict: "append", bytes: s.bytes })); }
        res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ ok: false, verdict: at < s.bytes ? "overlap" : "gap", bytes: s.bytes }));
      };
      return POST_DELAY_MS ? void setTimeout(answer, POST_DELAY_MS) : answer();
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const BASE = `http://127.0.0.1:${server.address().port}`;

const root = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-slog-"));
async function runHook(ev, { harness = "claude", env = {} } = {}) {
  const home = await fsp.mkdtemp(path.join(root, "home-"));
  await fsp.mkdir(path.join(home, ".lively"), { recursive: true });
  await fsp.writeFile(path.join(home, ".lively", "token"), "t\n");
  await fsp.writeFile(path.join(home, ".lively", "gateway-url"), BASE + "\n");
  const c = spawn(process.execPath, [HOOK], {
    cwd: root, env: { ...process.env, ...offlineLivelyEnv(), LIVELY_HOME: home, LIVELY_HARNESS: harness, LIVELY_GATEWAY_URL: BASE, LIVELY_TOKEN: "t",
      LIVELY_SESSION_ID: "box-log-e2e", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "",
      LIVELY_MODE: "", LIVELY_READONLY: "", LIVELY_INCOGNITO: "", ...env }, stdio: ["pipe", "pipe", "pipe"],
  });
  c.stdin.end(JSON.stringify(ev));
  const code = await new Promise((r) => c.on("exit", r));
  assert.equal(code, 0, "훅은 절대 세션을 막지 않는다(exit 0)");
}
async function mkTranscript(name, content) {
  const p = path.join(root, name);
  await fsp.writeFile(p, content);
  return p;
}
const reset = () => { SERVER = {}; appends = []; requests = []; POST_DELAY_MS = 0; POST_FAIL = []; CAPTURE = { enabled: true, harnesses: ["claude"], scope: "main", store: "raw" }; };
//  ⑧ 뒤에서 올리는 판의 잠금·사본은 os.tmpdir() 에 생긴다 — 시험마다 따로 둔 TMPDIR 로 가둬 남의 판과 섞이지 않게 한다.
const bgTmp = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-slog-bg-"));
//  뒤의 판이 끝에 닿은 뒤 기다리는 시간(⑨, 운영 3초)은 시험에선 줄인다 — 늦게 적힌 줄 시험만 그 시간 안에 적는다.
const BG_ENV = { TMPDIR: bgTmp, TMP: bgTmp, TEMP: bgTmp, LIVELY_LOGCAP_BG_QUIET_MS: "700" };
const waitFor = async (cond, ms, what) => {
  const t0 = Date.now();
  while (!cond()) { if (Date.now() - t0 > ms) throw new Error(`${ms}ms 안에 안 됨 — ${what}`); await new Promise((r) => setTimeout(r, 50)); }
};
const bgLeft = () => fs.readdirSync(bgTmp).filter((f) => f.startsWith("lively-logcap-"));
const MB = 1024 * 1024;
//  큰 한 턴 — 그림·큰 도구 결과가 붙은 줄 여럿(줄 하나 1MB) 끝에 마지막 답. 8MB 를 몇 번 넘는다.
const bigTurn = (mb, reply) => {
  let s = JSON.stringify({ type: "user", message: { role: "user", content: "그림 보고 답해 줘" } }) + "\n";
  const pad = "x".repeat(MB - 200);
  for (let i = 0; i < mb; i++) s += JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: pad }] } }) + "\n";
  return s + JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: reply }] } }) + "\n";
};
const serverText = (sid) => Buffer.concat((SERVER[sid]?.chunks || []).map((c) => c.body)).toString();

try {
  // ── 🔴 조직 스위치 꺼짐 → 아무것도 안 보냄 ──
  {
    reset(); CAPTURE.enabled = false;
    const tp = await mkTranscript("t1.jsonl", '{"type":"user"}\n{"type":"assistant"}\n');
    await runHook({ session_id: "s1", transcript_path: tp });
    assert.equal(appends.length, 0, "🔴 capture.enabled 꺼졌는데 전송함 — 조직이 안 켰으면 안 보냄");
    ok("🔴 enabled 꺼짐 → 전송 안 함");
  }

  // ── 🔴 정책 밖 하네스 → 안 보냄 ──
  {
    reset(); CAPTURE.harnesses = ["claude"];
    const tp = await mkTranscript("t2.jsonl", "line\n");
    await runHook({ session_id: "s2", transcript_path: tp }, { harness: "codex" });
    assert.equal(appends.length, 0, "🔴 harnesses 에 없는 codex 인데 전송함");
    ok("🔴 정책 밖 하네스 → 전송 안 함");
  }

  // ── 첫 캡처 → 워터마크 0 부터 전문 전송 ──
  {
    reset();
    const body = '{"type":"user","message":{"content":"안녕"}}\n{"type":"assistant"}\n';
    const tp = await mkTranscript("t3.jsonl", body);
    await runHook({ session_id: "s3", transcript_path: tp });
    assert.equal(appends.length, 1, "첫 턴에 한 번 전송");
    assert.equal(appends[0].at, 0, "워터마크 0 부터");
    assert.equal(appends[0].harness, "claude");
    assert.equal(appends[0].execution, "box-log-e2e", "대화 id와 별개인 실행 세션 id를 명시");
    assert.equal(appends[0].headerSession, "box-log-e2e", "query 실행 id와 인증 헤더가 일치");
    assert.equal(appends[0].body, body, "트랜스크립트 전문을 보냄");
    assert.equal(SERVER["s3"].bytes, Buffer.byteLength(body), "서버 워터마크가 그만큼 전진");
    ok("첫 캡처 → 워터마크 0부터 전문 전송 + 서버 전진");
  }

  // ── 둘째 턴 → 늘어난 꼬리만(서버 워터마크부터) ──
  {
    reset();
    const first = "aaaa\n";
    const tp = await mkTranscript("t4.jsonl", first);
    await runHook({ session_id: "s4", transcript_path: tp });
    const before = SERVER["s4"].bytes;
    const added = "bbbbbb\n";
    await fsp.appendFile(tp, added);
    appends = [];
    await runHook({ session_id: "s4", transcript_path: tp });
    assert.equal(appends.length, 1);
    assert.equal(appends[0].at, before, "둘째 턴은 서버 워터마크(=첫 턴 끝)부터");
    assert.equal(appends[0].body, added, "🔴 늘어난 꼬리만 보냄(중복 전송 없음)");
    ok("둘째 턴 → 서버 워터마크부터 늘어난 꼬리만(로컬 상태 파일 없이)");
  }

  // ── 늘어난 게 없으면 안 보냄 ──
  {
    reset();
    const body = "same\n";
    const tp = await mkTranscript("t5.jsonl", body);
    await runHook({ session_id: "s5", transcript_path: tp });   // 전송 1
    appends = [];
    await runHook({ session_id: "s5", transcript_path: tp });   // 변화 없음
    assert.equal(appends.length, 0, "파일이 안 늘었으면 전송 안 함");
    ok("변화 없음 → 전송 안 함");
  }

  // ── session_id / transcript_path 없으면 no-op ──
  {
    reset();
    const tp = await mkTranscript("t6.jsonl", "x\n");
    await runHook({ transcript_path: tp });                 // session_id 없음
    await runHook({ session_id: "s6" });                    // transcript_path 없음
    await runHook({ session_id: "s6", transcript_path: path.join(root, "nope.jsonl") }); // 파일 없음
    assert.equal(appends.length, 0, "필수정보 없거나 파일 없으면 no-op");
    ok("session_id·transcript_path 부재/파일 없음 → no-op");
  }

  // ── 🔴 읽기전용·인코그니토(#5048) → 게이트웨이를 한 번도 부르지 않는다(워터마크 GET 도 없음) ──
  //  조직이 수집을 켰고(CAPTURE.enabled) 트랜스크립트가 있어도. 구 boolean env(전이기 dual-env)도 같은 뜻이다.
  {
    for (const env of [{ LIVELY_MODE: "readonly" }, { LIVELY_MODE: "incognito" }, { LIVELY_MODE: " ReadOnly " },
      { LIVELY_READONLY: "1" }, { LIVELY_INCOGNITO: "1" }]) {
      reset();
      const tp = await mkTranscript("t7.jsonl", '{"type":"user","message":{"content":"기밀"}}\n');
      await runHook({ session_id: "s7", transcript_path: tp }, { env });
      assert.equal(appends.length, 0, `🔴 ${JSON.stringify(env)} 인데 대화를 올렸다`);
      assert.equal(requests.length, 0, `🔴 ${JSON.stringify(env)} 인데 게이트웨이를 불렀다(${requests.map((r) => r.method + " " + r.path).join(", ")})`);
    }
    ok("🔴 읽기전용·인코그니토(신·구 env) → 요청 0건");
  }

  // ── 대조군: 모드가 normal·미확장 리터럴·빈 값이면 종전대로 올린다(opt-in fail-safe — 실수로 끄지 않는다) ──
  {
    for (const env of [{ LIVELY_MODE: "normal" }, { LIVELY_MODE: "${LIVELY_MODE:-}" }, { LIVELY_MODE: "" }]) {
      reset();
      const tp = await mkTranscript("t8.jsonl", "ok\n");
      await runHook({ session_id: "s8", transcript_path: tp }, { env });
      assert.equal(appends.length, 1, `${JSON.stringify(env)} 는 normal — 올려야 한다`);
    }
    ok("대조군 — normal·미확장·빈 모드 → 종전대로 전송");
  }

  // ── ⑦ #5580 — 마지막 답이 파일에 늦게 적혀도 그 답까지 올린다 ──
  //  실측(Claude Code 2.1.326): Stop 훅이 뜬 순간 대화 파일엔 그 턴의 마지막 답이 아직 없다(훅 0건 · 1.5초 뒤 1건).
  //  종전 훅은 그 순간의 파일을 올려 중앙 기록이 «진행 중입니다» 같은 직전 문장에서 멈췄다(실제 하네스 5턴 중 5턴).
  const A = (text) => JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } }) + "\n";
  const U = (text) => JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n";
  const lastText = (body) => body.split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.type === "assistant").map((r) => r.message.content.map((c) => c.text).join("")).pop();
  {
    reset();
    const tp = await mkTranscript("t9.jsonl", U("영상 만들어 줘") + A("영상을 굽는 중입니다."));
    const late = setTimeout(() => { fs.appendFileSync(tp, A("밝은 판을 만들어 열었습니다.\n\n경로: /tmp/v1.mp4")); }, 400);
    const t0 = Date.now();
    await runHook({ session_id: "s9", transcript_path: tp, last_assistant_message: "밝은 판을 만들어 열었습니다.\n\n경로: /tmp/v1.mp4" });
    clearTimeout(late);
    assert.equal(appends.length, 1, "한 번 올린다");
    assert.equal(lastText(appends[0].body), "밝은 판을 만들어 열었습니다.\n\n경로: /tmp/v1.mp4",
      "🔴 마지막 답이 0.4초 늦게 적혔는데 직전 진행 문장까지만 올렸다 — 중앙 기록이 최신 답을 잃는다");
    assert.ok(Date.now() - t0 < 3000, "기다림은 답이 적히는 만큼만");
    ok("⑦ 마지막 답이 늦게 적혀도 그 답까지 올린다");
  }
  {
    reset();
    const tp = await mkTranscript("t10.jsonl", U("q") + A("다 됐어요."));
    const t0 = Date.now();
    await runHook({ session_id: "s10", transcript_path: tp, last_assistant_message: "다 됐어요." });
    assert.equal(appends.length, 1);
    assert.equal(lastText(appends[0].body), "다 됐어요.");
    assert.ok(Date.now() - t0 < 1500, `이미 적혀 있으면 기다리지 않는다(${Date.now() - t0}ms)`);
    ok("⑦ 이미 적혀 있으면 바로 올린다");
  }
  {
    reset();
    //  답 하나가 text 블록 둘로 나뉘어 두 줄로 적힌다 — 마지막 답 글은 둘을 이은 것이다.
    const tp = await mkTranscript("t11.jsonl", U("q") + A("첫 문단. ") + A("둘째 문단."));
    const t0 = Date.now();
    await runHook({ session_id: "s11", transcript_path: tp, last_assistant_message: "첫 문단. 둘째 문단." });
    assert.equal(appends.length, 1);
    assert.ok(Date.now() - t0 < 1500, `블록이 나뉘어 적혀도 마지막 블록이 끝부분이면 맞다(${Date.now() - t0}ms)`);
    ok("⑦ 블록이 나뉘어 적힌 답도 알아본다");
  }
  {
    reset();
    //  끝내 안 적히면(하네스가 그 줄을 안 쓰는 판) 상한에서 접고 있는 만큼 올린다 — 세션을 막지 않는다.
    const tp = await mkTranscript("t12.jsonl", U("q") + A("진행 중"));
    const t0 = Date.now();
    await runHook({ session_id: "s12", transcript_path: tp, last_assistant_message: "끝내 안 적히는 답" });
    const took = Date.now() - t0;
    assert.equal(appends.length, 1, "상한 뒤에도 있는 만큼은 올린다");
    assert.equal(lastText(appends[0].body), "진행 중");
    assert.ok(took >= 3500 && took < 7000, `상한(약 4초)에서 접는다 — ${took}ms`);
    ok("⑦ 끝내 안 적히면 상한에서 접고 있는 만큼 올린다");
  }
  {
    reset();
    //  답 글을 모르면(구 하네스 · 비Claude) 기다리지 않는다 — 종전 그대로.
    const tp = await mkTranscript("t13.jsonl", U("q") + A("진행 중"));
    const t0 = Date.now();
    await runHook({ session_id: "s13", transcript_path: tp });
    assert.equal(appends.length, 1);
    assert.ok(Date.now() - t0 < 1500, `답 글이 없으면 기다리지 않는다(${Date.now() - t0}ms)`);
    ok("⑦ 답 글을 모르면 종전 그대로(기다리지 않음)");
  }

  // ── ⑧ #5611 — 한 턴에 8MB 넘게 늘어도 마지막 답까지 올린다 ──
  //  실측(2026-11-20 맥미니 노드): 종전 훅은 턴마다 8MB 한 조각만 올려, 그림이 붙은 큰 턴 뒤 세션이 꺼지면 중앙 기록이
  //  «그 턴 시작 + 8MB×n» 에서 멈췄다(22,165,171 = 5,387,955 + 2×8MB). 꺼진 세션 대화창은 그 기록을 읽어 마지막 답이 없었다.
  {
    reset(); POST_DELAY_MS = 300;
    const reply = "다 만들었습니다 — 마지막 답";
    const tp = await mkTranscript("t14.jsonl", bigTurn(20, reply));
    const size = fs.statSync(tp).size;
    const t0 = Date.now();
    await runHook({ session_id: "s14", transcript_path: tp, last_assistant_message: reply }, { env: BG_ENV });
    const took = Date.now() - t0, postsAtExit = appends.length;
    await waitFor(() => SERVER.s14?.bytes === size, 30_000, `중앙 기록이 파일 끝(${size})까지 — 지금 ${SERVER.s14?.bytes}`);
    assert.ok(serverText("s14").endsWith(reply + '"}]}}\n'), "🔴 마지막 답이 중앙 기록 끝에 있어야 한다");
    assert.equal(appends.length, Math.ceil(size / (8 * MB)), "조각마다 한 번씩(겹쳐 올리지 않는다)");
    assert.equal(postsAtExit, 1, `훅은 첫 조각만 올리고 턴을 놓는다 — 나머지는 뒤에서(훅이 끝날 때 ${postsAtExit}번 · ${took}ms)`);
    await waitFor(() => bgLeft().length === 0, 5_000, `뒤에서 올린 판의 잠금·사본이 남았다: ${bgLeft().join(",")}`);
    ok("⑧ 8MB 넘는 턴 — 첫 조각은 훅이, 나머지는 뒤에서 마지막 답까지 올리고 흔적을 남기지 않는다");
  }
  {
    reset();
    const reply = "앞에서 다 올림";
    const tp = await mkTranscript("t15.jsonl", bigTurn(20, reply));
    const size = fs.statSync(tp).size;
    await runHook({ session_id: "s15", transcript_path: tp, last_assistant_message: reply }, { env: { ...BG_ENV, LIVELY_LOGCAP_BG_OFF: "1" } });
    assert.equal(SERVER.s15?.bytes, size, `🔴 뒤에서 못 돌리는 자리면 예산 안에서 앞에서 잇는다 — ${SERVER.s15?.bytes}/${size}`);
    assert.equal(bgLeft().length, 0, "뒤에서 도는 판을 띄우지 않았다");
    ok("⑧ 뒤에서 못 돌리는 자리(LIVELY_LOGCAP_BG_OFF) — 훅 예산 안에서 끝까지");
  }
  {
    reset(); POST_DELAY_MS = 600;
    const tp = await mkTranscript("t16.jsonl", bigTurn(20, "첫 턴 답"));
    await runHook({ session_id: "s16", transcript_path: tp, last_assistant_message: "첫 턴 답" }, { env: BG_ENV });
    await waitFor(() => bgLeft().some((f) => f.startsWith("lively-logcap-lock-")), 5_000, "뒤에서 올리는 판이 잠금을 잡는다");
    fs.appendFileSync(tp, U("또 물어봄") + A("둘째 턴 답"));
    const size = fs.statSync(tp).size;
    //  둘째 턴의 훅은 다른 실행 id 로 띄워 그 훅이 보낸 POST 만 따로 센다(뒤의 판은 첫 훅의 id 를 물려받았다).
    await runHook({ session_id: "s16", transcript_path: tp, last_assistant_message: "둘째 턴 답" }, { env: { ...BG_ENV, LIVELY_SESSION_ID: "box-log-e2e-2" } });
    await waitFor(() => SERVER.s16?.bytes === size, 30_000, `둘째 턴 몫까지 — 지금 ${SERVER.s16?.bytes}/${size}`);
    const byHook2 = appends.filter((a) => a.headerSession === "box-log-e2e-2").length;
    assert.equal(byHook2, 0, `뒤에서 올리는 판이 살아 있으면 다음 턴의 훅은 그 판에 맡긴다(겹쳐 보낸 POST ${byHook2})`);
    assert.ok(serverText("s16").endsWith(A("둘째 턴 답")), "🔴 둘째 턴의 마지막 답까지 올라가야 한다");
    await waitFor(() => bgLeft().length === 0, 5_000, "잠금이 풀린다");
    ok("⑧ 뒤에서 올리는 중에 끝난 다음 턴 — 그 판이 이 턴 몫까지 잇는다");
  }
  {
    reset(); POST_FAIL = [0, 413];   // 첫 조각은 받고, 뒤의 조각은 «너무 크다» 로 거절(영구 거절)
    const tp = await mkTranscript("t17.jsonl", bigTurn(20, "거절됨"));
    await runHook({ session_id: "s17", transcript_path: tp, last_assistant_message: "거절됨" }, { env: BG_ENV });
    await waitFor(() => appends.length >= 2 && bgLeft().length === 0, 5_000, "영구 거절이면 뒤의 판이 접고 잠금을 푼다");
    await new Promise((r) => setTimeout(r, 2500));   // 다시 해 보는 첫 간격(2초)을 넘겨 기다린다
    assert.equal(appends.length, 2, `🔴 영구 거절(413)을 되풀이하지 않는다 — POST ${appends.length}번`);
    assert.equal(SERVER.s17.bytes, 8 * MB, "받은 만큼만");
    ok("⑧ 영구 거절이면 뒤의 판이 바로 접는다(되풀이 없음)");
  }
  {
    reset(); POST_FAIL = [403];   // 첫 조각부터 영구 거절 — 뒤에서 띄우지도 않는다
    const tp = await mkTranscript("t18.jsonl", bigTurn(20, "x"));
    await runHook({ session_id: "s18", transcript_path: tp, last_assistant_message: "x" }, { env: BG_ENV });
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(appends.length, 1, `거절된 대화를 뒤에서 다시 올리지 않는다 — POST ${appends.length}번`);
    assert.equal(bgLeft().length, 0, "뒤에서 도는 판이 없다");
    ok("⑧ 첫 조각부터 영구 거절이면 뒤에서 띄우지 않는다");
  }
  {
    reset(); POST_FAIL = [0, 503];   // 뒤의 첫 조각이 일시 오류 — 2초 뒤 워터마크부터 다시
    const reply = "일시 오류를 넘어 올림";
    const tp = await mkTranscript("t19.jsonl", bigTurn(20, reply));
    const size = fs.statSync(tp).size;
    await runHook({ session_id: "s19", transcript_path: tp, last_assistant_message: reply }, { env: BG_ENV });
    await waitFor(() => SERVER.s19?.bytes === size, 30_000, `일시 오류 뒤 끝까지 — 지금 ${SERVER.s19?.bytes}/${size}`);
    await waitFor(() => bgLeft().length === 0, 5_000, "잠금이 풀린다");
    ok("⑧ 일시 오류(503)는 잠시 뒤 서버 워터마크부터 다시 해서 끝까지");
  }

  // ── ⑨ #5611 후속 — Stop 이 안 뜬 턴 끝(사람이 끊음 · 사용 한도)도 세션이 내려갈 때(SessionEnd) 올린다 ──
  //  실측(2026-11-20 맥미니): 턴마다 한도로 끝난 세션·끊고 둔 세션은 Stop 이 한 번도 안 떠 중앙 기록이 0바이트였다 —
  //  보관한 뒤 대화창이 통째로 비었다. tmux 를 내려도 Claude Code 는 SessionEnd 훅을 띄운다(reason "other").
  const END = (sid, tp) => ({ session_id: sid, transcript_path: tp, cwd: root, hook_event_name: "SessionEnd", reason: "other" });
  {
    reset();
    const first = U("첫 질문") + A("첫 답");
    const tp = await mkTranscript("t20.jsonl", first + U("둘째 질문") + A("답하다 끊긴 부분"));   // 끊긴 턴 — Stop 이 안 떴다
    SERVER.s20 = { bytes: Buffer.byteLength(first), chunks: [{ at: 0, body: Buffer.from(first) }] };
    const size = fs.statSync(tp).size;
    POST_DELAY_MS = 800;    // 훅이 앞에서 올렸다면 이 응답을 기다리느라 늦게 끝난다
    await runHook(END("s20", tp), { env: BG_ENV });
    assert.equal(appends.length, 0, "🔴 내려가는 중엔 훅이 앞에서 올리지 않고 뒤의 판에 맡긴다(하네스 종료를 붙잡지 않는다)");
    await waitFor(() => SERVER.s20?.bytes === size, 15_000, `끊긴 턴까지 — 지금 ${SERVER.s20?.bytes}/${size}`);
    assert.ok(serverText("s20").endsWith(U("둘째 질문") + A("답하다 끊긴 부분")), "🔴 끊긴 턴의 질문과 답이 중앙 기록 끝에 있어야 한다");
    await waitFor(() => bgLeft().length === 0, 10_000, "잠금이 풀린다");
    ok("⑨ 끊긴 턴(Stop 없음) — 세션이 내려갈 때 뒤의 판이 마저 올린다");
  }
  {
    reset();
    const tp = await mkTranscript("t21.jsonl", U("질문") + A("You've hit your limit · resets 6am") + U("또 질문") + A("You've hit your limit · resets 6am"));
    const size = fs.statSync(tp).size;
    await runHook(END("s21", tp), { env: BG_ENV });
    await waitFor(() => SERVER.s21?.bytes === size, 15_000, `처음부터 끝까지 — 지금 ${SERVER.s21?.bytes}/${size}`);
    assert.equal(serverText("s21"), fs.readFileSync(tp, "utf8"), "🔴 한 번도 안 올라간 대화는 처음부터 다 올린다");
    await waitFor(() => bgLeft().length === 0, 10_000, "잠금이 풀린다");
    ok("⑨ 턴마다 한도로 끝나 한 번도 안 올라간 대화 — 내려갈 때 처음부터 다 올린다");
  }
  {
    reset();
    const tp = await mkTranscript("t22.jsonl", U("질문") + A("진행 중 문장"));
    await runHook(END("s22", tp), { env: BG_ENV });
    await waitFor(() => SERVER.s22?.bytes === fs.statSync(tp).size, 15_000, "첫 몫");
    await new Promise((r) => setTimeout(r, 250));                // 종료하는 하네스가 마지막 줄을 늦게 적는다(기다림 700ms 안)
    fs.appendFileSync(tp, A("늦게 적힌 마지막 답"));
    const size = fs.statSync(tp).size;
    await waitFor(() => SERVER.s22?.bytes === size, 15_000, `늦게 적힌 줄까지 — 지금 ${SERVER.s22?.bytes}/${size}`);
    assert.ok(serverText("s22").endsWith(A("늦게 적힌 마지막 답")), "🔴 뒤의 판은 끝에 닿은 뒤 잠깐 기다렸다 다시 잰다");
    await waitFor(() => bgLeft().length === 0, 10_000, "잠금이 풀린다");
    ok("⑨ 종료하며 늦게 적힌 마지막 줄 — 뒤의 판이 잠깐 기다렸다 잇는다");
  }
  {
    reset(); CAPTURE.enabled = false;
    const tp = await mkTranscript("t23.jsonl", U("질문") + A("답"));
    await runHook(END("s23", tp), { env: BG_ENV });
    await waitFor(() => requests.length >= 1 && bgLeft().length === 0, 10_000, "정책을 물은 뒤 접는다");
    assert.equal(appends.length, 0, "🔴 조직이 껐으면 내려갈 때도 안 보낸다");
    ok("⑨ 내려갈 때도 조직 스위치(capture.enabled)를 따른다");
  }
  {
    reset();
    const tp = await mkTranscript("t24.jsonl", U("질문") + A("답"));
    for (const env of [{ LIVELY_MODE: "readonly" }, { LIVELY_MODE: "incognito" }]) {
      await runHook(END("s24", tp), { env: { ...BG_ENV, ...env } });
    }
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(requests.length, 0, "🔴 읽기전용·인코그니토는 내려갈 때도 게이트웨이를 한 번도 안 부른다");
    assert.equal(bgLeft().length, 0, "뒤의 판도 띄우지 않는다");
    ok("⑨ 읽기전용·인코그니토 — 내려갈 때도 아무것도 안 한다");
  }
  {
    reset();
    const tp = await mkTranscript("t25.jsonl", U("질문") + A("뒤에서 못 돌리는 자리"));
    await runHook(END("s25", tp), { env: { ...BG_ENV, LIVELY_LOGCAP_BG_OFF: "1" } });
    assert.equal(SERVER.s25?.bytes, fs.statSync(tp).size, "🔴 뒤에서 못 돌리면 내려갈 때도 앞에서 끝까지 올린다");
    assert.equal(bgLeft().length, 0, "뒤에서 도는 판을 띄우지 않았다");
    ok("⑨ 뒤에서 못 돌리는 자리 — 내려갈 때 앞에서 올린다");
  }

  console.log(`\n${pass} passed`);
} finally {
  server.close();
  await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  await fsp.rm(bgTmp, { recursive: true, force: true }).catch(() => {});
}
