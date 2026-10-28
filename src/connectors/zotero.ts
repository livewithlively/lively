// Zotero 커넥터 — 연구자의 라이브러리에서 **논문 한 편 = 자료 한 건**으로 모은다.
//
// ── 무엇을 모으나 (조사: 지식 zotero-collect-what-researchers-need) ───────────────────────────
//  연구자의 «생각»은 서지가 아니라 **주석(하이라이트·코멘트)과 노트**에 있다. 서지·초록·컬렉션·수동 태그는 그 생각을
//  어느 논문·어느 주제에 붙일지 정하는 뼈대다. 그래서 기본은 서지 + 초록 + 컬렉션 + 수동 태그 + 주석 + 노트이고,
//  사람이 고르는 것은 셋이다 — 전문 색인(include_fulltext, 기본 끔: 논문 자체지 연구자의 생각이 아니고 저작권·용량 부담),
//  자동 태그(include_auto_tags, 기본 끔: DB 가 붙인 주제어라 잡음), 그리고 주석·노트 자체(include_annotations·include_notes, 기본 켬).
//  PDF 파일은 받지 않는다 — 핵심 구간은 주석 원문이 이미 담고 있다.
//
// ── 왜 «논문 한 편 = 자료 한 건» 인가 ─────────────────────────────────────────────────
//  Zotero 는 주석을 논문이 아니라 **PDF 첨부에** 단다(주석 → 첨부 → 논문, 2026-10-26 공개 그룹 실측). 주석 한 줄은
//  "p.3 노랑 «...»" 라 그 자체로는 뜻이 없고, 논문의 제목·저자·다른 하이라이트와 함께 읽어야 무엇을 중요하다고 봤는지가 보인다.
//  그래서 커넥터가 논문 아래의 노트·첨부·주석을 한 본문으로 묶는다. 주석이 하나 더 달리면 그 논문 자료가 제자리에서 갱신된다
//  (외부 좌표 upsert) — 증류도 «논문 1편 = 지식 1» 로 같은 지식을 고쳐 쓴다.
//  독립 노트(논문에 안 붙은 노트)는 그 자체가 생각이라 따로 한 건이다.
//
// ── 범위 ─────────────────────────────────────────────────────────────────────────
//  · libraries — `users/<id>` · `groups/<id>` (공백 구분, zotero.org 그룹 주소 그대로도 된다). 비우면 이 키가 읽을 수 있는
//    라이브러리 전부(개인 + 키에 열린 그룹). 가시성의 울타리는 키 자체다 — 키에 안 열린 그룹은 목록에 안 나온다.
//  · collections — 컬렉션 key(8자, 공백 구분). 그 컬렉션(하위 포함)이 **있는 라이브러리만** 그 컬렉션으로 좁힌다.
//    개인 라이브러리엔 연구와 무관한 자료가 섞이는 일이 흔하고, Zotero 는 일부만 동기화하는 길이 없다 — 좁히기는 여기서 한다.
//
// ── 공개범위 ─────────────────────────────────────────────────────────────────────────
//  개인·그룹 라이브러리 모두 조직의 자료 공개범위 정책을 그대로 따른다(채널 = 라이브러리 이름) — 커넥터가 따로 잠그지 않는다.
//  워크스페이스에 연결한다는 것 자체가 «팀과 함께 쓰겠다»는 뜻이다(장원준 2026-10-28, #2202). 예전엔 개인 라이브러리를
//  주인에게만 잠갔는데(audience), 그 자료는 주인이 아닌 신원으로 도는 증류에 보이지 않아 영영 지식이 되지 못했다(#5072).
//  이미 잠겨 들어온 자료는 부팅 조정기가 푼다(v6/vis-personal-unlock.ts).
//
// ── 증분 ─────────────────────────────────────────────────────────────────────────
//  run-sync 의 커서 = 자료 updated_at 의 최대. 논문 자료의 updated_at 은 «논문과 그 아래 노트·첨부·주석 중 가장 늦은 수정»이다.
//  증분 run 은 dateModified 내림차순으로 바뀐 항목만 받고(경계에서 멈춘다) 그 항목이 속한 논문을 다시 묶는다.
//  ⚠ 휴지통·삭제는 따라가지 않는다 — /items 는 휴지통을 빼고 주고, 지운 것은 이미 모은 자료로 남는다.
//  ⚠ 다른 PDF 앱(Acrobat 등)으로 파일 안에 단 주석은 Zotero 가 동기화하지 않아 여기 오지 않는다
//   (zotero/zotero syncLocal.js «Don't sync external annotations»). 사람에게는 Zotero 의 [Import Annotations] 를 안내한다.
//
// ── 인증·예절 ─────────────────────────────────────────────────────────────────────
//  개인 API 키(zotero.org/settings/keys)를 Zotero-API-Key 헤더로. 노트는 키에 «Allow notes access» 가 있어야 읽힌다.
//  Zotero 는 Backoff·429 Retry-After 를 지키고 동시 요청을 4개 이하로 하라고 한다 — 이 커넥터는 한 번에 하나씩만 부른다.
import type { Connector, RawItem, BackfillOpts } from "./types.js";
import { resolveConnectorConfig } from "./config.js";

const API = "https://api.zotero.org";
const PAGE = 100;
/** 라이브러리 하나를 한 run 에 훑는 상한(100건 × 2000쪽 = 20만 항목 — 주석·첨부 포함). 넘으면 run 을 실패시킨다:
 *  조용히 멈추면 커서가 전진해 꼬리가 영영 빠진다(full 쪽은 정렬이 없어 «다음 run 이 이어 가기»가 성립하지 않는다). */
