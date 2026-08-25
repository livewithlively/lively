// #1843 — 리브가 온보딩 대화에서 알아낸 것이 **그 사람의 개인 층으로 그대로 실리는가**(renderLivOnboarding).
//  이 함수가 이 기능의 전부다: 화면엔 반영 버튼이 없고(설계), 주입 시점에 합쳐지는 것이 유일한 경로다.
//  그래서 여기서 깨지면 "리브가 물어본 보람이 화면 안에서 끝나던" 종전 상태로 조용히 되돌아간다.
import assert from "node:assert/strict";
import { renderLivOnboarding } from "./publish.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 아무것도 없을 때는 **한 글자도 내지 않는다** — 빈 소제목이 매 세션 첫머리에 깔리면 안 된다. ──
t("빈 입력(null·{}·빈 문자열·빈 배열)은 전부 빈 문자열", () => {
  for (const v of [null, {}, { work: null, answers: [] },
    { work: { asis: "", tobe: "   " }, answers: [] }] as any[]) {
    assert.equal(renderLivOnboarding(v), "", `빈 입력이 새어나옴: ${JSON.stringify(v)}`);
  }
});

t("고른 값도 직접 적은 것도 없는 답은 줄을 만들지 않는다", () => {
  assert.equal(renderLivOnboarding({ answers: [{ key: "k", question: "물음?", choices: [] }] }), "");
});

t("질문·key 가 모두 비면 그 답은 건너뛴다(라벨 없는 줄을 만들지 않는다)", () => {
  assert.equal(renderLivOnboarding({ answers: [{ choices: ["notion"] }] }), "");
});

// ── 실제 데이터 모양(2026-08-21 DB 실측) ──
t("업무 방식 + 답 하나 — 소제목 + 세 줄", () => {
  const out = renderLivOnboarding({
    work: { asis: "회의록 등 업무 기록을 노션에 쌓아 왔음", tobe: "매주 회의록이 라이블리에 자동으로 쌓이길 원함" },
    answers: [{ key: "context_sources", question: "지금까지 일한 내용, 주로 어디에 쌓아 두셨어요?", choices: ["notion"] }],
  });
  assert.equal(out.split("\n")[0], "### 온보딩에서 알려주신 것 (리브와의 대화에서)");
  assert.ok(out.includes("- 지금 하는 일: 회의록 등 업무 기록을 노션에 쌓아 왔음"));
  assert.ok(out.includes("- 이렇게 하고 싶어요: 매주 회의록이 라이블리에 자동으로 쌓이길 원함"));
  assert.ok(out.includes("- 지금까지 일한 내용, 주로 어디에 쌓아 두셨어요?: notion"));
  assert.equal(out.split("\n").length, 4, "소제목 1 + 항목 3");
});

t("업무 방식만 있어도(답 0건) 실린다", () => {
  const out = renderLivOnboarding({ work: { asis: "혼자 기획하고 외주로 만든다" } });
  assert.equal(out.split("\n").length, 2);
  assert.ok(out.includes("- 지금 하는 일: 혼자 기획하고 외주로 만든다"));
});

t("복수 선택 + '그 외' 자유입력이 한 줄에 함께 실린다", () => {
  const out = renderLivOnboarding({
    answers: [{ key: "context_sources", question: "어디에 쌓으세요?", choices: ["notion", "slack"], other: "카카오톡" }],
  });
  assert.ok(out.includes("- 어디에 쌓으세요?: notion · slack · 카카오톡"),
    `합쳐지지 않음:\n${out}`);
});

t("질문 문구가 없으면 key 로 라벨을 대신한다", () => {
  assert.ok(renderLivOnboarding({ answers: [{ key: "ai_usage", choices: ["writing"] }] })
    .includes("- ai_usage: writing"));
});

// ── 매 세션 첫머리에 실리는 줄이다 — 질문이 늘어도 컨텍스트가 무한히 불어나면 안 된다. ──
t("항목은 12줄에서 잘린다(업무 방식 2줄 포함)", () => {
  const answers = Array.from({ length: 40 }, (_, i) => ({ key: `k${i}`, question: `물음${i}`, choices: ["yes"] }));
  const out = renderLivOnboarding({ work: { asis: "가", tobe: "나" }, answers });
  assert.equal(out.split("\n").length, 13, "소제목 1 + 항목 12");
  assert.ok(out.includes("- 물음9: yes"), "앞쪽 답은 남는다");
  assert.ok(!out.includes("- 물음10: yes"), "12줄을 넘는 답은 잘린다");
});

console.log(`\n${pass} passed`);
