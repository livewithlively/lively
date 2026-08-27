// 처음 설정(#/welcome)의 순수 판정 — 갈래 key · LLM 답 파싱 · 진행 스트림 읽기 · 자료 세기 (#1813).
// 사양·엣지 표: <스크래치패드>/spec-welcome.md — 표의 22행마다 최소 하나.
// red 입증은 mutation(신규 파일이라 '변경 전 코드'가 없다).
// 실행: npm run build && node dist/capabilities/delivery/welcome.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { drawerKey, parseDrawers, lastAssistantText, tallySources, repeatedForms, analyzePrompt, squeezeExcerpt, normalizeProgress, PROGRESS_MAX_BYTES } from "./welcome.js";

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

// ── 내용으로 가른다 (#1813, 원준님 2026-08-27) ──────────────────────────────
//  실측 신고: 이미지 4개를 올렸더니 «이미지 4개» 라고만 하고 무엇에 대한 것인지 하나도 안 봤다.
//  이름만 보내던 프롬프트가 원인이었다 — 발췌를 실어야 «무엇»이 판단에 들어온다.

t("㊴ 발췌를 실으면 프롬프트에 내용 줄이 붙는다 — 이름만으로는 판단이 안 된다", () => {
  const p = analyzePrompt([{ title: "image-1.png", excerpt: "3월 정기회의: 가격 정책 재검토, 담당 김" }], null);
  assert.match(p, /image-1\.png/);
  assert.match(p, /· 내용: 3월 정기회의/, "발췌가 프롬프트에 안 실렸다");
  assert.match(p, /파일 이름이 아니라 내용으로 가릅니다/, "판단 기준을 안 알려 준다");
});

t("㊵ 형식 이름을 서랍으로 쓰지 말라고 명시한다 — 그게 이번 신고의 증상이었다", () => {
  const p = analyzePrompt([{ title: "a.png" }], null);
  assert.match(p, /'이미지'·'PDF'·'문서' 같은 이름을 쓰지 마세요/);
});

t("㊶ 하는 일·일하는 방식이 있으면 프롬프트에 싣는다 — 같은 자료도 직무마다 서랍이 다르다", () => {
  const p = analyzePrompt([{ title: "a.md" }], "제품·기획", "회사·조직에서 팀과 함께 일한다 · 제품·기획");
  assert.match(p, /이 사람이 하는 일: 제품·기획/);
  assert.match(p, /이 사람이 일하는 방식: 회사·조직에서/);
});

t("㊷ 옛 호출(문자열 배열)도 그대로 받는다 — 호출부를 한 번에 못 바꿔도 깨지지 않게", () => {
  const p = analyzePrompt(["a.md", "b.csv"], null);
  assert.match(p, /- a\.md/);
  assert.match(p, /- b\.csv/);
});

t("㊸ 발췌는 앞쪽 N건에만 — 120개 전부 실으면 프롬프트가 수만 자가 된다", () => {
  const many = Array.from({ length: 120 }, (_, i) => ({ title: `f${i}.md`, excerpt: `내용${i} 입니다` }));
  const p = analyzePrompt(many, null);
  const bodyLines = p.split("\n").filter((l) => l.includes("· 내용:"));
  assert.ok(bodyLines.length <= 40, `발췌 줄이 ${bodyLines.length}개 — 상한(40)을 넘었다`);
  assert.ok(bodyLines.length >= 1, "발췌가 하나도 안 실렸다");
});

// ── 발췌 다듬기 ──
t("㊹ 발췌는 줄바꿈·공백을 접어 한 줄로 만든다", () => {
  assert.equal(squeezeExcerpt("가\n\n나   다\t라"), "가 나 다 라");
});

t("㊺ 스텁 인용문(> …)은 내용이 아니다 — 실으면 그 문구를 주제로 착각한다", () => {
  const stub = "> 이 파일은 읽을 수 없습니다 — 형식 미지원\n실제 제목: 3월 매출 정리";
  const out = squeezeExcerpt(stub);
  assert.doesNotMatch(out, /읽을 수 없습니다/);
  assert.match(out, /3월 매출 정리/);
});

