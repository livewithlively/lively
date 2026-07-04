// Notion 블록 트리 → 마크다운 무손실 변환기 (#551) — 순수 함수(네트워크/FS 없음, 단위테스트 대상).
//
//   무손실 원칙(설계 notion-lossless-sync-551-design):
//   · 원장(ledger) = knowledge.raw 에 블록 트리 원본 JSON 전체 보존 — 이 모듈은 '뷰'(body_md)를 만든다.
//   · 뷰는 **우리 웹 렌더러(web/core.ts renderMarkdown) 방언**을 표적 — HTML 폴백 불가(렌더러가 XSS 방어로
//     innerHTML 금지)라, 마크다운 표준에 없는 구조(토글/콜아웃/컬럼 등)는 `:::타입 …` ~ `:::` 컨테이너
//     디렉티브로 표현한다(렌더러가 해석; 다른 MD 소비자에겐 읽히는 평문 마커로 우아하게 강등).
//   · 미지 블록/멘션 타입은 절대 죽이지 않는다 — rich_text 있으면 텍스트로, 없으면 :::unsupported 마커로
//     표면화(+원장 보존). 새 Notion 타입이 나와도 손실이 '조용히' 일어나지 않게.
//
//   컨테이너 문법(렌더러와 계약):
//     :::toggle <요약 인라인 md>     …자식…  :::
//     :::callout icon=💡 color=gray_background   …본문…  :::
//     :::columns  /  :::column ratio=0.5   …  :::   (중첩)
//     :::synced from=<uuid> [missing=true]  …  :::
//     :::toc  :::   ·  :::unsupported type=<t> id=<id>  :::
//   인라인 확장: ~~취소선~~ · ++밑줄++ · ==하이라이트==(배경색) · $수식$ · 체크박스 `- [ ]`/`- [x]`.
//
//   블록 트리 형태: 트래버설(notion.ts)이 has_children 블록에 자식 배열을 `_children` 로 부착한 재귀 구조.
import type { NotionRichText } from "./notion-types.js";

// ── 변환 컨텍스트 — 트래버설이 주입(순수성 유지: 이 모듈은 fetch 를 모른다) ──
export interface NotionMdCtx {
  /** notion uuid → 내부 지식 좌표(있으면 내부 링크로 재작성). null 이면 외부 URL 유지. */
  resolveRef(notionId: string): { name: string; title: string | null } | null;
  /** user uuid → 표시명(없으면 null — plain_text 폴백). */
  resolveUser(userId: string): string | null;
  /** 파일류 객체 → 참조 URL. 트래버설이 다운로드를 등록하고 로컬 라우트(/api/ui/notion-assets/…) 또는 원본 URL 을 돌려준다. */
  assetUrl(file: unknown, hint: { blockId?: string; kind: string; name?: string }): string | null;
  /** 링크 엣지 수집(페이지→페이지 연결구조) — kind: mention|inline|link_to_page|relation|child. */
  addLink(targetNotionId: string, kind: string): void;
}

type Rec = Record<string, unknown>;
const asRec = (v: unknown): Rec => (v && typeof v === "object" ? (v as Rec) : {});
const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

