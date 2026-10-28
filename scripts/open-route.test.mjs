// 액자 → 셸 «이 주소의 탭을 열어 줘» 메시지에 실린 첫 지시 — 보내는 쪽 · 받는 쪽 한 모양(web/lib/open-route.ts, #4906).
//
// 왜 이 테스트가 있나: 프로젝트 보드(액자)의 [세션 열기]가 만든 세션의 첫 지시는 액자 문서의 기억에만 있어 셸 문서가 못 읽었다
//  (문서마다 모듈이 따로다). 그래서 그 세션 화면이 첫 지시를 몰라 빈 터미널부터 보였다. 메시지에 첫 지시를 실어 옮기는데,
//  받는 쪽은 같은 출처의 메시지만 받지만(main.ts) 모양은 여기서 한 번 더 거른다 — 세션 주소 · 문자열 · 공백 · 상한의 경계를 표로 잠근다.
// 실행: npm run build:web 뒤 — 러너 `node scripts/run-tests.mjs --build`.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { OPEN_ROUTE, FIRST_PROMPT_MAX, openRouteMsg, openRouteFirstPrompt } = await import(pathToFileURL(path.join(ROOT, "public/app/lib/open-route.js")).href);

const KICK = "태스크 #9 진행해\n\n## 할 일\n- 본문";

test("보내는 쪽 — 첫 지시가 있으면 싣고, 없거나 비었으면 종전 모양 그대로", () => {
  assert.equal(OPEN_ROUTE, "lively:open-route");
  assert.deepEqual(openRouteMsg("#/s/box-a", KICK), { type: OPEN_ROUTE, href: "#/s/box-a", firstPrompt: KICK });
  for (const v of [undefined, null, "", "   "]) assert.deepEqual(openRouteMsg("#/s/box-a", v), { type: OPEN_ROUTE, href: "#/s/box-a" }, JSON.stringify(v));
});

test("받는 쪽 — 세션 주소에 실린 첫 지시를 { sid, text } 로(주소의 id 는 풀어서) · 보낸 모양과 왕복", () => {
  assert.deepEqual(openRouteFirstPrompt(openRouteMsg("#/s/box-a", KICK)), { sid: "box-a", text: KICK });
  assert.deepEqual(openRouteFirstPrompt(openRouteMsg("#/s/" + encodeURIComponent("box-한글 a"), "지시")), { sid: "box-한글 a", text: "지시" });
  assert.deepEqual(openRouteFirstPrompt({ type: OPEN_ROUTE, href: "#/s/box-a?tab=x", firstPrompt: "지시" }), { sid: "box-a", text: "지시" });
});

test("받는 쪽 — 세션 주소가 아니면 · 첫 지시가 없거나 이상하면 null(기억하지 않는다)", () => {
  const bad = [
    null, undefined, "문자열", 42,
    { type: "lively:open-section", href: "#/s/box-a", firstPrompt: "지시" },     // 다른 메시지
    { type: OPEN_ROUTE, href: "#/p/7?new=1", firstPrompt: "지시" },               // 세션 주소가 아니다
    { type: OPEN_ROUTE, href: "#/s/", firstPrompt: "지시" },                      // id 없음
    { type: OPEN_ROUTE, href: "#/s/%E0%A4%A", firstPrompt: "지시" },              // 풀 수 없는 id
    { type: OPEN_ROUTE, href: 7, firstPrompt: "지시" },                           // 주소가 문자열이 아님
    { type: OPEN_ROUTE, href: "#/s/box-a" },                                      // 첫 지시 없음(종전 모양)
    { type: OPEN_ROUTE, href: "#/s/box-a", firstPrompt: "   " },                  // 공백뿐
    { type: OPEN_ROUTE, href: "#/s/box-a", firstPrompt: 42 },                     // 문자열 아님
  ];
  for (const m of bad) assert.equal(openRouteFirstPrompt(m), null, JSON.stringify(m));
});

test("받는 쪽 — 상한 경계: 정확히 상한이면 받고, 한 글자 넘으면 받지 않는다(자른 글은 맞추기를 빗나가게 한다)", () => {
  assert.ok(FIRST_PROMPT_MAX >= 30_000, "서버 첫 지시(사람 글 20,000자 + 태스크 머리)보다 넉넉해야 한다");
  assert.equal(openRouteFirstPrompt({ type: OPEN_ROUTE, href: "#/s/box-a", firstPrompt: "가".repeat(FIRST_PROMPT_MAX) })?.text.length, FIRST_PROMPT_MAX);
  assert.equal(openRouteFirstPrompt({ type: OPEN_ROUTE, href: "#/s/box-a", firstPrompt: "가".repeat(FIRST_PROMPT_MAX + 1) }), null);
});
