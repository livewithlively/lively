// 로컬(내 컴퓨터) 업로드 → 자료 브리지의 **순수 부분**(#1881 L1) — 좌표·분류·채널·링크·스텁·텍스트 디코드.
//  IO(파일 읽기·DB)는 ./local-file.ts. 여기는 네트워크/DB/FS 무관이라 테스트가 그대로 돈다(local-file-core.test.ts).
//
//  좌표 규약(다른 수집기와 같은 3필드 유니크 — source_external_uidx):
//   external_system='local' · external_instance='default' · external_id='<root>/<상대경로>'
//   root = personal:<member> | project:<id> | shared. 같은 경로 재업로드 = upsert(자료 1건 유지).
import path from "node:path";
import { ooxmlKindFromName } from "../connectors/ooxml.js";

export const LOCAL_SYSTEM = "local";
export const LOCAL_INSTANCE = "default";
export const LOCAL_SOURCE_KIND = "local_file";

export type LocalRoot =
  | { kind: "personal"; member: string }
  | { kind: "project"; id: number }
  | { kind: "shared" };

/** 개인 루트의 주인 키 — 자료 좌표(`personal:<이 값>/…`)와 파일 휴지통 도장(root)·휴지통 목록의 «내 것» 판정이 같은 값을 쓴다.
 *  신원이 둘 다 비면 ""(그때 좌표를 만드는 쪽은 슬러그로 메우고, 목록은 개인 폴더 것을 세우지 않는다 — 닫는 쪽). */
export const personalRootMember = (user: { userId?: string | null; email?: string | null }): string => user.userId || user.email || "";

export function localRootKey(r: LocalRoot): string {
  if (r.kind === "personal") return `personal:${r.member}`;
  if (r.kind === "project") return `project:${r.id}`;
  return "shared";
}

export function parseLocalRootKey(key: string): LocalRoot | null {
  if (key === "shared") return { kind: "shared" };
  if (key.startsWith("personal:")) { const m = key.slice("personal:".length); return m ? { kind: "personal", member: m } : null; }
  if (key.startsWith("project:")) { const n = Number(key.slice("project:".length)); return Number.isInteger(n) && n > 0 ? { kind: "project", id: n } : null; }
  return null;
}

// 상대경로 정규화 — 구분자는 '/', 앞 구분자 제거. (저장 이름 NFC 정본은 업로드 라우트가 이미 맞춘다 — #1278b)
export function normalizeLocalRel(rel: string): string {
  return String(rel ?? "").split(path.sep).join("/").replace(/\\/g, "/").replace(/^\/+/, "");
}

export function localExternalId(root: LocalRoot, rel: string): string {
  return `${localRootKey(root)}/${normalizeLocalRel(rel)}`;
}

export function parseLocalExternalId(id: string): { root: LocalRoot; rel: string } | null {
  const i = id.indexOf("/");
  if (i < 0) return null;
  const root = parseLocalRootKey(id.slice(0, i));
  const rel = id.slice(i + 1);
  if (!root || !rel || rel.split("/").some((s) => s === "..")) return null;
  return { root, rel };
}

// ── 분류 — 확장자·경로로 "어떻게 본문을 얻나"를 정한다(업로드엔 신뢰할 MIME 이 없다: 라우트가 octet-stream 으로 받는다). ──
export type LocalIngestKind = "text" | "sniff" | "ooxml" | "hwp" | "vision" | "unreadable" | "skip";
export interface LocalClassification { kind: LocalIngestKind; ext: string; reason?: string }

