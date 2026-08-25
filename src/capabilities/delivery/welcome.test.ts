// 처음 설정(#/welcome)의 순수 판정 — 갈래 key · LLM 답 파싱 · 진행 스트림 읽기 · 자료 세기 (#1813).
// 사양·엣지 표: <스크래치패드>/spec-welcome.md — 표의 22행마다 최소 하나.
// red 입증은 mutation(신규 파일이라 '변경 전 코드'가 없다).
// 실행: npm run build && node dist/capabilities/delivery/welcome.test.js
import assert from "node:assert/strict";
import { drawerKey, parseDrawers, lastAssistantText, tallySources } from "./welcome.js";

let pass = 0, fail = 0;
// 실패해도 멈추지 않는다 — 어느 행이 빨간불인지 **전부** 봐야 red 입증이 된다.
const t = (name: string, fn: () => void): void => {
  try { fn(); pass++; console.log(`ok  ${name}`); }
  catch (e) { fail++; console.log(`not ok  ${name}\n    ${(e as Error).message.split("\n")[0]}`); }
};

// 카테고리 key 규칙(categories.ts KEY_RE 와 같은 모양) — 여기서 만든 key 가 실제로 통과해야 한다.
const KEY_RE = /^[a-z0-9_-]{1,64}$/;

// ── 갈래 이름 → key ─────────────────────────────────────────────────────────

t("① 영문 이름은 슬러그로 떨어진다", () => {
  assert.equal(drawerKey("Weekly Report"), "weekly-report");
  assert.equal(drawerKey("  Contract & Quote  "), "contract-quote");
});

t("② 한글 이름도 key 를 얻고, 같은 이름은 늘 같은 key 다", () => {
  const a = drawerKey("회의록"), b = drawerKey("회의록");
  assert.equal(a, b);
  assert.ok(a.length > 0, "한글 이름이 빈 key 로 떨어지면 카테고리를 못 만든다");
});

t("③ 다른 한글 이름은 다른 key 를 얻는다 — 안 그러면 서랍이 서로를 덮는다", () => {
  assert.notEqual(drawerKey("회의록"), drawerKey("월간 보고"));
  assert.notEqual(drawerKey("계약·견적"), drawerKey("고객 인터뷰"));
});

t("④ 만들어진 key 는 카테고리 규칙을 통과한다", () => {
  for (const n of ["Weekly Report", "회의록", "표·수치", "그 밖의 자료", "A/B 테스트 결과", "   ", "!!!"]) {
    const k = drawerKey(n);
    assert.match(k, KEY_RE, `${n} → ${k}`);
  }
});

// ── LLM 답에서 갈래 뽑기 ────────────────────────────────────────────────────

t("⑤ 코드펜스 안의 배열을 읽는다", () => {
  const out = parseDrawers('앞말\n```json\n[{"name":"회의록","why":"주간회의 12개"}]\n```\n뒷말');
  assert.deepEqual(out, [{ name: "회의록", why: "주간회의 12개" }]);
});

t("⑥ 펜스가 없어도 본문에 박힌 배열을 읽는다", () => {
  assert.deepEqual(parseDrawers('제안: [{"name":"월간 보고"}] 입니다'), [{ name: "월간 보고" }]);
});

t("⑦ {\"drawers\":[…]} 로 감싸 와도 읽는다", () => {
  assert.deepEqual(parseDrawers('```json\n{"drawers":[{"name":"계약·견적"}]}\n```'), [{ name: "계약·견적" }]);
});

t("⑧ 원소가 그냥 문자열이어도 읽는다", () => {
  assert.deepEqual(parseDrawers('["회의록","월간 보고"]'), [{ name: "회의록" }, { name: "월간 보고" }]);
});

t("⑨ 깨졌으면 **빈 배열** — 온보딩 한복판에서 예외를 던지지 않는다", () => {
  for (const bad of ["", "그냥 설명만 했습니다", "```json\n{oops\n```", '```json\n"문자열"\n```',
                     '```json\n{"a":1}\n```', "[[[", "null", "```json\n[]\n```"]) {
    assert.deepEqual(parseDrawers(bad), [], JSON.stringify(bad));
  }
});

t("⑩ 같은 이름은 한 번만 담는다", () => {
  assert.deepEqual(parseDrawers('[{"name":"회의록"},{"name":"회의록"},{"name":" 회의록 "}]'), [{ name: "회의록" }]);
});

