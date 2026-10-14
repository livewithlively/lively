// 프로젝트 리브 대화의 되그리기(replayHistory)·이어 받기(drain) 배선 — 진행 로그를 조각으로 읽는 순서를 고정한다.
//
//  빌드된 **실제 project-chat.js** 를 임시 폴더에 옮기고 core.js(api)·chat-view.js(화면)만 가짜로 끼워 돌린다.
//  시계도 가짜다(POLL_MS 400ms 대기) — 기다리지 않고 결정적으로 잰다(선례: scripts/shell-prefs-sync.test.mjs H 절).
//  러너는 web/ 을 수집하지 않으므로 컴파일 산출물을 쓴다(`npm run build:web` 선행).
//
//  무엇을 지키나:
//   R1 ★ 아직 도는 턴은 첫 조각 뒤 drain 에 넘긴다. 되그리기가 «빈 조각이 올 때까지» 쫓으면, 쓰는 속도가 왕복보다 빠른 동안
//      쉬지 않고 요청하고 · 입력이 안 잠기고(턴이 겹치면 --resume 이 꼬인다) · 글이 실시간으로 안 그려지며 ·
//      그 사이 끝나면 onTurnDone(화면이 프로젝트를 다시 읽는 신호)이 안 불린다.
//   R2 끝난 긴 턴은 빈 조각까지 이어 읽어 마지막 답을 그린다(첫 256KB 만 읽어 최종 답이 사라지던 결함).
//   R3 30분 넘게 멈춘 턴도 끝까지 읽어 보여 주고 «끝나지 못했다» 를 말한다.
//   R4 화면을 떠나면(destroy) 남은 조각을 더 읽지 않는다.
//   R5 이어 읽다 실패하면 그린 것은 두고 그 자리에 말한다 — 첫 요청부터 실패면 그 자리를 걷는다.
import assert from "node:assert/strict";
import { mkdtempSync, copyFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };

// ── 가짜 시계 ──
const realSetImmediate = setImmediate;
const timers = new Map();
let clock = 0, tid = 0;
globalThis.setTimeout = (fn, ms) => { const id = ++tid; timers.set(id, { fn, at: clock + (ms || 0) }); return id; };
globalThis.clearTimeout = (id) => { timers.delete(id); };
const flush = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => realSetImmediate(r)); };
/** 걸린 타이머가 없을 때까지 시계를 앞으로 민다 — drain 의 POLL_MS 대기를 기다리지 않는다. */
async function runIdle(maxSteps = 500) {
  await flush();
  for (let i = 0; i < maxSteps; i++) {
    let due = null;
    for (const [id, t] of timers) if (!due || t.at < due.t.at) due = { id, t };
    if (!due) return;
    timers.delete(due.id);
    clock = Math.max(clock, due.t.at);
    due.t.fn();
    await flush();
  }
  throw new Error("타이머가 끝나지 않는다 — 폴링이 멈추지 않는 상태");
}

// ── 빌드된 모듈 + 가짜 이웃 ──
const tmp = mkdtempSync(join(tmpdir(), "project-chat-replay-"));
copyFileSync(join(root, "public/app/project-chat.js"), join(tmp, "project-chat.js"));
copyFileSync(join(root, "public/app/jsonl-lines.js"), join(tmp, "jsonl-lines.js"));
writeFileSync(join(tmp, "core.js"), `export function api(url, opts) { return globalThis.__api(url, opts); }\n`);
writeFileSync(join(tmp, "chat-view.js"), `
export function createChatView() {
  const S = globalThis.__view;
  const log = (k, extra) => S.calls.push({ k, reads: S.reads(), ...(extra || {}) });
  return {
    turn: () => ({ work: { remove() { log("work.remove"); } } }),
    event: (t, ev) => { log("event", { type: ev.type }); return { text: ev.type === "assistant" }; },
    stream: () => log("stream"),
    settle: () => log("settle"), error: (t, m) => log("error", { m }),
    running: () => log("running"), busy: (on) => log("busy", { on }),
    scroll() {}, scrollToBottom() {}, removeOpening() {}, setNote() {}, divider() {},
    input: { focus() {}, value: "", disabled: false }, form: { requestSubmit() {} }, destroy() { log("destroy"); },
  };
}
`);
const { mountProjectChat } = await import(pathToFileURL(join(tmp, "project-chat.js")).href);

const BASE = "/api/ui/v6/projects/7/chat";
const L = (o) => JSON.stringify(o) + "\n";
const INIT = L({ type: "system", subtype: "init" });
const SE = L({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "토큰" } } });
const ANSWER = L({ type: "assistant", message: { content: [{ type: "text", text: "최종 답" }] } });
const RESULT = L({ type: "result", result: "최종 답" });

/**
 * 턴 하나짜리 대화를 띄운다. log = 진행 로그(바이트=글자로 단순화) · exited = 끝났나 · cap = 한 조각 상한(작게 잡아 여러 쪽을 만든다)
 *  onRead(n, T, from) = n 번째 진행 읽기 직전에 서버 쪽 상태를 바꾼다(쓰는 중인 판 · 실패 주입 · 화면 떠나기).
 */