const TEXT_EXT = new Set([
  "md", "markdown", "txt", "text", "csv", "tsv", "json", "jsonl", "ndjson", "html", "htm", "xml", "yaml", "yml", "toml",
  "ini", "cfg", "conf", "log", "tex", "srt", "vtt", "rtf", "org", "rst", "adoc", "svg",
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "java", "kt", "go", "rs", "c", "h", "cpp", "hpp", "cs", "rb", "php",
  "swift", "sh", "bash", "zsh", "ps1", "sql", "css", "scss", "less", "vue", "svelte", "dart", "r", "scala", "lua", "pl",
]);
// Claude Read 가 네이티브로 읽는 것(PDF·이미지) — [BINARY] 스텁 → 증류 세션이 source_artifact 로 on-demand.
const VISION_EXT = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp"]);
// 읽을 방법이 없는 문서 형식 — 스텁은 남기되 "fetch 해도 소용없다"를 적는다(증류 요약에 안내가 찍히게).
//  ⚠ .hwp 는 2026-09-09 에 여기서 빠졌다(#3778) — OLE2 컨테이너를 열고 BodyText 레코드를 풀면 본문이 나온다
//   (connectors/hwp.ts). 「읽을 방법이 없다」가 사실이 아니었던 것이지 형식이 바뀐 게 아니다.
const UNREADABLE_EXT: Record<string, string> = {
  doc: "구버전 워드 .doc", ppt: "구버전 파워포인트 .ppt", xls: "구버전 엑셀 .xls",
  pages: "애플 Pages", numbers: "애플 Numbers", key: "애플 Keynote", odt: "OpenDocument 문서", odp: "OpenDocument 발표",
  ods: "OpenDocument 시트", epub: "epub",
};
// 자료를 만들지 않는 것 — 실행파일·아카이브·미디어·DB 덤프. 파일은 폴더에 그대로 남는다(세션은 경로로 쓸 수 있다).
const SKIP_EXT = new Set([
  "exe", "dll", "so", "dylib", "app", "pkg", "msi", "dmg", "iso", "bin", "img", "jar", "war", "class", "o", "a", "lib", "pyc",
  "zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar", "lz4", "zst",
  "mp4", "mov", "avi", "mkv", "webm", "mp3", "m4a", "wav", "flac", "aac", "ogg", "wma", "heic", "tif", "tiff", "bmp", "psd", "ai",
  "db", "sqlite", "sqlite3", "lock", "map", "woff", "woff2", "ttf", "otf", "eot", "ico", "icns",
]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__"]);

export function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(i + 1).toLowerCase() : "";
}

export function classifyLocalPath(rel: string): LocalClassification {
  const segs = normalizeLocalRel(rel).split("/").filter(Boolean);
  const name = segs[segs.length - 1] ?? "";
  const ext = extOf(name);
  if (!name) return { kind: "skip", ext, reason: "empty" };
  if (segs.some((s) => s.startsWith("."))) return { kind: "skip", ext, reason: "dotfile" };       // .git/.lively/.DS_Store …
  if (segs.slice(0, -1).some((s) => SKIP_DIRS.has(s))) return { kind: "skip", ext, reason: "dependency-dir" };
  if (name.startsWith("~$")) return { kind: "skip", ext, reason: "office-lock" };                 // 워드가 여는 동안 만드는 잠금 파일
  if (SKIP_EXT.has(ext)) return { kind: "skip", ext, reason: `ext:${ext}` };
  if (ooxmlKindFromName(name)) return { kind: "ooxml", ext };
  if (ext === "hwp") return { kind: "hwp", ext };          // OLE2 — connectors/hwp.ts 가 본문을 뽑는다(#3778)
  if (TEXT_EXT.has(ext)) return { kind: "text", ext };
  if (VISION_EXT.has(ext)) return { kind: "vision", ext };
  if (ext in UNREADABLE_EXT) return { kind: "unreadable", ext, reason: UNREADABLE_EXT[ext] };
  return { kind: "sniff", ext };   // 모르는 확장자 — 읽어 보고 텍스트면 텍스트
}

// 채널 = 올린 최상위 폴더명. 증류기 include/exclude_channels·관측 화면이 폴더 단위로 동작한다.
//  개인 폴더는 컴포저·온보딩이 uploads/ 아래에 두므로 그 한 겹은 벗긴다(안 벗기면 채널이 전부 'uploads' 가 된다).
export function localChannelOf(root: LocalRoot, rel: string, fallback: string): string {
  const segs = normalizeLocalRel(rel).split("/").filter(Boolean);
  if (root.kind === "personal" && segs[0] === "uploads") segs.shift();
  return segs.length > 1 ? segs[0] : fallback;
}

