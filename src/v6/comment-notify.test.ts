// #4180 댓글·언급 알림 — 순수 판정(누가 받나 · 무슨 문장인가)을 못박는다. DB 배선(notifyTaskComment)은 실 DB 가 필요해 여기선 안 본다.
//
// ── 엣지 표 ──
//  M1 @표시이름 이 있으면 그 사람이 언급된 것이다
//  M2 @아이디 도 언급이다(화면·피드와 같은 규칙)
//  M3 닉네임은 «쓰기로 켠 사람» 만 @닉네임 으로 잡힌다
//  M4 «@장원준님» 처럼 뒤에 글자가 붙어도 언급이다(부분 일치 — 피드 LIKE 와 같은 폭)
//  M5 @ 가 없는 본문은 아무도 언급하지 않는다
//  R1 글쓴이 자신은 받지 않는다(언급돼도)
//  R2 언급이 참여를 이긴다 — 한 사람 한 건
//  R3 참여자 중복은 한 번
//  T1 제목 — 받침 있는 이름은 '이', 없는 이름은 '가', 영문은 '가'
//  T2 «어디» 가 비면 자리를 비우고 문장을 이어 붙이지 않는다
import { strict as assert } from "node:assert";
import test from "node:test";
import { commentRecipients, commentTitle, memberName, mentionedMembers, snippet } from "./comment-notify.js";

const MEMBERS = [
  { id: "jang", display_name: "장원준", nickname: "원준", use_nickname: false },
  { id: "yoon", display_name: "윤상민", nickname: "상민", use_nickname: true },
  { id: "charles", display_name: "Charles", nickname: null, use_nickname: false },
];

test("M1·M2 표시이름·아이디 언급", () => {
  assert.deepEqual(mentionedMembers("@장원준 이거 봐줘", MEMBERS), ["jang"]);
  assert.deepEqual(mentionedMembers("cc @charles", MEMBERS), ["charles"]);
});

test("M3 닉네임은 켠 사람만 — 상민(켬)은 잡히고 원준(끔)은 안 잡힌다", () => {
  assert.deepEqual(mentionedMembers("@상민 확인", MEMBERS), ["yoon"]);
  assert.deepEqual(mentionedMembers("@원준 확인", MEMBERS), []);
});

test("M4 «@장원준님» 도 언급이다 · M5 @ 없으면 아무도", () => {
  assert.deepEqual(mentionedMembers("@장원준님 부탁드려요", MEMBERS), ["jang"]);
  assert.deepEqual(mentionedMembers("장원준 부탁드려요", MEMBERS), []);
});

test("R1 글쓴이는 받지 않는다 — 자기 언급·자기 참여 모두", () => {
  const r = commentRecipients({ author: "jang", mentioned: ["jang", "yoon"], participants: ["jang", "charles"] });
  assert.deepEqual(r, { mention: ["yoon"], comment: ["charles"] });
});

test("R2 언급이 참여를 이긴다 · R3 중복은 한 번", () => {
  const r = commentRecipients({ author: "x", mentioned: ["yoon", "yoon"], participants: ["yoon", "charles", "charles", " "] });
  assert.deepEqual(r, { mention: ["yoon"], comment: ["charles"] });
});

test("T1 주격조사 — 받침/무받침/영문", () => {
  assert.equal(commentTitle("장원준", "9/22 UI 수정", false), "장원준이 «9/22 UI 수정»에 댓글을 남겼어요");
  assert.equal(commentTitle("김하나", "9/22 UI 수정", true), "김하나가 «9/22 UI 수정»에서 나를 언급했어요");
  assert.equal(commentTitle("Charles", "덱", false), "Charles가 «덱»에 댓글을 남겼어요");
});

test("T2 «어디» 가 비면 그 자리를 비운다", () => {
  assert.equal(commentTitle("장원준", "", false), "장원준이 댓글을 남겼어요");
  assert.equal(commentTitle("장원준", "  ", true), "장원준이 나를 언급했어요");
});

test("이름 규칙은 화면(person-name)과 같다 — 켠 사람만 닉네임", () => {
  assert.equal(memberName(MEMBERS[0]), "장원준");
  assert.equal(memberName(MEMBERS[1]), "상민");
  assert.equal(memberName({ id: "ghost" }), "ghost");
});

test("발췌 — 공백을 접고 200자에서 자른다", () => {
  assert.equal(snippet("  두  줄\n댓글 "), "두 줄 댓글");
  const long = snippet("a".repeat(300));
  assert.equal(long.length, 201);
  assert.ok(long.endsWith("…"));
});
