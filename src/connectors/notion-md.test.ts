// #551 notion-md 변환기 골든 테스트 — 순수 함수(DB/네트워크 불요).
//   실행: npm run build && node dist/connectors/notion-md.test.js
//   목적: 블록 타입 전수 → 마크다운 매핑이 조용히 손실되지 않음을 회귀로 잠근다
//        (rich text 서식·링크 재작성·링크 엣지 수집·표·컨테이너 디렉티브·속성 정규화·댓글 스레드).
import assert from "node:assert/strict";
import {
  blocksToMd, commentsToMd, dataSourceSchemaMd, normalizeNotionId, notionIdFromUrl,
  normalizeProperties, parseNotionRootId, propertiesTableMd, richTextToMd, type NotionMdCtx,
} from "./notion-md.js";

// ── 테스트 컨텍스트 — 알려진 페이지 2개 + 사용자 1명 + 자산은 로컬 라우트로. ──
const PAGE_A = "11111111-1111-1111-1111-111111111111";
const PAGE_B = "22222222-2222-2222-2222-222222222222";
const UNKNOWN = "99999999-9999-9999-9999-999999999999";
function makeCtx() {
  const links: Array<{ id: string; kind: string }> = [];
  const assets: string[] = [];
  const ctx: NotionMdCtx = {
    resolveRef: (id) => {
      if (id === PAGE_A) return { name: "notion-" + PAGE_A, title: "페이지A" };
      if (id === PAGE_B) return { name: "notion-" + PAGE_B, title: "페이지B" };
      return null;
    },
    resolveUser: (uid) => (uid === "u1" ? "윤상민" : null),
    assetUrl: (file, hint) => {
      const f = file as Record<string, any>;
      if (f?.type === "file") { assets.push(hint.kind); return "/api/ui/notion-assets/testasset.png"; }
      if (f?.type === "external") return String(f.external?.url ?? "");
      return null;
    },
    addLink: (id, kind) => links.push({ id, kind }),
  };
  return { ctx, links, assets };
}

const rt = (text: string, ann: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  type: "text", plain_text: text, text: { content: text, link: null },
  annotations: { bold: false, italic: false, strikethrough: false, underline: false, code: false, color: "default", ...ann },
  ...extra,
});

// ── id 정규화 · URL 파싱 ──
assert.equal(normalizeNotionId("11111111111111111111111111111111"), PAGE_A.replace(/1/g, "1")); // 32hex → 하이픈 삽입
assert.equal(normalizeNotionId("11111111-1111-1111-1111-111111111111"), PAGE_A);
assert.equal(notionIdFromUrl("https://www.notion.so/team/페이지A-11111111111111111111111111111111?pvs=4"), PAGE_A);
assert.equal(notionIdFromUrl("https://example.com/x-11111111111111111111111111111111"), null);

// ── 루트 페이지 관용 파싱(#551 실사용 함정: 제목 슬러그의 hex 글자가 id 앞에 붙음) ──
assert.equal(parseNotionRootId("Product-26b746a5e57380f4aec5c7bc8556d164"), "26b746a5-e573-80f4-aec5-c7bc8556d164");
assert.equal(parseNotionRootId("Engineering-325746a5e57380cd9eb2e5e338b19872"), "325746a5-e573-80cd-9eb2-e5e338b19872");
assert.equal(parseNotionRootId("26b746a5e57380f4aec5c7bc8556d164"), "26b746a5-e573-80f4-aec5-c7bc8556d164");
assert.equal(parseNotionRootId("26b746a5-e573-80f4-aec5-c7bc8556d164"), "26b746a5-e573-80f4-aec5-c7bc8556d164");
assert.equal(parseNotionRootId("https://www.notion.so/team/Product-26b746a5e57380f4aec5c7bc8556d164?pvs=4"), "26b746a5-e573-80f4-aec5-c7bc8556d164");
assert.equal(parseNotionRootId("https://app.notion.com/p/Product-26b746a5e57380f4aec5c7bc8556d164#26b7"), "26b746a5-e573-80f4-aec5-c7bc8556d164");
assert.equal(parseNotionRootId("그냥제목"), null);
assert.equal(parseNotionRootId(""), null);