// 원본 링크(#1436 공유 링크 문법: root+path 하나). 프로젝트 공유폴더는 shared 루트 아래 project/<id>/… 다.
export function localFileUrl(root: LocalRoot, rel: string, folder?: string | null): string {
  const r = normalizeLocalRel(rel);
  if (root.kind === "personal") return `#/f?root=personal&path=${encodeURIComponent(r)}`;
  if (root.kind === "project") {
    return folder ? `#/f?root=shared&path=${encodeURIComponent(`${normalizeLocalRel(folder)}/${r}`)}` : `#/projects/${root.id}`;
  }
  return `#/f?root=shared&path=${encodeURIComponent(r)}`;
}

const MIME: Record<string, string> = {
  pdf: "application/pdf", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  hwpx: "application/hwp+zip", hwp: "application/x-hwp",
  doc: "application/msword", ppt: "application/vnd.ms-powerpoint", xls: "application/vnd.ms-excel",
  md: "text/markdown", txt: "text/plain", csv: "text/csv", tsv: "text/tab-separated-values", json: "application/json",
  html: "text/html", htm: "text/html", xml: "application/xml", svg: "image/svg+xml",
};
export function localMimeOf(name: string): string {
  return MIME[extOf(name)] ?? "application/octet-stream";
}

// [BINARY] 스텁 — gdrive.buildBinaryStub 과 **같은 계약**(마커·filename·mime·size·url·modified) — 통합 distill 프롬프트가 읽는다.
export function buildLocalBinaryStub(o: { filename: string; mime: string; size: number; url: string; modified?: string | null; note: string }): string {
  const parts = [`[BINARY] filename=${o.filename}`, `mime=${o.mime}`, `size=${o.size}`, `url=${o.url}`];
  if (o.modified) parts.push(`modified=${o.modified}`);
  return parts.join(" ") + "\n" + o.note;
}
export const STUB_NOTE_VISION =
  "바이너리 파일(내용 미추출). 볼 가치가 있으면 source_artifact(source_id)로 원본을 받아 판단하고, 노이즈(밈·UI캡처 등)면 fetch 없이 skip 하세요.";
export const stubNoteUnreadable = (what: string, ext: string): string =>
  `읽을 수 없는 형식(${what}) — source_artifact 로 받아도 Read 가 본문을 못 뽑습니다. fetch 없이 skip 하고, 요약에 "${ext} 파일은 pdf 로 저장해 다시 올리면 읽습니다"를 남기세요.`;
export const stubNoteExtractFailed = (why: string): string =>
  `본문 추출 실패(${why}) — source_artifact 로 받아도 Read 가 이 형식을 못 뽑습니다. fetch 없이 skip 하세요.`;

// 텍스트 디코드 — UTF-8 기본, BOM 처리, 윈도 메모장 산물(UTF-16LE BOM · EUC-KR/CP949)은 대체문자가 줄어들 때만 채택.
export function decodeLocalText(buf: Buffer): string {
  let b = buf;
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b.length >= 3 && b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) b = b.subarray(3);
  const utf8 = b.toString("utf8");
  const bad = countReplacement(utf8);
  if (bad === 0) return utf8;
  try {
    const kr = new TextDecoder("euc-kr").decode(b);
    if (countReplacement(kr) < bad) return kr;
  } catch { /* ICU 없는 빌드 — utf8 그대로 */ }
  return utf8;
}
function countReplacement(s: string): number {
  let n = 0;
  for (const ch of s) if (ch === "�") n++;
  return n;
}

// 모르는 확장자(sniff) — 앞부분이 텍스트로 읽히면 텍스트. NUL 바이트가 있으면 바이너리.
export function looksLikeText(buf: Buffer): boolean {
  const head = buf.subarray(0, 65536);
  if (head.length === 0) return false;
  for (const byte of head) if (byte === 0) return false;
  const s = decodeLocalText(head);
  return countReplacement(s) / Math.max(1, s.length) < 0.01;
}

