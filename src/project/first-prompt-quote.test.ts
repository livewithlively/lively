// 이어쓰기 조각에서 «사람의 첫 지시 인용» 과 껍데기 안내 문구를 걷어 내는 규칙(withoutFirstPromptQuote) — 2026-10-14 리뷰 D.
//  실행: npm run build && node dist/project/first-prompt-quote.test.js
//
//  왜: 프로젝트 이관(project-bind-nudge 안내)은 껍데기의 본문(첫 지시 원문)을 대상 프로젝트에 이어 붙인다. 그 글은 사람의 지시라
//   서술 형식을 맞출 대상이 아니다. 그렇다고 헤딩이 있다는 이유로 조각 전체를 건너뛰면 헤딩 한 줄로 형식 검사를 비껴간다.
//   그래서 인용(그 절)과 서버가 쓴 안내 문구만 뺀다.
//
//  엣지 표(입력 조합 × 기대):
//   Q1 | 세 껍데기 본문(첫 지시 자동 생성 · 사람이 이름 지음 · 첫 지시 없음)  | 남는 글 없음
//   Q2 | 헤딩 앞 문단 · 다음 `## ` 절                                    | 남는다(인용 절만 빠진다)
//   Q3 | 인용 절 안의 `### ` 소제목                                     | 절이 안 끝난다(같이 빠진다)
//   Q4 | 인용 절 안의 `# ` 헤딩(표식 없음)                               | 절이 끝난다
//   Q5 | 표식 없는 인용 절 안의 코드 펜스 속 `## ` 줄                     | 헤딩이 아니다 — 절이 안 끝난다
//   Q6 | 표식 있는 인용(껍데기 통째) · 지시 안의 `## `                     | 표식까지 빠진다 · 표식 뒤 글은 남는다
//   Q7 | 인용 둘(껍데기 둘을 합침)                                       | 둘 다 빠지고 사이 글은 남는다
//   Q8 | 인용도 안내 문구도 없는 글                                      | 그대로
//   Q9 | CRLF 줄바꿈 껍데기                                             | 남는 글 없음
//   Q10| 표식만 있는 글                                                 | 표식 줄만 빠진다
import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_CREATED_MARK, FIRST_PROMPT_HEADING, humanShellProject, shellProjectFromPrompt, unnamedShellProject, withoutFirstPromptQuote,
} from "./first-prompt-project.js";

const PROMPT = "어제 /Users/bob/x 에서 본 오류를 고쳐줘";

test("Q1 세 껍데기 본문은 남는 글이 없다", () => {
  for (const d of [
    shellProjectFromPrompt(PROMPT)?.description,
    humanShellProject("결제 오류 정리", PROMPT)?.description,
    unnamedShellProject().description,
  ]) {
    assert.ok(d, "전제: 껍데기 본문이 있다");
    assert.equal(withoutFirstPromptQuote(d).trim(), "", d);
  }
});

test("Q2 헤딩 앞 문단과 다음 `## ` 절은 남고 인용 절만 빠진다", () => {
  const md = ["이관한 지시다.", "", FIRST_PROMPT_HEADING, "", PROMPT, "", "## 결정", "", "에이전트가 쓴 결정이다."].join("\n");
  const out = withoutFirstPromptQuote(md);
  assert.ok(out.includes("이관한 지시다."));
  assert.ok(out.includes("## 결정") && out.includes("에이전트가 쓴 결정이다."));
  assert.ok(!out.includes(FIRST_PROMPT_HEADING) && !out.includes("/Users/bob"), out);
});

test("Q3 인용 절 안의 `### ` 소제목은 절을 끝내지 않는다", () => {
  const md = [FIRST_PROMPT_HEADING, "", "지시", "", "### 세부", "", "/Users/bob/세부", "", "## 결정", "에이전트"].join("\n");
  const out = withoutFirstPromptQuote(md);
  assert.ok(!out.includes("/Users/bob") && !out.includes("### 세부"), out);
  assert.ok(out.includes("에이전트"));
});

test("Q4 표식 없는 인용 절은 `# ` 헤딩에서도 끝난다", () => {
  const out = withoutFirstPromptQuote([FIRST_PROMPT_HEADING, "", "지시", "# 다음", "에이전트"].join("\n"));
  assert.ok(out.includes("# 다음") && out.includes("에이전트"));
  assert.ok(!out.includes("지시\n"), out);
});

test("Q5 코드 펜스 속 `## ` 줄은 헤딩이 아니다(표식 없는 인용)", () => {
  const md = [FIRST_PROMPT_HEADING, "", "```sh", "## /Users/bob/run.sh 주석", "```", "", "## 결정", "에이전트"].join("\n");
  const out = withoutFirstPromptQuote(md);
  assert.ok(!out.includes("/Users/bob"), out);
  assert.ok(out.includes("## 결정") && out.includes("에이전트"));
});

test("Q6 껍데기를 통째로 옮긴 인용은 표식까지 빠지고, 지시 안의 `## ` 에 끊기지 않는다", () => {
  const d = String(shellProjectFromPrompt(`이거 해줘\n\n## 단계\n\n${PROMPT}`)?.description);
  const out = withoutFirstPromptQuote(`${d}\n\n## 이관 메모\n\n에이전트가 옮겼다.`);
  assert.ok(!out.includes("/Users/bob") && !out.includes("## 단계") && !out.includes(AUTO_CREATED_MARK), out);
  assert.ok(out.includes("## 이관 메모") && out.includes("에이전트가 옮겼다."));
});

test("Q7 인용 둘 사이의 글은 남는다", () => {
  const a = String(shellProjectFromPrompt("첫째 지시 /Users/bob/1")?.description);
  const b = String(shellProjectFromPrompt("둘째 지시 /Users/bob/2")?.description);
  const out = withoutFirstPromptQuote(`${a}\n\n사이 글이다.\n\n${b}`);
  assert.ok(!out.includes("/Users/bob"), out);
  assert.equal(out.trim(), "사이 글이다.");
});

test("Q8 인용도 안내 문구도 없는 글은 그대로", () => {
  const md = "결론이다.\n\n## 배경\n\n- 하나\n- 둘\n\n> 인용은 남는다\n";
  assert.equal(withoutFirstPromptQuote(md), md);
});

test("Q9 CRLF 줄바꿈 껍데기도 남는 글이 없다", () => {
  const d = String(shellProjectFromPrompt(PROMPT)?.description).replace(/\n/g, "\r\n");
  assert.equal(withoutFirstPromptQuote(d).trim(), "");
});

test("Q10 표식만 있는 글은 표식 줄만 빠진다", () => {
  const out = withoutFirstPromptQuote(`에이전트가 /Users/alice/z 를 봤다.\n\n${AUTO_CREATED_MARK}`);
  assert.equal(out.trim(), "에이전트가 /Users/alice/z 를 봤다.");
});
