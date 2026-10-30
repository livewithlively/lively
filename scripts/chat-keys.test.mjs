// 세션 대화창을 «터미널처럼» — 이 화면이 보이는 동안 친 키를 입력칸으로 보낼지 정하는 판정(#4797).
//
// 왜 이 테스트가 있나: 상민님(2026-10-16) «그부분 눌렀을때만 거기에 입력되는게 아니라 그냥 항상 실제 터미널처럼 그 화면
//  활성화돼있을때 입력되게». 키를 가로채는 자리는 잘못 넓으면 남의 칸의 키(검색창 글자 · 파일 칸의 Space · 단추의 Enter ·
//  ⌘K 같은 단축키)를 뺏고, 좁으면 «쳤는데 안 들어간다» 가 그대로 남는다. 그 경계를 표로 잠근다(web/lib/chat-keys.ts routeKey).
// 실행: npm run build:web 뒤 — 러너 `node scripts/run-tests.mjs --build`.
import { strict as assert } from "node:assert";
import test from "node:test";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { routeKey } = await import(pathToFileURL(path.join(ROOT, "public/app/lib/chat-keys.js")).href);

const at = (kind, owned = false) => ({ kind, owned });
const K = (key, more = {}) => ({ key, ...more });

test("글자 한 자 — 초점이 아무 데도 아닌 곳(바탕 · 대화 글 · 사이드바 줄 같은 단추)이면 입력칸으로", () => {
  for (const spot of ["none", "other", "interactive"]) {
    assert.equal(routeKey(K("a"), at(spot)), "focus", spot);
    assert.equal(routeKey(K("/"), at(spot)), "focus", spot);            // 슬래시 명령의 첫 글자
    assert.equal(routeKey(K("ㅎ"), at(spot)), "focus", spot);            // 한글 자모
    assert.equal(routeKey(K("😀"), at(spot)), "focus", spot);            // 서로게이트 쌍도 한 글자
  }
});

test("남의 칸 · 창 · 이미 내 입력칸이면 손대지 않는다", () => {
  assert.equal(routeKey(K("a"), at("editable")), null);                  // 다른 글칸(검색창 · 본문 편집)
  assert.equal(routeKey(K("a"), at("mine")), null);                      // 이미 입력칸 — 브라우저가 그대로 넣는다
  for (const spot of ["none", "other", "interactive", "editable"]) assert.equal(routeKey(K("a"), at(spot, true)), null, "owned " + spot);   // 창·메뉴·곁칸·액자 안
});

test("한글 입력기 — 조합을 시작하는 키(Process · 229)는 입력칸으로, 다른 칸에서 조합 중인 키는 그대로", () => {
  assert.equal(routeKey(K("Process"), at("none")), "focus");
  assert.equal(routeKey(K("Unidentified", { keyCode: 229 }), at("none")), "focus");
  assert.equal(routeKey(K("ㅎ", { isComposing: true }), at("none")), null);
});

test("단추 위의 Space · Enter 는 그 단추를 누르는 키다 — 그대로 둔다", () => {
  assert.equal(routeKey(K(" "), at("interactive")), null);
  assert.equal(routeKey(K("Enter"), at("interactive")), null);
  assert.equal(routeKey(K(" "), at("none")), "focus");
  assert.equal(routeKey(K(" "), at("other")), "focus");
});

test("Enter — 바탕에서 치면 보내기 · Shift+Enter 는 줄바꿈(입력칸으로) · Backspace 는 입력칸으로", () => {
  assert.equal(routeKey(K("Enter"), at("none")), "enter");
  assert.equal(routeKey(K("Enter"), at("other")), "enter");
  assert.equal(routeKey(K("Enter", { shiftKey: true }), at("none")), "focus");
  assert.equal(routeKey(K("Backspace"), at("none")), "focus");
  assert.equal(routeKey(K("Backspace"), at("interactive")), "focus");
});

test("수식키 조합은 단축키 몫 — 붙여넣기(⌘V · Ctrl+V)만 입력칸으로(한글 자판이면 key 가 'ㅍ' 여도 자판 위치로)", () => {
  assert.equal(routeKey(K("k", { metaKey: true, code: "KeyK" }), at("none")), null);     // ⌘K 통합검색
  assert.equal(routeKey(K("o", { ctrlKey: true, code: "KeyO" }), at("none")), null);     // Ctrl+O 펼치기
  assert.equal(routeKey(K("c", { metaKey: true, code: "KeyC" }), at("other")), null);    // 복사
  assert.equal(routeKey(K("v", { metaKey: true, code: "KeyV" }), at("none")), "focus");
  assert.equal(routeKey(K("v", { ctrlKey: true, code: "KeyV" }), at("interactive")), "focus");
  assert.equal(routeKey(K("ㅍ", { metaKey: true, code: "KeyV" }), at("none")), "focus");
  assert.equal(routeKey(K("v", { metaKey: true, altKey: true, code: "KeyV" }), at("none")), null);
  assert.equal(routeKey(K("v", { metaKey: true, code: "KeyV" }), at("editable")), null);   // 다른 글칸에 붙여넣는 중
});

test("이름 있는 키(화살표 · Esc · Tab · F키)와 이미 쓰인 키는 그대로", () => {
  for (const k of ["ArrowUp", "ArrowDown", "Escape", "Tab", "F5", "PageDown", "Home", "Shift", "Meta"]) assert.equal(routeKey(K(k), at("none")), null, k);
  assert.equal(routeKey(K("a", { defaultPrevented: true }), at("none")), null);
});
