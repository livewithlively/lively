// 이름짓기 안내 훅의 자격 판정 (#1979) — 이 규칙이 틀렸을 때 나는 일:
//  🔴 "ㄱㄱ"·"응"·"/clear" 같은 말에도 안내가 뜨면, 세션이 그걸로 이름을 지어 **아무 뜻 없는 이름이 굳는다**
//     (걸쇠 때문에 한 번 굳으면 에이전트는 다시 못 고친다 — 사람이 손으로 고쳐야 한다).
//  ⚠ 자격 규칙은 project-auto-bind 와 **같은 값**이어야 한다(12자·`/`·`!`·`<`). 갈리면 같은 지시에 대해
//     프로젝트는 생기는데 이름은 안 지어지는(또는 반대) 어긋남이 난다.
//  실행: node kit/hooks/session-name-ask.test.mjs
import assert from "node:assert/strict";
import { namingPromptOk } from "./examples/session-name-ask.org-hook.mjs";

let pass = 0;
const ok = (name) => { pass++; console.log(`ok  ${name}`); };

// 표 D — 입력 × 기대. 행 하나가 곧 못 잡는 버그다.
const TABLE = [
  ["앱 16 에서 한글이 다 분해돼서 보입니다", true,  "통상 — 실사용자 첫 지시(#1957 의 그 문장)"],
  ["가".repeat(12),                      true,  "★경계 — 정확히 12자는 통과"],
  ["가".repeat(11),                      false, "★경계 — 11자는 이름이 될 수 없다"],
  ["ㄱㄱ",                                false, "너무 짧다"],
  ["계속",                                false, "세션이 무엇인지 말해주지 않는다"],
  ["",                                    false, "빈 프롬프트"],
  ["   \n  ",                             false, "공백뿐"],
  ["/clear 를 하고 다시 시작해 줘",          false, "슬래시 커맨드 — 사람의 실질 지시가 아니다"],
  ["!ls -la 를 실행해서 결과를 보여줘",       false, "뱅 커맨드"],
  ["<system-reminder>주입된 맥락입니다</system-reminder>", false, "하네스 주입물 — 사람이 친 말이 아니다"],
];
for (const [input, want, why] of TABLE) {
  assert.equal(namingPromptOk(input), want, `namingPromptOk(${JSON.stringify(input).slice(0, 40)}) = ${!want} — ${why}`);
}
ok(`자격 표 ${TABLE.length}행 — 12자 경계 · 슬래시/뱅/주입물 배제`);

// null·undefined 도 죽지 않는다(훅은 무엇이 오든 exit 0 이어야 한다).
assert.equal(namingPromptOk(null), false);
assert.equal(namingPromptOk(undefined), false);
ok("null·undefined 에도 던지지 않고 false");

// 배선 확인 — 표가 참·거짓을 둘 다 만든다(한쪽으로만 나오면 아무것도 안 가르는 것이다).
{
  const trues = TABLE.filter(([i]) => namingPromptOk(i)).length;
  assert.ok(trues > 0 && trues < TABLE.length, `표가 한쪽으로만 나온다(true ${trues}/${TABLE.length})`);
  ok("배선 확인 — 표가 통과/배제를 실제로 둘 다 만든다");
}

console.log(`\n${pass} passed`);
