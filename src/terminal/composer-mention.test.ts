// 새 세션 컴포저의 @이름 초대(#3778) — 글자 규칙(web/v2/mention-text.ts)과 입구 계약.
//
// 요청(장원준 2026-09-09): "사람 초대는 @사람이름 이걸로 초대할 수 있게 해보자. 슬랙 참고해서. … 사람 버튼은 지워버려.
//  설정 + 시키기 버튼만 있게." / "@사람이름 해서 사람 초대했다고 쳐, 그러면 그냥 밑에 배지만 걸고 @사람이름 이걸 본문에
//  표시하지는 마."
//
// 사양·엣지 표(spec-failfirst):
//  Q1 줄 처음의 `@윤` 은 고르는 중이다 → '윤'
//  Q2 공백 뒤의 `@` 도 고르는 중이다(빈 질의 '') — 목록이 «전원»으로 뜬다
//  Q3 이메일 `a@b` 는 고르는 중이 아니다(앞이 공백이 아니다)
//  Q4 `@윤상민 ` 처럼 공백이 나왔으면 고르는 중이 아니다 → null
//  Q5 경계 — 커서가 0 이면 null, `@` 하나만 쳤을 때(커서 1) 빈 질의
//  M1 후보는 앞글자 일치 먼저, 부분 일치 다음 · 나는 빠진다 · 이미 부른 사람은 빠진다
//  E1 새 헬퍼의 빈 입력 — 구성원 목록이 비었거나 이름이 빈 사람은 후보가 아니다
//  R1 고르면 치던 `@윤` 이 글에서 사라진다 — «봐줘 @윤| 지금» → «봐줘 |지금» (공백이 둘 남지 않는다)
//  R2 글 끝의 `@윤` 을 고르면 앞 공백까지 걷는다 — «봐줘 @윤|» → «봐줘|»
//  R3 고르는 중이 아닌 자리(커서가 공백 뒤)는 글을 건드리지 않는다
//  R4 글 전체가 `@윤` 이면 빈 글이 된다
//  S2 꼬리는 아무도 없으면 빈 문자열, 있으면 이름을 쉼표로
//  P1 프로젝트 세션 입구(project-routes)가 body.invites 를 관문에 싣는다(PR #823) — 안 실으면 화면에서 누굴 고르든 나만 본다
//  P2 홈·프로젝트 컴포저 둘 다 사람 단추가 없고 설정(⚙)·＋·시키기 뿐이다
//  P3 화면 부품은 고른 이름을 글에 **끼우지 않는다** — 걷어 내는 헬퍼만 쓴다
//
// 웹 모듈은 src 테스트가 import 할 수 없어 소스를 transpile 해 data: URL 로 import 한다(web-project-rename.test.ts 와 같은 길).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";