// notion uuid 정규화 — API 캐노니컬(소문자, 하이픈 포함). URL 에서 뽑은 32-hex 는 하이픈 삽입.
export function normalizeNotionId(id: string): string {
  const s = String(id || "").trim().toLowerCase().replace(/[^0-9a-f]/g, "");
  if (s.length !== 32) return String(id || "").trim().toLowerCase();
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

// notion.so URL → page/database uuid (없으면 null). 딥링크 재작성·링크 엣지용.
//  형태: https://www.notion.so/<slug>-<32hex>[?…] | https://www.notion.so/<32hex> | #<32hex>(블록 앵커는 페이지 id 아님 → 경로만).
export function notionIdFromUrl(url: string): string | null {
  try {
    const u = new URL(url);
    if (!/(^|\.)notion\.(so|site)$/.test(u.hostname)) return null;
    const path = u.pathname.split("/").filter(Boolean).pop() ?? "";
    const m = path.match(/([0-9a-fA-F]{32})$/);
    if (m) return normalizeNotionId(m[1]);
    return null;
  } catch { return null; }
}

// ── rich text → 인라인 md ─────────────────────────────────────────────────────
function annotate(text: string, ann: Rec): string {
  if (!text) return text;
  let t = text;
  if (ann.code) t = "`" + t.replace(/`/g, "'") + "`";
  if (ann.bold) t = `**${t}**`;
  if (ann.italic) t = `*${t}*`;
  if (ann.strikethrough) t = `~~${t}~~`;
  if (ann.underline) t = `++${t}++`;
  const color = typeof ann.color === "string" ? ann.color : "default";
  if (color.endsWith("_background") && color !== "default") t = `==${t}==`;
  return t;
}

/** rich_text 배열 → 인라인 마크다운. 멘션/링크는 내부 좌표로 재작성 + 링크 엣지 수집. */
export function richTextToMd(rts: unknown, ctx: NotionMdCtx): string {
  const out: string[] = [];
  for (const rtu of asArr(rts)) {
    const rt = asRec(rtu) as NotionRichText & Rec;
    const plain = String(rt.plain_text ?? "");
    const ann = asRec(rt.annotations);
    const href = typeof rt.href === "string" ? rt.href : null;

    let piece: string;
    if (rt.type === "equation") {
      const expr = String(asRec(rt.equation).expression ?? plain);
      piece = `$${expr}$`;
    } else if (rt.type === "mention") {
      piece = mentionToMd(asRec(rt.mention), plain, ctx);
    } else {
      // type === 'text' (또는 미지 타입 — plain_text 폴백)
      const content = String(asRec(rt.text).content ?? plain);
      piece = annotate(content, ann);
      const linkUrl = (asRec(rt.text).link ? String(asRec(asRec(rt.text).link).url ?? "") : "") || href || "";
      if (linkUrl) piece = wrapLink(piece, linkUrl, ctx, "inline");
      out.push(piece);
      continue;
    }
    // mention/equation 도 annotations·href 존중(노션이 멘션에 서식을 허용).
    piece = annotate(piece, ann);
    if (href && rt.type !== "mention") piece = wrapLink(piece, href, ctx, "inline");
    out.push(piece);
  }
  return out.join("");
}

// URL 이 노션 내부 페이지면 내부 링크(#/k/<name>)로 재작성 + 엣지, 아니면 그대로.
function wrapLink(label: string, url: string, ctx: NotionMdCtx, kind: string): string {
  const nid = notionIdFromUrl(url);
  if (nid) {
    ctx.addLink(nid, kind);
    const ref = ctx.resolveRef(nid);
    if (ref) return `[${label || ref.title || "페이지"}](#/k/${ref.name})`;
  }
  return `[${label || url}](${url})`;
}

function mentionToMd(m: Rec, plain: string, ctx: NotionMdCtx): string {
  const type = String(m.type ?? "");
  switch (type) {
    case "page": {
      const id = normalizeNotionId(String(asRec(m.page).id ?? ""));
      if (id) {
        ctx.addLink(id, "mention");
        const ref = ctx.resolveRef(id);
        if (ref) return `[${plain || ref.title || "페이지"}](#/k/${ref.name})`;
      }
      return plain || "(페이지)";
    }
    case "database": {
      const id = normalizeNotionId(String(asRec(m.database).id ?? ""));
      if (id) {
        ctx.addLink(id, "mention");
        const ref = ctx.resolveRef(id);
        if (ref) return `[${plain || ref.title || "데이터베이스"}](#/k/${ref.name})`;
      }
      return plain || "(데이터베이스)";
    }
    case "data_source": { // 2025-09+ — data_source 멘션은 소유 DB 로 폴딩(트래버설의 resolveRef 가 처리)
      const id = normalizeNotionId(String(asRec(m.data_source).id ?? ""));
      if (id) {
        ctx.addLink(id, "mention");
        const ref = ctx.resolveRef(id);
        if (ref) return `[${plain || ref.title || "데이터베이스"}](#/k/${ref.name})`;
      }
      return plain || "(데이터베이스)";
    }
    case "user": {
      const id = String(asRec(m.user).id ?? "");
      const name = (id && ctx.resolveUser(id)) || plain || "사용자";
      return `@${name.replace(/^@/, "")}`;
    }
    case "date": {
      const d = asRec(m.date);
      const s = String(d.start ?? "");
      const e = d.end ? ` → ${String(d.end)}` : "";
      return `📅 ${s}${e}` || plain;
    }
    case "link_preview": case "link_mention": {
      const url = String(asRec(m[type]).url ?? m.url ?? "");
      return url ? wrapLink(plain || url, url, ctx, "mention") : plain;
    }
    case "template_mention": return plain || "(템플릿)";
    case "custom_emoji": {
      const ce = asRec(m.custom_emoji);
      return `:${String(ce.name ?? "emoji")}:`;
    }
    default: return plain || `(${type || "멘션"})`; // 미지 멘션 — 텍스트 보존(원장에 원본)
  }
}

// ── 블록 트리 → md ────────────────────────────────────────────────────────────
const CHILD_KEY = "_children";

function children(b: Rec): Rec[] { return asArr(b[CHILD_KEY]).map(asRec); }

function blockText(b: Rec, ctx: NotionMdCtx): string {
  return richTextToMd(asRec(b[String(b.type)]).rich_text, ctx);
}

function pushBlank(lines: string[]): void {
  if (lines.length && lines[lines.length - 1] !== "") lines.push("");
}

// 자식들을 별도 walk 로 md 화(컨테이너/인용 내부용).
function childrenToMd(b: Rec, ctx: NotionMdCtx): string {
  return blocksToMd(children(b), ctx).trim();
}

function indent(text: string, pad: string): string {
  return text.split("\n").map((l) => (l ? pad + l : l)).join("\n");
}

function fileUrlOf(fobj: Rec): { url: string; expiring: boolean } {
  const t = String(fobj.type ?? "");
  if (t === "external") return { url: String(asRec(fobj.external).url ?? ""), expiring: false };
  if (t === "file") return { url: String(asRec(fobj.file).url ?? ""), expiring: true };
  if (t === "file_upload") return { url: "", expiring: false };
  // icon 등에서 {url} 평면형도 관용
  return { url: String(fobj.url ?? ""), expiring: false };
}

function captionOf(b: Rec, type: string, ctx: NotionMdCtx): string {
  return richTextToMd(asRec(b[type]).caption, ctx).trim();
}

// 미디어/파일 블록 공통 — 자산 다운로드 참조 + 캡션.
function mediaToMd(b: Rec, type: string, ctx: NotionMdCtx): string[] {
  const inner = asRec(b[type]);
  const cap = captionOf(b, type, ctx);
  const name = String(inner.name ?? "");
  const url = ctx.assetUrl(inner, { blockId: String(b.id ?? ""), kind: type, name }) ?? fileUrlOf(inner).url;
  if (!url) return cap ? [`*(${type}: ${cap})*`] : [`*(${type})*`];
  if (type === "image") return [`![${cap || name}](${url})`];
  const icon = type === "video" ? "🎬" : type === "audio" ? "🎵" : "📎";
  const label = cap || name || type;
  const lines = [`${icon} [${label}](${url})`];
  return lines;
}

/** 블록 배열(형제 시퀀스) → 마크다운. 리스트 연속 그룹·번호 계산·중첩 들여쓰기 포함. */
export function blocksToMd(blocks: unknown, ctx: NotionMdCtx): string {
  const lines: string[] = [];
  const arr = asArr(blocks).map(asRec);
  let numCounter = 0;
  let prevType = "";

  for (const b of arr) {
    const type = String(b.type ?? "");
    // 번호 리스트 카운터 — 연속 numbered 형제만 증가, 끊기면 리셋. list_start_index(2026)로 시작값 보존.
    if (type === "numbered_list_item") {
      const start = Number(asRec(b[type]).list_start_index);
      if (prevType !== "numbered_list_item") numCounter = Number.isFinite(start) && start > 0 ? start : 1;
      else numCounter += 1;
    }
    emitBlock(b, type, lines, ctx, numCounter);
    prevType = type;
  }
  // 연속 빈 줄 압축
  const out: string[] = [];
  for (const l of lines) {
    if (l === "" && out[out.length - 1] === "") continue;
    out.push(l);
  }
  return out.join("\n").replace(/^\n+|\n+$/g, "");
}

function emitBlock(b: Rec, type: string, lines: string[], ctx: NotionMdCtx, num: number): void {
  const inner = asRec(b[type]);
  switch (type) {
    case "paragraph": {
      const t = blockText(b, ctx);
      pushBlank(lines);
      if (t) lines.push(t);
      const kids = childrenToMd(b, ctx);
      if (kids) { lines.push(indent(kids, "  ")); }
      pushBlank(lines);
      return;
    }
    case "heading_1": case "heading_2": case "heading_3": case "heading_4": {
      const level = Number(type.slice(-1));
      const t = blockText(b, ctx);
      pushBlank(lines);
      lines.push(`${"#".repeat(Math.min(level, 6))} ${t}`.trimEnd());
      // 토글 헤딩 — 숨은 자식은 details 컨테이너로.
      if (inner.is_toggleable && children(b).length) {
        lines.push(":::toggle 펼치기");
        lines.push(childrenToMd(b, ctx));
        lines.push(":::");
      } else if (children(b).length) {
        lines.push(childrenToMd(b, ctx));
      }
      pushBlank(lines);
      return;
    }
    case "bulleted_list_item": case "numbered_list_item": case "to_do": {
      const t = blockText(b, ctx);
      let marker: string;
      if (type === "bulleted_list_item") marker = "- ";
      else if (type === "numbered_list_item") marker = `${num}. `;
      else marker = asRec(b[type]).checked ? "- [x] " : "- [ ] ";
      lines.push(marker + t);
      const kids = childrenToMd(b, ctx);
      if (kids) lines.push(indent(kids, "  "));
      return;
    }
    case "toggle": {
      const t = blockText(b, ctx);
      pushBlank(lines);
      lines.push(`:::toggle ${t}`.trimEnd());
      const kids = childrenToMd(b, ctx);
      if (kids) lines.push(kids);
      lines.push(":::");
      pushBlank(lines);
      return;
    }
    case "quote": {
      const t = blockText(b, ctx);
      pushBlank(lines);
      const body = [t, childrenToMd(b, ctx)].filter(Boolean).join("\n");
      for (const l of body.split("\n")) lines.push(l ? `> ${l}` : ">");
      pushBlank(lines);
      return;
    }
    case "callout": {
      const icon = calloutIcon(asRec(inner.icon), ctx, String(b.id ?? ""));
      const color = String(inner.color ?? "default");
      pushBlank(lines);
      lines.push(`:::callout${icon ? ` icon=${icon}` : ""}${color !== "default" ? ` color=${color}` : ""}`);
      const body = [blockText(b, ctx), childrenToMd(b, ctx)].filter(Boolean).join("\n\n");
      if (body) lines.push(body);
      lines.push(":::");
      pushBlank(lines);
      return;
    }
    case "code": {
      const lang = String(inner.language ?? "");
      const t = richTextToPlain(inner.rich_text);
      pushBlank(lines);
      lines.push("```" + (lang === "plain text" ? "" : lang));
      lines.push(t);
      lines.push("```");
      const cap = captionOf(b, type, ctx);
      if (cap) lines.push(`*${cap}*`);
      pushBlank(lines);
      return;
    }
    case "equation": {
      pushBlank(lines);
      lines.push("$$");
      lines.push(String(inner.expression ?? ""));
      lines.push("$$");
      pushBlank(lines);
      return;
    }
    case "divider": pushBlank(lines); lines.push("---"); pushBlank(lines); return;
    case "table_of_contents": pushBlank(lines); lines.push(":::toc"); lines.push(":::"); pushBlank(lines); return;
    case "breadcrumb": return; // 시각 요소(현 위치 표시) — 뷰 생략, 원장 보존
    case "image": case "video": case "audio": case "file": case "pdf": {
      pushBlank(lines);
      for (const l of mediaToMd(b, type, ctx)) lines.push(l);
      pushBlank(lines);
      return;
    }
    case "bookmark": case "embed": case "link_preview": {
      const url = String(inner.url ?? "");
      const cap = type === "bookmark" ? captionOf(b, type, ctx) : "";
      pushBlank(lines);
      if (url) lines.push(`🔖 ${wrapLink(cap || url, url, ctx, "inline")}`);
      else if (cap) lines.push(`🔖 ${cap}`);
      pushBlank(lines);
      return;
    }
    case "link_to_page": {
      const targetId = normalizeNotionId(String(inner.page_id ?? inner.database_id ?? inner.data_source_id ?? asRec(inner).comment_id ?? ""));
      pushBlank(lines);
      if (targetId) {
        ctx.addLink(targetId, "link_to_page");
        const ref = ctx.resolveRef(targetId);
        lines.push(ref ? `🔗 [${ref.title || "페이지"}](#/k/${ref.name})` : `🔗 (외부 페이지 ${targetId})`);
      }
      pushBlank(lines);
      return;
    }
    case "child_page": {
      const id = normalizeNotionId(String(b.id ?? ""));
      const title = String(inner.title ?? "") || "(제목 없음)";
      ctx.addLink(id, "child");
      const ref = ctx.resolveRef(id);
      pushBlank(lines);
      lines.push(ref ? `📄 [${title}](#/k/${ref.name})` : `📄 ${title}`);
      pushBlank(lines);
      return;
    }
    case "child_database": {
      const id = normalizeNotionId(String(b.id ?? ""));
      const title = String(inner.title ?? "") || "(제목 없음)";
      ctx.addLink(id, "child");
      const ref = ctx.resolveRef(id);
      pushBlank(lines);
      lines.push(ref ? `🗄 [${title}](#/k/${ref.name})` : `🗄 ${title}`);
      pushBlank(lines);
      return;
    }
    case "column_list": {
      pushBlank(lines);
      lines.push(":::columns");
      for (const col of children(b)) {
        const ratio = Number(asRec(col.column).width_ratio);
        lines.push(`:::column${Number.isFinite(ratio) && ratio > 0 ? ` ratio=${ratio}` : ""}`);
        const body = blocksToMd(children(col), ctx).trim();
        if (body) lines.push(body);
        lines.push(":::");
      }
      lines.push(":::");
      pushBlank(lines);
      return;
    }
    case "column": { // column_list 밖에서 단독 등장(방어) — 자식만 평탄화
      const kids = childrenToMd(b, ctx);
      if (kids) lines.push(kids);
      return;
    }
    case "synced_block": {
      const from = asRec(inner.synced_from);
      const fromId = inner.synced_from == null ? null : normalizeNotionId(String(from.block_id ?? ""));
      const kids = childrenToMd(b, ctx);
      pushBlank(lines);
      if (fromId) {
        lines.push(`:::synced from=${fromId}${kids ? "" : " missing=true"}`);
        if (kids) lines.push(kids);
        lines.push(":::");
      } else if (kids) {
        lines.push(kids); // 원본 synced — 마커 없이 콘텐츠 그대로(원장에 synced 사실 보존)
      }
      pushBlank(lines);
      return;
    }
    case "table": {
      emitTable(b, lines, ctx);
      return;
    }
    case "table_row": return; // table 이 소비(단독 등장 시 무시 — 원장 보존)
    case "template": {
      const t = blockText(b, ctx);
      pushBlank(lines);
      lines.push(`:::toggle 🧩 템플릿: ${t}`.trimEnd());
      const kids = childrenToMd(b, ctx);
      if (kids) lines.push(kids);
      lines.push(":::");
      pushBlank(lines);
      return;
    }
    case "unsupported": {
      pushBlank(lines);
      lines.push(`:::unsupported type=unsupported id=${String(b.id ?? "")}`);
      lines.push(":::");
      pushBlank(lines);
      return;
    }
    default: {
      // 미지 타입(tab/meeting_notes/신규…) — rich_text·title 있으면 텍스트 보존, 자식 재귀. 아무 것도 없으면 마커.
      const t = blockText(b, ctx) || (typeof inner.title === "string" ? String(inner.title) : "");
      const kids = childrenToMd(b, ctx);
      pushBlank(lines);
      if (t || kids) {
        if (t) lines.push(t);
        if (kids) lines.push(kids);
      } else {
        lines.push(`:::unsupported type=${type} id=${String(b.id ?? "")}`);
        lines.push(":::");
      }
      pushBlank(lines);
      return;
    }
  }
}

function calloutIcon(icon: Rec, ctx: NotionMdCtx, blockId: string): string {
  const t = String(icon.type ?? "");
  if (t === "emoji") return String(icon.emoji ?? "");
  if (t === "external" || t === "file" || t === "custom_emoji") {
    // 파일형 아이콘은 다운로드 등록만(마커에 URL 을 박으면 만료·장황) — 뷰에선 생략 가능.
    ctx.assetUrl(icon, { blockId, kind: "callout_icon" });
    return "";
  }
  return "";
}

function richTextToPlain(rts: unknown): string {
  return asArr(rts).map((r) => String(asRec(r).plain_text ?? "")).join("");
}

function emitTable(b: Rec, lines: string[], ctx: NotionMdCtx): void {
  const inner = asRec(b.table);
  const hasColHeader = inner.has_column_header === true;
  const hasRowHeader = inner.has_row_header === true;
  const rows = children(b).filter((r) => String(r.type) === "table_row");
  const width = Number(inner.table_width) || Math.max(0, ...rows.map((r) => asArr(asRec(r.table_row).cells).length));
  if (!rows.length || !width) return;

  const cellMd = (cell: unknown): string =>
    richTextToMd(cell, ctx).replace(/\|/g, "\\|").replace(/\n/g, " ").trim();

  const rowCells = (r: Rec): string[] => {
    const cells = asArr(asRec(r.table_row).cells).map(cellMd);
    while (cells.length < width) cells.push("");
    return cells;
  };

  pushBlank(lines);
  let bodyRows = rows;
  if (hasColHeader) {
    lines.push(`| ${rowCells(rows[0]).join(" | ")} |`);
    bodyRows = rows.slice(1);
  } else {
    lines.push(`| ${Array.from({ length: width }, () => " ").join(" | ")} |`); // 헤더 없는 표 — 빈 헤더
  }
  lines.push(`|${Array.from({ length: width }, () => " --- ").join("|")}|`);
  for (const r of bodyRows) {
    const cells = rowCells(r);
    if (hasRowHeader && cells[0]) cells[0] = `**${cells[0]}**`;
    lines.push(`| ${cells.join(" | ")} |`);
  }
  pushBlank(lines);
}

// ── 페이지 속성(properties) → 정규화 값 + md 표 ────────────────────────────────
export interface NormalizedProp { type: string; text: string; value: unknown }

/** property 값 객체 1개 → {type, text(사람이 읽는), value(구조 보존)} — 링크 엣지(relation)도 수집. */
export function propertyToNormalized(prop: unknown, ctx: NotionMdCtx): NormalizedProp {
  const p = asRec(prop);
  const type = String(p.type ?? "");
  const v = p[type];
  const opt = (o: unknown): string => String(asRec(o).name ?? "");
  switch (type) {
    case "title": case "rich_text":
      return { type, text: richTextToMd(v, ctx), value: richTextToPlain(v) };
    case "number": return { type, text: v == null ? "" : String(v), value: v ?? null };
    case "checkbox": return { type, text: v ? "✅" : "☐", value: !!v };
    case "select": case "status":
      return { type, text: v ? opt(v) : "", value: v ? { name: opt(v), color: asRec(v).color ?? null } : null };
    case "multi_select":
      return { type, text: asArr(v).map(opt).join(", "), value: asArr(v).map((o) => ({ name: opt(o), color: asRec(o).color ?? null })) };
    case "date": {
      const d = asRec(v);
      const text = v ? `${String(d.start ?? "")}${d.end ? ` → ${String(d.end)}` : ""}` : "";
      return { type, text, value: v ?? null };
    }
    case "people": {
      const names = asArr(v).map((u) => {
        const ur = asRec(u);
        return ctx.resolveUser(String(ur.id ?? "")) || String(ur.name ?? "") || String(ur.id ?? "");
      });
      return { type, text: names.map((n) => `@${n}`).join(", "), value: asArr(v).map((u) => asRec(u).id ?? null) };
    }
    case "files": {
      const parts = asArr(v).map((f, i) => {
        const fr = asRec(f);
        const name = String(fr.name ?? `파일${i + 1}`);
        const url = ctx.assetUrl(fr, { kind: "property_file", name }) ?? fileUrlOf(fr).url;
        return url ? `[${name}](${url})` : name;
      });
      return { type, text: parts.join(", "), value: asArr(v).map((f) => asRec(f).name ?? null) };
    }
    case "url": return { type, text: v ? `[${String(v)}](${String(v)})` : "", value: v ?? null };
    case "email": case "phone_number": return { type, text: v == null ? "" : String(v), value: v ?? null };
    case "formula": {
      const f = asRec(v);
      const ft = String(f.type ?? "");
      const fv = f[ft];
      const text = ft === "date" ? String(asRec(fv).start ?? "") : fv == null ? "" : String(fv);
      return { type, text, value: v ?? null };
    }
    case "relation": {
      const ids = asArr(v).map((r) => normalizeNotionId(String(asRec(r).id ?? ""))).filter(Boolean);
      const parts = ids.map((id) => {
        ctx.addLink(id, "relation");
        const ref = ctx.resolveRef(id);
        return ref ? `[${ref.title || "항목"}](#/k/${ref.name})` : `(${id.slice(0, 8)}…)`;
      });
      return { type, text: parts.join(", "), value: ids };
    }
    case "rollup": {
      const r = asRec(v);
      const rt = String(r.type ?? "");
      if (rt === "array") {
        const items = asArr(r.array).map((it) => propertyToNormalized(it, ctx).text).filter(Boolean);
        return { type, text: items.join(", "), value: r ?? null };
      }
      const rv = r[rt];
      const text = rt === "date" ? String(asRec(rv).start ?? "") : rv == null ? "" : String(rv);
      return { type, text, value: r ?? null };
    }
    case "created_time": case "last_edited_time": return { type, text: String(v ?? ""), value: v ?? null };
    case "created_by": case "last_edited_by": {
      const ur = asRec(v);
      const name = ctx.resolveUser(String(ur.id ?? "")) || String(ur.name ?? "") || "";
      return { type, text: name ? `@${name}` : "", value: ur.id ?? null };
    }
    case "unique_id": {
      const u = asRec(v);
      const text = `${u.prefix ? String(u.prefix) + "-" : ""}${String(u.number ?? "")}`;
      return { type, text, value: v ?? null };
    }
    case "verification": {
      const s = String(asRec(v).state ?? "");
      return { type, text: s === "verified" ? "✔ 검증됨" : s, value: v ?? null };
    }
    case "button": case "place": return { type, text: "", value: v ?? null }; // API 미지원 속성 — 원장만
    default: {
      // 미지 속성 타입 — 문자열화 폴백(조용한 손실 방지) + 원장 보존.
      const text = v == null ? "" : typeof v === "string" ? v : JSON.stringify(v);
      return { type: type || "unknown", text, value: v ?? null };
    }
  }
}

/** properties 전체 → { [이름]: NormalizedProp } (title 제외 옵션). */
export function normalizeProperties(props: unknown, ctx: NotionMdCtx): Record<string, NormalizedProp> {
  const out: Record<string, NormalizedProp> = {};
  for (const [name, p] of Object.entries(asRec(props))) out[name] = propertyToNormalized(p, ctx);
  return out;
}

/** DB 행 속성 md 표 — title 속성은 제외(페이지 제목과 중복). 값 없는 속성도 행 유지(스키마 가시성). */
export function propertiesTableMd(norm: Record<string, NormalizedProp>): string {
  const rows = Object.entries(norm).filter(([, v]) => v.type !== "title");
  if (!rows.length) return "";
  const lines = ["| 속성 | 값 |", "| --- | --- |"];
  for (const [name, v] of rows) {
    lines.push(`| ${name.replace(/\|/g, "\\|")} | ${(v.text || "").replace(/\|/g, "\\|").replace(/\n/g, " ")} |`);
  }
  return lines.join("\n");
}

/** 데이터소스 스키마(properties 정의) → md 표 — DB 노드 본문용(옵션·색까지 표기). */
export function dataSourceSchemaMd(dsList: unknown[]): string {
  const lines: string[] = [];
  for (const dsu of dsList) {
    const ds = asRec(dsu);
    const dsTitle = richTextToPlain(ds.title) || String(asRec(ds).name ?? "");
    if (dsList.length > 1) lines.push(`### ${dsTitle || "데이터소스"}`, "");
    lines.push("| 속성 | 타입 | 상세 |", "| --- | --- | --- |");
    for (const [pname, pdefu] of Object.entries(asRec(ds.properties))) {
      const pdef = asRec(pdefu);
      const ptype = String(pdef.type ?? "");
      let detail = "";
      if (ptype === "select" || ptype === "multi_select") {
        detail = asArr(asRec(pdef[ptype]).options).map((o) => String(asRec(o).name ?? "")).join(", ");
      } else if (ptype === "status") {
        detail = asArr(asRec(pdef.status).options).map((o) => String(asRec(o).name ?? "")).join(", ");
      } else if (ptype === "relation") {
        detail = "관계";
      } else if (ptype === "formula") {
        detail = "`" + String(asRec(pdef.formula).expression ?? "") + "`";
      } else if (ptype === "rollup") {
        const r = asRec(pdef.rollup);
        detail = `${String(r.rollup_property_name ?? "")} · ${String(r.function ?? "")}`;
      } else if (ptype === "number") {
        detail = String(asRec(pdef.number).format ?? "");
      }
      lines.push(`| ${pname.replace(/\|/g, "\\|")} | ${ptype} | ${detail.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  return lines.join("\n").trim();
}

// ── 댓글 → md 섹션 ────────────────────────────────────────────────────────────
/** 댓글 목록(플랫) → discussion_id 스레드 복원 md. 빈 배열이면 "". */
export function commentsToMd(comments: unknown[], ctx: NotionMdCtx): string {
  if (!comments.length) return "";
  const threads = new Map<string, Rec[]>();
  for (const cu of comments) {
    const c = asRec(cu);
    const did = String(c.discussion_id ?? c.id ?? "");
    if (!threads.has(did)) threads.set(did, []);
    threads.get(did)!.push(c);
  }
  const lines: string[] = ["---", "", "## 💬 댓글", ""];
  for (const [, thread] of threads) {
    thread.sort((a, b) => String(a.created_time ?? "").localeCompare(String(b.created_time ?? "")));
    thread.forEach((c, i) => {
      const who = ctx.resolveUser(String(asRec(c.created_by).id ?? "")) || String(c.display_name ? asRec(c.display_name).resolved_name ?? "" : "") || "익명";
      const when = String(c.created_time ?? "").slice(0, 16).replace("T", " ");
      const text = richTextToMd(c.rich_text, ctx);
      const prefix = i === 0 ? "- " : "  - ";
      lines.push(`${prefix}**${who}** (${when}): ${text}`);
      for (const au of asArr(c.attachments)) {
        const a = asRec(au);
        const url = ctx.assetUrl(a, { kind: "comment_attachment", name: String(a.category ?? "첨부") }) ?? "";
        if (url) lines.push(`${i === 0 ? "  " : "    "}- 📎 [첨부](${url})`);
      }
    });
  }
  return lines.join("\n");
}
