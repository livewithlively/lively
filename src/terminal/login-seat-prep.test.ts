// 화면 안 로그인 전에 그 사람의 서버 계정을 갖춘다(#4970, login-seat-prep.ts) — 가짜 상태로 «기다림» 의 순서를 단언한다.
//  설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16 · 엣지 표 = 아래 S·P 행.
//  격리 리뷰(2026-10-23): 계정(useradd)은 만들기 초반에 생기고 1~2분의 대부분은 그 뒤다 — «계정이 있나» 만 보고 넘어가면 아직 깔리는
//   codex 를 «없음» 으로 만나 로그인이 실패했다. 만드는 중이면 그 일 끝까지 기다려야 한다.
//  실행: npm run build && node dist/terminal/login-seat-prep.test.js
import assert from "node:assert/strict";
import { prepareMemberSeat, awaitMemberSeat, type SeatPrepDeps } from "./login-seat-prep.js";
import type { MemberOsState } from "./profiles.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };
const tick = () => new Promise((r) => setTimeout(r, 5));

/** 가짜 계정 자리 — 상태 · 진행 중인 일 · 만들기 호출 수를 들고 있다. */
function seat(init: { state: MemberOsState; inflight?: Promise<unknown>; ensure?: () => Promise<unknown> }) {
  const box = { state: init.state, inflight: init.inflight as Promise<unknown> | undefined, ensures: 0, cleared: 0 };
  const deps: SeatPrepDeps = {
    state: async () => box.state,
    inflight: () => box.inflight,
    ensure: () => { box.ensures++; return init.ensure ? init.ensure() : Promise.resolve(null); },
    clearFailure: () => { box.cleared++; if (box.state === "failed") box.state = "absent"; },
  };
  return { box, deps };
}
function deferred() { let resolve!: (v: unknown) => void; const p = new Promise((r) => { resolve = r; }); return { p, resolve }; }

await t("S1 ★ 만드는 중이면 그 일이 **끝날 때까지** 기다린다(계정이 이미 있어도) · 만들기를 또 부르지 않는다", async () => {
  const d = deferred();
  const s = seat({ state: "preparing", inflight: d.p });
  let done = false;
  const w = awaitMemberSeat(s.deps).then(() => { done = true; });
  await tick();
  assert.equal(done, false, "★ 만드는 중인데 기다리지 않고 넘어갔다 — 아직 깔리는 codex 를 «없음» 으로 만난다");
  s.box.state = "ready"; s.box.inflight = undefined; d.resolve("box_a");
  await w;
  assert.equal(done, true);
  assert.equal(s.box.ensures, 0, "진행 중인 일이 있는데 만들기를 또 불렀다");
});

await t("S2 아직 없으면 만들고 그 끝을 기다린다", async () => {
  const s = seat({ state: "absent" });
  s.deps.ensure = () => { s.box.ensures++; s.box.state = "ready"; return Promise.resolve("box_a"); };
  await awaitMemberSeat(s.deps);
  assert.equal(s.box.ensures, 1);
});

await t("S3 끝내 못 만들었으면 503 — 공용 자리로 몰래 가지 않는다", async () => {
  for (const after of ["failed", "absent"] as MemberOsState[]) {
    const s = seat({ state: "absent" });
    s.deps.ensure = () => { s.box.ensures++; s.box.state = after; return Promise.resolve(null); };
    await assert.rejects(awaitMemberSeat(s.deps), (e: { status?: number }) => e?.status === 503, `${after}: 503 이 아니다`);
  }
});

await t("S7 ★ 기다림에 상한이 있다 — 넘으면 409 «준비하는 중»(요청이 1~3분 묶이지 않는다) · 만들기는 뒤에서 계속 돈다", async () => {
  const s = seat({ state: "preparing", inflight: new Promise(() => { /* 끝나지 않는 만들기 */ }) });
  const t0 = Date.now();
  await assert.rejects(awaitMemberSeat(s.deps, { waitMs: 60 }), (e: { status?: number; message?: string }) => e?.status === 409 && /준비하고 있어요/.test(String(e?.message)), "409 «준비하는 중» 이 아니다");
  assert.ok(Date.now() - t0 < 2000, "상한을 넘겨 기다렸다");
  assert.equal(s.box.ensures, 0, "만드는 중인데 또 만들었다");
});

