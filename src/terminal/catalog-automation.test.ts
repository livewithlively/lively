// 무인 자동화의 모델·추론강도 확정(automationFlags) — 사양 엣지 표를 행마다 고정한다(#4008).
//
// 왜 이 테스트가 있나(실측 2026-09-16, 원준님): 증류가 **페이블로** 돌아 토큰을 태웠다. 설정을 안 해서가
// 아니라, 설정을 **비워 두면 무엇이 되는지 아무도 정하지 않았기** 때문이다 — 빈 model 은 `--model` 자체를
// 생략했고, 그러면 그 CLI 계정의 기본 모델이 뜬다. CLI 기본은 우리가 정하는 값이 아니라 하네스가 올려
// 버리는 값이라(claude → fable), 라이블리는 «비우면 싼 모델» 을 약속한 적이 없는데 사용자는 그렇게 읽었다.
//
// 그래서 못박는 것:
//  ① **아는 하네스에서 빈 값은 «생략» 이 아니다** — 자동화 기본값이 반드시 붙는다(무인 배치의 상한을 우리가 쥔다).
//  ② **하네스가 모르는 모델도 생략이 아니다** — 기본값으로 갈아탄다. 종전엔 harnessFlagArgs 가 조용히 버려
//     다시 CLI 기본(=가장 비싼 모델)으로 떨어졌는데, 그게 정확히 고치려는 그 사고다.
//  ③ **모르는 하네스에서는 반대로 아무것도 안 붙인다** — 없는 모델 이름을 넘기면 하네스가 실행조차 못 한다.
// 사양·엣지 표 전문은 이 변경의 spec.md(#4008).
import { strict as assert } from "node:assert";
import { automationFlags, AUTOMATION_DEFAULTS, HARNESSES } from "./catalog.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 표 1~3행 — «미지정» 의 여러 모양은 전부 같은 뜻이다(기본값으로 채운다) ─────────────
t("1. claude — 아무것도 안 주면 opus/low(계정 기본 fable 로 떨어지지 않는다)", () => {
  assert.deepEqual(automationFlags("claude", {}), { flags: { "--model": "opus", "--effort": "low" }, dropped: [] });
});

t("2. null 과 빈 문자열도 미지정이다", () => {
  assert.deepEqual(automationFlags("claude", { model: null, effort: "" }),
    { flags: { "--model": "opus", "--effort": "low" }, dropped: [] });
});

t("3. 공백만 있는 값도 미지정이다 — «갈아탐»으로 보고하지 않는다(경계)", () => {
  assert.deepEqual(automationFlags("claude", { model: "   " }),
    { flags: { "--model": "opus", "--effort": "low" }, dropped: [] });
});

// ── 표 4~5행 — 유효한 설정은 기본값을 이긴다. 축은 서로 독립이다 ────────────────────
t("4. 그 하네스가 아는 값이면 그대로 나간다", () => {
  assert.deepEqual(automationFlags("claude", { model: "sonnet", effort: "xhigh" }),
    { flags: { "--model": "sonnet", "--effort": "xhigh" }, dropped: [] });
});

t("5. 한 축만 지정하면 그 축만 존중하고 나머지 축을 기본값으로 채운다", () => {
  assert.deepEqual(automationFlags("claude", { model: "haiku" }),
    { flags: { "--model": "haiku", "--effort": "low" }, dropped: [] });
});

// ── 표 6~8행 — 하네스별 자동화 기본값(원준님 2026-09-16 지정) ─────────────────────
t("6. codex — 미지정은 gpt-5.6-sol/medium", () => {
  assert.deepEqual(automationFlags("codex", {}),
    { flags: { "--model": "gpt-5.6-sol", "--effort": "medium" }, dropped: [] });
});

t("7. antigravity(제미나이) — 미지정은 gemini-3.8-flash-high/high", () => {
  assert.deepEqual(automationFlags("antigravity", {}),
    { flags: { "--model": "gemini-3.8-flash-high", "--effort": "high" }, dropped: [] });
});

