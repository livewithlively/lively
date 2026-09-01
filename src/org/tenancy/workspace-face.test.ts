// #2188 워크스페이스 설정 모달 — **워크스페이스 얼굴(face)은 이제 파생값이 아니라 저장값이다.**
//
// ── 왜 ──────────────────────────────────────────────────────────────────────
// 2026-08-31 장원준: "아바타나 이름이나 초대나 이런것까지도 거기서 설정할 수 있는 모달".
// 종전엔 워크스페이스에 얼굴 필드 자체가 없었다 — 개인은 «내 계정 아바타», 팀은 «이름 첫 글자»로
// 매번 파생했다(switcher.workspaceFace, #1875). 사람이 정한 색·글자를 담을 자리(gw_workspace.face,
// CP workspaces.face)를 새로 만들면서, 그 입력을 거르는 규칙을 한 벌로 둔다.
//
// ── 왜 한 벌인가 ────────────────────────────────────────────────────────────
// face 는 **모든 구성원의 화면에 그대로 그려지는 값**이다. 검증이 핸들러마다 흩어지면 한 문(예: CP 창구)만
// 느슨해져 style 주입·화면 깨짐이 그 문으로 들어온다. normalizeWorkspaceFace 하나가 전 문을 지킨다.
//
// ── 엣지 표(입력 × 기대) ────────────────────────────────────────────────────
//   E1 undefined/null            → null (바꾸지 말라는 뜻 — 지우는 것과 다르다)
//   E2 {}                        → {}   (지움 — 파생값으로 되돌아간다)
//   E3 {color:'#3b82f6'}         → 그대로 (#rgb·#rrggbb 만)
//   E4 ★color 에 CSS 주입        → 400  ('red', 'url(...)', 'blue;background:url(x)' 전부)
//   E5 char 1~2자(이모지 포함)   → 그대로 ('라', '하루', '🔥')
//   E6 char 가 길다              → 앞 2자만 (막지 않고 다듬는다 — 사람 입력이다)
//   E7 char 공백뿐               → 키 자체가 빠진다
//   E8 모르는 키                 → 버린다 (저장소에 임의 JSON 이 쌓이지 않게)
//   E9 객체가 아니다('x', 3)     → 400
import { strict as assert } from "node:assert";
import test from "node:test";
import { normalizeWorkspaceFace } from "./registry.js";

const bad = (raw: unknown, label: string): void => {
  assert.throws(() => normalizeWorkspaceFace(raw), /400|아바타|색/, label);
};

test("★ E1~E9 워크스페이스 얼굴 입력 규칙 — 색은 hex 만, 글자는 2자까지, 나머지는 버린다", () => {
  assert.equal(normalizeWorkspaceFace(undefined), null, "E1 undefined 는 '바꾸지 마라'다");
  assert.equal(normalizeWorkspaceFace(null), null, "E1 null 도 같다");
  assert.deepEqual(normalizeWorkspaceFace({}), {}, "E2 빈 객체는 '지워라'다");

  assert.deepEqual(normalizeWorkspaceFace({ color: "#3b82f6" }), { color: "#3b82f6" }, "E3 #rrggbb");
  assert.deepEqual(normalizeWorkspaceFace({ color: "#F60" }), { color: "#f60" }, "E3 #rgb — 소문자로 눕힌다(같은 색이 두 표기로 갈리지 않게)");

  // ★ E4 — 이 값은 모두의 화면에 style 로 꽂힌다. hex 밖은 전부 거절이다.
  bad({ color: "red" }, "E4 이름색이 통과했다");
  bad({ color: "url(javascript:1)" }, "E4 ★url() 이 통과했다 — style 주입 통로");
  bad({ color: "#fff;background:url(x)" }, "E4 ★세미콜론 밀수가 통과했다");

  assert.deepEqual(normalizeWorkspaceFace({ char: "라" }), { char: "라" }, "E5 한 글자");
  assert.deepEqual(normalizeWorkspaceFace({ char: "하루" }), { char: "하루" }, "E5 두 글자");
  assert.deepEqual(normalizeWorkspaceFace({ char: "🔥" }), { char: "🔥" }, "E5 이모지(서로게이트 쌍)가 잘리면 깨진 문자가 그려진다");
  //  ★돌연변이로 잡은 자리: UTF-16 slice(0,2) 는 '🔥' 하나는 통과시키지만 «두 번째 자리의 이모지»를
  //   반쪽(\ud83d)으로 자른다 — 코드포인트 기준이어야 한다.
  assert.deepEqual(normalizeWorkspaceFace({ char: "라🔥" }), { char: "라🔥" }, "E5' 글자+이모지 조합이 반쪽으로 잘렸다");
  assert.deepEqual(normalizeWorkspaceFace({ char: "라이블리" }), { char: "라이" }, "E6 길면 앞 2자");
  assert.deepEqual(normalizeWorkspaceFace({ char: "   " }), {}, "E7 공백뿐이면 키가 빠진다");

  assert.deepEqual(normalizeWorkspaceFace({ color: "#123456", evil: "x", __proto__: { a: 1 } } as never),
    { color: "#123456" }, "E8 모르는 키는 버린다");
  bad("파랑", "E9 문자열이 통과했다");
  bad(3, "E9 숫자가 통과했다");
});
