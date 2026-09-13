// #3870 — claude 대화 폴더 이름 규약(claudeProjectsDirName)이 **Claude Code 실제 규약과 같은가**.
//
//  사양(Claude Code 2.1.270 번들 실측): `k(e) = e.replace(/[^a-zA-Z0-9]/g, "-")` · 결과가 200자를 넘으면
//   `${앞 200자}-${해시}` 로 자른다. 즉 **영숫자가 아닌 모든 글자**가 `-` 가 된다.
//  실측 대조(이 박스 ~/.claude/projects): cwd `/home/box_wonjoon-jang/box` 의 대화가 `-home-box-wonjoon-jang-box/` 에 있다
//   — 밑줄(`_`)도 `-` 다. 종전 lively 규약(`/` 와 `.` 만)은 `-home-box_wonjoon-jang-box` 를 가리켜 **없는 폴더**를 봤다.
//  그 결과: 멤버 홈(`/home/box_<slug>/…`) 아래 세션은 훅 보고 경로가 없을 때 대화를 **영영 못 찾았다** — 복원의
//   «대화가 그 기계에 있나» 판정이 거짓 «없다» 가 되고(#3870 빈 피커 수정의 전제를 무너뜨린다), 완전 삭제(#1850)는
//   그 폴더의 대화 파일을 지우지 못한 채 «지웠다» 고 답했다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeProjectsDirName, claudeProjectsDirExact } from "./terminal-transcript.js";
import { claudeIo } from "./harness-io/claude.js";

const UUID = "dd17f75c-f920-4883-ad9a-7cbc2000bd50";

// ── 엣지 표 — 행마다 하나 ──────────────────────────────────────────────────────────
const TABLE: Array<[string, string, string]> = [
  ["특수문자 없는 프로젝트 폴더(종전과 같아야 한다)", "/work/shared/project/3870", "-work-shared-project-3870"],
  ["★ 실측 쌍 — 멤버 홈의 밑줄", "/home/box_wonjoon-jang/box", "-home-box-wonjoon-jang-box"],
  ["★ 갇혔던 세션의 작업 폴더", "/home/box_wonjoon-jang/box/sessions/box-jang-8ee2bf2d", "-home-box-wonjoon-jang-box-sessions-box-jang-8ee2bf2d"],
  ["점(.) — 종전 주석의 예시 그대로", "/Users/lively/.openclaw/workspace/project/657", "-Users-lively--openclaw-workspace-project-657"],
  ["공백", "/tmp/a b", "-tmp-a-b"],
  ["한글(영숫자 아님)", "/home/u/한글", "-home-u---"],
  ["빈 값", "", ""],
];
for (const [what, cwd, want] of TABLE) {
  test(`claudeProjectsDirName — ${what}`, () => {
    assert.equal(claudeProjectsDirName(cwd), want);
  });
}

// ── 경계 — 200자 ────────────────────────────────────────────────────────────────────
test("경계: 인코딩 결과가 정확히 200자면 그대로 쓴다(Claude Code 가 자르지 않는다)", () => {
  const cwd = "/" + "a".repeat(199);
  assert.equal(cwd.length, 200);
  assert.equal(claudeProjectsDirExact(cwd), true);
  assert.equal(claudeProjectsDirName(cwd), "-" + "a".repeat(199));
});

test("경계: 201자면 Claude Code 는 해시 꼬리를 붙인다 — 우리는 그 해시를 재현하지 않으므로 «정확하지 않다» 고 말한다", () => {
  const cwd = "/" + "a".repeat(200);
  assert.equal(claudeProjectsDirExact(cwd), false);
});

// ── 실제 소비자 — 복원·대화창이 쓰는 경로 규약 ─────────────────────────────────────
test("pathFor 가 밑줄 폴더를 Claude Code 가 쓰는 자리로 가리킨다(복원 판정이 보는 바로 그 경로)", () => {
  const got = claudeIo.pathFor!("/home/box_wonjoon-jang/.claude/projects", { cwd: "/home/box_wonjoon-jang/box/sessions/box-jang-8ee2bf2d", convId: UUID });
  assert.equal(got, `/home/box_wonjoon-jang/.claude/projects/-home-box-wonjoon-jang-box-sessions-box-jang-8ee2bf2d/${UUID}.jsonl`);
});

test("pathFor 는 규약으로 정확히 못 짚는 폴더(200자 초과)에 **틀린 경로를 내지 않고 null** 을 준다", () => {
  //  틀린 경로를 내면 stat 이 빈손 → «없다» 로 읽혀 멀쩡한 대화를 버린다. null 이면 호출부가 «규약 없음» 으로 다룬다.
  assert.equal(claudeIo.pathFor!("/r", { cwd: "/" + "a".repeat(200), convId: UUID }), null);
});
