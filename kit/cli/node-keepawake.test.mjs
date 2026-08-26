#!/usr/bin/env node
// 순수 계약 체크 — `lively node` 의 잠자기 표면(#1849). 전 플랫폼에서 돈다(스텁·부작용 없음).
//  ⚠ Windows 분기는 mac/linux CI 에서 한 번도 실행되지 않는다(#1510 §5) → 계약을 여기서 못박는다.
//  실행: node kit/cli/node-keepawake.test.mjs   (npm test 체인에 포함)
import assert from "node:assert/strict";
import { sleepHintLines, forceAwakeArgv, nodeSleepInfoFrom } from "./cmd-node.mjs";

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 상시화 직후 안내 ───────────────────────────────────────────────────────────
t("K1 맥 — 자동 억제와 **뚜껑 닫기 한계**를 둘 다 말한다(한계를 안 말하면 사용자는 왜 아직 끊기는지 모른다)", () => {
  const lines = sleepHintLines("darwin").join("\n");
  assert.ok(lines.includes("자동으로 잠자기를 막습니다"), "무엇이 이미 되고 있는지");
  assert.ok(lines.includes("뚜껑"), "무엇이 안 되는지");
  assert.ok(lines.includes("lively node keepawake"), "무엇을 하면 되는지");
});
t("K2 윈도우 — modern standby 한계와 조치를 말한다", () => {
  const lines = sleepHintLines("win32").join("\n");
  assert.ok(lines.includes("자동으로 절전을 막습니다"));
  assert.ok(/최신 대기|modern standby/.test(lines));
  assert.ok(lines.includes("lively node keepawake"));
});
t("K3 그 외 OS 는 아무 말도 하지 않는다 — 할 말이 없으면 침묵이 정직하다", () => {
  assert.deepEqual(sleepHintLines("linux"), []);
});
t("K4 ★안내는 '화면은 꺼진다'를 명시한다 — 안 그러면 사용자는 화면이 계속 켜질까 봐 이 기능을 끈다", () => {
  for (const p of ["darwin", "win32"]) {
    assert.ok(sleepHintLines(p).join("\n").includes("화면은 꺼집니다"), p);
  }
});

// ── 전역 설정 변경(권한 1회) ───────────────────────────────────────────────────
t("K5 맥 — pmset 으로 전 전원원의 잠자기를 끈다(뚜껑 닫기까지 막는 유일한 방법)", () => {
  const p = forceAwakeArgv("darwin", true);
  assert.equal(p.cmd, "sudo");
  assert.deepEqual(p.args, ["pmset", "-a", "disablesleep", "1"]);
  assert.equal(p.needsAdmin, true, "권한이 필요하다는 사실을 호출부가 미리 말해야 한다");
});
t("K6 맥 — off 는 되돌린다(켜기만 하고 못 끄면 사용자 PC 를 인질로 잡는 셈이다)", () => {
  assert.deepEqual(forceAwakeArgv("darwin", false).args, ["pmset", "-a", "disablesleep", "0"]);
});
t("K7 ★윈도우 — **전원 연결(-ac)만** 바꾼다. 배터리 타임아웃은 건드리지 않는다(계약 ③)", () => {
  const p = forceAwakeArgv("win32", true);
  assert.equal(p.cmd, "powercfg");
  assert.deepEqual(p.args, ["/change", "standby-timeout-ac", "0"]);
  assert.ok(!p.args.some((a) => String(a).includes("-dc")), "배터리 설정을 건드리면 사용자 배터리를 태운다");
});
t("K8 윈도우 — off 는 기본값(30분)으로 되돌린다", () => {
  assert.deepEqual(forceAwakeArgv("win32", false).args, ["/change", "standby-timeout-ac", "30"]);
});
t("K9 그 외 OS 는 null — 지원하지 않는다고 정직하게 말할 수 있어야 한다", () => {
  assert.equal(forceAwakeArgv("linux", true), null);
});

// ── 서버 문구 나르기 ───────────────────────────────────────────────────────────
t("K10 게이트웨이 응답에서 이 노드의 문구를 고른다(문구는 서버가 만든다 — CLI 는 짓지 않는다)", () => {
  const payload = { nodes: [
    { id: "other", link_note: "남의 노드", keep_awake_note: "x" },
    { id: "mine", link_note: "잠자기로 보입니다", keep_awake_note: "붙잡는 중" },
  ] };
  assert.deepEqual(nodeSleepInfoFrom(payload, "mine"), { note: "잠자기로 보입니다", keepAwake: "붙잡는 중" });
});
t("K11 ★못 찾으면 null(모름) — '문제 없음'과 섞지 않는다", () => {
  assert.equal(nodeSleepInfoFrom({ nodes: [] }, "mine"), null);
  assert.equal(nodeSleepInfoFrom(null, "mine"), null);
  assert.equal(nodeSleepInfoFrom({ nodes: [{ id: "mine" }] }, "mine").note, null, "필드가 없으면 note 는 null");
});
t("K12 배열 형태 응답도 받는다(다른 표면이 그렇게 줄 수 있다)", () => {
  assert.equal(nodeSleepInfoFrom([{ id: "a", link_note: "n" }], "a").note, "n");
});

console.log(`\n${pass} checks passed`);
