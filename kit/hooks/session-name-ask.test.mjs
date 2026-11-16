// 이름짓기 안내 훅 (#1979) — **훅 프로세스를 실제로 스폰해** 관측 가능한 부작용(stdout 주입 여부)으로 검증한다.
//
// ⚠ 이 훅을 `import` 하면 안 된다 — 모듈 최상단 IIFE 가 끝나면서 `process.exit(0)` 을 부른다.
//  종전 판(2026-08-25)이 `namingPromptOk` 를 import 해서 썼는데, 동기 단언만 있을 땐 우연히 통과했지만
//  뒤에 비동기(스폰) 단언을 붙이자 **그 exit 가 테스트 프로세스를 먼저 죽여** 남은 단언이 조용히 안 돌았다
//  (증상: 실패 없이 exit 0 인데 ok 줄이 몇 개 사라진다 — 통과하면서 아무것도 안 보는 vacuous test).
//  그래서 예외 없이 전부 스폰으로 본다. 부작용 단언이라 "문구가 아니라 효과로 단언" 지침에도 맞는다.
//
// 이 훅이 틀렸을 때 나는 일:
//  🔴 "ㄱㄱ"·"/clear" 같은 말에 안내가 뜨면 세션이 그걸로 이름을 짓고, 걸쇠(label_source)상 agent 는 agent 를
//     못 덮으므로 **뜻 없는 이름이 그대로 굳는다**(사람이 손으로 고쳐야 한다).
//  🔴 위탁(task) 세션에 안내가 뜨면 `위탁 #<taskId>` 라벨이 덮여 배치가 진짜 작업으로 위장된다(#1979 항목4).
//
// 실행: node kit/hooks/session-name-ask.test.mjs
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { offlineLivelyEnv } from "../testlib/os-sandbox.mjs";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "session-name-ask.org-hook.mjs");
const CONTEXT_HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "project-agents-inject.org-hook.mjs");
const HOOK_TMP = path.join(os.tmpdir(), "lively-hooks");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

const flags = [];
let seq = 0;

/** 훅을 한 번 돌린다 → stdout. 세션 id 는 매번 새로(훅이 세션당 1회 플래그를 쓴다). stdin 에 더 실을 것은 input 으로. */
async function run(prompt, env = {}, input = {}) {
  const sid = `box-nametest-${process.pid}-${seq++}`;
  flags.push(path.join(os.tmpdir(), "lively-hooks", `${sid}.sessname`));
  const child = spawn(process.execPath, [HOOK], {
    // ⚠ 억제 env 를 전부 ""로 지운다 — 이 테스트를 돌리는 셸이 LIVELY_OFF 등을 들고 있으면
    //  훅이 통째로 침묵해 **모든 단언이 vacuous** 해진다(아래 대조군 행이 그걸 잡는다).
    env: { ...process.env, ...offlineLivelyEnv(), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", LIVELY_TASK_WS: "",
           LIVELY_SESSION_KIND: "", LIVELY_SESSION_LABEL_SOURCE: "",
           LIVELY_HARNESS: "claude", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "",
           LIVELY_SESSION_ID: sid, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ prompt, ...input }));
  let out = "";
  child.stdout.on("data", (c) => { out += c; });
  // ⚠ 'exit' 이 아니라 'close' — exit 은 stdio 가 다 비워지기 전에 올 수 있어 큰 stdout 이 잘린다.
  const code = await new Promise((r) => child.on("close", r));
  assert.equal(code, 0, "훅은 어떤 경우에도 exit 0 이어야 한다(세션을 막지 않는다)");
  return out;
}
const guided = (out) => /session_rename/.test(out);

