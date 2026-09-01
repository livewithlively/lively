// 위탁 플래그 → 하네스 argv 조립(harnessFlagArgs) — 사양 엣지 표를 행마다 고정한다.
//
// 왜 이 테스트가 있나: 하네스마다 **argv 문법이 다른데** 위탁 경로는 플래그 맵을 이름 그대로 펼치고 있었다.
// codex 는 추론강도를 일반 플래그로 받지 않는다 — 실측(`codex exec --help`, CLI 0.149.1)상 `-m/--model` 은
// 있고 `--effort` 는 **없다**(대신 `-c/--config key=value`). 세션 경로(terminal/sessions.ts)는 이 번역을
// 하고 있었는데 위탁 경로에만 빠져 있었다. 그래서 codex 로 뜬 위탁은 `codex exec --json --effort high` 로
// 실행돼 `unexpected argument '--effort'` 로 죽는다 — 그것도 무증상에 가까운 방식으로: 하네스가 실행조차
// 안 되니 stream.jsonl 이 0줄이고, 배치 seen 롤백 때문에 같은 프롬프트가 영원히 재시도된다(진행 0).
// 증류기·분류기에 effort 를 박은 뒤부터 codex 로그인 의뢰자의 배치가 전부 이 자리에서 죽으므로,
// **«codex argv 에 --effort 문자열이 0건»** 을 회귀 가드로 못박는다.
import { strict as assert } from "node:assert";
import { harnessFlagArgs } from "./tasks.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 표 1행 — claude 기준선(번역 대상이 아니다) ────────────────────────────────────
t("1. claude — 이름 그대로 편다", () => {
  assert.deepEqual(harnessFlagArgs("claude", { "--model": "sonnet", "--effort": "high" }),
    ["--model", "sonnet", "--effort", "high"]);
});

// ── 표 2·3·4행 — codex 번역 ──────────────────────────────────────────────────────
t("2. codex — effort 는 --config 로 번역되고, 모델 이름은 번역하지 않는다", () => {
  assert.deepEqual(harnessFlagArgs("codex", { "--model": "gpt-5.6-terra", "--effort": "high" }),
    ["--model", "gpt-5.6-terra", "--config", "model_reasoning_effort=high"]);
});

t("3. codex — 모델 없이 effort 만 줘도 번역된다", () => {
  assert.deepEqual(harnessFlagArgs("codex", { "--effort": "high" }),
    ["--config", "model_reasoning_effort=high"]);
});

t("4. ★ codex — 허용 추론강도 전부가 번역되고 argv 에 --effort 가 0건이다(즉사 회귀 가드)", () => {
  const all = ["low", "medium", "high", "xhigh", "max", "ultra"];   // ultra 는 codex 표에만 있는 경계값
  for (const v of all) {
    const argv = harnessFlagArgs("codex", { "--effort": v });
    assert.deepEqual(argv, ["--config", `model_reasoning_effort=${v}`], `codex effort=${v}`);
    assert.equal(argv.includes("--effort"), false, `codex 는 --effort 를 받지 않는다(${v})`);
  }
  // 배선 확인 — 위 루프가 정말 무언가를 관측했나(전부 버려져 vacuous 로 통과하는 형태를 막는다).
  assert.equal(harnessFlagArgs("codex", { "--effort": "high" }).length, 2);
});

// ── 표 5·6행 — 번역이 codex 밖으로 새지 않는다 ────────────────────────────────────
t("5. antigravity — 자기 표의 --effort 를 그대로 받는다", () => {
  assert.deepEqual(harnessFlagArgs("antigravity", { "--model": "claude-sonnet-4-6", "--effort": "high" }),
    ["--model", "claude-sonnet-4-6", "--effort", "high"]);
});

t("6. grok — 자기 표의 --effort 를 그대로 받는다", () => {
  assert.deepEqual(harnessFlagArgs("grok", { "--model": "grok-4.6", "--effort": "high" }),
    ["--model", "grok-4.6", "--effort", "high"]);
});

// ── 표 7·8행 — 표로 먼저 거르고, 그 다음이 번역이다 ───────────────────────────────
t("7. codex — claude 표의 모델 이름('sonnet')은 붙지 않는다", () => {
  assert.deepEqual(harnessFlagArgs("codex", { "--model": "sonnet" }), []);
});

t("8. codex — 표 밖 추론강도는 번역하지 않고 버린다(검증이 번역보다 먼저)", () => {
  assert.deepEqual(harnessFlagArgs("codex", { "--effort": "bogus" }), []);
});

// ── 표 9·10행 — 하네스마다 추론강도 표가 다르다(경계값) ───────────────────────────
t("9. claude — 'ultra' 는 claude 표에 없어 버려진다", () => {
  assert.deepEqual(harnessFlagArgs("claude", { "--effort": "ultra" }), []);
});

t("10. antigravity — 표가 3단(low·medium·high)이라 'xhigh' 는 버려진다(모델은 통과)", () => {
  assert.deepEqual(harnessFlagArgs("antigravity", { "--model": "claude-sonnet-4-6", "--effort": "xhigh" }),
    ["--model", "claude-sonnet-4-6"]);
});

// ── 표 11·12행 — 빈 입력·부재·모르는 하네스 ──────────────────────────────────────
t("11. 빈 값·모르는 플래그·빈 맵·인자 부재는 아무것도 만들지 않는다", () => {
  assert.deepEqual(harnessFlagArgs("claude", { "--effort": "" }), []);
  assert.deepEqual(harnessFlagArgs("claude", { "--dangerously-skip-permissions": "1" }), []);
  assert.deepEqual(harnessFlagArgs("claude", {}), []);
  assert.deepEqual(harnessFlagArgs("claude"), []);
});

t("12. 모르는 하네스는 표가 없어 전부 버린다", () => {
  assert.deepEqual(harnessFlagArgs("nope", { "--model": "sonnet", "--effort": "high" }), []);
});

console.log(`node/task-flags.test OK (${pass})`);
