// #4084 자동저장 상태기계(web/lib/autosave.ts) + 못 저장한 글의 보관(web/lib/unsaved-text.ts) — 행위로 지킨다.
//
//  왜 따로 시험하나: 격리 리뷰(2026-09-20)가 잡은 결함이 이 자리였다 — 종전 flush 는 도는 저장을 **안 기다리고** 곧바로
//  풀려, 부른 쪽이 «저장됐다» 고 믿고 글칸을 걷은 뒤에야 그 저장이 충돌(409)로 끝났다. 글은 사라진 글칸에만 있었고 안내할
//  화면도 없었다. 화면 코드 안에 있을 땐 값으로 못 재던 것을 순수 모듈로 빼서 잰다(가짜 타이머 · 손으로 푸는 저장 약속).
//
//  엣지 표(행마다 단언 1개 이상 · 전부 값 비교):
//   A1 쓰면 지연 뒤 한 번 저장 · A2 ★flush 는 도는 저장이 끝나야 풀린다 · A3 그 저장이 충돌('pause')이면 flush 뒤 dirty·paused,
//      이후 입력·flush 에도 더 안 보낸다 · A4 도는 동안 더 친 글은 flush 가 한 번 더 저장 · A5 일반 실패는 자동으로 되풀이 안 함
//      (타이머 0) · flush 의 재시도는 한 번 · A6 destroy 뒤엔 새 타이머를 걸지 않는다 · A7 합쳐진 글(kept≠sent)은 adopt 로 넘기고
//      그 글이 새 기준 · A8 바뀐 게 없으면 저장 안 함 · A9 setSaved 가 멈춤을 푼다 · A10 도는 중의 두 번째 저장 요청은 같은 약속
//      (save 1회) · A11 'handled' 실패는 'failed' 상태를 내지 않는다(안내는 부른 쪽이 했다) · A12 ★실패 때 넘기는 글은 live(보낸 글 아님)
//   U1 넣고 읽기 · U2 읽어도 안 지워짐 · U3 지우기 · U4 8개 넘으면 오래된 것부터 버림 · U5 한도(300,000자) 경계: 딱 맞으면 보관,
//      1자 넘으면 **자르지 않고** 거절 · U6 깨진 JSON·배열은 빈 것으로 · U7 저장소가 던져도(용량) 죽지 않는다 · U8 없는 열쇠 지우기 = 무동작
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import assert from "node:assert/strict";

const root = path.resolve(import.meta.dirname, "..");
const out = mkdtempSync(path.join(tmpdir(), "autosave-"));
execFileSync(path.join(root, "node_modules/.bin/tsc"),
  [path.join(root, "web/lib/autosave.ts"), path.join(root, "web/lib/unsaved-text.ts"), "--outDir", out,
   "--module", "esnext", "--target", "es2022", "--skipLibCheck"], { stdio: "inherit" });
const { autoSaveCore } = await import(path.join(out, "autosave.js"));
const { stashUnsaved, peekUnsaved, dropUnsaved } = await import(path.join(out, "unsaved-text.js"));

let pass = 0;
const eq = (got, want, name) => { assert.deepEqual(got, want, name); pass++; console.log(`ok  ${name}`); };
const tick = () => new Promise((r) => setImmediate(r));   // 마이크로태스크·finally 를 다 흘려보낸다

/** 가짜 글칸 + 가짜 타이머 + 손으로 푸는 저장. */
function rig(initial = "원문", onFail) {
  const st = { text: initial, timers: [], saves: [], states: [], adopted: [], savedCb: [] };
  const io = {
    read: () => st.text,
    save: (text) => new Promise((resolve, reject) => st.saves.push({ text, resolve, reject })),
    adopt: (kept, sent) => { st.adopted.push([kept, sent]); if (st.text === sent) st.text = kept; },
    status: (s) => st.states.push(s),
    onSaved: (k) => st.savedCb.push(k),
    onFail, delayMs: 1200,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; st.timers.push(h); return h; },
    clearTimer: (h) => { h.live = false; },
  };
  const core = autoSaveCore(io, initial);
  const live = () => st.timers.filter((t) => t.live);
  const fire = () => { const t = live()[0]; t.live = false; t.fn(); };
  return { st, core, live, fire };
}
const settled = async (p) => { let done = false; p.then(() => { done = true; }); await tick(); return done; };

