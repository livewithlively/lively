// 순수 단위 체크 — 노드 오프라인 안내 문구 조립(#1849). 근거는 link-advice.ts 머리말.
// 실행: npm run build && node dist/node/link-advice.test.js
//
// ★ 왜 문구를 테스트하나: 보통은 문구 단언을 피한다(구현 미러링·거짓 실패). 하지만 여기서 검증하는 건
//  **문장이 문장으로 조립되는가** 라는 계약이다 — e2e 에서 조각을 접속사로 이어 "…없습니다이고, …" 가
//  실제로 사용자에게 나갔다. 개수(0·1·여러 개)에 따라 깨지는 자리라 표로 못박는다.
import assert from "node:assert/strict";
import { keepAwakeLine, linkDiagMessage, linkDiagSummary, humanDur, forceAwakeCommand } from "./link-advice.js";
import type { LinkDiagnosis } from "./sleep-pattern.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
/** 문장 나열이 깨지지 않았나 — 종결어미 바로 뒤에 접속조사가 붙으면 안 된다. */
const wellFormed = (s: string): boolean => !/(습니다|입니다)(이고|이며|고,|,)/.test(s);

const sleepDiag: LinkDiagnosis = { suspected: "sleep", cycles: 4, medianUpSec: 60, medianGapSec: 3600 };

t("A1 ★구멍이 여러 개여도 문장으로 나열된다 — 조각을 접속사로 이으면 깨진다(e2e 가 잡은 실제 결함)", () => {
  const line = keepAwakeLine({ active: true, method: "caffeinate", gaps: ["clamshell", "battery"] }, "darwin");
  assert.ok(wellFormed(line), line);
  assert.ok(line.includes("뚜껑"));
  assert.ok(line.includes("배터리"));
});
t("A2 구멍이 하나여도, 없어도 문장이 성립한다", () => {
  for (const gaps of [[], ["battery"] as const]) {
    const line = keepAwakeLine({ active: true, method: "caffeinate", gaps: [...gaps] }, "darwin");
    assert.ok(wellFormed(line), line);
    assert.ok(line.endsWith("."), line);
  }
});
t("A3 ★'모름'(구 번들)과 '안 걸림'을 다른 문장으로 말한다 — 섞으면 사용자를 오도한다", () => {
  const unknown = keepAwakeLine(null, "darwin");
  const off = keepAwakeLine({ active: false, method: null, gaps: [], reason: "unsupported-platform" }, "linux");
  assert.notEqual(unknown, off);
  assert.ok(unknown.includes("보고하지 않습니다"));
  assert.ok(off.includes("걸려 있지 않습니다"));
});
t("A4 실패 사유별로 다른 이유를 댄다(미지원 · 도구 없음 · 기동 실패)", () => {
  const say = (reason: "unsupported-platform" | "tool-missing" | "spawn-failed"): string =>
    keepAwakeLine({ active: false, method: null, gaps: [], reason }, "darwin");
  const all = [say("unsupported-platform"), say("tool-missing"), say("spawn-failed")];
  assert.equal(new Set(all).size, 3, "세 사유가 같은 문장이면 진단이 안 된다");
  for (const s of all) assert.ok(wellFormed(s), s);
});
t("A5 ★판정이 없으면 아무 말도 하지 않는다 — 근거 없이 원인을 지목하지 않는다", () => {
  assert.equal(linkDiagMessage({ suspected: null, cycles: 9, medianUpSec: 10, medianGapSec: 9999 }), null);
  assert.equal(linkDiagMessage(null), null);
  assert.equal(linkDiagMessage(undefined), null);
});
t("A6 잠자기 추정 문장 = 근거 + 추정 + 억제상태 + 조치. 넷이 다 있어야 사람이 움직인다", () => {
  const msg = linkDiagMessage(sleepDiag, { platform: "darwin", keepAwake: { active: true, method: "caffeinate", gaps: ["clamshell"] } });
  assert.ok(msg);
  assert.ok(msg.includes("4번"), "근거(횟수)");
  assert.ok(msg.includes("60초") && msg.includes("60분"), "근거(지속·공백)");
  assert.ok(msg.includes("보입니다"), "단정이 아니라 추정으로 말한다");
  assert.ok(msg.includes("pmset"), "조치(맥)");
  assert.ok(wellFormed(msg), msg);
  // 명령 뒤 조사 — 백틱 명령이 숫자/영문으로 끝나 "…1 를" 같은 어색한 문장이 나왔었다(e2e 가 잡음).
  assert.ok(!/`\s*를 /.test(msg) && !/`\s*을 /.test(msg), `명령 바로 뒤에 조사를 붙이지 않는다: ${msg}`);
});
t("A7 플랫폼별로 조치가 다르다 — 맥에 powercfg 를 시키면 안 된다", () => {
  const mac = linkDiagMessage(sleepDiag, { platform: "darwin" }) ?? "";
  const win = linkDiagMessage(sleepDiag, { platform: "win32" }) ?? "";
  assert.ok(mac.includes("pmset") && !mac.includes("powercfg"));
  assert.ok(win.includes("powercfg") && !win.includes("pmset"));
  assert.equal(forceAwakeCommand("linux"), "", "모르는 OS 엔 명령을 지어내지 않는다");
});
t("A8 플랫폼을 모르면 조치를 지어내지 않고 일반 안내로 끝낸다", () => {
  const msg = linkDiagMessage(sleepDiag, { platform: null }) ?? "";
  assert.ok(!msg.includes("pmset") && !msg.includes("powercfg"));
  assert.ok(msg.includes("절전 설정"));
});
t("A9 시간 표기 — 초·분·시간 경계", () => {
  assert.equal(humanDur(0), "0초");
  assert.equal(humanDur(62), "62초");
  assert.equal(humanDur(89), "89초");
  assert.equal(humanDur(90), "2분");
  assert.equal(humanDur(3600), "60분", "90분 미만은 분으로 — 1시간 0분보다 읽기 쉽다");
  assert.equal(humanDur(5400), "1시간 30분", "90분부터 시간 표기");
  assert.equal(humanDur(-5), "0초", "음수·NaN 은 0으로 — 이상한 값을 화면에 내보내지 않는다");
  assert.equal(humanDur(NaN), "0초");
});

t("A10 ★좁은 자리용 요약 — 짧고, 판정이 없으면 null(전문과 같은 규칙)", () => {
  const short = linkDiagSummary(sleepDiag) ?? "";
  assert.ok(short.length > 0 && short.length < 60, `요약이 길면 좁은 열에서 또 세로로 흐른다: ${short.length}자`);
  assert.ok(short.includes("60초") && short.includes("60분"));
  assert.equal(linkDiagSummary({ suspected: null, cycles: 0, medianUpSec: 0, medianGapSec: 0 }), null);
  assert.equal(linkDiagSummary(null), null);
  const full = linkDiagMessage(sleepDiag, { platform: "darwin" }) ?? "";
  assert.ok(full.length > short.length, "전문이 요약보다 길어야 둘을 나눈 의미가 있다");
});

console.log(`\n${pass} checks passed`);