const webPath = (rel: string): string => new URL(`../../web/${rel}`, import.meta.url).pathname.replace("/dist/", "/src/").replace("/src/web/", "/web/");
const readWeb = (rel: string): string => readFileSync(webPath(rel), "utf8");
const readSrc = (rel: string): string => readFileSync(new URL(`../${rel}`, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
const code = (s: string): string => s.split("\n").filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join("\n");

type M = { id: string; name: string };
type Mod = {
  mentionQuery: (t: string, c: number) => string | null;
  mentionMatches: (ms: M[], q: string, o?: { meId?: string; exclude?: Set<string> }) => M[];
  removeMentionQuery: (t: string, c: number) => { text: string; caret: number };
  mentionTail: (names: string[]) => string;
};
let cached: Promise<Mod> | null = null;
function load(): Promise<Mod> {
  if (!cached) {
    const js = ts.transpileModule(readWeb("v2/mention-text.ts"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
    cached = import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`) as Promise<Mod>;
  }
  return cached;
}
const MS: M[] = [{ id: "yoon", name: "윤상민" }, { id: "wonjoon", name: "장원준" }, { id: "yoon2", name: "윤상민" }, { id: "kim", name: "김민수" }];

test("Q1 줄 처음의 @윤 은 고르는 중", async () => { const m = await load(); assert.equal(m.mentionQuery("@윤", 2), "윤"); });
test("Q2 공백 뒤 @ 는 빈 질의로 고르는 중", async () => { const m = await load(); assert.equal(m.mentionQuery("이거 봐줘 @", 8), ""); });
test("Q3 이메일 속 @ 는 아니다", async () => { const m = await load(); assert.equal(m.mentionQuery("a@b", 3), null); });
test("Q4 공백이 나왔으면 고르는 중이 아니다", async () => { const m = await load(); assert.equal(m.mentionQuery("@윤상민 이거", 7), null); });
test("Q5 경계 — 커서 0 은 null, @ 하나는 빈 질의", async () => {
  const m = await load();
  assert.equal(m.mentionQuery("@윤", 0), null);
  assert.equal(m.mentionQuery("@", 1), "");
});
test("M1 앞글자 먼저·나 제외·이미 부른 사람 제외", async () => {
  const m = await load();
  assert.deepEqual(m.mentionMatches(MS, "윤", { meId: "yoon2" }).map((x) => x.id), ["yoon"]);
  assert.deepEqual(m.mentionMatches(MS, "", { exclude: new Set(["kim"]) }).map((x) => x.id), ["yoon", "wonjoon", "yoon2"]);
  assert.deepEqual(m.mentionMatches(MS, "민수").map((x) => x.id), ["kim"]);   // 부분 일치
});
test("E1 빈 목록·빈 이름은 후보가 아니다", async () => {
  const m = await load();
  assert.deepEqual(m.mentionMatches([], "윤"), []);
  assert.deepEqual(m.mentionMatches([{ id: "ghost", name: "" }, { id: "kim", name: "김민수" }], ""), [{ id: "kim", name: "김민수" }]);
});
test("R1 고르면 치던 @윤 이 사라지고 공백이 둘 남지 않는다", async () => {
  const m = await load();
  const r = m.removeMentionQuery("봐줘 @윤 지금", 5);
  assert.equal(r.text, "봐줘 지금");
  assert.equal(r.caret, 3);
});
test("R2 글 끝의 @윤 은 앞 공백까지 걷는다", async () => {
  const m = await load();
  assert.deepEqual(m.removeMentionQuery("봐줘 @윤", 5), { text: "봐줘", caret: 2 });
});
test("R3 고르는 중이 아닌 자리는 건드리지 않는다", async () => {
  const m = await load();
  assert.deepEqual(m.removeMentionQuery("@윤상민 이거", 8), { text: "@윤상민 이거", caret: 8 });
  assert.deepEqual(m.removeMentionQuery("a@b", 3), { text: "a@b", caret: 3 });
});
test("R4 글 전체가 @윤 이면 빈 글", async () => {
  const m = await load();
  assert.deepEqual(m.removeMentionQuery("@윤", 2), { text: "", caret: 0 });
});
test("S2 꼬리", async () => {
  const m = await load();
  assert.equal(m.mentionTail([]), "");
  assert.match(m.mentionTail(["윤상민", "김민수"]), /함께 보는 사람.*윤상민, 김민수/);
});
test("P1 프로젝트 세션 입구가 body.invites 를 관문에 싣는다", () => {
  assert.match(code(readSrc("project/project-routes.ts")), /invites:\s*b\.invites/);
});
test("P2 두 컴포저 모두 사람 단추 없이 설정·＋·시키기", () => {
  for (const rel of ["v2/views.ts", "v2/panes-parts.ts"]) {
    const c = code(readWeb(rel));
    assert.match(c, /v2-launch-act'\s*\},\s*runPicker(\?|!)?\.gear,\s*att\.btn,\s*send/, rel + ": [⚙][＋][시키기] 순서");
    assert.doesNotMatch(c, /v2-launch-ppl-btn|초대 단추/, rel + ": 사람 단추가 남아 있다");
  }
});
test("P3 화면 부품은 고른 이름을 글에 끼우지 않는다", () => {
  const c = code(readWeb("v2/compose-mention.ts"));
  assert.match(c, /removeMentionQuery/);
  assert.doesNotMatch(c, /applyMention|'@' \+ m\.name|`@\$\{m\.name\}/);
});