// ── 이름 바꾸기·옮기기의 순수 부분(#4688) — 옮긴 파일의 자료 행을 새 좌표로. DB 는 local-file.ts moveLocalPath. ──
//  같은 행을 **제자리에서** 고친다 — 지식 근거(knowledge_source)·공개 대상(source_member)·증류 기록이 자료 번호(source.id)에 걸려 있어,
//   새로 만들고 옛 것을 닫으면(첨부 옮기기 방식) 그 연결이 전부 끊긴다. updated_at 은 올리지 않는다(증류기가 «내용이 바뀌었다» 로 읽어 다시 판단한다).
//  고치는 칸은 좌표가 담긴 곳뿐: 좌표 · 링크 · 이름(제목이 파일 이름이었으면) · fields 의 path · container_name(채널 = 맨 위 폴더) · ext ·
//   바이너리 안내문 머리 줄(이름 · 종류 · 주소)과 «본문이 길어 …» 꼬리의 주소.

/** 도착 좌표를 비울 때 그 자리에 남아 있던 다른 행(지운 파일의 닫힌 기록·휴지통 기록)을 비켜 두는 좌표 머리 — 뒤에 자료 번호가 붙는다.
 *  어느 자리 키(personal:·project:·shared)와도 안 겹치고 '/' 가 없어 parseLocalExternalId 가 null 을 준다(원본 열기·접두 판정에 안 걸린다).
 *  원래 좌표는 fields.aside_from 에 남는다 — 휴지통에서 되살리면 그 좌표를 되찾는다(reviveTrashedFile). */
export const LOCAL_ASIDE_PREFIX = "aside:";

export interface LocalMove {
  root: LocalRoot;
  /** 그 루트 기준 옛·새 상대경로(폴더면 하위 전부가 따라간다) */
  fromRel: string;
  toRel: string;
  /** 프로젝트 폴더(project/<id>) — 링크 구성용(localFileUrl). 개인·shared 는 생략 */
  folder?: string | null;
  /** 맨 위에 놓인 파일의 채널(localChannelOf 의 fallback) — 업로드 때와 같은 값(프로젝트명·'uploads'·'shared') */
  channelFallback: string;
}
/**
 * 옮길 행 — 본문은 통째로 받지 않는다(폴더 하나에 큰 글이 수천 건이면 그만큼을 게이트웨이로 끌어오게 된다).
 *  body_head = 첫 줄(바이너리 안내문 머리 줄 자리 — 안내문일 때만, 길이 상한) · body_tail = 끝 몇천 자(긴 본문 꼬리 자리 — 그 꼴일 때만).
 */
export interface LocalRowForMove {
  external_id: string; external_url?: string | null; title?: string | null; fields?: Record<string, unknown> | null;
  body_head?: string | null; body_tail?: string | null;
}
/** 본문 고치기 한 군데 — from 이 그 자리(첫 줄 전체 · 끝)와 글자 그대로 같을 때만 to 로 바꾼다(그새 본문이 바뀌었으면 손대지 않는다). */
export interface BodyEdit { from: string; to: string }
export interface MovedLocalRow {
  external_id: string; external_url: string; title: string | null; fields: Record<string, unknown>;
  /** 첫 줄(안내문 머리 줄) 고치기 */ head: BodyEdit | null;
  /** 끝(긴 본문 꼬리) 고치기 */ tail: BodyEdit | null;
}

//  안내문 머리 줄(buildLocalBinaryStub) · 긴 본문 꼬리(ingest 의 buildBody) 꼴. ⚠ 본문의 **다른 자리**는 손대지 않는다 —
//   텍스트 자료의 본문은 파일 내용 그 자체라, 사람이 쓴 글 속 옛 주소까지 바꾸면 자료가 파일과 달라진다.
const STUB_HEAD = /^\[BINARY\] filename=(.*) mime=(\S+) size=(\d+) url=(\S+)( modified=\S+)?$/;
const LONG_TAIL = /( — 전문은 )(\S+)\]$/;

