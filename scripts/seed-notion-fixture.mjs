#!/usr/bin/env node
// #551 노션 무손실 싱크 검증 픽스처 생성기 — 실제 워크스페이스에 '모든 블록 타입·구조·연결'을 가진
// 페이지 트리를 만든다(사용자 승인 하에). 이후 full 싱크 → verify-notion-sync.mjs 로 전수 대조.
//
//   사용: node --env-file-if-exists=.env scripts/seed-notion-fixture.mjs [--parent <page_id>]
//   필요 env: NOTION_TOKEN (insert content capability 필요)
//   산출: 생성한 객체 id 매니페스트를 stdout(JSON) + NOTION_FIXTURE_MANIFEST(기본 ./notion-fixture-manifest.json)
//
//   포함: 문단(서식 전조합·인라인 링크·페이지/사용자/날짜 멘션·인라인 수식) · h1~3(+토글 헤딩) ·
//   불릿(3중첩)·번호·할일 · 토글(7중첩) · 인용(자식) · 콜아웃(아이콘+색) · 코드(+캡션) · 수식 블록 ·
//   구분선 · TOC · breadcrumb · 북마크(+캡션) · embed · 이미지(external + **file_upload 업로드**) · 비디오 ·
//   표(열/행 헤더 + 파이프 문자 셀) · 컬럼 2단 · synced(원본+참조) · link_to_page ·
//   하위 페이지 6단 체인 · 인라인 DB 2개(select/multi/date/people/checkbox/url/email/phone/files/formula/
//   relation(>25개 — has_more 페이지네이션 유발)/rollup) + 행 페이지 본문 · 페이지 아이콘/커버 · 댓글 스레드.
import fs from "node:fs";

const API = "https://api.notion.com/v1";
const VER = process.env.NOTION_API_VERSION || "2025-09-03";
const TOKEN = process.env.NOTION_TOKEN;
if (!TOKEN) { console.error("NOTION_TOKEN 필요"); process.exit(2); }
const argParent = process.argv.includes("--parent") ? process.argv[process.argv.indexOf("--parent") + 1] : null;

let last = 0;
async function notion(path, init) {
  for (let a = 0; a <= 5; a++) {
    const w = last + 350 - Date.now();
    if (w > 0) await new Promise((r) => setTimeout(r, w));
    last = Date.now();
    const res = await fetch(path.startsWith("http") ? path : API + path, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${TOKEN}`, "Notion-Version": VER,
        ...(init?.form ? {} : { "Content-Type": "application/json" }),
      },
      body: init?.form ? init.form : init?.body != null ? JSON.stringify(init.body) : undefined,
    });
    if (res.status === 429 || res.status >= 500) {
      const ra = Number(res.headers.get("retry-after"));
      await res.text().catch(() => {});
      if (a < 5) { await new Promise((r) => setTimeout(r, ra > 0 ? ra * 1000 : 800 * (a + 1))); continue; }
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Notion ${res.status} ${init?.method ?? "GET"} ${path}: ${t.slice(0, 400)}`);
    }
    return res.json();
  }
}

const rt = (text, ann, extra) => ({ type: "text", text: { content: text, ...(extra?.link ? { link: { url: extra.link } } : {}) }, ...(ann ? { annotations: ann } : {}) });
const para = (rich) => ({ type: "paragraph", paragraph: { rich_text: Array.isArray(rich) ? rich : [rt(rich)] } });
const manifest = { created_at: new Date().toISOString(), pages: {}, dbs: {}, blocks: {} };

async function appendChildren(blockId, children) {
  const out = [];
  for (let i = 0; i < children.length; i += 50) {
    const d = await notion(`/blocks/${blockId}/children`, { method: "PATCH", body: { children: children.slice(i, i + 50) } });
    out.push(...(d.results ?? []));
  }
  return out;
}

