// 프로젝트 화면 리브 대화의 시스템 프롬프트 조각(#1757) — 지문이 지켜야 할 것만 고정한다.
//
// | # | 조건 | 기대 |
// |---|---|---|
// | P1 | 언제나 | 프로젝트 번호·이름이 들어 있다(어느 프로젝트의 대화인지 리브가 안다) |
// | P2 | 언제나 | 바꾸기 전 project_get_v6 로 다시 읽으라는 규칙이 있다(사람이 [편집]으로 고쳤을 수 있다) |
// | P3 | 언제나 | 본문 형식(요약 한 줄 + ## 목표/범위/결정/다음 할 일)이 있다 — 리브가 쓴 본문이 화면에서 정돈돼 보이는 근거 |
// | P4 | 이름에 개행·긴 글 | 한 줄로 접히고 잘린다(사람이 지은 자유 텍스트가 지문 구조를 깨지 않는다) |
// | P5 | 빈 이름 | `프로젝트 #<id>` 로 대신한다(「」가 비어 있으면 리브가 이름을 지어낸다) |
// | P6 | 언제나 | 셸·파일을 만지라는 말이 없다(경계는 플래그가 지키지만 지문이 반대로 부추기면 안 된다) |
import { strict as assert } from "node:assert";
import { projectChatPersona } from "./project-chat-prompt.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

t("P1 번호·이름", () => {
  const s = projectChatPersona({ id: 1757, name: "2열 프로젝트 수정" });
  assert.ok(s.includes("#1757"));
  assert.ok(s.includes("「2열 프로젝트 수정」"));
  assert.ok(s.includes("project_get_v6 {id: 1757}"));
});
t("P2 바꾸기 전 다시 읽기", () => {
  assert.ok(/바꾸기 전엔 반드시 다시 읽는다/.test(projectChatPersona({ id: 1, name: "x" })));
});
t("P3 본문 형식", () => {
  const s = projectChatPersona({ id: 1, name: "x" });
  for (const k of ["## 목표", "## 범위", "## 결정", "## 다음 할 일", "한 문장 요약"]) assert.ok(s.includes(k), k);
});
t("P4 이름 한 줄·잘림", () => {
  const s = projectChatPersona({ id: 2, name: "가".repeat(300) + "\n\n줄바꿈 뒤" });
  const line = s.split("\n").find((l) => l.includes("「"))!;
  assert.ok(line.includes("…"), "잘림 표시");
  assert.ok(line.length < 200, `길이 ${line.length}`);
  assert.ok(!s.includes("줄바꿈 뒤"), "개행 뒤 꼬리는 잘려 나간다");
});
t("P5 빈 이름", () => {
  assert.ok(projectChatPersona({ id: 9, name: "   " }).includes("「프로젝트 #9」"));
});
t("P6 셸·파일 부추김 없음", () => {
  const s = projectChatPersona({ id: 1, name: "x" });
  assert.ok(!/Bash|셸을 실행|파일을 고쳐/.test(s));
  assert.ok(/그런 도구는 이 대화에 없다/.test(s));
});

console.log(`\n${pass} passed`);