// ── rich text — 서식 조합 · 인라인 링크 · 노션 링크 재작성 ──
{
  const { ctx } = makeCtx();
  assert.equal(richTextToMd([rt("굵게", { bold: true })], ctx), "**굵게**");
  assert.equal(richTextToMd([rt("기울임", { italic: true })], ctx), "*기울임*");
  assert.equal(richTextToMd([rt("취소", { strikethrough: true })], ctx), "~~취소~~");
  assert.equal(richTextToMd([rt("밑줄", { underline: true })], ctx), "++밑줄++");
  assert.equal(richTextToMd([rt("코드", { code: true })], ctx), "`코드`");
  assert.equal(richTextToMd([rt("하이라이트", { color: "yellow_background" })], ctx), "==하이라이트==");
  assert.equal(richTextToMd([rt("조합", { bold: true, italic: true })], ctx), "***조합***");
}
{
  const { ctx, links } = makeCtx();
  const md = richTextToMd([rt("외부", {}, { href: "https://example.com" })], ctx);
  assert.equal(md, "[외부](https://example.com)");
  // 노션 내부 URL → 내부 링크 재작성 + 엣지
  const md2 = richTextToMd([rt("내부", {}, { href: `https://www.notion.so/x-${PAGE_A.replace(/-/g, "")}` })], ctx);
  assert.equal(md2, `[내부](#/k/notion-${PAGE_A})`);
  assert.deepEqual(links, [{ id: PAGE_A, kind: "inline" }]);
}
// 멘션 — page(내부 재작성)·미지 페이지(평문 폴백)·user·date·equation
{
  const { ctx, links } = makeCtx();
  const md = richTextToMd([
    { type: "mention", plain_text: "페이지A", mention: { type: "page", page: { id: PAGE_A } }, annotations: {} },
    rt(" · "),
    { type: "mention", plain_text: "미지페이지", mention: { type: "page", page: { id: UNKNOWN } }, annotations: {} },
    rt(" · "),
    { type: "mention", plain_text: "@윤상민", mention: { type: "user", user: { object: "user", id: "u1" } }, annotations: {} },
    rt(" · "),
    { type: "mention", plain_text: "2026-07-04", mention: { type: "date", date: { start: "2026-07-04", end: null } }, annotations: {} },
    rt(" · "),
    { type: "equation", plain_text: "E=mc^2", equation: { expression: "E=mc^2" }, annotations: {} },
  ], ctx);
  assert.equal(md, `[페이지A](#/k/notion-${PAGE_A}) · 미지페이지 · @윤상민 · 📅 2026-07-04 · $E=mc^2$`);
  assert.deepEqual(links.map((l) => l.kind), ["mention", "mention"]); // 미지 페이지도 엣지는 수집(타깃 미존재 시 물질화에서 걸러짐)
}

// ── 블록 전수 — 골든 ──
const b = (type: string, inner: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ object: "block", id: "b-" + type, type, [type]: inner, ...extra });