const MAX_PAGES = 2000;
/** 증분 창을 이만큼 뒤로 넓힌다 — dateModified 는 서버가 아니라 **편집한 클라이언트의 시계**라, 오프라인에서 고친 것이
 *  늦게 동기화되면 커서보다 과거 시각으로 들어온다. 다시 받는 것은 멱등 upsert 라 무해하다(본문이 같으면 갱신도 없다). */
const LOOKBACK_MS = 3 * 86_400_000;
/** 요청 하나의 상한 — 걸린 소켓이 run 을 «살아 있는 채» 붙잡지 않게. */
const REQUEST_TIMEOUT_MS = 60_000;
/** 증분에서 다시 묶을 논문이 이만큼을 넘으면 라이브러리를 통째로 받는 편이 요청 수가 적다(논문마다 children 왕복 2회 이상). */
const FULL_FALLBACK = 300;
/** 전문 색인을 본문에 실을 때 논문당 상한 — 넘는 부분은 잘라 내고 그 사실을 적는다. */
const FULLTEXT_MAX = 30_000;
/** 증류 사전필터가 «생각이 담긴 논문»을 고르는 표지 — 본문에 이 머리가 있어야 주석·노트가 있는 것이다(zotero-preset.ts). */
export const ANNOTATION_HEAD = "## 하이라이트·코멘트";
export const NOTE_HEAD = "## 노트";

// ── 순수 함수 (테스트가 직접 본다) ─────────────────────────────────────────────────────

export interface ZoteroLibrary { kind: "users" | "groups"; id: string; name?: string }

export const libraryPath = (l: Pick<ZoteroLibrary, "kind" | "id">): string => `${l.kind}/${l.id}`;

/**
 * 사람이 적은 라이브러리 목록 → 라이브러리. 받아들이는 형태: `users/123` · `groups/456` ·
 *  zotero.org 그룹 주소(`https://www.zotero.org/groups/456/…`) · `me`(이 키의 개인 라이브러리 — userId 가 있을 때만).
 *  못 알아보면 건너뛰고 unknown 에 담는다 — 호출자가 경고한다(조용한 무수집 방지).
 */
