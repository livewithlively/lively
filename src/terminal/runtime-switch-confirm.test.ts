// 순수 단위 + 가짜 exec 드라이브 체크(node:assert) — 전환 확인창 눌러 주기(#4772).
//  실측 화면(claude 2.1.300, tmux) 꼬리를 그대로 옮겨 판정을 못박는다. spec.md 엣지 표의 모든 행 = 시나리오.
import assert from "node:assert/strict";
import {
  runtimeSwitchAction,
  confirmRuntimeSwitch,
  type SwitchExec,
} from "./runtime-switch-confirm.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> | void => {
  const done = (): void => { pass++; console.log(`ok  ${name}`); };
  const r = fn();
  return r instanceof Promise ? r.then(done) : done();
};

// ── 실측 꼬리 ────────────────────────────────────────────────────────────────────
const MODEL_DIALOG = [
  "✻ Sautéed for 1s · done 6:02 PM",
  "▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔",
  "   Switch model?",
  "   Your next response will be slower and use more tokens",
  "",
  "   This conversation is cached for the current model. Switching to Opus 5.5 means the full history gets re-read on",
  "   your next message.",
  "",
  "   ❯ 1. Yes, switch to Opus 5.5",
  "     2. No, go back",
].join("\n");

const EFFORT_DIALOG = [
  "   Change effort level?",
  "   Your next response will be slower and use more tokens",
  "",
  "   This conversation is cached for the current effort level. Switching to medium means the full history gets re-read",
  "   on your next message.",
  "",
  "   ❯ 1. Yes, switch to medium",
  "     2. No, go back",
].join("\n");

const IDLE_WITH_DRAFT = [
  "❯ /model opus",
  "  ⎿  Set model to Opus 5.5 and saved as your default for new sessions",
  "                                                                       Draft restored",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ 캐시 따뜻할 때 초안",
  "────────────────────────────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

const PROCESSING = [
  "✻ Baked for 1s · done 5:47 PM",
  "────────────────────────────────────────────────────────────────────────────────",
  "❯ /model opus",
  "────────────────────────────────────────────────────────────────────────────────",
].join("\n");

// 기본이 «No» 인 가상의 미래 판 — ❯ 가 2번 줄에. 블라인드 Yes 금지.
const DIALOG_NO_DEFAULT = [
  "   Switch model?",
  "   This conversation is cached for the current model.",
  "     1. Yes, switch to Opus 5.5",
  "   ❯ 2. No, go back",
].join("\n");

// 스크롤백에 지난 전환 흔적이 있어도, 지금 아이들이면 done(초안 제출 방지). 꼬리 16줄 밖으로 밀어낸다.
const STALE_THEN_IDLE = [
  "❯ /model sonnet",
  "  ⎿  Set model to Sonnet 5.5 and saved as your default for new sessions",
  ...Array.from({ length: 14 }, (_, i) => `   line ${i}`),
  "❯ 지금 치던 글",
  "  ⏵⏵ auto mode on (shift+tab to cycle)",
].join("\n");

async function main(): Promise<void> {
  // ── runtimeSwitchAction (spec 엣지 표 7행) ──
  await t("모델 확인창 → confirm", () => assert.equal(runtimeSwitchAction(MODEL_DIALOG), "confirm"));
  await t("추론강도 확인창 → confirm", () => assert.equal(runtimeSwitchAction(EFFORT_DIALOG), "confirm"));
  await t("입력창 복귀(초안 복원) → done", () => assert.equal(runtimeSwitchAction(IDLE_WITH_DRAFT), "done"));
  await t("처리 중(스피너·명령만) → wait", () => assert.equal(runtimeSwitchAction(PROCESSING), "wait"));
  await t("기본이 No 인 창 → confirm 아님(안전)", () => assert.notEqual(runtimeSwitchAction(DIALOG_NO_DEFAULT), "confirm"));
  await t("스크롤백에 지난 전환, 지금 아이들 → done", () => assert.equal(runtimeSwitchAction(STALE_THEN_IDLE), "done"));
  await t("빈 화면 → wait", () => assert.equal(runtimeSwitchAction(""), "wait"));

  const fast = { initialMs: 0, pollMs: 0, maxPolls: 8 };
  const clock = { sleep: async (): Promise<void> => undefined };

  // ── confirmRuntimeSwitch (spec 폴링 표 6행) ──
  await t("확인창 → Enter 한 번 · confirmed", async () => {
    let enters = 0;
    const exec: SwitchExec = {
      peek: async () => ({ ok: true, pane: MODEL_DIALOG }),
      enter: async () => { enters++; },
    };
    const r = await confirmRuntimeSwitch(exec, clock, fast);
    assert.equal(r, "confirmed");
    assert.equal(enters, 1, "정확히 한 번만 Enter");
  });

  await t("입력창 복귀 → Enter 안 누름 · none", async () => {
    let enters = 0;
    const exec: SwitchExec = {
      peek: async () => ({ ok: true, pane: IDLE_WITH_DRAFT }),
      enter: async () => { enters++; },
    };
    const r = await confirmRuntimeSwitch(exec, clock, fast);
    assert.equal(r, "none");
    assert.equal(enters, 0, "아이들엔 Enter 금지(복원된 초안이 나가면 안 됨)");
  });

  await t("wait 몇 번 뒤 창 → confirmed", async () => {
    const frames = [PROCESSING, PROCESSING, MODEL_DIALOG];
    let i = 0; let enters = 0;
    const exec: SwitchExec = {
      peek: async () => ({ ok: true, pane: frames[Math.min(i++, frames.length - 1)] }),
      enter: async () => { enters++; },
    };
    const r = await confirmRuntimeSwitch(exec, clock, fast);
    assert.equal(r, "confirmed");
    assert.equal(enters, 1);
  });

  await t("peek 실패(ok:false) → unknown · Enter 안 누름", async () => {
    let enters = 0;
    const exec: SwitchExec = {
      peek: async () => ({ ok: false }),
      enter: async () => { enters++; },
    };
    const r = await confirmRuntimeSwitch(exec, clock, fast);
    assert.equal(r, "unknown");
    assert.equal(enters, 0);
  });

  await t("peek 가 던져도 삼키고 unknown", async () => {
    const exec: SwitchExec = {
      peek: async () => { throw new Error("node-unsupported-op:outboxStep"); },
      enter: async () => { throw new Error("should not reach"); },
    };
    const r = await confirmRuntimeSwitch(exec, clock, fast);
    assert.equal(r, "unknown");
  });

  await t("계속 처리 중 → 상한에서 unknown · peek maxPolls 회", async () => {
    let peeks = 0;
    const exec: SwitchExec = {
      peek: async () => { peeks++; return { ok: true, pane: PROCESSING }; },
      enter: async () => {},
    };
    const r = await confirmRuntimeSwitch(exec, clock, { initialMs: 0, pollMs: 0, maxPolls: 5 });
    assert.equal(r, "unknown");
    assert.equal(peeks, 5, "maxPolls 만큼만 본다");
  });

  console.log(`\n${pass} passed`);
}

await main();