{
  const { ctx } = makeCtx();
  const md = blocksToMd([
    b("heading_1", { rich_text: [rt("제목1")] }),
    b("heading_2", { rich_text: [rt("제목2")] }),
    b("heading_3", { rich_text: [rt("제목3")] }),
    b("heading_4", { rich_text: [rt("제목4")] }),
    b("paragraph", { rich_text: [rt("문단")] }),
    b("divider", {}),
  ], ctx);
  assert.equal(md, "# 제목1\n\n## 제목2\n\n### 제목3\n\n#### 제목4\n\n문단\n\n---");
}
// 리스트 — 불릿·번호(시작값)·할일·중첩(2칸 들여쓰기)
{
  const { ctx } = makeCtx();
  const md = blocksToMd([
    b("bulleted_list_item", { rich_text: [rt("불릿")] }, {
      _children: [b("bulleted_list_item", { rich_text: [rt("중첩")] })],
    }),
    b("numbered_list_item", { rich_text: [rt("셋째")], list_start_index: 3 }),
    b("numbered_list_item", { rich_text: [rt("넷째")] }),
    b("to_do", { rich_text: [rt("할일")], checked: false }),
    b("to_do", { rich_text: [rt("완료")], checked: true }),
  ], ctx);
  assert.equal(md, "- 불릿\n  - 중첩\n3. 셋째\n4. 넷째\n- [ ] 할일\n- [x] 완료");
}
// 토글·토글헤딩·콜아웃·인용
{
  const { ctx } = makeCtx();
  const md = blocksToMd([
    b("toggle", { rich_text: [rt("토글 제목")] }, { _children: [b("paragraph", { rich_text: [rt("토글 내용")] })] }),
    b("heading_2", { rich_text: [rt("접는 헤딩")], is_toggleable: true }, { _children: [b("paragraph", { rich_text: [rt("숨은 내용")] })] }),
    b("callout", { rich_text: [rt("주의!")], icon: { type: "emoji", emoji: "💡" }, color: "gray_background" }),
    b("quote", { rich_text: [rt("인용문")] }, { _children: [b("paragraph", { rich_text: [rt("인용 안 문단")] })] }),
  ], ctx);
  assert.equal(md, [
    ":::toggle 토글 제목", "토글 내용", ":::",
    "", "## 접는 헤딩", ":::toggle 펼치기", "숨은 내용", ":::",
    "", ":::callout icon=💡 color=gray_background", "주의!", ":::",
    "", "> 인용문", "> 인용 안 문단",
  ].join("\n"));
}
// 코드(+캡션)·수식·TOC·breadcrumb(생략)
{
  const { ctx } = makeCtx();
  const md = blocksToMd([
    b("code", { rich_text: [rt("const x = 1;")], language: "typescript", caption: [rt("예시 코드")] }),
    b("equation", { expression: "\\int_0^1 x dx" }),
    b("table_of_contents", { color: "default" }),
    b("breadcrumb", {}),
  ], ctx);
  assert.equal(md, "```typescript\nconst x = 1;\n```\n*예시 코드*\n\n$$\n\\int_0^1 x dx\n$$\n\n:::toc\n:::");
}
// 미디어 — notion 호스팅(다운로드 참조) vs external(원본 유지) + 북마크
{
  const { ctx, assets } = makeCtx();
  const md = blocksToMd([
    b("image", { type: "file", file: { url: "https://s3.example/x.png?sig=1", expiry_time: "2026-01-01" }, caption: [rt("스크린샷")] }),
    b("image", { type: "external", external: { url: "https://img.example/y.png" }, caption: [] }),
    b("file", { type: "file", file: { url: "https://s3.example/f.pdf" }, name: "문서.pdf", caption: [] }),
    b("file", { type: "file", file: { url: "https://s3.example/g.pdf" }, name: "계약.pdf", caption: [rt("최종본")] }),
    b("bookmark", { url: "https://example.com", caption: [rt("북마크 설명")] }),
    b("embed", { url: "https://embed.example/x", caption: [rt("임베드 캡션")] }),
  ], ctx);
  assert.equal(md, [
    "![스크린샷](/api/ui/notion-assets/testasset.png)",
    "", "![](https://img.example/y.png)",
    "", "📎 [문서.pdf](/api/ui/notion-assets/testasset.png)",
    "", "📎 [최종본 (계약.pdf)](/api/ui/notion-assets/testasset.png)",  // 캡션+파일명 둘 다 보존(#551 리뷰)
    "", "🔖 [북마크 설명](https://example.com)",
    "", "🔖 [임베드 캡션](https://embed.example/x)",  // embed 캡션 유실 회귀(#551 리뷰)
  ].join("\n"));
  assert.deepEqual(assets, ["image", "file", "file"]);
}
// 표 — 열 헤더 + 행 헤더(굵게) + 파이프 이스케이프
{
  const { ctx } = makeCtx();
  const row = (cells: string[][]) => b("table_row", { cells: cells.map((c) => c.map((t) => rt(t))) });
  const md = blocksToMd([
    b("table", { table_width: 2, has_column_header: true, has_row_header: true }, {
      _children: [
        row([["이름"], ["값 | 단위"]]),
        row([["속도"], ["3rps"]]),
      ],
    }),
  ], ctx);
  assert.equal(md, "| 이름 | 값 \\| 단위 |\n| --- | --- |\n| **속도** | 3rps |");
}
// 컬럼 레이아웃 · synced(원본/복제/유실) · child_page/child_database · link_to_page
{
  const { ctx, links } = makeCtx();
  const md = blocksToMd([
    b("column_list", {}, {
      _children: [
        { object: "block", id: "c1", type: "column", column: { width_ratio: 0.5 }, _children: [b("paragraph", { rich_text: [rt("왼쪽")] })] },
        { object: "block", id: "c2", type: "column", column: {}, _children: [b("paragraph", { rich_text: [rt("오른쪽")] })] },
      ],
    }),
    b("synced_block", { synced_from: null }, { _children: [b("paragraph", { rich_text: [rt("원본 동기화")] })] }),
    b("synced_block", { synced_from: { type: "block_id", block_id: PAGE_B } }, { _children: [b("paragraph", { rich_text: [rt("복제 내용")] })] }),
    b("synced_block", { synced_from: { type: "block_id", block_id: UNKNOWN } }, { _children: [] }),
    { object: "block", id: PAGE_A, type: "child_page", child_page: { title: "하위 페이지" } },
    { object: "block", id: PAGE_B, type: "child_database", child_database: { title: "하위 DB" } },
    b("link_to_page", { type: "page_id", page_id: PAGE_A }),
  ], ctx);
  assert.equal(md, [
    ":::columns", ":::column ratio=0.5", "왼쪽", ":::", ":::column", "오른쪽", ":::", ":::",
    "", "원본 동기화",
    "", `:::synced from=${PAGE_B}`, "복제 내용", ":::",
    "", `:::synced from=${UNKNOWN} missing=true`, ":::",
    "", `📄 [하위 페이지](#/k/notion-${PAGE_A})`,
    "", `🗄 [하위 DB](#/k/notion-${PAGE_B})`,
    "", `🔗 [페이지A](#/k/notion-${PAGE_A})`,
  ].join("\n"));
  assert.deepEqual(links.map((l) => l.kind), ["child", "child", "link_to_page"]);
}
// 미지 블록 — rich_text 있으면 텍스트 보존, 없으면 unsupported 마커(조용한 손실 금지)
{
  const { ctx } = makeCtx();
  const md = blocksToMd([
    b("new_fancy_block", { rich_text: [rt("신형 블록 텍스트")] }),
    b("mystery", {}),
    b("unsupported", {}),
  ], ctx);
  assert.equal(md, "신형 블록 텍스트\n\n:::unsupported type=mystery id=b-mystery\n:::\n\n:::unsupported type=unsupported id=b-unsupported\n:::");
}