export function parseLibraryList(v: string | undefined, userId?: string): { libs: ZoteroLibrary[]; unknown: string[] } {
  const libs: ZoteroLibrary[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  const add = (kind: "users" | "groups", id: string) => {
    const k = `${kind}/${id}`;
    if (!seen.has(k)) { seen.add(k); libs.push({ kind, id }); }
  };
  for (const raw of String(v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/^(users|groups)\/(\d+)$/i);
    if (m) { add(m[1].toLowerCase() as "users" | "groups", m[2]); continue; }
    const u = raw.match(/zotero\.org\/groups\/(\d+)/i);
    if (u) { add("groups", u[1]); continue; }
    if (/^me$/i.test(raw) && userId) { add("users", userId); continue; }
    unknown.push(raw);
  }
  return { libs, unknown };
}

/** 사람이 적은 컬렉션 key 목록(8자 영숫자, 공백 구분). zotero.org 컬렉션 주소의 `collections/<key>` 도 받는다. */
export function parseCollectionKeys(v: string | undefined): string[] {
  const out = new Set<string>();
  for (const raw of String(v ?? "").split(/[\s,]+/).map((s) => s.trim()).filter(Boolean)) {
    const m = raw.match(/collections\/([A-Z0-9]{8})/i) ?? raw.match(/^([A-Z0-9]{8})$/i);
    if (m) out.add(m[1].toUpperCase());
  }
  return [...out];
}

/** 하위 컬렉션까지 펼친다 — Zotero 항목의 collections 는 바로 위 컬렉션만 적혀 있어 부모를 고르면 하위가 빠진다. */
export function expandCollections(picked: string[], all: Array<{ key: string; parentCollection?: string | false }>): Set<string> {
  const children = new Map<string, string[]>();
  for (const c of all) {
    const p = typeof c.parentCollection === "string" ? c.parentCollection : "";
    if (p) children.set(p, [...(children.get(p) ?? []), c.key]);
  }
  const out = new Set<string>();
  const stack = picked.filter((k) => all.some((c) => c.key === k));
  while (stack.length) {
    const k = stack.pop()!;
    if (out.has(k)) continue;
    out.add(k);
    stack.push(...(children.get(k) ?? []));
  }
  return out;
}

/** Zotero 리더의 기본 색 8개 → 사람 말. 사람마다 색에 의미를 두므로(노랑=핵심, 빨강=반박 …) 색 이름을 남겨 증류가 묻게 한다. */
const COLOR_NAME: Record<string, string> = {
  "#ffd400": "노랑", "#ff6666": "빨강", "#5fb236": "초록", "#2ea8e5": "파랑",
  "#a28ae5": "보라", "#e56eee": "자홍", "#f19837": "주황", "#aaaaaa": "회색",
};
export function colorName(hex: string | undefined): string {
  const h = String(hex ?? "").trim().toLowerCase();
  return COLOR_NAME[h] ?? (h ? h : "");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
/** 노트 HTML → 읽을 수 있는 글. 문단·목록·줄바꿈만 살리고 나머지 태그는 걷는다(노트는 Zotero 편집기의 HTML 이다). */
export function noteHtmlToText(html: string | undefined): string {
  let s = String(html ?? "");
  s = s.replace(/<\s*br\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")   // 항목은 여는 태그가 줄을 바꾼다 — 닫는 태그까지 바꾸면 항목 사이에 빈 줄이 생긴다
    .replace(/<\s*\/\s*li\s*>/gi, "")
    .replace(/<\s*\/\s*(p|div|h[1-6]|ul|ol|blockquote|tr)\s*>/gi, "\n")
    .replace(/<\s*h([1-6])[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");
  s = s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      //  범위 밖(&#99999999;)·서로게이트는 fromCodePoint 가 던진다 — 노트 하나가 라이브러리 수집 전체를 세우지 않게 그대로 둔다.
      return Number.isInteger(n) && n > 0 && n <= 0x10ffff && !(n >= 0xd800 && n <= 0xdfff) ? String.fromCodePoint(n) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
  return s.split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

interface ZCreator { creatorType?: string; firstName?: string; lastName?: string; name?: string }
interface ZTag { tag?: string; type?: number }
export interface ZItemData {
  key: string;
  version?: number;
  itemType: string;
  title?: string;
  creators?: ZCreator[];
  abstractNote?: string;
  date?: string;
  publicationTitle?: string;
  bookTitle?: string;
  proceedingsTitle?: string;
  university?: string;
  publisher?: string;
  DOI?: string;
  url?: string;
  tags?: ZTag[];
  collections?: string[];
  parentItem?: string;
  note?: string;
  contentType?: string;
  filename?: string;
  annotationType?: string;
  annotationText?: string;
  annotationComment?: string;
  annotationColor?: string;
  annotationPageLabel?: string;
  annotationSortIndex?: string;
  dateAdded?: string;
  dateModified?: string;
}
interface ZUser { id?: number; username?: string; name?: string }
export interface ZItem { key: string; version?: number; meta?: { createdByUser?: ZUser; numChildren?: number }; data: ZItemData }

/** 저자 한 줄 — 셋까지 쓰고 나머지는 «외 n명». */
export function creatorsLine(cs: ZCreator[] | undefined): string {
  const names = (cs ?? []).filter((c) => !c.creatorType || c.creatorType === "author" || c.creatorType === "editor")
    .map((c) => (c.name ?? [c.firstName, c.lastName].filter(Boolean).join(" ")).trim()).filter(Boolean);
  if (names.length <= 3) return names.join(", ");
  return `${names.slice(0, 3).join(", ")} 외 ${names.length - 3}명`;
}

export function yearOf(date: string | undefined): string {
  const m = String(date ?? "").match(/\b(1[5-9]\d\d|20\d\d|21\d\d)\b/);
  return m ? m[1] : "";
}

/** 사람 이름 — 그룹 라이브러리의 «누가 달았나». 개인 라이브러리엔 meta.createdByUser 가 없다. */
const whoOf = (it: ZItem): string => String(it.meta?.createdByUser?.name || it.meta?.createdByUser?.username || "").trim();

/** 논문 아래에 묶이는 것 — 노트·첨부(그 아래 주석)·전문. */
export interface PaperBundle {
  notes: ZItem[];
  attachments: Array<{ item: ZItem; annotations: ZItem[]; fulltext?: string }>;
}

export interface PaperOpts {
  includeAnnotations: boolean;
  includeNotes: boolean;
  includeAutoTags: boolean;
}

const annSortKey = (a: ZItem): string => String(a.data.annotationSortIndex ?? "") || String(a.data.dateAdded ?? "");

/** 주석 한 줄 — `p.3 [노랑] «원문» — 코멘트: … (이름)`. 내용이 없는 이미지·잉크 주석은 null(세기만 한다). */
export function annotationLine(a: ZItem, withAuthor: boolean): string | null {
  const d = a.data;
  const t = String(d.annotationType ?? "");
  const quote = t === "text" ? "" : String(d.annotationText ?? "").replace(/\s+/g, " ").trim();
  const comment = String(d.annotationComment ?? "").replace(/\s+/g, " ").trim();
  if (!quote && !comment) return null;
  //  쪽 이름이 없는 PDF 는 Zotero 가 «-» 를 넣는다(2026-10-26 공개 그룹 실측) — 그건 쪽이 아니다.
  const page = String(d.annotationPageLabel ?? "").trim();
  const head = [page && page !== "-" ? `p.${page}` : "", colorName(d.annotationColor) ? `[${colorName(d.annotationColor)}]` : ""]
    .filter(Boolean).join(" ");
  const kind = t === "underline" ? "밑줄 " : t === "note" || t === "text" ? "메모 " : t === "image" ? "그림 영역 " : "";
  const parts = [head, quote ? `${kind}«${quote}»` : kind.trim()].filter(Boolean).join(" ");
  const who = withAuthor && whoOf(a) ? ` (${whoOf(a)})` : "";
  return `- ${parts}${comment ? `${quote ? " — " : " "}코멘트: ${comment}` : ""}${who}`.replace(/^- +/, "- ");
}

/** 수동 태그(type 0/없음)만 — 자동 태그(type 1)는 옵션이 켤 때만. */
export function tagList(tags: ZTag[] | undefined, includeAuto: boolean): string[] {
  return (tags ?? []).filter((t) => t.tag && (includeAuto || Number(t.type ?? 0) !== 1)).map((t) => String(t.tag));
}

/** 그 논문이 실린 곳 — 학술지·책·학회·학위 수여 기관 중 있는 것. */
const venueOf = (d: ZItemData): string =>
  String(d.publicationTitle || d.proceedingsTitle || d.bookTitle || d.university || d.publisher || "").trim();

export interface PaperDoc { body: string; annotationCount: number; noteCount: number; updatedAt: string | undefined }

/**
 * 논문 한 편 → 본문. 순수(네트워크 불요) — 매핑 규약을 테스트가 본다.
 *  주석·노트가 있으면 ANNOTATION_HEAD·NOTE_HEAD 머리를 단다(증류 사전필터의 표지). 없으면 그 머리를 쓰지 않는다.
 */
export function buildPaperDoc(
  paper: ZItem, bundle: PaperBundle, opts: PaperOpts, ctx: { libraryName: string; collectionNames: string[]; group: boolean },
): PaperDoc {
  const d = paper.data;
  const lines: string[] = [];
  const title = String(d.title || d.filename || "(제목 없음)").trim();
  lines.push(`# ${title}`);
  const byline = [creatorsLine(d.creators), yearOf(d.date), venueOf(d)].filter(Boolean).join(" · ");
  if (byline) lines.push(byline);
  const ids = [d.DOI ? `DOI: ${d.DOI}` : "", d.url ? `URL: ${d.url}` : ""].filter(Boolean).join(" · ");
  if (ids) lines.push(ids);
  const where = [`라이브러리: ${ctx.libraryName}`, ctx.collectionNames.length ? `컬렉션: ${ctx.collectionNames.join(", ")}` : ""]
    .filter(Boolean).join(" · ");
  lines.push(where);
  const tags = tagList(d.tags, opts.includeAutoTags);
  if (tags.length) lines.push(`태그: ${tags.join(", ")}`);
  if (ctx.group && whoOf(paper)) lines.push(`추가한 사람: ${whoOf(paper)}`);
  if (d.abstractNote?.trim()) lines.push("", "## 초록", d.abstractNote.trim());

  let annotationCount = 0;
  //  수정 시각은 **종류를 껐어도** 모든 자식에서 잰다 — 꺼 둔 주석이 바뀌어 다시 묶여 올 때 updated_at 이 그대로면
  //   커서가 그 자리에 멈춰 같은 논문을 매 run 다시 받는다.
  let latest = Date.parse(String(d.dateModified ?? "")) || 0;
  const bump = (it: ZItem) => { const t = Date.parse(String(it.data.dateModified ?? "")); if (t > latest) latest = t; };
  for (const n of bundle.notes) bump(n);
  for (const a of bundle.attachments) { bump(a.item); for (const x of a.annotations) bump(x); }

  if (opts.includeAnnotations) {
    const blocks: string[] = [];
    let skipped = 0;
    for (const a of bundle.attachments) {
      const rows: string[] = [];
      for (const ann of [...a.annotations].sort((x, y) => annSortKey(x).localeCompare(annSortKey(y)))) {
        const ln = annotationLine(ann, ctx.group);
        if (ln) { rows.push(ln); annotationCount++; } else skipped++;
      }
      if (!rows.length) continue;
      // 첨부가 하나면 이름을 따로 달지 않는다(대개 «PDF» 라 군말이다). 여럿이면 어느 파일의 주석인지가 뜻을 가른다.
      if (bundle.attachments.filter((x) => x.annotations.length).length > 1) {
        blocks.push(`### ${String(a.item.data.title || a.item.data.filename || "첨부")}`);
      }
      blocks.push(...rows);
    }
    if (annotationCount) {
      lines.push("", `${ANNOTATION_HEAD} (${annotationCount})`, ...blocks);
      if (skipped) lines.push(`(글이 없는 그림·손글씨 주석 ${skipped}개는 뺐습니다)`);
    }
  }

  let noteCount = 0;
  if (opts.includeNotes) {
    const blocks: string[] = [];
    for (const n of [...bundle.notes].sort((x, y) => String(x.data.dateAdded ?? "").localeCompare(String(y.data.dateAdded ?? "")))) {
      const text = noteHtmlToText(n.data.note);
      if (!text) continue;
      noteCount++;
      const meta = [ctx.group ? whoOf(n) : "", String(n.data.dateModified ?? "").slice(0, 10)].filter(Boolean).join(" · ");
      blocks.push(`### 노트 ${noteCount}${meta ? ` (${meta})` : ""}`, text);
    }
    if (noteCount) lines.push("", `${NOTE_HEAD} (${noteCount})`, ...blocks);
  }

  const texts = bundle.attachments.map((a) => a.fulltext ?? "").filter((t) => t.trim());
  if (texts.length) {
    let ft = texts.join("\n\n").trim();
    const cut = ft.length > FULLTEXT_MAX;
    if (cut) ft = ft.slice(0, FULLTEXT_MAX);
    lines.push("", "## 본문(전문 색인)", ft + (cut ? `\n\n(본문이 길어 앞 ${FULLTEXT_MAX.toLocaleString("en-US")}자까지만 실었습니다)` : ""));
  }

  return { body: lines.join("\n").trim(), annotationCount, noteCount, updatedAt: latest ? new Date(latest).toISOString() : undefined };
}

/** 사람이 열 수 있는 주소 — 개인은 사용자 이름, 그룹은 그룹 id(zotero.org 가 이름 붙은 주소로 넘겨 준다 — 302 실측).
 *  개인 라이브러리인데 사용자 이름을 모르면 주소를 만들지 않는다(틀린 주소보다 없는 주소가 낫다). */
export function zoteroItemUrl(lib: ZoteroLibrary, key: string, username?: string): string | undefined {
  if (lib.kind === "groups") return `https://www.zotero.org/groups/${lib.id}/items/${key}`;
  return username ? `https://www.zotero.org/${encodeURIComponent(username)}/items/${key}` : undefined;
}

export interface ItemCtx {
  lib: ZoteroLibrary;
  libraryName: string;
  collectionNames: string[];
  username?: string;
  /** 개인 라이브러리면 그 주인(구성원 id) — 누구의 라이브러리인지 기록만 한다(잠그지 않는다). */
  owner?: string;
}

/** 논문 한 편 → RawItem. 자료의 단위는 **논문 한 편**(노트·주석은 본문 안에), 독립 노트는 같은 모양의 한 건. */
export function paperToItem(paper: ZItem, bundle: PaperBundle, opts: PaperOpts, ctx: ItemCtx): RawItem {
  const group = ctx.lib.kind === "groups";
  const isNote = paper.data.itemType === "note";
  const doc = isNote
    ? standaloneNoteDoc(paper, { libraryName: ctx.libraryName, collectionNames: ctx.collectionNames, group })
    : buildPaperDoc(paper, bundle, opts, { libraryName: ctx.libraryName, collectionNames: ctx.collectionNames, group });
  const d = paper.data;
  const who = group ? paper.meta?.createdByUser : undefined;
  return {
    // "note" — 적재 라우팅이 source(자료)로 보낸다(ingest-classify routeIngestV6). 연구자의 노트·주석 묶음이 실제로도 그것이다.
    type: "note",
    provenance: {
      category: "research",
      system: "zotero",
      // instance 를 비운다 — 같은 그룹을 두 연구자가 각자 모아도 외부 좌표(라이브러리:항목)가 같아 한 자료로 합쳐진다.
      external_id: `${libraryPath(ctx.lib)}:${paper.key}`,
      external_url: zoteroItemUrl(ctx.lib, paper.key, ctx.username),
    },
    actor: who?.id || who?.username ? { external_id: who.id != null ? String(who.id) : undefined, display_name: who.name || who.username } : undefined,
    container_ref: libraryPath(ctx.lib),
    container_name: ctx.libraryName,
    title: isNote ? (doc.body.split("\n")[0] ?? "").replace(/^#\s*/, "") : String(d.title || d.filename || "(제목 없음)"),
    body: doc.body,
    occurred_at: d.dateAdded || undefined,
    updated_at: doc.updatedAt ?? d.dateModified ?? undefined,
    fields: {
      library: libraryPath(ctx.lib),
      library_name: ctx.libraryName,
      item_key: paper.key,
      item_type: d.itemType,
      doi: d.DOI || null,
      year: yearOf(d.date) || null,
      creators: creatorsLine(d.creators) || null,
      venue: venueOf(d) || null,
      collections: ctx.collectionNames,
      tags: tagList(d.tags, opts.includeAutoTags),
      annotation_count: doc.annotationCount,
      note_count: doc.noteCount,
      // 연구자의 생각(주석·노트)이 담겼나 — 증류는 이것이 참인 논문만 지식으로 만든다(서지만 있는 논문은 검색용 자료로 남는다).
      has_thinking: doc.annotationCount + doc.noteCount > 0,
      added_by: who?.name || who?.username || null,
      // 개인 라이브러리의 주인(수집기를 켠 구성원) — 누구의 라이브러리인지. 잠금 근거가 아니다(옛 잠금을 풀 때 대조에 쓴다).
      owner_member: ctx.owner ?? null,
    },
    raw: { key: paper.key, version: paper.version, itemType: d.itemType, library: libraryPath(ctx.lib) },
  };
}

/** 독립 노트(논문에 안 붙은 노트) — 노트 자체가 생각이라 NOTE_HEAD 를 단다(사전필터 통과). */
function standaloneNoteDoc(n: ZItem, ctx: { libraryName: string; collectionNames: string[]; group: boolean }): PaperDoc {
  const text = noteHtmlToText(n.data.note);
  const first = (text.split("\n").find((l) => l.trim()) ?? "노트").replace(/^-\s*/, "").slice(0, 80);
  const lines = [`# 노트: ${first}`,
    [`라이브러리: ${ctx.libraryName}`, ctx.collectionNames.length ? `컬렉션: ${ctx.collectionNames.join(", ")}` : ""].filter(Boolean).join(" · ")];
  if (ctx.group && whoOf(n)) lines.push(`쓴 사람: ${whoOf(n)}`);
  lines.push("", `${NOTE_HEAD} (1)`, text);
  return { body: lines.join("\n").trim(), annotationCount: 0, noteCount: text ? 1 : 0, updatedAt: n.data.dateModified || undefined };
}

// ── 네트워크 ───────────────────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const statusOf = (e: unknown): number | undefined => (e as { status?: number })?.status;
const on = (v: string | undefined, dflt: boolean): boolean => { const s = String(v ?? "").trim().toLowerCase(); return s ? !["off", "false", "0", "no"].includes(s) : dflt; };

/** 한 번에 하나씩 부른다. Backoff 는 다음 요청 전에 쉬고, 429·503 은 Retry-After 만큼 쉬고 다시 한다(최대 4번). */
export async function zoteroGet<T>(token: string, path: string): Promise<{ data: T; total: number | null }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(`${API}${path}`, {
      headers: { "Zotero-API-Version": "3", "Zotero-API-Key": token }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const backoff = Number(res.headers.get("backoff") ?? 0);
    if (res.status === 429 || res.status === 503) {
      const wait = Number(res.headers.get("retry-after") ?? 0) || backoff || 5 * (attempt + 1);
      await sleep(Math.min(wait, 120) * 1000);
      continue;
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const err = new Error(`Zotero ${res.status} ${path}${text ? ` — ${text.slice(0, 200)}` : ""}`);
      (err as Error & { status?: number }).status = res.status;
      throw err;
    }
    const data = (await res.json()) as T;
    const total = res.headers.get("total-results");
    if (backoff > 0) await sleep(Math.min(backoff, 120) * 1000);
    return { data, total: total != null && total !== "" ? Number(total) : null };
  }
  throw new Error(`Zotero 가 요청을 계속 미룹니다(429) — ${path}`);
}

export interface ZoteroKeyInfo {
  userID?: number;
  username?: string;
  displayName?: string;
  access?: {
    user?: { library?: boolean; notes?: boolean; files?: boolean; write?: boolean };
    groups?: Record<string, { library?: boolean; write?: boolean }>;
  };
}

/** 이 키가 읽을 수 있는 라이브러리 전부 — 개인(열려 있으면) + 그룹(all 이면 소속 그룹 전부, 아니면 키에 적힌 그룹만). */
export async function accessibleLibraries(token: string, info: ZoteroKeyInfo): Promise<ZoteroLibrary[]> {
  const out: ZoteroLibrary[] = [];
  const uid = info.userID != null ? String(info.userID) : "";
  if (uid && info.access?.user?.library) out.push({ kind: "users", id: uid, name: "내 라이브러리" });
  const g = info.access?.groups ?? {};
  const allGroups = !!g.all?.library;
  const named = new Set(Object.keys(g).filter((k) => k !== "all" && g[k]?.library));
  if (uid && (allGroups || named.size)) {
    for (let start = 0, n = 0; n < 20; n++, start += PAGE) {
      const r = await zoteroGet<Array<{ id: number; data?: { name?: string } }>>(token, `/users/${uid}/groups?limit=${PAGE}&start=${start}`);
      for (const gr of r.data) {
        const id = String(gr.id);
        if (allGroups || named.has(id)) out.push({ kind: "groups", id, name: gr.data?.name || `그룹 ${id}` });
      }
      if (r.data.length < PAGE) break;
    }
  }
  return out;
}

async function* pagedItems(token: string, path: string, label: string): AsyncGenerator<ZItem[]> {
  const sep = path.includes("?") ? "&" : "?";
  for (let n = 0, start = 0; n < MAX_PAGES; n++, start += PAGE) {
    const r = await zoteroGet<ZItem[]>(token, `${path}${sep}limit=${PAGE}&start=${start}`);
    const page = Array.isArray(r.data) ? r.data : [];
    yield page;
    if (page.length < PAGE || (r.total != null && start + PAGE >= r.total)) return;
  }
  throw new Error(`zotero: ${label} — 쪽 상한(${MAX_PAGES}쪽 · ${MAX_PAGES * PAGE}건)을 넘었습니다. 컬렉션으로 좁히거나 라이블리에 알려 주세요(조용히 자르면 나머지를 영영 놓친다).`);
}

/** 논문 아래 묶음 — 증분에서 논문 하나씩 다시 묶을 때 쓴다(통째로 받는 full 경로는 메모리에서 묶는다). */
async function fetchBundle(token: string, lp: string, key: string, wantFulltext: boolean): Promise<PaperBundle> {
  const bundle: PaperBundle = { notes: [], attachments: [] };
  for await (const page of pagedItems(token, `/${lp}/items/${key}/children`, `${lp}:${key} children`)) {
    for (const c of page) {
      if (c.data.itemType === "note") bundle.notes.push(c);
      else if (c.data.itemType === "attachment") bundle.attachments.push({ item: c, annotations: [] });
    }
  }
  for (const a of bundle.attachments) {
    if (!isReadable(a.item)) continue;
    for await (const page of pagedItems(token, `/${lp}/items/${a.item.key}/children`, `${lp}:${a.item.key} annotations`)) {
      a.annotations.push(...page.filter((x) => x.data.itemType === "annotation"));
    }
    if (wantFulltext) a.fulltext = await fetchFulltext(token, lp, a.item.key);
  }
  return bundle;
}

/** 주석이 달리는 첨부 — PDF·EPUB·웹 스냅샷. 링크만 있는 첨부는 children 이 없다. */
const isReadable = (a: ZItem): boolean => /pdf|epub|html/i.test(String(a.data.contentType ?? ""));

async function fetchFulltext(token: string, lp: string, key: string): Promise<string | undefined> {
  try {
    const r = await zoteroGet<{ content?: string }>(token, `/${lp}/items/${key}/fulltext`);
    return typeof r.data?.content === "string" ? r.data.content : undefined;
  } catch (e) {
    if (statusOf(e) === 404) return undefined;   // 색인이 없는 첨부 — 흔하다(스캔 PDF·동기화 꺼짐)
    throw e;
  }
}

/** 항목 key 들을 50개씩 받아 온다(itemKey 는 한 번에 50개까지). */
async function fetchByKeys(token: string, lp: string, keys: string[]): Promise<ZItem[]> {
  const out: ZItem[] = [];
  for (let i = 0; i < keys.length; i += 50) {
    const r = await zoteroGet<ZItem[]>(token, `/${lp}/items?itemKey=${keys.slice(i, i + 50).join(",")}&limit=50`);
    out.push(...(Array.isArray(r.data) ? r.data : []));
  }
  return out;
}

/** 논문(맨 위 항목)인가 — 주석은 늘 첨부 아래고, 노트·첨부는 부모가 없을 때만 맨 위다. */
const isTop = (it: ZItem): boolean => !it.data.parentItem && it.data.itemType !== "annotation";

export const zoteroConnector: Connector = {
  name: "zotero",

  async *backfill(opts?: BackfillOpts): AsyncIterable<RawItem> {
    const cfg = await resolveConnectorConfig("zotero");
    const token = cfg.token;
    if (!token) {
      throw new Error(
        "Zotero API 키가 없습니다 — [외부 앱 연결 ▸ Zotero]에서 개인 API 키를 저장하거나, '키 출처'를 member:<구성원 id> 로 지정하세요(자격 금고의 zotero_token 을 씁니다).",
      );
    }
    yield* zoteroItems(token, cfg, opts?.since);
  },
};

/**
 * 수집 본체 — 설정 해소(DB·금고)와 떼어 둔다. 테스트가 가짜 Zotero(전역 fetch)로 full·증분 묶기를 그대로 돌린다.
 * @param since 커서(ISO) — 없으면 full(라이브러리 전부), 있으면 그 뒤에 바뀐 항목이 속한 논문만.
 */
export async function* zoteroItems(
  token: string, cfg: Record<string, string | undefined>, since: string | undefined,
): AsyncGenerator<RawItem> {
  let info: ZoteroKeyInfo;
  try {
    info = (await zoteroGet<ZoteroKeyInfo>(token, "/keys/current")).data;
  } catch (e) {
    if (statusOf(e) === 403 || statusOf(e) === 401) {
      throw new Error("Zotero 가 API 키를 거부했습니다 — 지워졌거나 잘못 붙여 넣은 키입니다. zotero.org/settings/keys 에서 새로 만들어 저장하세요.");
    }
    throw e;
  }
  const opt: PaperOpts = {
    includeAnnotations: on(cfg.include_annotations, true),
    includeNotes: on(cfg.include_notes, true),
    includeAutoTags: on(cfg.include_auto_tags, false),
  };
  const wantFulltext = on(cfg.include_fulltext, false);
  if (opt.includeNotes && info.access?.user?.library && info.access.user.notes === false) {
    console.warn("zotero: 이 키에 «Allow notes access» 가 꺼져 있어 개인 라이브러리의 노트를 읽지 못합니다 — 키 설정에서 켜 주세요.");
  }

  const reachable = await accessibleLibraries(token, info);
  const uid = info.userID != null ? String(info.userID) : undefined;
  const parsed = parseLibraryList(cfg.libraries, uid);
  for (const u of parsed.unknown) console.warn(`zotero: 라이브러리를 알아볼 수 없습니다 — ${u} (users/<id> · groups/<id> · 그룹 주소)`);
  const libs = parsed.libs.length
    ? parsed.libs.map((l) => reachable.find((r) => r.kind === l.kind && r.id === l.id) ?? l)
    : reachable;
  if (!libs.length) {
    throw new Error("이 키로 읽을 수 있는 Zotero 라이브러리가 없습니다 — 키를 만들 때 «Allow library access»(개인)나 그룹 읽기 권한을 켰는지 확인하세요.");
  }
  const owner = String(cfg.token_source ?? "").startsWith("member:") ? String(cfg.token_source).slice("member:".length) : undefined;
  const pickedCollections = parseCollectionKeys(cfg.collections);
  const sinceMs = since && Number.isFinite(Date.parse(since)) ? Date.parse(since) - LOOKBACK_MS : undefined;
  const nowMs = Date.now();
  /** 커서는 yield 한 updated_at 의 최대다 — 시계가 앞선 클라이언트의 미래 시각 하나가 커서를 미래로 밀면 그때까지 아무것도 못 받는다. */
  const capped = (it: RawItem): RawItem => {
    const t = Date.parse(String(it.updated_at ?? ""));
    return Number.isFinite(t) && t > nowMs ? { ...it, updated_at: new Date(nowMs).toISOString() } : it;
  };
  //  라이브러리 하나의 실패를 삼키면 run 이 성공으로 끝나 공용 커서가 전진하고, 그 라이브러리의 그 창은 영영 다시 안 읽힌다.
  //   그래서 다른 라이브러리는 끝까지 받되 실패를 모아 마지막에 던진다(커서 동결 → 다음 run 이 같은 창을 다시 읽는다).
  const failures: string[] = [];
  let collectionHits = 0;

  for (const lib of libs) {
    const lp = libraryPath(lib);
    const libraryName = lib.name || (lib.kind === "users" ? "내 라이브러리" : `그룹 ${lib.id}`);
    try {
      // ① 컬렉션 이름표(본문의 «컬렉션:» 줄)와 좁히기
      const cols: Array<{ key: string; parentCollection?: string | false; name?: string }> = [];
      for await (const page of pagedItems(token, `/${lp}/collections`, `${lp} collections`)) {
        for (const c of page as unknown as Array<{ key: string; data?: { name?: string; parentCollection?: string | false } }>) {
          cols.push({ key: c.key, name: c.data?.name, parentCollection: c.data?.parentCollection });
        }
      }
      const colName = new Map(cols.map((c) => [c.key, c.name || c.key]));
      //  컬렉션을 골랐으면 **그 컬렉션만** 모은다(닫는 쪽). 고른 컬렉션이 없는 라이브러리는 라이브러리 칸에 직접 적은 것만
      //   통째로 받는다 — 오타·지운 컬렉션 하나로 개인 라이브러리 전체가 열리지 않게.
      const allowed = pickedCollections.length ? expandCollections(pickedCollections, cols) : new Set<string>();
      if (pickedCollections.length) {
        if (allowed.size) collectionHits++;
        else if (!parsed.libs.some((l) => l.kind === lib.kind && l.id === lib.id)) continue;
      }
      const inScope = (it: ZItem): boolean => !allowed.size || (it.data.collections ?? []).some((k) => allowed.has(k));
      const ctxOf = (it: ZItem): ItemCtx => ({
        lib, libraryName, username: info.username,
        collectionNames: (it.data.collections ?? []).map((k) => colName.get(k) ?? k),
        owner: lib.kind === "users" ? owner : undefined,
      });

      // ② 무엇을 다시 묶나 — full 이면 라이브러리 전부, 증분이면 바뀐 항목이 속한 논문만
      const byKey = new Map<string, ZItem>();
      let full = sinceMs === undefined;
      const affected = new Set<string>();
      if (!full) {
        const changed: ZItem[] = [];
        outer: for await (const page of pagedItems(token, `/${lp}/items?sort=dateModified&direction=desc`, `${lp} changed`)) {
          for (const it of page) {
            if ((Date.parse(String(it.data.dateModified ?? "")) || 0) <= sinceMs!) break outer;
            changed.push(it);
          }
        }
        for (const it of changed) byKey.set(it.key, it);
        // 부모를 두 단계까지 거슬러 맨 위 항목을 찾는다(주석 → 첨부 → 논문). 모르는 부모는 key 로 받아 온다.
        let frontier = changed;
        for (let depth = 0; depth < 3 && frontier.length; depth++) {
          const missing = [...new Set(frontier.map((x) => x.data.parentItem).filter((k): k is string => !!k && !byKey.has(k)))];
          const got = missing.length ? await fetchByKeys(token, lp, missing) : [];
          for (const g of got) byKey.set(g.key, g);
          frontier = got;
        }
        for (const it of changed) {
          let cur: ZItem | undefined = it;
          for (let i = 0; cur && !isTop(cur) && i < 3; i++) cur = cur.data.parentItem ? byKey.get(cur.data.parentItem) : undefined;
          if (cur && isTop(cur)) affected.add(cur.key);
        }
        if (affected.size > FULL_FALLBACK) full = true;
      }

      if (full) {
        // 라이브러리를 통째로 받아 메모리에서 묶는다 — 논문마다 children 을 부르면 요청이 논문 수의 두세 배가 된다.
        byKey.clear();
        for await (const page of pagedItems(token, `/${lp}/items`, `${lp} items`)) for (const it of page) byKey.set(it.key, it);
        const bundles = new Map<string, PaperBundle>();
        const attOwner = new Map<string, string>();
        for (const it of byKey.values()) if (isTop(it)) bundles.set(it.key, { notes: [], attachments: [] });
        for (const it of byKey.values()) {
          const p = it.data.parentItem;
          if (!p) continue;
          if (it.data.itemType === "note") bundles.get(p)?.notes.push(it);
          else if (it.data.itemType === "attachment") { bundles.get(p)?.attachments.push({ item: it, annotations: [] }); attOwner.set(it.key, p); }
        }
        // 부모 없는 첨부(PDF 만 끌어다 놓은 것)는 그 자신이 맨 위다 — 주석은 그 첨부에 달린다.
        for (const it of byKey.values()) if (isTop(it) && it.data.itemType === "attachment") { bundles.get(it.key)!.attachments.push({ item: it, annotations: [] }); attOwner.set(it.key, it.key); }
        for (const it of byKey.values()) {
          if (it.data.itemType !== "annotation" || !it.data.parentItem) continue;
          const top = attOwner.get(it.data.parentItem);
          const slot = top ? bundles.get(top)?.attachments.find((a) => a.item.key === it.data.parentItem) : undefined;
          slot?.annotations.push(it);
        }
        for (const [key, bundle] of bundles) {
          const paper = byKey.get(key)!;
          if (!inScope(paper)) continue;
          if (paper.data.itemType === "note" && !opt.includeNotes) continue;
          if (wantFulltext) for (const a of bundle.attachments) if (isReadable(a.item)) a.fulltext = await fetchFulltext(token, lp, a.item.key);
          const item = safeItem(paper, bundle, opt, ctxOf(paper));
          if (item?.body) yield capped(item);
        }
      } else {
        for (const key of affected) {
          const paper = byKey.get(key) ?? (await fetchByKeys(token, lp, [key]))[0];
          if (!paper || !inScope(paper)) continue;
          if (paper.data.itemType === "note" && !opt.includeNotes) continue;
          const item = safeItem(paper, await bundleOf(token, lp, paper, wantFulltext), opt, ctxOf(paper));
          if (item?.body) yield capped(item);
        }
      }
    } catch (e) {
      const st = statusOf(e);
      if (st === 401) throw new Error(`Zotero 가 API 키를 거부했습니다(401) — 키를 다시 만들어 저장하세요. 원문: ${(e as Error).message}`);
      //  그룹에서 빠졌거나 키에서 그 그룹이 닫힌 것(403·404)은 «사라진 라이브러리» 다 — 기다려도 돌아오지 않으니 커서를 붙잡지 않는다.
      if (lib.kind === "groups" && (st === 403 || st === 404)) {
        console.warn(`zotero: ${lp}(${libraryName}) 를 더는 읽을 수 없습니다(${st}) — 그룹에서 빠졌거나 키에서 닫혔습니다. 건너뜁니다.`);
        continue;
      }
      console.warn(`zotero: ${lp}(${libraryName}) 수집 실패 — ${(e as Error).message}`);
      failures.push(`${libraryName}(${lp}): ${(e as Error).message}`);
    }
  }
  if (pickedCollections.length && !collectionHits) {
    throw new Error(`고른 컬렉션(${pickedCollections.join(", ")})을 어느 라이브러리에서도 찾지 못했습니다 — 컬렉션 key 를 다시 확인하세요(웹 라이브러리 주소의 collections/ 뒤 8자).`);
  }
  if (failures.length) {
    throw new Error(`Zotero 라이브러리 ${failures.length}곳을 다 읽지 못했습니다 — 다음 수집이 같은 범위를 다시 읽습니다. ${failures.join(" · ").slice(0, 600)}`);
  }
}

/** 논문 하나를 묶다 실패하면(깨진 노트 등) 그 논문만 건너뛴다 — 한 건이 라이브러리 수집 전체를 매번 세우는 독약이 되지 않게. */
function safeItem(paper: ZItem, bundle: PaperBundle, opt: PaperOpts, ctx: ItemCtx): RawItem | null {
  try { return paperToItem(paper, bundle, opt, ctx); }
  catch (e) { console.warn(`zotero: ${libraryPath(ctx.lib)}:${paper.key} 를 묶지 못해 건너뜁니다 — ${(e as Error).message}`); return null; }
}

/** 맨 위 항목 하나의 묶음 — 독립 노트는 빈 묶음, 부모 없는 첨부는 그 자신에 달린 주석, 논문은 노트·첨부·주석. */
async function bundleOf(token: string, lp: string, top: ZItem, wantFulltext: boolean): Promise<PaperBundle> {
  if (top.data.itemType === "note") return { notes: [], attachments: [] };
  if (top.data.itemType !== "attachment") return fetchBundle(token, lp, top.key, wantFulltext);
  const slot: PaperBundle["attachments"][number] = { item: top, annotations: [] };
  for await (const page of pagedItems(token, `/${lp}/items/${top.key}/children`, `${lp}:${top.key} annotations`)) {
    slot.annotations.push(...page.filter((x) => x.data.itemType === "annotation"));
  }
  if (wantFulltext) slot.fulltext = await fetchFulltext(token, lp, top.key);
  return { notes: [], attachments: [slot] };
}
