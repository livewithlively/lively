// 처음 설정(#/welcome)의 순수 판정 — 갈래 key · LLM 답 파싱 · 진행 스트림 읽기 · 자료 세기 (#1813).
// 사양·엣지 표: <스크래치패드>/spec-welcome.md — 표의 22행마다 최소 하나.
// red 입증은 mutation(신규 파일이라 '변경 전 코드'가 없다).
// 실행: npm run build && node dist/capabilities/delivery/welcome.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drawerKey, parseDrawers, lastAssistantText, tallySources, repeatedForms, analyzePrompt } from "./welcome.js";

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


// ㉓ 실측에서 잡힌 것 — 온보딩 업로드는 kind='local_file' 로 들어온다(2026-08-26, 프리뷰에서 실제로 올려 봄).
//    'other' 만 확장자로 가르면 **올린 파일이 전부 한 서랍**이 된다. 파일류는 전부 확장자로 가른다.
t("㉓ 업로드는 kind=local_file 로 온다 — 이것도 확장자로 갈라야 한다", () => {
  const out = tallySources([
    { kind: "local_file", title: "주간회의_2026-08-4주.md" },
    { kind: "local_file", title: "월간_매출.csv" },
    { kind: "local_file", title: "매출.xlsx" },
  ]);
  const m = new Map(out.map((x) => [x.name, x.n]));
  assert.equal(m.get("표·수치"), 2, `local_file 이 확장자로 안 갈렸다 — ${JSON.stringify(out)}`);
  assert.equal(m.get("문서"), 1);
});

t("㉔ 모르는 kind 도 파일류로 보고 확장자로 가른다 — 새 kind 가 생겨도 한 서랍에 뭉치지 않는다", () => {
  const out = tallySources([{ kind: "brand_new_kind", title: "a.docx" }, { kind: "brand_new_kind", title: "b.csv" }]);
  assert.deepEqual(out.map((x) => x.name).sort(), ["문서", "표·수치"]);
});

t("㉕ 이름 있는 kind 는 그대로 둔다 — 확장자로 덮어쓰지 않는다", () => {
  const out = tallySources([{ kind: "slack", title: "무엇.csv" }, { kind: "email", title: "메일.docx" }]);
  assert.deepEqual(out.map((x) => x.name).sort(), ["메일", "슬랙"]);
});

// ── 같은 꼴 이름 찾기 ───────────────────────────────────────────────────────
//  이 판정이 곧 온보딩이 "같은 양식 문서가 여러 달치 있네요" 라고 말할 **근거**다.
//  근거 없이 말하면 그건 사람의 자료를 지어내는 것이다.

t("㉖ 날짜·번호만 다른 이름을 한 묶음으로 본다", () => {
  const g = repeatedForms(["주간회의_2026-08-1주.md", "주간회의_2026-08-2주.md", "주간회의_2026-08-3주.md"]);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.names.length, 3);
});

t("㉗ 확장자가 달라도 같은 꼴이면 묶는다", () => {
  const g = repeatedForms(["월간보고 1.docx", "월간보고 2.pdf"]);
  assert.equal(g.length, 1);
  assert.equal(g[0]!.names.length, 2);
});

t("㉘ 하나뿐인 이름은 묶음이 아니다 — 근거가 없으면 말하지 않는다", () => {
  assert.deepEqual(repeatedForms(["계약서.pdf", "제안서.docx", "사진.png"]), []);
  assert.deepEqual(repeatedForms([]), []);
});

t("㉙ 숫자만 있는 이름은 '같은 양식 문서'가 아니다 — 1.pdf·2.pdf 를 그렇게 부르면 지어낸 관찰이다", () => {
  assert.deepEqual(repeatedForms(["1.pdf", "2.pdf", "3.pdf"]), []);
  assert.deepEqual(repeatedForms(["2026-08-01.png", "2026-08-02.png"]), []);
});

t("㉚ 구분자가 달라도(밑줄·하이픈·공백) 같은 꼴로 본다", () => {
  const g = repeatedForms(["매출_보고_1.xlsx", "매출-보고-2.xlsx", "매출 보고 3.xlsx"]);
  assert.equal(g.length, 1, JSON.stringify(g));
  assert.equal(g[0]!.names.length, 3);
});

t("㉛ 묶음이 여럿이면 큰 것부터", () => {
  const g = repeatedForms(["A 1.md", "A 2.md", "A 3.md", "B 1.md", "B 2.md"]);
  assert.deepEqual(g.map((x) => x.names.length), [3, 2]);
});

// ── 프롬프트 비용 ───────────────────────────────────────────────────────────
//  실측(2026-08-26): 파일 이름 200개(21KB)를 그대로 넣었더니 온보딩 한 번에 $1.22 가 나갔다.

t("㉜ 프롬프트에 넣는 파일 이름은 120개로 자르고, 자른 사실을 밝힌다", () => {
  const many = Array.from({ length: 300 }, (_, i) => `파일_${i}.md`);
  const p = analyzePrompt(many, null);
  const lines = p.split("\n").filter((l) => l.startsWith("- 파일_"));
  assert.equal(lines.length, 120, `${lines.length}개가 들어갔다`);
  assert.match(p, /그 밖에 180건 더 있습니다/);
});