// ── 속성 정규화 + 표 ──
{
  const { ctx, links } = makeCtx();
  const props = {
    "이름": { id: "t", type: "title", title: [rt("행 제목")] },
    "상태": { id: "s", type: "status", status: { name: "진행중", color: "blue" } },
    "태그": { id: "m", type: "multi_select", multi_select: [{ name: "A", color: "red" }, { name: "B", color: "blue" }] },
    "기한": { id: "d", type: "date", date: { start: "2026-07-04", end: "2026-07-10" } },
    "담당": { id: "p", type: "people", people: [{ object: "user", id: "u1" }] },
    "완료": { id: "c", type: "checkbox", checkbox: true },
    "관계": { id: "r", type: "relation", relation: [{ id: PAGE_A }, { id: UNKNOWN }] },
    "번호": { id: "u", type: "unique_id", unique_id: { prefix: "LV", number: 42 } },
    "수식": { id: "f", type: "formula", formula: { type: "number", number: 7 } },
    "링크": { id: "l", type: "url", url: "https://example.com" },
  };
  const norm = normalizeProperties(props, ctx);
  assert.equal(norm["상태"].text, "진행중");
  assert.equal(norm["태그"].text, "A, B");
  assert.equal(norm["기한"].text, "2026-07-04 → 2026-07-10");
  assert.equal(norm["담당"].text, "@윤상민");
  assert.equal(norm["완료"].text, "✅");
  assert.equal(norm["관계"].text, `[페이지A](#/k/notion-${PAGE_A}), (99999999…)`);
  assert.equal(norm["번호"].text, "LV-42");
  assert.equal(norm["수식"].text, "7");
  assert.ok(links.some((l) => l.id === PAGE_A && l.kind === "relation"));
  const table = propertiesTableMd(norm);
  assert.ok(table.startsWith("| 속성 | 값 |"));
  assert.ok(!table.includes("행 제목"), "title 속성은 표에서 제외(페이지 제목과 중복)");
  assert.ok(table.includes("| 상태 | 진행중 |"));
}

// ── DB 스키마 표 ──
{
  const schema = dataSourceSchemaMd([{
    id: "ds1", title: [rt("메인")],
    properties: {
      "상태": { type: "status", status: { options: [{ name: "todo" }, { name: "done" }], groups: [] } },
      "심각도": { type: "select", select: { options: [{ name: "낮음", color: "gray" }, { name: "높음", color: "red" }] } },
      "점수": { type: "number", number: { format: "number" } },
    },
  } as any]);
  assert.ok(schema.includes("| 상태 | status | todo, done |"));
  assert.ok(schema.includes("| 심각도 | select | 낮음, 높음 |"));
  assert.ok(schema.includes("| 점수 | number | number |"));
}

// ── 댓글 스레드 ──
{
  const { ctx } = makeCtx();
  const md = commentsToMd([
    { id: "c1", discussion_id: "d1", created_time: "2026-07-01T10:00:00Z", created_by: { object: "user", id: "u1" }, rich_text: [rt("첫 댓글")] },
    { id: "c2", discussion_id: "d1", created_time: "2026-07-01T11:00:00Z", created_by: { object: "user", id: "u2" }, rich_text: [rt("답글")] },
  ] as any, ctx);
  assert.ok(md.includes("## 💬 댓글"));
  assert.ok(md.includes("- **윤상민** (2026-07-01 10:00): 첫 댓글"));
  assert.ok(md.includes("  - **익명** (2026-07-01 11:00): 답글"));
}

console.log("notion-md.test OK — 블록 전수 골든·rich text·속성·스키마·댓글 통과");