async function boot({ log, exited, ageMin = 1, cap = 1 << 20, onRead }) {
  const T = { log, exited, reads: 0, froms: [] };
  const S = globalThis.__view = { calls: [], reads: () => T.reads };
  let handle = null, turnDone = 0;
  globalThis.__api = async (url) => {
    if (url === BASE) return { chat: { turns: [{ id: "t1", text: "해 줘", at: new Date(Date.now() - ageMin * 60_000).toISOString() }] } };
    const m = /\/turn\/t1\?from=(\d+)$/.exec(url);
    if (!m) throw new Error(`예상 밖 요청: ${url}`);
    const from = Number(m[1]);
    T.reads++; T.froms.push(from);
    onRead?.(T.reads, T, from, () => handle.destroy());
    const chunk = T.log.slice(from, from + cap);
    return { chunk, next: from + chunk.length, done: T.exited, exit: T.exited ? 0 : null };
  };
  handle = mountProjectChat({}, { projectId: 7, onTurnDone: () => { turnDone++; S.calls.push({ k: "onTurnDone", reads: T.reads }); } });
  await runIdle();
  const first = (k) => S.calls.find((c) => c.k === k);
  const count = (k, f = () => true) => S.calls.filter((c) => c.k === k && f(c)).length;
  return { T, S, first, count, turnDone: () => turnDone };
}

try {
  // R1 ★ 쓰는 중인 턴 — 읽을 때마다 새 줄이 붙어 있고(쓰기가 왕복보다 빠르다) 여섯 번째 읽기에서 끝난다.
  {
    const h = await boot({
      log: INIT, exited: false,
      onRead: (n, T) => {
        if (n < 6) T.log += SE;
        else if (n === 6) { T.log += ANSWER + RESULT; T.exited = true; }
      },
    });
    const run = h.first("running");
    ok(run && run.reads === 1, `★R1 도는 턴은 첫 조각 뒤 바로 «도는 중» 이 된다(그때까지 읽기 ${run?.reads ?? "없음"}회) — 되그리기가 쫓으면 끝날 때까지 안 켜진다`);
    ok(h.count("busy", (c) => c.on === true) === 1, "★R1 그동안 입력이 잠긴다 — 안 잠기면 그 사이 보낸 말이 도는 턴과 겹친다");
    ok(h.count("stream") >= 1, `R1 글이 실시간으로 그려진다(stream ${h.count("stream")}건) — 되그리기는 stream_event 를 버린다`);
    ok(h.turnDone() === 1, `★R1 턴이 끝나면 onTurnDone 이 한 번 불린다(${h.turnDone()}) — 안 불리면 리브가 바꾼 프로젝트를 화면이 다시 안 읽는다`);
    ok(h.count("event", (c) => c.type === "assistant") === 1, "R1 최종 답은 한 번만 그린다");
    ok(h.count("busy", (c) => c.on === false) >= 1, "R1 끝나면 입력이 풀린다");
  }

  // R2 끝난 긴 턴 — 조각 상한(64자)을 여러 번 넘는다. 최종 답이 맨 뒤에 있다.
  {
    const log = INIT + SE.repeat(12) + ANSWER + RESULT;
    const h = await boot({ log, exited: true, cap: 64 });
    ok(h.count("event", (c) => c.type === "assistant") === 1, "★R2 끝난 긴 턴의 마지막 답까지 그린다 — 첫 조각만 읽으면 최종 답이 사라진다");
    ok(Math.max(...h.T.froms) === log.length, `R2 파일 끝까지 읽는다(마지막 from ${Math.max(...h.T.froms)} / ${log.length})`);
    ok(!h.first("running") && h.turnDone() === 0, "R2 끝난 턴은 «도는 중» 이 되지 않는다");
  }

  // R3 30분 넘게 멈춘 턴 — 더 쓸 것이 없으니 끝까지 읽어 보여 주고 끝나지 못했다고 말한다.
  {
    const log = INIT + SE.repeat(12) + ANSWER;
    const h = await boot({ log, exited: false, ageMin: 40, cap: 64 });
    ok(h.count("event", (c) => c.type === "assistant") === 1, "R3 멈춘 턴도 끝까지 읽어 그린다");
    ok(h.S.calls.some((c) => c.k === "error" && /끝나지 못했습니다/.test(c.m)), "R3 끝나지 못했다고 말한다");
    ok(!h.first("running"), "R3 멈춘 턴을 «도는 중» 으로 붙잡지 않는다");
  }

  // R4 화면을 떠나면 남은 조각을 더 읽지 않는다 — 두 번째 읽기 도중 destroy.
  {
    const log = INIT + SE.repeat(40) + ANSWER + RESULT;
    const h = await boot({ log, exited: true, cap: 64, onRead: (n, T, from, destroy) => { if (n === 2) destroy(); } });
    ok(h.T.reads === 2, `★R4 떠난 뒤로는 더 읽지 않는다(읽기 ${h.T.reads}회 / 끝까지면 ${Math.ceil(log.length / 64) + 1}회)`);
  }

  // R5 이어 읽다 실패 — 그린 것은 두고 그 자리에 말한다. 첫 요청부터 실패면 자리를 걷는다.
  {
    const log = INIT + ANSWER + SE.repeat(12) + RESULT;
    const h = await boot({ log, exited: true, cap: 64, onRead: (n) => { if (n === 4) throw new Error("502"); } });
    ok(h.count("event", (c) => c.type === "assistant") === 1 && !h.first("work.remove"), "R5 중간 실패에도 이미 그린 이벤트는 남는다");
    ok(h.S.calls.some((c) => c.k === "error" && /끝까지 불러오지 못했습니다/.test(c.m)), "R5 그 자리에 실패를 말한다");
    const h0 = await boot({ log, exited: true, cap: 64, onRead: (n) => { if (n === 1) throw new Error("502"); } });
    ok(!!h0.first("work.remove"), "R5 첫 요청부터 실패면 그 자리를 걷는다(종전과 같다)");
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed`);