t("8. grok — 미지정은 grok-4.6/medium", () => {
  assert.deepEqual(automationFlags("grok", {}),
    { flags: { "--model": "grok-4.6", "--effort": "medium" }, dropped: [] });
});

// ── 표 9~10행 — 하네스가 모르는 값은 **버리지 않고 기본값으로 갈아탄다**(이 결함의 핵심) ──
t("9. 하네스를 바꿔 남아 있던 남의 모델 이름은 그 하네스의 기본값으로 대체된다", () => {
  //  codex 로 도는데 설정엔 claude 별칭이 남아 있는 상황 — 하네스를 바꿔도 model 은 남으므로 흔하다.
  //  effort 'low' 는 codex 도 아는 값이라 그대로 존중한다(축 독립).
  assert.deepEqual(automationFlags("codex", { model: "opus", effort: "low" }),
    { flags: { "--model": "gpt-5.6-sol", "--effort": "low" }, dropped: ["--model=opus"] });
});

t("10. 추론강도도 같은 규칙 — antigravity 는 3단계뿐이라 xhigh 는 기본값으로 갈아탄다", () => {
  assert.deepEqual(automationFlags("antigravity", { model: "gemini-3.8-flash-low", effort: "xhigh" }),
    { flags: { "--model": "gemini-3.8-flash-low", "--effort": "high" }, dropped: ["--effort=xhigh"] });
});

// ── 표 11~13행 — **새로 도입한 표(AUTOMATION_DEFAULTS)에 그 하네스가 없을 때** ──────
//  이 셋이 이번 변경이 새로 만든 엣지다. 표를 도입하면 «표에 없는 하네스» 라는 자리가 함께 생기고,
//  거기서까지 기본값을 지어내면 **없는 모델 이름을 넘겨 하네스가 실행조차 못 한다** — 조용한 stall 이다.
t("11. 카탈로그엔 있지만 자동화 기본값이 없는 하네스는 아무 축도 붙이지 않는다", () => {
  assert.deepEqual(automationFlags("opencode", {}), { flags: {}, dropped: [] });
});

t("12. 그 하네스가 받는 값은 여전히 존중하고, 없는 플래그만 갈아탈 기본값 없이 버린다", () => {
  //  opencode 는 --model 은 받지만 --effort 플래그 자체가 없다(카탈로그 실측).
  assert.deepEqual(automationFlags("opencode", { model: "opencode/big-pickle", effort: "high" }),
    { flags: { "--model": "opencode/big-pickle" }, dropped: ["--effort=high"] });
});

t("13. 아예 모르는 하네스는 설정값도 넘기지 않는다(넘기면 실행 자체가 안 된다)", () => {
  assert.deepEqual(automationFlags("nope", { model: "sonnet" }), { flags: {}, dropped: ["--model=sonnet"] });
});

// ── 표 14행 — 기본값 표 자체의 오타 가드 ────────────────────────────────────────
//  기본값에 존재하지 않는 모델 이름이 들어가면 그 하네스의 무인 배치가 **통째로** 죽는다(실행 즉시 실패).
//  위 1~10행은 값을 그대로 적어 두기 때문에 «표와 카탈로그가 함께 틀린» 경우를 못 잡는다 — 그래서 대조한다.
t("14. 모든 자동화 기본값은 그 하네스의 카탈로그 choices 에 실재한다", () => {
  for (const [key, def] of Object.entries(AUTOMATION_DEFAULTS)) {
    const h = HARNESSES.find((x) => x.key === key);
    assert.ok(h, `자동화 기본값에 카탈로그에 없는 하네스가 있다: ${key}`);
    for (const [flag, want] of [["--model", def.model], ["--effort", def.effort]] as const) {
      const choices = h.flags.find((f) => f.name === flag)?.choices;
      assert.ok(choices?.includes(want), `${key} 의 ${flag} 기본값 '${want}' 이(가) 카탈로그 choices 에 없다`);
    }
  }
});

console.log(`terminal/catalog-automation.test OK (${pass})`);