t("㉝ 긴 이름은 잘라서 넣는다 — 이름 하나가 프롬프트를 먹지 않게", () => {
  const long = "가".repeat(300) + ".md";
  const p = analyzePrompt([long], null);
  const line = p.split("\n").find((l) => l.startsWith("- 가"));   // 규칙 줄도 "- " 로 시작한다 — 파일 줄만 고른다
  assert.ok(line!.length < 120, `안 잘렸다(${line!.length}자)`);
  assert.match(line!, /…$/);
});

t("㉞ 파일이 적으면 자르지 않고 '더 있습니다' 도 안 붙인다", () => {
  const p = analyzePrompt(["a.md", "b.csv"], "제품·기획");
  assert.match(p, /- a\.md/);
  assert.match(p, /- b\.csv/);
  assert.doesNotMatch(p, /더 있습니다/);
  assert.match(p, /이 사람이 하는 일: 제품·기획/);
});

// ── 자격 리스 배선 ──────────────────────────────────────────────────────────
//  이 셋은 **소스를 읽어** 계약을 못박는다. 흔치 않은 형태지만 여기서는 그게 맞다:
//   리스가 안 붙어도 **아무 오류가 안 난다**(#1289 — 등록해도 영영 안 붙던 결함이 last_used_at
//   null 로만 드러났다). 격리 컨테이너에선 토큰 없이 띄우면 fast-fail 이 아니라 hang 이라(#1014·#1101)
//   증상은 "5분 뒤 무출력 사망"이다. 런타임 테스트로 잡으려면 DB·컨테이너·벤더 인증이 다 필요하다.
//   그래서 **부르는가·넘기는가**를 정적으로 잰다. 리팩터가 이 줄을 지우면 여기서 걸린다.
const SRC = readFileSync(new URL("./welcome.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

t("㉟ 판정 기준은 **로그인한 하네스**다 — setup-token 유무가 아니다", () => {
  // 매니지드에서 사람은 웹 터미널에서 CLI 를 띄워 로그인하고, 자격은 자기 프로필에 남는다.
  //  헤드리스는 그 프로필로 폴백한다(tasks.ts). 리스로만 판정하면 **이미 로그인한 사람을 막는다**.
  assert.match(SRC, /memberLoggedInHarnessesAny\(userId\)/,
    "프로필 로그인을 안 본다 — 웹 터미널에서 로그인한 사람이 «AI 안 이었음» 으로 막힌다");
  assert.match(SRC, /ai_ready: aiHarnesses\.length > 0/, "조회의 ai_ready 가 로그인 기준이 아니다");
  // 헤드리스로 못 돌리는 하네스를 세면 안 된다 — 로그인은 했는데 분석은 안 도는 자리가 생긴다.
  assert.match(SRC, /HEADLESS_KEYS\.includes\(k\)/, "헤드리스 규약을 아는 하네스로 거르지 않는다");
});

t("㊱ 하네스를 claude 로 박지 않는다 — codex 만 로그인한 사람이 hang 하지 않게", () => {
  // #1884 가 고친 사고: codex 로만 로그인한 멤버의 잡이 전부 자격 없는 `claude -p` 로 떠서
  //  무출력 hang → stall 종결이 됐다. 같은 실수를 여기서 되풀이하지 않는다.
  const spawn = SRC.slice(SRC.indexOf("await spawnTaskSession({"));
  assert.doesNotMatch(spawn.slice(0, 700), /harness: "claude"/,
    "하네스가 claude 로 박혀 있다 — codex 사용자의 분석이 무출력으로 죽는다");
  assert.match(SRC, /resolveHeadlessHarness\(userId\)/, "크론·위탁과 같은 하네스 선택 함수를 쓰지 않는다");
  // claude 전용 플래그를 다른 하네스에 실으면 기동이 깨진다.
  assert.match(SRC, /harness === "claude" \? livTurnArgs/,
    "claude 전용 플래그(livTurnArgs)를 하네스 무관하게 싣는다");
});

t("㊲ 자격이 **아무것도** 없을 때만 막는다 — 로그인한 사람은 통과시킨다", () => {
  assert.match(SRC, /if \(!loggedIn\.length && !env\) \{[\s\S]{0,240}HttpError\(402/,
    "'로그인 없음 AND 리스 없음' 이 아니면 되는 사람을 막는 회귀다");
  assert.ok(SRC.indexOf("HttpError(402") < SRC.indexOf("await spawnTaskSession({"),
    "402 가드가 spawn 뒤에 있다 — 이미 띄운 뒤라 아무것도 못 막는다(#1101 hang)");
});

t("㊳ 자격 값은 응답에 절대 싣지 않는다", () => {
  // 리스 env 는 {CLAUDE_CODE_OAUTH_TOKEN: '<토큰>'} 이다 — 통째로 실으면 토큰 유출.
  assert.doesNotMatch(SRC, /(ai|lease)\w*:\s*env\b/, "리스 env 를 응답에 그대로 실었다");
  assert.doesNotMatch(SRC, /ai_env/, "자격 env 를 응답 필드로 열었다");
  // 하네스 **이름**은 비밀이 아니다 — 화면이 '무엇으로 도는지' 말하려면 필요하다.
  assert.match(SRC, /ai_harnesses: aiHarnesses/, "무엇으로 도는지 화면이 알 방법이 없다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