t("㊻ 빈 본문·없음은 빈 문자열 — 프롬프트에 빈 '내용:' 줄을 만들지 않는다", () => {
  assert.equal(squeezeExcerpt(null), "");
  assert.equal(squeezeExcerpt(undefined), "");
  assert.equal(squeezeExcerpt("   \n  "), "");
  const p = analyzePrompt([{ title: "a.md", excerpt: "" }], null);
  assert.doesNotMatch(p, /· 내용:/);
});

t("㊼ 긴 발췌는 잘라서 싣고 잘린 것을 표시한다", () => {
  const out = squeezeExcerpt("가".repeat(900));
  assert.ok(out.length <= 401, `안 잘렸다(${out.length}자)`);
  assert.match(out, /…$/);
});

// ── 승인이 곧 스위치다 (#1881 L3 · #1813) ──────────────────────────────────
//  갈래(=위키 분류)를 만들어도 증류기가 꺼져 있으면 자료는 자료로만 남는다 — 빈 서랍이다.
//  local-preset 머리말이 "온보딩 승인 때 켠다"고 설계를 적어 뒀는데 정작 그 코드가 없었다(실측 2026-08-27).
//  런타임으로 재려면 DB·크론이 필요하므로 **배선 자체**를 소스에서 못박는다(㉟~㊲와 같은 이유).
t("㊽ 갈래를 만들면 로컬 증류기를 켠다 — 안 켜면 위키가 빈 채로 남는다", () => {
  assert.match(SRC, /ensureLocalFilesDistiller\(\{ enable: true/,
    "승인 때 증류기를 켜지 않는다 — 올린 자료가 지식이 되지 않는다");
  assert.match(SRC, /if \(created\.length\) \{[\s\S]{0,400}ensureLocalFilesDistiller/,
    "갈래를 하나도 안 만든 사람에게도 켠다 — 승인한 적이 없는 사람이다");
});

t("㊾ 증류기 켜기가 실패해도 온보딩은 끝난다 — 마무리를 막지 않는다", () => {
  const seg = SRC.slice(SRC.indexOf("ensureLocalFilesDistiller"));
  assert.match(seg.slice(0, 300), /catch/, "실패가 마무리를 통째로 깨뜨린다");
});

// ── 분석이 본문을 실제로 읽는가 ──
t("㊿ 분석은 자료 본문을 읽어 발췌를 만든다 — 목록 조회만으로는 body_md 가 없다", () => {
  assert.match(SRC, /getSource\(r\.id, null\)/, "본문을 안 읽는다 — 이름만 보내던 그 상태로 되돌아갔다");
  assert.match(SRC, /squeezeExcerpt\(\(full as \{ body_md\?: string \} \| null\)\?\.body_md\)/);
  assert.match(SRC, /analyzePrompt\(files, job, work\)/, "하는 일을 프롬프트에 안 싣는다");
});

// ── 하다 만 자리 저장 (#2207) ───────────────────────────────────────────────
//  엣지 표 「scene × state × 크기 → 저장값/거절」:
//   R1 정상            scene='role', state={...}        → {at, scene, state}
//   R2 scene 없음/빈값                                   → 400
//   R3 scene 이 이상한 모양(경로·스크립트·40자 초과)       → 400
//   R4 state 가 객체가 아님(문자열·배열·null)             → 400
//   R5 state 가 빈 객체                                  → 400  (저장할 진행이 없다)
//   R6 크기 초과                                         → 413
//   R7 at 은 **주어진 시각**을 쓴다(함수 안에서 시계를 읽지 않는다 — 순수)
//   R8 저장값은 입력과 **다른 객체**다(호출부가 나중에 손대도 저장한 것이 안 바뀐다)
const throws = (fn: () => unknown, status: number, why: string): void => {
  try { fn(); assert.fail(`거절하지 않았다 — ${why}`); }
  catch (e) {
    if ((e as Error).name === "AssertionError") throw e;
    assert.equal((e as { status?: number }).status, status, `${why} (문구: ${(e as Error).message})`);
  }
};

t("R1 정상 입력은 {at, scene, state} 로 떨어진다", () => {
  const out = normalizeProgress({ scene: "role", state: { name: "원준", stage: "company" } }, "2026-08-27T01:00:00Z");
  assert.deepEqual(out, { at: "2026-08-27T01:00:00Z", scene: "role", state: { name: "원준", stage: "company" } });
});

t("R2 scene 이 없으면 거절 — 어디로 되돌아갈지 모르는 저장은 저장이 아니다", () => {
  throws(() => normalizeProgress({ state: { a: 1 } }, "t"), 400, "scene 없음");
  throws(() => normalizeProgress({ scene: "   ", state: { a: 1 } }, "t"), 400, "scene 공백");
});

t("R3 scene 은 모양을 본다 — 경로·스크립트·긴 값은 거절", () => {
  throws(() => normalizeProgress({ scene: "../../etc", state: { a: 1 } }, "t"), 400, "경로");
  throws(() => normalizeProgress({ scene: "<script>", state: { a: 1 } }, "t"), 400, "스크립트");
  throws(() => normalizeProgress({ scene: "x".repeat(41), state: { a: 1 } }, "t"), 400, "41자");
  assert.equal(normalizeProgress({ scene: "x".repeat(40), state: { a: 1 } }, "t").scene, "x".repeat(40));
});

t("R4 state 는 객체여야 한다", () => {
  for (const bad of ["문자열", 42, null, undefined, [1, 2]]) {
    throws(() => normalizeProgress({ scene: "role", state: bad }, "t"), 400, `state=${JSON.stringify(bad)}`);
  }
});

t("R5 빈 객체는 저장할 진행이 아니다", () => {
  throws(() => normalizeProgress({ scene: "role", state: {} }, "t"), 400, "빈 객체");
});

t("R6 크기를 넘으면 413 — 조용히 자르지 않는다(잘린 JSON 은 못 이어 연다)", () => {
  const big = { notes: "가".repeat(PROGRESS_MAX_BYTES) };   // 한글은 UTF-8 3바이트라 확실히 넘는다
  throws(() => normalizeProgress({ scene: "role", state: big }, "t"), 413, "상한 초과");
  // 상한 아래는 통과한다 — 상한이 실사용을 막으면 안 된다(온보딩 답은 몇 줄이다).
  assert.ok(normalizeProgress({ scene: "role", state: { notes: "a".repeat(1000) } }, "t").state);
});

t("R7 at 은 준 시각을 그대로 쓴다 — 함수가 시계를 읽지 않는다(순수)", () => {
  assert.equal(normalizeProgress({ scene: "b1", state: { a: 1 } }, "2020-01-01T00:00:00Z").at, "2020-01-01T00:00:00Z");
});

t("R8 저장값은 입력과 다른 객체다 — 호출부가 나중에 손대도 저장한 것은 안 바뀐다", () => {
  const state: Record<string, unknown> = { a: 1 };
  const out = normalizeProgress({ scene: "b1", state }, "t");
  state.a = 999;
  assert.equal((out.state as { a: number }).a, 1);
});

// ── 끝나면 자리표를 걷는다 ──────────────────────────────────────────────────
t("R9 반영이 끝나면 하다 만 자리를 지운다 — 끝낸 사람에게 «이어서 하기» 가 남으면 안 된다", () => {
  assert.match(SRC, /setLivWelcomeProgress\(userId, null\)/,
    "완료 반영이 진행 자리표를 안 지운다 — 다음 로그인이 다시 온보딩으로 간다");
});

t("R10 끝낸 사람에게는 progress 를 내주지 않는다 — 옛 진행이 되살아나면 안 된다", () => {
  assert.match(SRC, /progress: done \? null :/,
    "GET 이 끝낸 사람에게도 진행을 내준다");
});

// ── 화면 쪽 계약 (#2207) — 브라우저 검증에서 실제로 물린 자리만 못박는다 ─────────
//  왜 소스를 읽나: 이 고장들은 **오류를 내지 않는다.** 화면은 멀쩡히 뜨고, 저장된 자리만 조용히
//   어긋난다(한 장면 되감김 · 이어 열기가 영영 안 뜸). 런타임으로 잡으려면 실브라우저 + 히스토리
//   조작 + 서버 왕복이 다 필요하다 — src/terminal/ai-login.test.ts 가 같은 판단으로 이미 이렇게 한다.
const OB = readFileSync(new URL("../../../web/v2/onboarding.ts", import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");

t("W1 ★ popstate 를 «뒤로» 로 단정하지 않는다 — 순번(obSeq)으로 가른다", () => {
  // 실측 2026-08-27: 같은 문서에서 해시가 바뀌는 이동이면 브라우저가 전부 popstate 를 띄운다.
  //  가르지 않으면 사람이 홈으로 **나가는** 순간 장면이 하나 되감기고, 그 되감긴 자리가 서버에 저장된다
  //  (「AI 고르기」에서 Claude 를 고르고 나갔더니 저장된 자리가 다시 「AI 고르기」였다).
  const fn = OB.slice(OB.indexOf("function onPop"), OB.indexOf("function onPop") + 700);
  assert.match(fn, /obSeq/, "onPop 이 순번을 안 본다 — 나가는 이동까지 «뒤로» 로 처리한다");
  assert.match(fn, /st\.obSeq\s*>=\s*obSeq/, "«되돌아온 것» 판정이 없다");
});

t("W2 히스토리에 쌓는 걸음마다 순번을 찍는다 + 출발점 도장이 있다", () => {
  assert.match(OB, /history\.pushState\(\{ ob: key, obSeq: \+\+obSeq \}/, "걸음에 순번을 안 찍으면 W1 의 판정이 늘 거짓이 된다");
  assert.match(OB, /history\.replaceState\(\{ \.\.\.\(history\.state \|\| \{\}\), ob: S\.scene, obSeq: 0 \}/,
    "출발점 도장이 없다 — 첫 걸음에서의 «뒤로» 가 안 먹는다(#2026 이 고쳤던 증상)");
});

t("W3 ★ 아무것도 안 답한 로컬 상태는 «있음» 이 아니다 — 한 번의 서버 실패가 이어 열기를 영영 가린다", () => {
  // 실측: 프리뷰 백엔드가 잠깐 죽은 사이 첫 화면이 sessionStorage 에 저장됐고, 그 뒤로 그 탭은
  //  서버에 다시 묻지 않았다(hadLocal=true) — 저장돼 있던 진행이 통째로 가려졌다.
  assert.match(OB, /hadLocal = v\.scene !== 'name' \|\| !!v\.nameSet/, "빈 첫 화면을 «있음» 으로 읽는다");
});

t("W4 답이 하나라도 있어야 서버에 남긴다 — 열어보기만 한 사람을 다음 로그인마다 끌어오지 않는다", () => {
  assert.match(OB, /const worthSaving = \(\) => S\.scene !== 'name' \|\| S\.nameSet/);
  assert.match(OB, /if \(pushOff \|\| !worthSaving\(\)\) return/, "문턱 없이 저장하면 first-run 판정이 그 사람을 놓아주지 않는다");
});

t("W5 끝내면 진행 저장을 멈춘다 — 늦게 도착한 push 가 자리표를 되살리면 안 된다", () => {
  assert.match(OB, /pushOff = true;/, "완료 뒤에도 push 가 살아 있으면 다음 로그인이 다시 온보딩으로 간다");
});

t("W6 검토용 점프에서만 없는 답을 지어낸다 — 이어 여는 사람에게 남의 이름을 부르지 않는다", () => {
  assert.match(OB, /if \(demoJump && !S\.nameSet\) \{ S\.name = '원준'/, "이어 여는 사람에게도 '원준' 을 쓴다");
  assert.match(OB, /if \(demoJump && !S\.sources\.length\)/, "고른 적 없는 앱이 골라진 것으로 뜬다");
  assert.match(OB, /S\.read\.total = demoJump \? 41 : realTotal\(\)/, "연출 숫자 41 이 실제 화면에 샌다");
});

t("W7 화면을 떠날 때·창을 닫을 때 마지막 한 걸음을 남긴다", () => {
  assert.match(OB, /addEventListener\('pagehide', onPageHide\)/);
  assert.match(OB, /removeEventListener\('pagehide', onPageHide\)/, "떠난 화면의 리스너가 남는다(누수)");
  assert.match(OB, /void flushProgress\(\);\s*\/\/ 화면을 떠나는 것도/, "destroy 에서 안 밀면 debounce 대기 중이던 마지막 답이 사라진다");
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
