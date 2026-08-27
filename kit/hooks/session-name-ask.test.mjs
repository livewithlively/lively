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
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "examples", "session-name-ask.org-hook.mjs");
let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

const flags = [];
let seq = 0;

/** 훅을 한 번 돌린다 → stdout. 세션 id 는 매번 새로(훅이 세션당 1회 플래그를 쓴다). */
async function run(prompt, env = {}) {
  const sid = `box-nametest-${process.pid}-${seq++}`;
  flags.push(path.join(os.tmpdir(), "lively-hooks", `${sid}.sessname`));
  const child = spawn(process.execPath, [HOOK], {
    // ⚠ 억제 env 를 전부 ""로 지운다 — 이 테스트를 돌리는 셸이 LIVELY_OFF 등을 들고 있으면
    //  훅이 통째로 침묵해 **모든 단언이 vacuous** 해진다(아래 대조군 행이 그걸 잡는다).
    env: { ...process.env, LIVELY_OFF: "", LIVELY_HOOKS_OFF: "", LIVELY_MODE: "", LIVELY_TASK_WS: "",
           LIVELY_HARNESS: "claude", CODEX_THREAD_ID: "", CODEX_SESSION_ID: "", CLAUDE_SESSION_ID: "",
           LIVELY_SESSION_ID: sid, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdin.end(JSON.stringify({ prompt }));
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