try {
  // ── 표 D — 어떤 프롬프트에 안내를 다나(자격 판정). project-auto-bind 와 **일부러 다르다**(훅 주석 참고). ──
  const TABLE = [
    ["앱 16 에서 한글이 다 분해돼서 보입니다", true,  "통상 — 실사용자 첫 지시(#1957 의 그 문장)"],
    ["가".repeat(12),                      true,  "★경계 — 정확히 12자는 통과"],
    ["가".repeat(11),                      false, "★경계 — 11자는 이름이 될 수 없다"],
    ["ㄱㄱ",                                false, "너무 짧다"],
    ["계속",                                false, "세션이 무엇인지 말해주지 않는다"],
    ["",                                    false, "빈 프롬프트"],
    ["   \n  ",                             false, "공백뿐"],
    ["/clear 를 하고 다시 시작해 줘",          false, "슬래시 커맨드 — 사람의 실질 지시가 아니다"],
    ["!ls -la 를 실행해서 결과를 보여줘",       false, "뱅 커맨드"],
    ["<system-reminder>주입된 맥락입니다</system-reminder>", false, "하네스 주입물 — 사람이 친 말이 아니다"],
  ];
  let yes = 0;
  for (const [prompt, want, why] of TABLE) {
    const got = guided(await run(prompt));
    assert.equal(got, want, `프롬프트 ${JSON.stringify(prompt).slice(0, 40)} → 안내=${got} — ${why}`);
    if (got) yes++;
  }
  assert.ok(yes > 0 && yes < TABLE.length, `표가 한쪽으로만 나온다(안내 ${yes}/${TABLE.length}) — 아무것도 안 가르고 있다`);
  ok(`자격 표 ${TABLE.length}행 — 12자 경계 · 슬래시/뱅/주입물 배제 (안내 ${yes}건 / 침묵 ${TABLE.length - yes}건)`);

  // ── 세션당 1회 — 같은 세션 id 로 두 번 부르면 두 번째는 침묵한다(tmp 플래그 O_EXCL). ──
  {
    const sid = `box-nametest-${process.pid}-once`;
    flags.push(path.join(os.tmpdir(), "lively-hooks", `${sid}.sessname`));
    const twice = [];
    for (let i = 0; i < 2; i++) twice.push(guided(await run("이 작업을 실제 코드로 구현하고 테스트까지 완료해줘", { LIVELY_SESSION_ID: sid })));
    assert.deepEqual(twice, [true, false], "첫 턴에만 안내하고 그 뒤로는 침묵해야 한다");
    ok("세션당 1회 — 두 번째 턴부터는 침묵");
  }

  // ── #1979 항목4 — **위탁(task) 세션엔 안내하지 않는다.** ──
  //  🔴 없으면: `위탁 #<taskId>` 라벨(src/node/tasks.ts:376)이 agent 이름에 덮여, 위탁이 만든 것이
  //   «내 컴퓨터 자료 증류 배치»·«도메인맵 미분류 매핑» 처럼 진짜 작업으로 위장된다(실측 2026-08-26~27).
  //   덤으로 배치마다 이름짓기 툴콜이 한 번씩 붙는 순수 낭비.
  const REAL = "이 작업을 실제 코드로 구현하고 테스트까지 완료해줘";
  assert.equal(guided(await run(REAL, { LIVELY_TASK_WS: "/tmp/lively-task-ws-e2e" })), false,
    "위탁 세션에 이름짓기 안내가 나갔다");
  ok("★위탁 세션(LIVELY_TASK_WS) → 이름짓기 안내 없음");

  // 대조군 — 표식만 빼면 안내가 **나와야** 한다. 이게 없으면 위 단언이 vacuous 하다.
  assert.equal(guided(await run(REAL)), true, "대조군에 안내가 안 나왔다 — 위 단언이 무의미해진다");
  ok("대조군(표식 없음) — 종전대로 안내가 나온다");

  // 경계 — 빈 값·공백은 표식이 아니다. 여길 틀리면 안내가 **통째로** 죽는다(env 를 ""로 지우는 배선이 흔하다).
  for (const [label, val] of [["빈 문자열", ""], ["공백만", "   "]]) {
    assert.equal(guided(await run(REAL, { LIVELY_TASK_WS: val })), true, `LIVELY_TASK_WS=${label} 이 표식으로 오인됐다`);
  }
  ok("경계 — LIVELY_TASK_WS 빈 문자열·공백은 위탁 표식이 아니다");

  // ── #4418 — 이미 이름이 정해진 세션(사람이 준 이름 · AI 가 지은 세션의 복원)엔 **세션 이름짓기(①)를 안내하지 않는다.** ──
  //  🔴 없으면: 태스크에서 연 세션마다 첫 턴에 헛 이름짓기 툴콜이 붙고, 종전 노드 경합에선 그 툴콜이 이겨
  //   사람이 지은 태스크 이름까지 바뀌었다(맥미니 실측 2026-10-16 — 태스크에서 연 세션 넷).
  //  ②(자동 생성 프로젝트 이름)는 남는다 — 이름을 지어 프로젝트 없이 연 세션의 임시 프로젝트(«새 작업»)를 지을 유일한 자리다.
  const projectOnly = (out) => !guided(out) && /project_rename_v6/.test(out);
  {
    const sid = `box-nametest-${process.pid}-named`;
    flags.push(path.join(os.tmpdir(), "lively-hooks", `${sid}.sessname`));
    const twice = [];
    for (let i = 0; i < 2; i++) twice.push(await run(REAL, { LIVELY_SESSION_ID: sid, LIVELY_SESSION_LABEL_SOURCE: "human" }));
    assert.equal(projectOnly(twice[0]), true, "사람이 이름을 준 세션 — 세션 이름짓기 없이 프로젝트 이름(②)만 안내해야 한다");
    assert.equal(twice[1], "", "②만 안내해도 세션당 1회다 — 두 번째 턴은 침묵");
    for (const v of ["agent", "HUMAN", " human ", "Agent"]) {
      const out = await run(REAL, { LIVELY_SESSION_LABEL_SOURCE: v });
      assert.equal(projectOnly(out), true, `출처 ${JSON.stringify(v)} 인데 세션 이름짓기가 안내됐다(또는 ②가 빠졌다)`);
    }
    // 대조군 — 아직 이름이 없는 세션(rule·id)과 이 env 이전 세션(빈 값)은 종전대로 전부 안내한다(위 단언이 vacuous 하지 않게).
    for (const v of ["rule", "id", "", "   ", "humanoid"]) {
      const out = await run(REAL, { LIVELY_SESSION_LABEL_SOURCE: v });
      assert.equal(guided(out) && /project_rename_v6/.test(out), true, `출처 ${JSON.stringify(v)} 인데 종전 안내(①+②)가 안 나왔다`);
    }
    ok("★이미 이름이 정해진 세션(human·agent, 대소문자·공백 무관) → ②만 · 세션당 1회 · rule·id·빈 값·모르는 값은 종전대로 ①+②");
  }

  // ── #5552 — 이름이 정해졌는지는 **서버가 이번 턴에 답한 값**으로 가른다. pane env 는 여는 순간의 스냅샷이라 폴백일 뿐이다. ──
  //  값은 앞 묶음의 project-agents-inject 가 `<tmp>/lively-hooks/<세션>.naming` 에 적어 둔다(open·closed).
  //  🔴 없으면: AI 가 이미 이름을 지은 세션(«세션당 1회» 플래그가 사라진 pane) · 사람이 웹에서 이름을 고친 세션 · env 가 없는
  //   외부 실행 세션에 세션 이름짓기가 다시 안내돼, 그 턴에 헛 툴콜 하나와 «이름 붙이기를 시도했는데 서버가 적용하지
  //   않았습니다(applied:false)» 보고가 사람에게 보인다(윤상민 2026-11-16).
  {
    const full = (out) => guided(out) && /project_rename_v6/.test(out);
    let n = 0;
    /** 서버 답이 적힌 세션 하나를 차린다 → 그 세션 id. naming 이 null 이면 파일을 안 만든다. */
    const sessionWith = async (naming, id = `box-nametest-${process.pid}-nm${n++}`) => {
      flags.push(path.join(HOOK_TMP, `${id}.sessname`), path.join(HOOK_TMP, `${id}.naming`));
      await fsp.mkdir(HOOK_TMP, { recursive: true, mode: 0o700 });
      if (naming !== null) await fsp.writeFile(path.join(HOOK_TMP, `${id}.naming`), naming);
      return id;
    };

    // ★ⓐⓑ — env 는 «아직 이름 없음»(id·rule·빈 값)인데 서버는 «이미 정해졌다». 종전 훅은 여기서 ①을 안내했다.
    for (const v of ["id", "rule", ""]) {
      const out = await run(REAL, { LIVELY_SESSION_ID: await sessionWith("closed"), LIVELY_SESSION_LABEL_SOURCE: v });
      assert.equal(projectOnly(out), true, `서버가 이름이 정해졌다고 했는데(env=${JSON.stringify(v)}) 세션 이름짓기가 안내됐다`);
    }
    ok("★서버 값 closed → env 가 id·rule·빈 값이어도 세션 이름짓기(①) 없이 ②만");

    // 대조군 — 서버가 «먹힌다» 고 하면 env 가 뭐라든 전체 안내다(서버 값이 먼저다). 위 단언이 «파일만 있으면 ②만» 이 아님을 보인다.
    for (const v of ["id", "agent", "human"]) {
      const out = await run(REAL, { LIVELY_SESSION_ID: await sessionWith("open"), LIVELY_SESSION_LABEL_SOURCE: v });
      assert.equal(full(out), true, `서버 값 open 인데(env=${v}) ①+② 가 안 나왔다`);
    }
    ok("대조군 — 서버 값 open → env 와 무관하게 ①+②");

    // 줄바꿈·공백이 붙어도 같은 값이다(손으로 쓴 파일 · 다른 판의 맥락 훅).
    assert.equal(projectOnly(await run(REAL, { LIVELY_SESSION_ID: await sessionWith("closed\n"), LIVELY_SESSION_LABEL_SOURCE: "id" })), true, "'closed\\n' 을 못 읽었다");
    assert.equal(full(await run(REAL, { LIVELY_SESSION_ID: await sessionWith(" open \n"), LIVELY_SESSION_LABEL_SOURCE: "human" })), true, "' open \\n' 을 못 읽었다");
    ok("값 앞뒤 공백·줄바꿈은 무시");

    // ── 폴백 — 서버 값이 없거나 못 읽으면 **종전 판정(pane env)** 그대로다. ──
    //  🔴 폴백이 «②만» 쪽으로 기울면: 옛 게이트웨이(이 값을 안 주는 판)에 붙은 세션 · 프로젝트에 안 붙은 세션이 전부 이름을 못 얻는다.
    const UNKNOWN = [["파일 없음", null], ["빈 파일", ""], ["모르는 값", "maybe"], ["JSON 꼴", '{"open":false}'], ["대문자", "CLOSED"]];
    for (const [label, body] of UNKNOWN) {
      assert.equal(full(await run(REAL, { LIVELY_SESSION_ID: await sessionWith(body), LIVELY_SESSION_LABEL_SOURCE: "id" })), true, `${label} + env=id → 종전대로 ①+② 여야 한다`);
      assert.equal(projectOnly(await run(REAL, { LIVELY_SESSION_ID: await sessionWith(body), LIVELY_SESSION_LABEL_SOURCE: "human" })), true, `${label} + env=human → 종전대로 ②만이어야 한다`);
    }
    ok(`폴백 ${UNKNOWN.length}종 — 서버 값을 모르면 pane env 로(id → ①+② · human → ②만)`);

    // 남의 세션 값은 안 읽는다 — 파일은 세션 id 로 갈린다.
    {
      await sessionWith("closed");                                    // 다른 세션의 값
      assert.equal(full(await run(REAL, { LIVELY_SESSION_ID: await sessionWith(null), LIVELY_SESSION_LABEL_SOURCE: "id" })), true, "다른 세션의 closed 를 읽었다");
      ok("값은 세션마다 따로다");
    }

    // ★ⓒ — 라이블리가 띄우지 않은 외부 실행 세션(LIVELY_SESSION_ID 없음 → `claude-<대화 id>`). env 신호가 아예 없다.
    {
      const native = `nametest-${process.pid}-ext`;
      await sessionWith("closed", `claude-${native}`);
      const out = await run(REAL, { LIVELY_SESSION_ID: "" }, { session_id: native });
      assert.equal(projectOnly(out), true, "외부 실행 세션에 세션 이름짓기가 안내됐다(서버 값은 closed 였다)");
      ok("★외부 실행 세션(claude-<id>) — 서버 값 closed → ②만");
    }

    // ②만 안내해도 세션당 1회다.
    {
      const sid = await sessionWith("closed");
      const twice = [];
      for (let i = 0; i < 2; i++) twice.push(await run(REAL, { LIVELY_SESSION_ID: sid, LIVELY_SESSION_LABEL_SOURCE: "id" }));
      assert.equal(projectOnly(twice[0]), true);
      assert.equal(twice[1], "", "두 번째 턴에 안내가 또 나갔다");
      ok("서버 값으로 ②만 안내해도 세션당 1회");
    }

    // ★ 두 훅을 **실제로 이어** 돌린다 — 맥락 훅이 서버 답을 받아 적고, 안내 훅이 그걸 읽는다(파일 이름·값의 약속이 갈리면
    //  안내 훅은 조용히 env 로 물러나 고친 것이 통째로 안 돈다. 한쪽씩만 재는 시험으로는 그 어긋남이 안 보인다).
    //  러너는 묶음을 sort 순서로 차례로 돌린다(맥락 훅 10 → 안내 훅 30). 여기서도 그 순서로 부른다.
    {
      let naming;                                                     // 가짜 게이트웨이가 줄 값
      const srv = http.createServer((req, res) => {
        if (!/\/project-context(\?|$)/.test(req.url || "")) { res.writeHead(200, { "content-type": "application/json" }); res.end("{}"); return; }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ found: true, changed: false, project_id: 7, revision: 3, applied_revision: 3, binding_epoch: 1,
          ...(naming === undefined ? {} : { naming_open: naming }) }));
      });
      await new Promise((r) => srv.listen(0, "127.0.0.1", r));
      const home = await fsp.mkdtemp(path.join(os.tmpdir(), "lively-nametest-home-"));
      const turn = async (sid, env) => {
        // 맥락 훅(앞 묶음) — 실제 훅 프로세스. 빈 홈을 물려 이 기계의 토큰·게이트웨이로 새지 않게 한다.
        const c = spawn(process.execPath, [CONTEXT_HOOK], {
          env: { ...process.env, ...offlineLivelyEnv(), LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_HOME: home, LVLY_TENANT_SLUG: "",
                 LIVELY_HARNESS: "claude", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "",
                 LIVELY_TOKEN: "tok-nametest", LIVELY_GATEWAY_URL: `http://127.0.0.1:${srv.address().port}`, LIVELY_SESSION_ID: sid },
          stdio: ["pipe", "pipe", "pipe"],
        });
        c.stdin.end(JSON.stringify({ prompt: REAL }));
        c.stdout.resume(); c.stderr.resume();
        assert.equal(await new Promise((r) => c.on("close", r)), 0, "맥락 훅은 exit 0 이어야 한다");
        return await run(REAL, { LIVELY_SESSION_ID: sid, ...env });   // 안내 훅(뒤 묶음)
      };
      try {
        naming = false;
        assert.equal(projectOnly(await turn(await sessionWith(null), { LIVELY_SESSION_LABEL_SOURCE: "id" })), true,
          "서버가 naming_open:false 를 줬는데(env=id) 세션 이름짓기가 안내됐다 — 두 훅의 파일 약속이 갈렸다");
        naming = true;
        assert.equal(full(await turn(await sessionWith(null), { LIVELY_SESSION_LABEL_SOURCE: "human" })), true,
          "서버가 naming_open:true 를 줬는데(env=human) ①+② 가 안 나왔다");
        naming = undefined;                                           // 옛 게이트웨이 — 값을 안 준다
        assert.equal(full(await turn(await sessionWith(null), { LIVELY_SESSION_LABEL_SOURCE: "rule" })), true, "서버가 값을 안 줬는데(env=rule) ①+② 가 안 나왔다");
        assert.equal(projectOnly(await turn(await sessionWith(null), { LIVELY_SESSION_LABEL_SOURCE: "agent" })), true, "서버가 값을 안 줬는데(env=agent) ②만이 아니다");
        // ★ⓐ 그대로 — 첫 턴에 열려 있던 세션(①+② 안내 → AI 가 이름을 지음) → 플래그가 사라짐 → 다음 턴엔 서버가 닫혔다고 답한다.
        const sid = await sessionWith(null);
        naming = true;
        assert.equal(full(await turn(sid, { LIVELY_SESSION_LABEL_SOURCE: "id" })), true, "첫 턴 — 열린 세션에 ①+② 가 안 나왔다");
        await fsp.rm(path.join(HOOK_TMP, `${sid}.sessname`), { force: true });   // OS 가 tmp 를 치웠다
        await fsp.rm(path.join(HOOK_TMP, `${sid}.naming`), { force: true });
        naming = false;                                                           // 그 사이 AI 가 이름을 지었다
        assert.equal(projectOnly(await turn(sid, { LIVELY_SESSION_LABEL_SOURCE: "id" })), true,
          "플래그가 사라진 뒤의 턴 — 이미 이름이 지어진 세션에 세션 이름짓기가 다시 안내됐다");
        ok("★두 훅을 이어 돌림 — 서버 false → ②만 · true → ①+② · 값 없음 → env · 플래그가 사라진 세션에도 ①이 다시 안 나간다");
      } finally {
        srv.closeAllConnections?.();
        await new Promise((r) => srv.close(r));
        await fsp.rm(home, { recursive: true, force: true }).catch(() => {});
      }
    }
  }

  // ── 억제 플래그 — 종전 계약(전역 OFF·읽기전용·인코그니토)이 그대로인지. ──
  for (const [label, env] of [
    ["LIVELY_OFF=1", { LIVELY_OFF: "1" }],
    ["LIVELY_HOOKS_OFF=1", { LIVELY_HOOKS_OFF: "1" }],
    ["LIVELY_MODE=readonly", { LIVELY_MODE: "readonly" }],
    ["LIVELY_MODE=incognito", { LIVELY_MODE: "incognito" }],
  ]) {
    assert.equal(guided(await run(REAL, env)), false, `${label} 인데 안내가 나갔다`);
  }
  ok("억제 플래그 4종 — 전역 OFF · 읽기전용 · 인코그니토에서 침묵");

  console.log(`\n${pass} passed`);
} finally {
  for (const f of flags) await fsp.rm(f, { force: true }).catch(() => {});
}