async function createPage(parentId, title, opts = {}) {
  const d = await notion("/pages", { method: "POST", body: {
    parent: { type: "page_id", page_id: parentId },
    ...(opts.icon ? { icon: { type: "emoji", emoji: opts.icon } } : {}),
    ...(opts.cover ? { cover: { type: "external", external: { url: opts.cover } } } : {}),
    properties: { title: { title: [rt(title)] } },
    ...(opts.children ? { children: opts.children } : {}),
  } });
  console.error(`  페이지: ${title} → ${d.id}`);
  return d;
}

// ── 0. 부모 결정 — 인자 > 워크스페이스 루트 페이지 아무거나 ──
let parentId = argParent;
if (!parentId) {
  const s = await notion("/search", { method: "POST", body: { filter: { property: "object", value: "page" }, page_size: 100 } });
  const rootish = (s.results ?? []).find((p) => p.parent?.type === "workspace") ?? (s.results ?? [])[0];
  if (!rootish) { console.error("접근 가능한 페이지가 없음 — --parent 로 지정 필요"); process.exit(2); }
  parentId = rootish.id;
  console.error(`부모 페이지: ${parentId} (${rootish.parent?.type})`);
}

// ── 1. 루트 픽스처 페이지 ──
const root = await createPage(parentId, "#551 무손실 싱크 검증 픽스처", {
  icon: "🧪", cover: "https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1200",
  children: [para("이 트리는 노션 커넥터 무손실 싱크 검증용 픽스처입니다(자동 생성). 모든 블록 타입·구조·연결을 포함합니다.")],
});
manifest.pages.root = root.id;

// ── 2. P1 블록 타입 전수 ──
const p1 = await createPage(root.id, "P1 블록 타입 전수", { icon: "📚" });
manifest.pages.p1 = p1.id;
const p3 = await createPage(root.id, "P3 링크 그래프 허브", { icon: "🔗" });
manifest.pages.p3 = p3.id;

// 사용자 1명(멘션·people 용)
let userId = null;
try {
  const us = await notion("/users?page_size=20");
  userId = (us.results ?? []).find((u) => u.type === "person")?.id ?? null;
} catch {}