t("⑪ 서랍이 열 개를 넘으면 열 개로 자른다", () => {
  const many = JSON.stringify(Array.from({ length: 15 }, (_, i) => ({ name: `갈래${i}` })));
  assert.equal(parseDrawers(many).length, 10);
});

t("⑫ 이름이 공백뿐이면 버린다", () => {
  assert.deepEqual(parseDrawers('[{"name":"   "},{"name":"회의록"},{"name":""}]'), [{ name: "회의록" }]);
});

t("⑬ 설명이 섞여 있어도 배열만 뽑는다", () => {
  const text = "파일을 살펴봤습니다. 아래처럼 나누는 게 좋겠습니다.\n\n```json\n" +
    '[{"name":"회의록","why":"a"},{"name":"그 밖의 자료","why":"b"}]' +
    "\n```\n\n필요하면 더 나눌 수 있습니다.";
  assert.deepEqual(parseDrawers(text).map((d) => d.name), ["회의록", "그 밖의 자료"]);
});

// ── 진행 스트림에서 마지막 AI 말 ────────────────────────────────────────────

t("⑭ assistant 가 여러 번 말하면 **마지막** 것이 답이다", () => {
  const jsonl = [
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "생각 중" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "최종 답" } }),
  ].join("\n");
  assert.equal(lastAssistantText(jsonl), "최종 답");
});

t("⑮ content 가 블록 배열이면 text 블록만 이어 붙인다", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [
      { type: "text", text: "앞" }, { type: "tool_use", name: "x", input: {} }, { type: "text", text: "뒤" },
    ] },
  });
  assert.equal(lastAssistantText(jsonl), "앞\n뒤");
});

t("⑯ 사람 줄과 JSON 이 아닌 줄은 무시한다", () => {
  const jsonl = [
    "그냥 로그 한 줄",
    JSON.stringify({ type: "user", message: { role: "user", content: "사람 말" } }),
    JSON.stringify({ type: "assistant", message: { role: "assistant", content: "AI 말" } }),
    "",
  ].join("\n");
  assert.equal(lastAssistantText(jsonl), "AI 말");
});

t("⑰ assistant 가 하나도 없으면 빈 문자열", () => {
  assert.equal(lastAssistantText(""), "");
  assert.equal(lastAssistantText('{"type":"user","message":{"role":"user","content":"x"}}'), "");
});

// ── 올린 자료 세기 ──────────────────────────────────────────────────────────

t("⑱ kind 로 가른다", () => {
  const out = tallySources([{ kind: "minutes" }, { kind: "minutes" }, { kind: "minutes" }]);
  assert.deepEqual(out.map((x) => [x.name, x.n]), [["회의록", 3]]);
});

t("⑲ kind 가 other 면 **확장자로 한 겹 더** 가른다 — 안 그러면 올린 파일이 전부 한 서랍이다", () => {
  const out = tallySources([
    { kind: "other", title: "매출.xlsx" }, { kind: "other", title: "실적.csv" },
    { kind: "other", title: "기획서.docx" },
  ]);
  const m = new Map(out.map((x) => [x.name, x.n]));
  assert.equal(m.get("표·수치"), 2, `표·수치가 안 갈렸다 — ${JSON.stringify(out)}`);
  assert.equal(m.get("문서"), 1);
  assert.equal(out.length, 2, "한 서랍으로 뭉치면 안 된다");
});

t("⑳ 확장자가 없거나 모르는 것이면 '그 밖의 자료'", () => {
  const out = tallySources([{ kind: "other", title: "README" }, { kind: "other", title: "x.qqqq" }, { kind: "other", title: null }]);
  assert.deepEqual(out.map((x) => [x.name, x.n]), [["그 밖의 자료", 3]]);
});

t("㉑ 많은 것부터, 같으면 이름순으로 정렬한다", () => {
  const out = tallySources([
    { kind: "other", title: "a.docx" }, { kind: "other", title: "b.docx" }, { kind: "other", title: "c.docx" },
    { kind: "other", title: "d.xlsx" },
    { kind: "email" },
  ]);
  assert.deepEqual(out.map((x) => x.name), ["문서", "메일", "표·수치"]);
  assert.equal(out[0]!.n, 3);
});

t("㉒ 올린 게 없으면 빈 배열", () => {
  assert.deepEqual(tallySources([]), []);
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
