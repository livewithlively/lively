// 우클릭 메뉴 모델 (#1870) — **우클릭 지점의 상태(params) → 메뉴 항목**의 순수 변환. Electron 의 Menu 는 이 모델을 그리기만 한다.
//
// 왜: 앱은 브라우저와 달리 **기본 우클릭 메뉴가 없다** — 링크를 우클릭해도 아무 일도 일어나지 않아 주소를
//  복사할 길이 없었다(장원준 2026-08-24 신고). 링크는 클릭하면 곧장 이동해 버려 '글자를 선택해 ⌘C' 도 링크에는
//  통하지 않으므로, 우클릭 메뉴가 링크 복사의 사실상 유일한 길이다.
// 왜 갈라놓나: 트레이 메뉴(tray-menu.mjs)와 같은 이유 — Electron 메뉴는 띄우지 않으면 검증할 수 없어서,
//  로직이 popup 안에 있으면 "편집칸이 아닌데 붙여넣기가 보인다" 같은 결함이 조용히 남는다.
//
// 항목은 브라우저 관례의 최소 집합만: 링크(주소 복사) · 선택(복사) · 이미지(복사·주소 복사) · 편집칸(잘라내기·붙여넣기).
//  '검사' 같은 개발 항목은 넣지 않는다 — 이 메뉴는 개발 도구가 아니라 복사 수단이다.

/**
 * Electron `context-menu` 이벤트의 params → 항목 모델 `[{id, label} | {type:'separator'}]`.
 * 보일 것이 없으면 [] — 빈 메뉴를 띄우지 않는다(아무 데나 우클릭했을 때 조용한 것이 브라우저 관례다).
 */
export function contextMenuModel(p) {
  const link = String(p?.linkURL || "");
  const sel = String(p?.selectionText || "").trim();
  const img = p?.mediaType === "image" && !!p?.srcURL;
  const items = [];
  if (link) items.push({ id: "copy-link", label: "링크 주소 복사" });
  if (sel) items.push({ id: "copy", label: "복사" });
  if (img) {
    items.push({ id: "copy-image", label: "이미지 복사" });
    // data: URL 은 '주소' 가 아니라 본문 그 자체(수 MB)다 — 클립보드에 넣어 봐야 붙여넣을 곳이 없다.
    if (!/^data:/i.test(String(p.srcURL))) items.push({ id: "copy-image-url", label: "이미지 주소 복사" });
  }
  if (p?.isEditable) {
    if (items.length) items.push({ type: "separator" });
    if (sel) items.push({ id: "cut", label: "잘라내기" });
    items.push({ id: "paste", label: "붙여넣기" });
  }
  return items;
}

/**
 * 항목 실행. wc(webContents)·clipboard 는 호출부가 준다 — 이 모듈은 Electron 을 import 하지 않아
 *  테스트가 스텁으로 전 항목을 돌릴 수 있다. 모르는 id 는 false(모델과 실행이 어긋난 것 — 테스트가 잡는다).
 */
export function runContextMenuAction(id, p, wc, clipboard) {
  switch (id) {
    case "copy-link": clipboard.writeText(String(p?.linkURL || "")); return true;
    case "copy": wc.copy(); return true;
    case "copy-image": wc.copyImageAt(p?.x ?? 0, p?.y ?? 0); return true;
    case "copy-image-url": clipboard.writeText(String(p?.srcURL || "")); return true;
    case "cut": wc.cut(); return true;
    case "paste": wc.paste(); return true;
    default: return false;
  }
}
