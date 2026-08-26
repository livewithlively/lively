// Figma 커넥터 순수 단위 (#1881 F5) — DB·네트워크 불요.
// 실행: npm run build && node dist/connectors/figma.test.js
//
//  이 테스트가 지키는 것: 피그마 수집의 **범위 선언은 사람이 붙여넣은 링크**다. 그 파싱이 조용히 틀리면
//  수집기는 "파일 0개"로 죽거나(그나마 낫다) 엉뚱한 키를 훑는다. 그래서 링크 형태를 표로 박아 둔다.
import assert from "node:assert/strict";
import {
  parseFigmaFileKey, figmaCommentText, figmaCommentToItem, isExcludedFile, splitList, figmaFileUrl,
  type FigmaComment,
} from "./figma.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 링크 → file key (범위 선언 장치) ──
t("parseFigmaFileKey: 사람이 실제로 복사해 오는 주소들을 전부 알아본다", () => {
  const K = "abcDEF123456";
  for (const url of [
    `https://www.figma.com/design/${K}/My-Design?node-id=1-2&t=xyz`,
    `https://www.figma.com/file/${K}/Old-Style-Link`,
    `https://www.figma.com/board/${K}/FigJam-Board`,      // FigJam
    `https://www.figma.com/slides/${K}/Deck`,             // Slides
    `https://www.figma.com/proto/${K}/Prototype?page-id=0`,
    `https://figma.com/design/${K}/no-www`,
  ]) {
    assert.equal(parseFigmaFileKey(url), K, `못 알아본 주소: ${url}`);
  }
});
t("parseFigmaFileKey: 파일 키만 적어도 받는다(주소를 못 찾는 사람이 있다)", () => {
  assert.equal(parseFigmaFileKey("abcDEF123456"), "abcDEF123456");
  assert.equal(parseFigmaFileKey("  abcDEF123456  "), "abcDEF123456");
});
t("parseFigmaFileKey: 피그마가 아닌 주소는 거부한다 — 남의 호스트를 훑지 않는다", () => {
  assert.equal(parseFigmaFileKey("https://figma.com.evil.example/design/abcDEF123456/x"), null);
  assert.equal(parseFigmaFileKey("https://notfigma.com/design/abcDEF123456/x"), null);
  assert.equal(parseFigmaFileKey("https://www.figma.com/community/plugin/123/x"), null); // 파일이 아니다
});
t("parseFigmaFileKey: 못 알아보면 null — 조용히 빈 키를 만들지 않는다", () => {
  assert.equal(parseFigmaFileKey(""), null);
  assert.equal(parseFigmaFileKey("   "), null);
  assert.equal(parseFigmaFileKey("그냥 문장"), null);
  assert.equal(parseFigmaFileKey("short"), null); // 10자 미만은 키로 보지 않는다
});

// ── 본문 ──
t("figmaCommentText: message 가 정본이고, 조각 배열만 오는 응답도 관용한다", () => {
  assert.equal(figmaCommentText({ id: "1", message: "여기 간격 8 로" }), "여기 간격 8 로");
  assert.equal(
    figmaCommentText({ id: "1", message_meta: [{ text: "확인 부탁 " }, { mention: "1234" }, { text: " 님" }] }),
    "확인 부탁 @1234 님",
  );
  assert.equal(figmaCommentText({ id: "1" }), "");
  assert.equal(figmaCommentText({ id: "1", message: "   " }), ""); // 공백뿐이면 빈 것으로 본다
});

// ── 매핑 규약 ──
const C: FigmaComment = {
  id: "c-77", parent_id: "c-70", created_at: "2026-08-20T01:02:03Z", resolved_at: "2026-08-21T00:00:00Z",
  message: "이 화면은 A 안으로 갑니다", user: { id: "u-1", handle: "다온", email: "daon@example.com" },
  order_id: "12",
};
t("figmaCommentToItem: 자료 1건 = 코멘트 1건 · external_id 는 파일+코멘트로 유일하다", () => {
  const it = figmaCommentToItem("FILEKEY123", "홈 리디자인", C, "team-9");
  assert.equal(it.type, "comment");
  assert.equal(it.provenance.system, "figma");
  assert.equal(it.provenance.instance, "team-9");
  assert.equal(it.provenance.external_id, "FILEKEY123:c-77");
  assert.equal(it.provenance.external_url, figmaFileUrl("FILEKEY123"));
  assert.equal(it.container_ref, "FILEKEY123");
  assert.equal(it.container_name, "홈 리디자인");   // #735 — id 만으론 지식화 맥락이 준다
  assert.equal(it.body, "이 화면은 A 안으로 갑니다");
  assert.equal(it.occurred_at, "2026-08-20T01:02:03Z");
});
t("figmaCommentToItem: 답글은 부모를 가리킨다 — 스레드가 완결 단위로 붙는다", () => {
  const it = figmaCommentToItem("FILEKEY123", undefined, C);
  assert.equal(it.parent_external_id, "FILEKEY123:c-70");
  assert.equal((it.fields as Record<string, unknown>).is_reply, true);
  const top = figmaCommentToItem("FILEKEY123", undefined, { ...C, parent_id: undefined });
  assert.equal(top.parent_external_id, undefined);
  assert.equal((top.fields as Record<string, unknown>).is_reply, false);
});
t("figmaCommentToItem: resolved 는 '결론이 났다'는 신호라 필드로 승격한다", () => {
  const done = figmaCommentToItem("F", undefined, C);
  assert.equal((done.fields as Record<string, unknown>).resolved, true);
  const open = figmaCommentToItem("F", undefined, { ...C, resolved_at: null });
  assert.equal((open.fields as Record<string, unknown>).resolved, false);
});
t("figmaCommentToItem: 작성자가 없으면 actor 를 만들지 않는다(빈 사람 레코드 방지)", () => {
  const it = figmaCommentToItem("F", undefined, { id: "x", message: "m" });
  assert.equal(it.actor, undefined);
});

// ── 설정 파싱 ──
t("splitList: 공백·쉼표·줄바꿈 아무거나 — 사람이 붙여넣는 대로 받는다", () => {
  assert.deepEqual(splitList("a b,c\n d"), ["a", "b", "c", "d"]);
  assert.deepEqual(splitList(undefined), []);
  assert.deepEqual(splitList("   "), []);
});
t("isExcludedFile: 이름 조각 부분일치(대소문자 무시)", () => {
  assert.equal(isExcludedFile("Archive 2024", ["archive"]), true);
  assert.equal(isExcludedFile("홈 리디자인", ["archive"]), false);
  assert.equal(isExcludedFile("무엇이든", []), false);   // 패턴이 없으면 아무것도 제외하지 않는다
  assert.equal(isExcludedFile(undefined, ["archive"]), false);
});

console.log(`\nfigma connector tests: ${pass} passed`);
