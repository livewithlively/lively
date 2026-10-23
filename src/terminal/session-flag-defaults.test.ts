// 서버가 대신 여는 세션(리브)의 모델·추론강도 = 새 세션 화면의 기본(#4970). 설계: 지식 onboarding-single-flow-connect-in-own-ai-4970 §16 · 엣지 표 = 아래 C·D 행.
//  종전: 리브 세션은 flags 가 비어 그 AI 계정의 CLI 기본으로 떴다 — 무엇으로 도는지 라이블리가 말할 수 없었다.
//  실행: npm run build && node dist/terminal/session-flag-defaults.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { HARNESSES, sessionFlagDefaults, type Harness } from "./catalog.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("C1 claude — 새 세션 화면과 같은 fable · high", () => {
  assert.deepEqual(sessionFlagDefaults("claude"), { "--model": "fable", "--effort": "high" });
});

t("C2 codex — gpt-5.6-sol · medium, 그 모델이 그 강도를 받는다", () => {
  const f = sessionFlagDefaults("codex");
  assert.deepEqual(f, { "--model": "gpt-5.6-sol", "--effort": "medium" });
  const codex = HARNESSES.find((h) => h.key === "codex")!;
  assert.ok(codex.effortsByModel?.[f["--model"]!]?.includes(f["--effort"]!), "모델이 받지 않는 강도를 고르면 createSession 이 400 이다");
});

t("C3 antigravity — 모델 기본이 없으면 싣지 않는다(계정 기본) · 강도만 medium", () => {
  assert.deepEqual(sessionFlagDefaults("antigravity"), { "--effort": "medium" });
});

t("C4 grok — 모델만(grok-4.6) · 강도 기본이 없으면 싣지 않는다", () => {
  assert.deepEqual(sessionFlagDefaults("grok"), { "--model": "grok-4.6" });
});

t("C5·C6 기본을 선언하지 않은 하네스·셸·모르는 하네스는 빈 값", () => {
  assert.deepEqual(sessionFlagDefaults("opencode"), {});
  assert.deepEqual(sessionFlagDefaults("shell"), {});
  assert.deepEqual(sessionFlagDefaults("nope"), {});
});

t("C7 선언값이 choices 밖이면(낡은 모델) 그 플래그를 싣지 않는다 · 고르기가 아닌 플래그도", () => {
  const fake: Harness[] = [{
    key: "x", label: "X", bin: "x", provider: { id: "o", label: "O" },
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "a"], default: "gone" },
      { name: "--effort", label: "강도", desc: "", type: "select", choices: ["", "low"], default: "low" },
      { name: "--fast", label: "빠르게", desc: "", type: "bool", default: "1" },
    ],
  } as Harness];
  assert.deepEqual(sessionFlagDefaults("x", fake), { "--effort": "low" });
});

t("C9 기본 강도가 기본 모델의 허용 밖이면 강도를 싣지 않는다 — 세션 생성 400 으로 리브가 안 열리는 것보다 낫다", () => {
  const fake: Harness[] = [{
    key: "y", label: "Y", bin: "y", provider: { id: "o", label: "O" },
    flags: [
      { name: "--model", label: "모델", desc: "", type: "select", choices: ["", "m1"], default: "m1" },
      { name: "--effort", label: "강도", desc: "", type: "select", choices: ["", "low", "ultra"], default: "ultra" },
    ],
    effortsByModel: { m1: ["low"] },
  } as Harness];
  assert.deepEqual(sessionFlagDefaults("y", fake), { "--model": "m1" });
  const ok: Harness[] = [{ ...fake[0]!, effortsByModel: { m1: ["low", "ultra"] } } as Harness];
  assert.deepEqual(sessionFlagDefaults("y", ok), { "--model": "m1", "--effort": "ultra" }, "허용되는 강도까지 버린다");
});

t("C8 실제 카탈로그 전부 — 돌려준 값이 세션 생성 검증(choices · 모델별 강도)을 통과한다", () => {
  for (const h of HARNESSES) {
    const f = sessionFlagDefaults(h.key);
    for (const [name, v] of Object.entries(f)) {
      const def = h.flags.find((x) => x.name === name);
      assert.ok(def && def.choices?.includes(v), `${h.key} ${name}=${v} 가 허용 목록 밖`);
    }
    const m = f["--model"], e = f["--effort"];
    if (m && e && h.effortsByModel?.[m]) assert.ok(h.effortsByModel[m]!.includes(e), `${h.key} ${m} 는 ${e} 를 안 받는다`);
  }
});

// ── D. 리브 세션이 그 값을 실제로 싣는다(소스 구조 — 세션 생성은 tmux·DB 가 필요하다) ──
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");
const SESSION = code(readFileSync(new URL("../org/liv/session.js", import.meta.url).pathname.replace("/dist/", "/src/").replace(/\.js$/, ".ts"), "utf8"));
t("D 리브 세션은 고른 하네스의 새 세션 기본을 싣는다(빈 flags 로 열지 않는다)", () => {
  const open = SESSION.slice(SESSION.indexOf("export async function openLivSession"), SESSION.indexOf("export function serialByKey"));
  assert.ok(open.length > 100, "openLivSession 을 못 찾았다 — 검사가 헛돈다");
  assert.match(open, /harness, flags: sessionFlagDefaults\(harness\), autoApprove: false,/, "★ 리브 세션이 모델·추론강도를 지정하지 않는다");
  assert.doesNotMatch(open, /flags: \{\}/, "빈 flags 로 연다");
});

console.log(`session-flag-defaults.test: ${pass} ok`);
