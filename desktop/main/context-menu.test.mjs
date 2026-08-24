// 우클릭 메뉴 (#1870 · context-menu.mjs) — 모델 판정 + **배선**. 사양 엣지 표의 행 번호(1~15)가 테스트명이다.
//  실행: node desktop/main/context-menu.test.mjs (러너가 desktop/**/*.test.mjs 를 자동 수집한다)
//
// ⚠ 왜 배선까지 보나: 메뉴는 띄우지 않으면 검증할 수 없어서, main.mjs 가 이 모델을 안 쓰면(리스너 누락)
//  "우클릭해도 아무 일도 없음"이 그대로 남는다 — browser-surface.test.mjs 와 같은 규율로 소스를 읽어 잡는다.
//  특히 리스너는 webview 게스트 조기 return **앞**이어야 서피스 안에서도 메뉴가 뜬다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { contextMenuModel, runContextMenuAction } from "./context-menu.mjs";

let pass = 0;
const t = (n, fn) => { fn(); pass++; console.log(`ok  ${n}`); };
const ids = (m) => m.map((x) => x.type === "separator" ? "|" : x.id).join(",");

// ── 모델 판정 ──────────────────────────────────────────────────────────────
t("1  params 부재 → 빈 메뉴를 띄우지 않는다([])", () => {
  assert.deepEqual(contextMenuModel({}), []);
  assert.deepEqual(contextMenuModel(null), []);
  assert.deepEqual(contextMenuModel(undefined), []);
});
t("2  링크만 → 링크 주소 복사 하나", () => {
  assert.equal(ids(contextMenuModel({ linkURL: "https://dev.lvly.io/ui/#/s/x" })), "copy-link");
});
t("3  글자 선택 → 복사", () => {
  assert.equal(ids(contextMenuModel({ selectionText: "안녕" })), "copy");
});
t("4  경계: 공백뿐인 선택은 선택이 아니다", () => {
  assert.deepEqual(contextMenuModel({ selectionText: "  \n" }), []);
});
t("5  링크 + 선택 동시 → 둘 다, 주소가 먼저", () => {
  assert.equal(ids(contextMenuModel({ linkURL: "https://a", selectionText: "a" })), "copy-link,copy");
});
t("6  이미지(http) → 이미지 복사 + 주소 복사", () => {
  assert.equal(ids(contextMenuModel({ mediaType: "image", srcURL: "https://a/i.png" })), "copy-image,copy-image-url");
});
t("7  경계: data: 이미지는 '주소'가 없다 — 이미지 복사만", () => {
  assert.equal(ids(contextMenuModel({ mediaType: "image", srcURL: "data:image/png;base64,AAAA" })), "copy-image");
});
t("8  부재 엣지: 이미지인데 srcURL 없음 → 메뉴 없음", () => {
  assert.deepEqual(contextMenuModel({ mediaType: "image" }), []);
  assert.deepEqual(contextMenuModel({ mediaType: "image", srcURL: "" }), []);
});
t("9  편집칸(선택 없음) → 붙여넣기만, 잘라내기 없음", () => {
  assert.equal(ids(contextMenuModel({ isEditable: true })), "paste");
});
t("10 편집칸 + 선택 → 복사 | 잘라내기·붙여넣기(구분선 포함)", () => {
  assert.equal(ids(contextMenuModel({ isEditable: true, selectionText: "x" })), "copy,|,cut,paste");
});
t("11 경계: 편집칸 단독이면 구분선도 없다(앞 항목 0)", () => {
  assert.ok(!contextMenuModel({ isEditable: true }).some((m) => m.type === "separator"));
});

// ── 실행 디스패치 — 문구가 아니라 부작용(스텁 호출 로그)으로 단언 ─────────────────
t("12 각 id → 대응 부작용 정확히 1회", () => {
  const calls = [];
  const wc = { copy: () => calls.push("copy"), cut: () => calls.push("cut"), paste: () => calls.push("paste"),
    copyImageAt: (x, y) => calls.push(`img@${x},${y}`) };
  const clip = { writeText: (s) => calls.push(`clip:${s}`) };
  const p = { linkURL: "https://a", srcURL: "https://a/i.png", x: 3, y: 7 };
  for (const id of ["copy-link", "copy", "copy-image", "copy-image-url", "cut", "paste"]) {
    assert.equal(runContextMenuAction(id, p, wc, clip), true, id);
  }
  assert.deepEqual(calls, ["clip:https://a", "copy", "img@3,7", "clip:https://a/i.png", "cut", "paste"]);
});
t("13 모르는 id → false + 부작용 0건", () => {
  const calls = [];
  const wc = { copy: () => calls.push("x"), cut: () => calls.push("x"), paste: () => calls.push("x"), copyImageAt: () => calls.push("x") };
  const clip = { writeText: () => calls.push("x") };
  assert.equal(runContextMenuAction("nope", {}, wc, clip), false);
  assert.equal(calls.length, 0);
});
t("14 모델이 낼 수 있는 모든 id 를 실행부가 안다(어긋나면 죽은 메뉴)", () => {
  const every = [
    contextMenuModel({ linkURL: "https://a", selectionText: "s", isEditable: true }),
    contextMenuModel({ mediaType: "image", srcURL: "https://a/i.png" }),
  ].flat().filter((m) => m.type !== "separator");
  assert.ok(every.length >= 6, "표본이 전 항목을 덮어야 한다");
  const wc = { copy: () => {}, cut: () => {}, paste: () => {}, copyImageAt: () => {} };
  const clip = { writeText: () => {} };
  for (const m of every) assert.equal(runContextMenuAction(m.id, {}, wc, clip), true, m.id);
});

// ── 배선(main.mjs 소스 검사) ────────────────────────────────────────────────
t("15 main.mjs 가 리스너를 webview 조기 return 앞에 단다 + 모델·clipboard 로 실행", () => {
  const src = readFileSync(fileURLToPath(new URL("./main.mjs", import.meta.url)), "utf8");
  const hook = src.indexOf('app.on("web-contents-created"');
  const menu = src.indexOf('wc.on("context-menu"', hook);
  const guest = src.indexOf('wc.getType() === "webview"', hook);
  assert.ok(hook >= 0 && menu > hook, "web-contents-created 안에 context-menu 리스너가 있어야 한다");
  assert.ok(guest > menu, "리스너가 webview 게스트 분기(조기 return)보다 앞이어야 서피스에서도 메뉴가 뜬다");
  assert.match(src, /runContextMenuAction\(m\.id, params, wc, clipboard\)/, "실행부가 모델 id·clipboard 로 배선돼야 한다");
});

console.log(`\n${pass} tests passed`);
