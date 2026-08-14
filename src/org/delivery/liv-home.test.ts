// 순수 단위 체크(node:assert) — 홈에 무엇을 띄우나(#1631).
// 사양 엣지표 10행(choice × 로그인 × 성숙)을 전수로 옮긴 것. 이 판정이 틀리면 **사람이 홈을 잃는다** —
//  띄우지 말아야 할 리브가 뜨거나(잔소리), 띄워야 할 리브가 안 뜨거나(못 찾음), 못 띄우는데 열려 빈 화면이 된다.
import assert from "node:assert/strict";
import { livHomeMode, type LivHomeInput } from "./liv-home.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const mode = (i: LivHomeInput): string => livHomeMode(i).mode;

// ── 고른 적 없음 — 상태가 정한다 ─────────────────────────────────────────────
t("[1] 미성숙 + 로그인됨 → 리브 (리브가 가장 필요한 상태)", () => {
  assert.equal(mode({ choice: null, claudeLoggedIn: true, mature: false }), "liv");
});

t("[2] 성숙 + 로그인됨 → 대시보드", () => {
  assert.equal(mode({ choice: null, claudeLoggedIn: true, mature: true }), "dashboard");
});

t("[3] 미성숙 + 로그인 안 됨 → 로그인 안내 (리브를 못 띄우는데 열면 빈 화면이다)", () => {
  assert.equal(mode({ choice: null, claudeLoggedIn: false, mature: false }), "login");
});

t("[4] 성숙 + 로그인 안 됨 → 대시보드 (리브를 띄울 상황이 아니니 로그인 안내도 불필요)", () => {
  assert.equal(mode({ choice: null, claudeLoggedIn: false, mature: true }), "dashboard");
});

t("[5] 로그인 여부를 **모름**(null) → 가두지 않는다 = 리브", () => {
  // null 을 false 로 뭉개면 프로브가 못 돈 사람에게 영영 로그인 안내만 뜬다.
  assert.equal(mode({ choice: null, claudeLoggedIn: null, mature: false }), "liv");
});

// ── 사람이 골랐음 — 선택이 상태를 이긴다 ─────────────────────────────────────
t("[6] 대시보드를 골랐으면 미성숙이어도 대시보드 (내가 껐는데 자꾸 뜨면 고장으로 읽힌다)", () => {
  assert.equal(mode({ choice: "dashboard", claudeLoggedIn: true, mature: false }), "dashboard");
});

t("[7] 대시보드를 골랐으면 로그인 안 돼 있어도 대시보드 (로그인은 리브의 전제지 대시보드의 전제가 아니다)", () => {
  assert.equal(mode({ choice: "dashboard", claudeLoggedIn: false, mature: false }), "dashboard");
});

t("[8] 리브를 골랐으면 성숙해도 리브", () => {
  assert.equal(mode({ choice: "liv", claudeLoggedIn: true, mature: true }), "liv");
});

t("[9] 리브를 골랐는데 로그인 안 됨 → 로그인 안내 (고른 대로 열어 봐야 아무것도 못 한다)", () => {
  assert.equal(mode({ choice: "liv", claudeLoggedIn: false, mature: true }), "login");
});

t("[10] 리브를 골랐고 로그인 여부 모름 → 리브 (모름은 차단 사유가 아니다)", () => {
  assert.equal(mode({ choice: "liv", claudeLoggedIn: null, mature: true }), "liv");
});

// ── 배선 — 판정에 이유가 붙는다(화면이 사람에게 설명할 수 있어야 한다) ────────
t("[배선] 모든 조합이 비어 있지 않은 이유를 준다", () => {
  for (const choice of [null, "liv", "dashboard"] as const) {
    for (const claudeLoggedIn of [true, false, null]) {
      for (const mature of [true, false]) {
        const d = livHomeMode({ choice, claudeLoggedIn, mature });
        assert.ok(d.reason.trim().length > 0, `이유 없음: ${JSON.stringify({ choice, claudeLoggedIn, mature })}`);
        assert.ok(/[.!?]$|다\.$/.test(d.reason), `어미가 안 끝맺음: ${d.reason}`); // 화면 문구 규약
        assert.ok(["login", "liv", "dashboard"].includes(d.mode));
      }
    }
  }
});

console.log(`\n${pass} passed`);