await t("S7b 새로 만드는 경우도 상한 안에서만 기다린다", async () => {
  const s = seat({ state: "absent", ensure: () => new Promise(() => {}) });
  await assert.rejects(awaitMemberSeat(s.deps, { waitMs: 60 }), (e: { status?: number }) => e?.status === 409);
  assert.equal(s.box.ensures, 1);
});

await t("S8 방금 실패했어도 로그인 시작(사람이 직접 누름)은 다시 만든다", async () => {
  const s = seat({ state: "failed" });
  s.deps.ensure = () => { s.box.ensures++; s.box.state = "ready"; return Promise.resolve("box_a"); };
  await awaitMemberSeat(s.deps);
  assert.equal(s.box.cleared, 1, "실패 표식을 안 지웠다");
  assert.equal(s.box.ensures, 1, "★ 다시 만들지 않았다 — 5분 동안 로그인이 503 으로 막힌다");
});

await t("S4·S5 격리 박스가 아니거나(none) 이미 다 됐으면(ready) 아무것도 안 한다", async () => {
  for (const st of ["none", "ready"] as MemberOsState[]) {
    const s = seat({ state: st });
    await awaitMemberSeat(s.deps);
    assert.equal(s.box.ensures, 0, `${st}: 만들기를 불렀다`);
  }
});

await t("S6 기다리는 사이 다른 요청이 새로 시작한 일에도 붙는다", async () => {
  const d1 = deferred(); const d2 = deferred();
  const s = seat({ state: "preparing", inflight: d1.p });
  let done = false;
  const w = awaitMemberSeat(s.deps).then(() => { done = true; });
  await tick();
  s.box.inflight = d2.p; d1.resolve(null);   // 첫 일은 끝났지만 곧바로 둘째가 섰다
  await tick();
  assert.equal(done, false, "둘째 일을 안 기다렸다");
  s.box.state = "ready"; s.box.inflight = undefined; d2.resolve("box_a");
  await w;
});

await t("P1 prepare — 없으면 만들기를 **시작만** 하고 곧바로 «preparing»(기다리지 않는다)", async () => {
  const s = seat({ state: "absent", ensure: () => new Promise(() => { /* 끝나지 않는 만들기 */ }) });
  const st = await Promise.race([prepareMemberSeat(s.deps), new Promise((r) => setTimeout(() => r("TIMEOUT"), 200))]);
  assert.equal(st, "preparing", "★ prepare 가 만들기를 기다린다(1~2분 응답이 묶인다)");
  assert.equal(s.box.ensures, 1, "배선 — 만들기를 시작하지 않았다");
});

await t("P2 prepare — 이미 있거나 · 만드는 중이거나 · 필요 없거나 · 방금 실패했으면 그대로 답하고 만들기를 안 부른다", async () => {
  for (const st of ["ready", "preparing", "none", "failed"] as MemberOsState[]) {
    const s = seat({ state: st });
    assert.equal(await prepareMemberSeat(s.deps), st);
    assert.equal(s.box.ensures, 0, `${st}: 만들기를 불렀다(실패 뒤 몇 초마다 1~2분짜리 일을 다시 띄운다)`);
  }
});

await t("P3 prepare retry — 사람이 «다시 해 보기» 를 누르면 실패 표식을 지우고 다시 만든다", async () => {
  const s = seat({ state: "failed", ensure: () => new Promise(() => {}) });
  assert.equal(await prepareMemberSeat(s.deps, { retry: true }), "preparing");
  assert.equal(s.box.cleared, 1);
  assert.equal(s.box.ensures, 1);
});

console.log(`login-seat-prep.test: ${pass} ok`);