// ── A1 · A8 ──
{
  const { st, core, live, fire } = rig();
  await core.flush();
  eq(st.saves.length, 0, "A8 바뀐 게 없으면 flush 해도 저장하지 않는다");
  st.text = "고침"; core.input();
  eq([live().length, live()[0].ms, st.saves.length], [1, 1200, 0], "A1 쓰면 지연 타이머 하나가 걸린다(아직 저장 전)");
  st.text = "고침 더"; core.input();
  eq(live().length, 1, "A1b 더 쓰면 타이머를 미룬다(둘이 되지 않는다)");
  fire(); await tick();
  eq(st.saves.map((s) => s.text), ["고침 더"], "A1c 지연 뒤 **지금 글**로 한 번 저장한다");
  st.saves[0].resolve("고침 더"); await tick();
  eq([core.dirty(), st.savedCb, live().length], [false, ["고침 더"], 0], "A1d 저장되면 dirty 가 풀리고 타이머가 남지 않는다");
}

// ── A2 ★flush 는 도는 저장이 끝나야 풀린다 ──
{
  const { st, core, fire } = rig();
  st.text = "A"; core.input(); fire(); await tick();          // 저장 #1 이 가는 중
  const f = core.flush();
  eq([await settled(f), st.saves.length], [false, 1], "A2 ★도는 저장이 안 끝났으면 flush 도 안 끝난다 — 새 저장을 또 보내지도 않는다");
  st.saves[0].resolve("A");
  eq([await settled(f), core.dirty()], [true, false], "A2b 그 저장이 끝나야 flush 가 풀린다");
}

// ── A3 그 저장이 충돌이면 ──
{
  const { st, core, live, fire } = rig("원문", (e) => (e.status === 409 ? "pause" : undefined));
  st.text = "내 글"; core.input(); fire(); await tick();
  const f = core.flush();
  st.saves[0].reject({ status: 409 });
  await f;
  eq([core.dirty(), core.paused(), st.states.includes("failed")], [true, true, false],
    "A3 ★충돌로 끝난 저장 — flush 가 돌아왔을 때 dirty·paused 다(부른 쪽이 «못 남겼다»를 안다). 'pause' 는 failed 안내를 내지 않는다");
  core.input(); await core.flush(); await tick();
  eq([st.saves.length, live().length], [1, 0], "A3b 멈춘 뒤엔 입력·flush 에도 더 보내지 않는다(같은 충돌을 되풀이하지 않는다)");
  core.setSaved("원문"); st.text = "다시"; core.input();
  eq([core.paused(), live().length], [false, 1], "A9 setSaved 가 멈춤을 푼다(최신 글을 다시 불러온 뒤)");
}

// ── A4 도는 동안 더 친 글 ──
{
  const { st, core, fire } = rig();
  st.text = "A"; core.input(); fire(); await tick();
  st.text = "AB";                                              // 저장 #1 이 가는 동안 더 쳤다
  const f = core.flush();
  st.saves[0].resolve("A"); await tick();
  eq(st.saves.map((s) => s.text), ["A", "AB"], "A4 flush 는 도는 저장을 기다린 뒤, 그동안 더 친 글을 한 번 더 저장한다");
  st.saves[1].resolve("AB"); await f;
  eq(core.dirty(), false, "A4b 그러고 나면 남은 글이 없다");
}

// ── A5 일반 실패 ──
{
  const { st, core, live, fire } = rig();
  st.text = "A"; core.input(); fire(); await tick();
  st.saves[0].reject(new Error("네트워크")); await tick();
  eq([st.states.at(-1), live().length, st.saves.length], ["failed", 0, 1], "A5 실패하면 알리고, **스스로 다시 걸지 않는다**(1.2초마다 되풀이 금지)");
  const f = core.flush(); await tick();
  eq(st.saves.length, 2, "A5b flush 는 한 번 더 시도한다");
  st.saves[1].reject(new Error("네트워크")); await f; await tick();
  eq([st.saves.length, live().length, core.dirty()], [2, 0, true], "A5c 그것도 실패하면 거기서 멈춘다(무한 루프 없음) — dirty 로 남는다");
}

// ── A6 destroy ──
{
  const { st, core, live, fire } = rig();
  st.text = "A"; core.input(); fire(); await tick();
  st.text = "AB"; core.destroy();
  st.saves[0].resolve("A"); await tick();
  eq([live().length, st.saves.length], [0, 1], "A6 걷힌 뒤엔 도는 저장이 끝나도 새 타이머를 걸지 않는다(떠난 글칸에 매인 저장이 남지 않는다)");
}