/** 옮긴 자리(자신·하위)의 자료 행 → 새 좌표의 값. 그 행이 옮긴 자리 밖이면 null. */
export function movedLocalRow(row: LocalRowForMove, m: LocalMove): MovedLocalRow | null {
  const rootKey = localRootKey(m.root);
  const fromKey = localExternalId(m.root, m.fromRel);
  const toKey = localExternalId(m.root, m.toRel);
  const old = String(row.external_id ?? "");
  if (old !== fromKey && !old.startsWith(fromKey + "/")) return null;
  const nextId = toKey + old.slice(fromKey.length);
  const oldRel = old.slice(rootKey.length + 1);
  const newRel = nextId.slice(rootKey.length + 1);
  const oldName = path.posix.basename(oldRel);
  const newName = path.posix.basename(newRel);
  const newUrl = localFileUrl(m.root, newRel, m.folder);
  const oldUrls = new Set([String(row.external_url ?? ""), localFileUrl(m.root, oldRel, m.folder)].filter(Boolean));

  let head: BodyEdit | null = null;
  let tail: BodyEdit | null = null;
  const firstLine = row.body_head ?? "";
  const hm = STUB_HEAD.exec(firstLine);
  if (hm) {
    //  이름은 그 파일 이름일 때만(가려 적힌 이름은 그대로) · 종류는 확장자에서 나온 값일 때만 새 확장자로.
    const name = hm[1] === oldName ? newName : hm[1];
    const mime = hm[2] === localMimeOf(oldName) ? localMimeOf(newName) : hm[2];
    const to = `[BINARY] filename=${name} mime=${mime} size=${hm[3]} url=${newUrl}${hm[5] ?? ""}`;
    if (to !== firstLine) head = { from: firstLine, to };
  } else {
    const tm = LONG_TAIL.exec(row.body_tail ?? "");
    if (tm && oldUrls.has(tm[2]) && tm[2] !== newUrl) tail = { from: tm[0], to: tm[1] + newUrl + "]" };
  }

  const fields: Record<string, unknown> = { ...(row.fields ?? {}), path: newRel, container_name: localChannelOf(m.root, newRel, m.channelFallback), ext: extOf(newName) };
  const title = row.title == null ? null : row.title === oldName ? newName : row.title;
  return { external_id: nextId, external_url: newUrl, title, fields, head, tail };
}

/** 고치기를 본문에 적용(순수) — DB 쪽(moveLocalPath 의 SQL)과 **같은 규칙**: 첫 줄이 글자 그대로 같으면 첫 줄을, 아니면 끝이 같으면 끝을. */
export function applyBodyEdits(body: string, e: Pick<MovedLocalRow, "head" | "tail">): string {
  const nl = body.indexOf("\n");
  const first = nl < 0 ? body : body.slice(0, nl);
  if (e.head && first === e.head.from) return e.head.to + (nl < 0 ? "" : body.slice(nl));
  if (e.tail && body.endsWith(e.tail.from)) return body.slice(0, body.length - e.tail.from.length) + e.tail.to;
  return body;
}

/** 옮길 행을 읽을 때 본문에서 가져올 두 자리(SQL 식) — 안내문 머리 줄(상한 8000자) · 긴 본문 꼬리(끝 4000자). 그 꼴이 아니면 NULL. */
export const BODY_HEAD_SQL = `CASE WHEN left(body_md, 9) = '[BINARY] ' THEN split_part(left(body_md, 8000), E'\\n', 1) END`;
export const BODY_TAIL_SQL = `CASE WHEN right(body_md, 1) = ']' AND position(' — 전문은 ' in right(body_md, 4000)) > 0 THEN right(body_md, 4000) END`;

// ── 파일 휴지통의 순수 부분(#3778) — 보관 자리 계산. DB·FS 없음(도장 찍기·옮기기는 local-file.ts · project-routes.ts). ──
//  root = 어느 루트의 보관인가(localRootKey — 'personal:<member>' · 'shared' · 'project:<id>'). 개인·공유 폴더 삭제도 휴지통을 거치면서 생겼다.
//   옛 도장(프로젝트 파일 전용)에는 없다 — 그때는 project_id 가 곧 루트다(trashStampRoot 가 둘을 한 답으로 접는다). 경로는 전부 **그 루트 기준** posix 상대경로.
export interface FileTrashStamp { batch: string; at: string; by: string | null; project_id: number; base_rel: string; held_rel: string; root?: string }
export const FILE_TRASH_DIR = path.posix.join(".lively", "trash");