const p1Blocks = [
  { type: "heading_1", heading_1: { rich_text: [rt("제1장 서식")] } },
  para([
    rt("굵게", { bold: true }), rt(" · "),
    rt("기울임", { italic: true }), rt(" · "),
    rt("취소", { strikethrough: true }), rt(" · "),
    rt("밑줄", { underline: true }), rt(" · "),
    rt("코드조각", { code: true }), rt(" · "),
    rt("노랑배경", { color: "yellow_background" }), rt(" · "),
    rt("빨강글자", { color: "red" }), rt(" · "),
    rt("외부링크텍스트", null, { link: "https://lively.example.com/docs" }),
  ]),
  para([
    rt("페이지 멘션: "),
    { type: "mention", mention: { page: { id: p3.id } } },
    rt(" · 날짜 멘션: "),
    { type: "mention", mention: { date: { start: "2026-07-04" } } },
    ...(userId ? [rt(" · 사용자 멘션: "), { type: "mention", mention: { user: { id: userId } } }] : []),
    rt(" · 인라인 수식: "),
    { type: "equation", equation: { expression: "e^{i\\pi}+1=0" } },
  ]),
  { type: "heading_2", heading_2: { rich_text: [rt("제2장 리스트")] } },
  { type: "bulleted_list_item", bulleted_list_item: { rich_text: [rt("불릿 1층")], children: [
    { type: "bulleted_list_item", bulleted_list_item: { rich_text: [rt("불릿 2층")], children: [
      { type: "bulleted_list_item", bulleted_list_item: { rich_text: [rt("불릿 3층 — 깊이 확인")] } },
    ] } },
  ] } },
  { type: "numbered_list_item", numbered_list_item: { rich_text: [rt("번호 하나")] } },
  { type: "numbered_list_item", numbered_list_item: { rich_text: [rt("번호 둘")] } },
  { type: "to_do", to_do: { rich_text: [rt("할 일 미완")], checked: false } },
  { type: "to_do", to_do: { rich_text: [rt("할 일 완료")], checked: true } },
  { type: "heading_3", heading_3: { rich_text: [rt("제3장 구조 블록")] } },
  { type: "quote", quote: { rich_text: [rt("인용문 본문입니다.")], children: [para("인용 안의 하위 문단.")] } },
  { type: "callout", callout: { rich_text: [rt("콜아웃 — 아이콘과 배경색을 가진 강조 상자.")], icon: { type: "emoji", emoji: "💡" }, color: "yellow_background" } },
  { type: "code", code: { rich_text: [rt("const 무손실 = (x) => x | 0; // 파이프 포함")], language: "typescript", caption: [rt("코드 캡션 텍스트")] } },
  { type: "equation", equation: { expression: "\\int_0^1 x^2 \\, dx = \\tfrac{1}{3}" } },
  { type: "divider", divider: {} },
  { type: "table_of_contents", table_of_contents: {} },
  { type: "breadcrumb", breadcrumb: {} },
  { type: "bookmark", bookmark: { url: "https://developers.notion.com/reference/block", caption: [rt("노션 블록 레퍼런스 북마크")] } },
  { type: "embed", embed: { url: "https://www.openstreetmap.org/export/embed.html?bbox=126.9,37.5,127.0,37.6" } },
  { type: "image", image: { type: "external", external: { url: "https://upload.wikimedia.org/wikipedia/commons/thumb/4/47/PNG_transparency_demonstration_1.png/280px-PNG_transparency_demonstration_1.png" }, caption: [rt("외부 이미지 캡션")] } },
  { type: "video", video: { type: "external", external: { url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" } } },
  { type: "table", table: { table_width: 3, has_column_header: true, has_row_header: true, children: [
    { type: "table_row", table_row: { cells: [[rt("항목")], [rt("값 | 단위")], [rt("비고")]] } },
    { type: "table_row", table_row: { cells: [[rt("속도")], [rt("3", { bold: true }), rt("rps")], [rt("스로틀")]] } },
    { type: "table_row", table_row: { cells: [[rt("깊이")], [rt("무제한")], [rt("순환가드 64")]] } },
  ] } },
  { type: "column_list", column_list: { children: [
    { type: "column", column: { children: [para("왼쪽 컬럼 내용 — 레이아웃 검증.")] } },
    { type: "column", column: { children: [para("오른쪽 컬럼 내용 — flex 강등 확인.")] } },
  ] } },
  { type: "link_to_page", link_to_page: { type: "page_id", page_id: p3.id } },
];
await appendChildren(p1.id, p1Blocks);

// 토글 헤딩(+자식) · synced 원본/참조 — 생성 후 자식 append 가 필요한 것들
{
  const r = await appendChildren(p1.id, [
    { type: "heading_2", heading_2: { rich_text: [rt("접히는 헤딩(토글)")], is_toggleable: true } },
    { type: "toggle", toggle: { rich_text: [rt("토글 — 눌러서 펼치기")] } },
    { type: "synced_block", synced_block: { synced_from: null, children: [para("동기화 원본 콘텐츠입니다.")] } },
  ]);
  const [thead, toggle, synced] = r;
  await appendChildren(thead.id, [para("토글 헤딩 안에 숨은 내용.")]);
  await appendChildren(toggle.id, [para("토글 내부 1층."), { type: "bulleted_list_item", bulleted_list_item: { rich_text: [rt("토글 내부 리스트")] } }]);
  manifest.blocks.synced_original = synced.id;
  await appendChildren(p1.id, [
    { type: "synced_block", synced_block: { synced_from: { type: "block_id", block_id: synced.id } } },
  ]);
}

// 업로드 이미지(file_upload → notion 호스팅 → 1시간 만료 URL → 커넥터 다운로드 검증 대상)
try {
  // 16x16 빨간 PNG 생성(순수 바이트)
  const { deflateSync } = await import("node:zlib");
  const crcTable = (() => { const t = []; for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const W = 16, H = 16;
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  const rowsPx = Buffer.concat(Array.from({ length: H }, () => Buffer.concat([Buffer.from([0]), Buffer.alloc(W * 3).fill(Buffer.from([220, 40, 40]))])));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rowsPx)), chunk("IEND", Buffer.alloc(0))]);

  const fu = await notion("/file_uploads", { method: "POST", body: { mode: "single_part", filename: "fixture-red.png" } });
  const form = new FormData();
  form.append("file", new Blob([png], { type: "image/png" }), "fixture-red.png");
  await notion(`/file_uploads/${fu.id}/send`, { method: "POST", form });
  await appendChildren(p1.id, [
    { type: "image", image: { type: "file_upload", file_upload: { id: fu.id }, caption: [rt("업로드 이미지(노션 호스팅 — 만료 URL 다운로드 검증)")] } },
  ]);
  manifest.blocks.uploaded_image = fu.id;
  console.error("  업로드 이미지 OK");
} catch (e) { console.error("  업로드 이미지 실패(스킵):", e.message); }

// ── 3. P2 깊은 중첩 — 토글 7단 + 하위 페이지 6단 체인 ──
const p2 = await createPage(root.id, "P2 깊은 중첩", { icon: "🕳️" });
manifest.pages.p2 = p2.id;
{
  let cur = p2.id;
  for (let d = 1; d <= 7; d++) {
    const r = await appendChildren(cur, [{ type: "toggle", toggle: { rich_text: [rt(`토글 깊이 ${d}`)] } }]);
    await appendChildren(r[0].id, [para(`깊이 ${d} 의 본문 내용 — 구버전 깊이5 절단 회귀 검증.`)]);
    cur = r[0].id;
  }
  let curPage = p2.id;
  for (let d = 1; d <= 6; d++) {
    const cp = await createPage(curPage, `체인 하위 ${d}단`, { children: [para(`체인 깊이 ${d} 페이지 본문.`)] });
    manifest.pages[`chain${d}`] = cp.id;
    curPage = cp.id;
  }
}

// ── 4. 링크 그래프 — P3 허브에 세 종류 링크 ──
{
  const p1Url = (await notion(`/pages/${p1.id}`)).url;
  await appendChildren(p3.id, [
    para([rt("인라인 링크로 "), rt("P1 블록 전수", null, { link: p1Url }), rt(" 를 가리킨다.")]),
    para([rt("멘션으로 "), { type: "mention", mention: { page: { id: p2.id } } }, rt(" 를 가리킨다.")]),
    { type: "link_to_page", link_to_page: { type: "page_id", page_id: root.id } },
  ]);
}

// ── 5. 데이터베이스 — DB2(관계 대상, 30행) + DB1(전 속성 + relation>25 + rollup) ──
const dbHost = await createPage(root.id, "P4 데이터베이스 컨테이너", { icon: "🗄️" });
manifest.pages.p4 = dbHost.id;

const db2 = await notion("/databases", { method: "POST", body: {
  parent: { type: "page_id", page_id: dbHost.id },
  title: [rt("DB2 관계 대상")],
  initial_data_source: { properties: { "이름": { title: {} }, "점수": { number: { format: "number" } } } },
} });
manifest.dbs.db2 = db2.id;
const ds2 = db2.data_sources?.[0]?.id;
console.error(`  DB2 → ${db2.id} (ds ${ds2})`);
const db2Rows = [];
for (let i = 1; i <= 30; i++) {
  const row = await notion("/pages", { method: "POST", body: {
    parent: { type: "data_source_id", data_source_id: ds2 },
    properties: { "이름": { title: [rt(`대상 ${String(i).padStart(2, "0")}`)] }, "점수": { number: i } },
  } });
  db2Rows.push(row.id);
}
console.error("  DB2 행 30개 OK");

const db1 = await notion("/databases", { method: "POST", body: {
  parent: { type: "page_id", page_id: dbHost.id },
  title: [rt("DB1 전속성 검증")],
  initial_data_source: { properties: {
    "이름": { title: {} },
    "설명": { rich_text: {} },
    "수치": { number: { format: "number" } },
    "선택": { select: { options: [{ name: "낮음", color: "gray" }, { name: "높음", color: "red" }] } },
    "다중": { multi_select: { options: [{ name: "알파", color: "blue" }, { name: "베타", color: "green" }, { name: "감마", color: "purple" }] } },
    "날짜": { date: {} },
    "사람": { people: {} },
    "체크": { checkbox: {} },
    "링크": { url: {} },
    "메일": { email: {} },
    "전화": { phone_number: {} },
    "파일": { files: {} },
    "수식": { formula: { expression: "prop(\"수치\") * 2" } },
    "관계": { relation: { data_source_id: ds2, single_property: {} } },
  } },
} });
manifest.dbs.db1 = db1.id;
const ds1 = db1.data_sources?.[0]?.id;
console.error(`  DB1 → ${db1.id} (ds ${ds1})`);
try {
  await notion(`/data_sources/${ds1}`, { method: "PATCH", body: { properties: {
    "롤업": { rollup: { relation_property_name: "관계", rollup_property_name: "점수", function: "sum" } },
  } } });
  console.error("  DB1 롤업 속성 OK");
} catch (e) { console.error("  롤업 추가 실패(스킵):", e.message); }

const db1RowDefs = [
  { name: "행1 — 관계 30개(초과 페이지네이션)", rel: db2Rows, num: 10, sel: "높음", multi: ["알파", "베타"], check: true },
  { name: "행2 — 부분 속성", rel: db2Rows.slice(0, 2), num: 5, sel: "낮음", multi: ["감마"], check: false },
  { name: "행3 | 파이프 포함 제목", rel: [], num: 0, sel: null, multi: [], check: false },
];
for (const def of db1RowDefs) {
  const row = await notion("/pages", { method: "POST", body: {
    parent: { type: "data_source_id", data_source_id: ds1 },
    properties: {
      "이름": { title: [rt(def.name)] },
      "설명": { rich_text: [rt("리치 "), rt("서식", { bold: true }), rt(" 설명")] },
      "수치": { number: def.num },
      ...(def.sel ? { "선택": { select: { name: def.sel } } } : {}),
      "다중": { multi_select: def.multi.map((name) => ({ name })) },
      "날짜": { date: { start: "2026-07-01", end: "2026-07-31" } },
      ...(userId ? { "사람": { people: [{ id: userId }] } } : {}),
      "체크": { checkbox: def.check },
      "링크": { url: "https://lively.example.com" },
      "메일": { email: "dabetai@snu.ac.kr" },
      "전화": { phone_number: "+82-10-0000-0000" },
      "파일": { files: [{ type: "external", name: "외부파일.pdf", external: { url: "https://example.com/doc.pdf" } }] },
      "관계": { relation: def.rel.map((id) => ({ id })) },
    },
    children: [para(`${def.name} 의 행 본문 콘텐츠.`)],
  } });
  manifest.pages["db1row_" + def.name.slice(0, 4)] = row.id;
}
console.error("  DB1 행 3개 OK");

// ── 6. 댓글 스레드(P1) ──
try {
  const c1 = await notion("/comments", { method: "POST", body: { parent: { page_id: p1.id }, rich_text: [rt("검증용 첫 댓글입니다.")] } });
  await notion("/comments", { method: "POST", body: { discussion_id: c1.discussion_id, rich_text: [rt("같은 스레드의 답글입니다.")] } });
  console.error("  댓글 스레드 OK");
} catch (e) { console.error("  댓글 실패(스킵 — capability 없을 수 있음):", e.message); }

const out = process.env.NOTION_FIXTURE_MANIFEST || "./notion-fixture-manifest.json";
fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
console.error(`\n픽스처 생성 완료 — 매니페스트: ${out}`);
console.log(JSON.stringify(manifest, null, 2));
