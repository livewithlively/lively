// 헤드리스 하네스 선택(#1884) — pickHeadlessHarness 의 엣지 표(순수 함수, 프로브 없음).
//
// 왜 이 테스트가 있나: 헤드리스 잡(증류·분류·관리·agent_headless·delegate_run·세션 AI 이름)은 여태 `claude` 에
//  못박혀 있었다. 매니지드 테넌트에서 **codex 로만** 로그인한 멤버가 파이프라인을 켜면 모든 잡이 자격 없는
//  `claude -p` 로 떠서 무출력 hang(#1101 부류)이 됐다. 선택 규칙은 셋뿐이고 그 순서가 전부다:
//   명시(잡/API) > 의뢰자 로그인 ∩ 헤드리스 가능(둘 이상이면 claude 우선, 아니면 HEADLESS 표 순) > claude(종전 기본).
import { strict as assert } from "node:assert";
import { HEADLESS_KEYS, pickHeadlessHarness } from "./headless-harness.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("표 = HEADLESS 키 — claude 가 첫째, codex 포함, opencode·shell 은 헤드리스 불가라 없다", () => {
  assert.equal(HEADLESS_KEYS[0], "claude");
  assert.ok(HEADLESS_KEYS.includes("codex"));
  assert.ok(HEADLESS_KEYS.indexOf("codex") < HEADLESS_KEYS.indexOf("grok"), "표 순서(codex < grok)가 아래 동률 판정의 근거다");
  assert.ok(!HEADLESS_KEYS.includes("opencode"));
  assert.ok(!HEADLESS_KEYS.includes("shell"));
});

t("명시 유효 → 로그인과 무관하게 그대로", () => {
  assert.equal(pickHeadlessHarness({ explicit: "codex", loggedIn: ["claude"] }), "codex");
  assert.equal(pickHeadlessHarness({ explicit: "claude", loggedIn: ["codex"] }), "claude");
});

t("명시 미지원 → 지원 목록을 담아 던진다(조용히 claude 로 바꾸지 않는다)", () => {
  assert.throws(
    () => pickHeadlessHarness({ explicit: "opencode", loggedIn: [] }),
    (e: Error) => e.message.includes("opencode") && HEADLESS_KEYS.every((k) => e.message.includes(k)),
  );
});

t("빈 문자열·null 명시 = 미지정(자동)", () => {
  assert.equal(pickHeadlessHarness({ explicit: "", loggedIn: ["codex"] }), "codex");
  assert.equal(pickHeadlessHarness({ explicit: null, loggedIn: ["codex"] }), "codex");
  assert.equal(pickHeadlessHarness({ explicit: "  ", loggedIn: ["codex"] }), "codex");
});

t("로그인 없음 → claude(종전 기본 — 무회귀)", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: [] }), "claude");
});

t("codex 만 로그인 → codex(이 과업의 핵심 사례)", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["codex"] }), "codex");
});

t("codex+claude → claude 우선(claude 사용자는 바이트 동일)", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["codex", "claude"] }), "claude");
  assert.equal(pickHeadlessHarness({ loggedIn: ["claude", "codex"] }), "claude");
});

t("grok+codex → codex(HEADLESS 표 순 — 로그인 나열 순이 아니다)", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["grok", "codex"] }), "codex");
  assert.equal(pickHeadlessHarness({ loggedIn: ["codex", "grok"] }), "codex");
});

t("opencode 만 로그인 → claude(헤드리스 불가 하네스는 후보가 아니다)", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["opencode"] }), "claude");
});

t("노드 지원 필터 — claude+codex 로그인인데 노드가 codex 만 띄우면 codex", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["claude", "codex"], nodeSupports: ["codex"] }), "codex");
});

t("노드 지원 [] → 교집합 없음 → claude 폴백", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["claude", "codex"], nodeSupports: [] }), "claude");
});

t("노드 지원 null/미지정 = 필터 없음", () => {
  assert.equal(pickHeadlessHarness({ loggedIn: ["codex"], nodeSupports: null }), "codex");
});

console.log(`headless-harness.test: ${pass} passed`);