/** 지운 경로(base_rel) 아래 파일 하나가 보관 자리에서 어디에 있나 — 순수 계산. 경로는 전부 프로젝트 폴더 기준 posix 상대경로. */
export function heldPathOf(stamp: Pick<FileTrashStamp, "base_rel" | "held_rel">, filePath: string): string {
  const base = stamp.base_rel.replace(/\/+$/, "");
  const file = filePath.replace(/\/+$/, "");
  if (file === base) return stamp.held_rel;
  if (!file.startsWith(base + "/")) throw new Error(`보관 도장과 파일 경로가 어긋납니다(${file} ∉ ${base})`);
  return stamp.held_rel + file.slice(base.length);
}

/** 새 보관 묶음 — `.lively/trash/<batch>/<지운 것의 이름>`. batch 는 시각+난수(같은 이름을 두 번 지워도 안 겹친다). */
export function newFileTrashStamp(projectId: number, rel: string, by: string | null, now = new Date(), rand = Math.random()): FileTrashStamp {
  const clean = rel.split(path.sep).join("/").replace(/^\/+|\/+$/g, "");
  const batch = now.getTime().toString(36) + "-" + Math.floor(rand * 0xffffff).toString(36).padStart(4, "0");
  return { batch, at: now.toISOString(), by, project_id: projectId, base_rel: clean, held_rel: path.posix.join(FILE_TRASH_DIR, batch, path.posix.basename(clean)) };
}

/** 루트를 아는 도장 — 개인·공유 폴더(브라우즈) 삭제용. 프로젝트 루트면 project_id 도 채워 옛 읽는 쪽(프로젝트 라우트·화면)이 그대로 돈다. */
export function newRootTrashStamp(root: LocalRoot, rel: string, by: string | null, now = new Date(), rand = Math.random()): FileTrashStamp {
  return { ...newFileTrashStamp(root.kind === "project" ? root.id : 0, rel, by, now, rand), root: localRootKey(root) };
}

/** 이 도장은 어느 루트의 것인가 — root 가 있으면 그것, 없으면(옛 도장) project_id. 둘 다 못 읽으면 null(되살릴 자리를 지어내지 않는다). */
export function trashStampRoot(stamp: Pick<FileTrashStamp, "root" | "project_id"> | null | undefined): LocalRoot | null {
  if (!stamp) return null;
  if (typeof stamp.root === "string" && stamp.root) return parseLocalRootKey(stamp.root);
  const id = Number(stamp.project_id);
  return Number.isInteger(id) && id > 0 ? { kind: "project", id } : null;
}

/**
 * 되살리기·완전 삭제 뒤 보관 묶음 폴더를 치워도 되나 — 순수 판정(리뷰 지적 2026-09-20).
 *  ★ 묶음 안에는 **자료가 아닌 동행 파일**이 있을 수 있다: 폴더를 지우면 폴더째 옮기는데, zip·영상·실행 파일·점 파일은 애초에
 *   자료 행이 없어(SKIP_EXT) 도장도 없고 휴지통 화면에도 안 선다. 남은 도장 수(DB)만 보고 묶음을 rm -rf 하면, 사람이 본 적 없는
 *   그 파일들이 **«되살리기» 의 부작용으로** 영영 사라진다. 되살리기는 아무것도 없애지 않아야 한다.
 *   · 되살리기: 파일 하나만 지웠던 묶음(그 파일이 묶음의 전부)일 때만 치운다. 폴더 묶음은 남긴다 — 빈 폴더가 남는 쪽이 낫다.
 *   · 완전 삭제: 남은 도장이 0 이면 묶음째 치운다 — 사람이 지우기로 한 폴더의 나머지이고, 확인창이 그렇게 말한다.
 *   · 도장이 하나라도 남았으면 어느 쪽이든 손대지 않는다(남은 자료의 바이트가 그 안에 있다).
 */
export function fileTrashBatchCleanup(op: "restore" | "purge", stamp: Pick<FileTrashStamp, "base_rel">, filePath: string, remaining: number): "remove" | "keep" {
  if (!Number.isFinite(remaining) || remaining > 0) return "keep";
  if (op === "purge") return "remove";
  const single = stamp.base_rel.replace(/\/+$/, "") === filePath.replace(/\/+$/, "");
  return single ? "remove" : "keep";
}