// ── A7 합쳐진 글 ──
{
  const { st, core, fire } = rig();
  st.text = "사람 글"; core.input(); fire(); await tick();
  st.saves[0].resolve("사람 글\n\n세션 꼬리"); await tick();
  eq([st.adopted, st.text, core.dirty()], [[["사람 글\n\n세션 꼬리", "사람 글"]], "사람 글\n\n세션 꼬리", false],
    "A7 서버가 남긴 글이 보낸 것과 다르면 adopt 로 넘기고, 그 글이 새 기준이 된다");
}

// ── A10 · A11 ──
{
  const { st, core, fire } = rig("원문", () => "handled");
  st.text = "A"; core.input(); fire(); await tick();
  core.input(); fire(); await tick();                          // 도는 중에 타이머가 또 터졌다
  eq(st.saves.length, 1, "A10 도는 중의 두 번째 저장 요청은 같은 약속을 받는다(save 는 한 번)");
  st.saves[0].reject(new Error("x")); await tick();
  eq(st.states.includes("failed"), false, "A11 'handled' 로 받은 실패는 failed 상태를 내지 않는다(안내는 부른 쪽이 이미 했다)");
}

// ── A12 ★실패한 순간의 글(live) — 보낸 글(sent)이 아니다 ──
{
  const seen = [];
  const { st, core, fire } = rig("원문", (e, live, sent) => { seen.push({ live, sent }); return "pause"; });
  st.text = "Hello"; core.input(); fire(); await tick();      // "Hello" 를 보내는 중
  st.text = "Hello World";                                     // 그 사이 더 쳤다
  st.saves[0].reject({ status: 409 }); await tick();
  eq(seen, [{ live: "Hello World", sent: "Hello" }],
    "A12 ★실패를 받는 쪽엔 **지금 글칸의 글**이 간다 — 남길 글을 sent 로 잡으면 저장이 가는 동안 친 « World» 가 말없이 빠진다(격리 재리뷰)");
  eq(core.dirty(), true, "A12b 그 글은 여전히 못 남긴 글이다");
}

// ── 못 저장한 글의 보관 ─────────────────────────────────────────────────────────────────
{
  const mem = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => { m.set(k, v); }, m }; };
  const s = mem(); const K = "k";
  eq([stashUnsaved(s, K, "p1:body", "쓰던 글", 1), peekUnsaved(s, K, "p1:body")], [true, "쓰던 글"], "U1 넣은 글을 읽는다");
  eq(peekUnsaved(s, K, "p1:body"), "쓰던 글", "U2 읽어도 지워지지 않는다(되살린 글이 실제로 저장된 뒤에 지운다)");
  dropUnsaved(s, K, "p1:body");
  eq([peekUnsaved(s, K, "p1:body"), peekUnsaved(s, K, "없는것")], [null, null], "U3 지우면 없다 · 없는 열쇠는 null");
  for (let i = 1; i <= 9; i++) stashUnsaved(s, K, "p" + i, "글" + i, i);
  eq([peekUnsaved(s, K, "p1"), peekUnsaved(s, K, "p2"), peekUnsaved(s, K, "p9")], [null, "글2", "글9"], "U4 8개를 넘으면 가장 오래된 것부터 버린다");
  const s2 = mem();
  eq([stashUnsaved(s2, K, "a", "가".repeat(300_000)), peekUnsaved(s2, K, "a")?.length], [true, 300_000], "U5 한도(300,000자)에 딱 맞으면 보관한다");
  eq([stashUnsaved(s2, K, "b", "가".repeat(300_001)), peekUnsaved(s2, K, "b")], [false, null],
    "U5b 1자라도 넘으면 **자르지 않고** 거절한다 — 잘린 본문을 되살려 저장하면 그게 더 큰 사고다");
  const s3 = mem(); s3.m.set(K, "{깨진 JSON");
  eq([peekUnsaved(s3, K, "a"), stashUnsaved(s3, K, "a", "새 글"), peekUnsaved(s3, K, "a")], [null, true, "새 글"], "U6 깨진 JSON 은 빈 것으로 보고 새로 쓴다");
  s3.m.set(K, "[1,2]");
  eq(peekUnsaved(s3, K, "0"), null, "U6b 배열이 들어 있어도 열쇠로 읽지 않는다");
  const full = { getItem: () => null, setItem: () => { throw new Error("QuotaExceeded"); } };
  eq(stashUnsaved(full, K, "a", "글"), true, "U7 저장소가 던져도(용량 초과) 죽지 않는다");
  const s4 = mem(); dropUnsaved(s4, K, "없는것");
  eq(s4.m.size, 0, "U8 없는 열쇠를 지우는 것은 아무것도 쓰지 않는다");
}

console.log(`\n${pass} passed`);
