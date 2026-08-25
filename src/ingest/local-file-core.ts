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
export type LocalIngestKind = "text" | "sniff" | "ooxml" | "vision" | "unreadable" | "skip";
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
const UNREADABLE_EXT: Record<string, string> = {
  hwp: "한글 hwp(5.0 바이너리)", doc: "구버전 워드 .doc", ppt: "구버전 파워포인트 .ppt", xls: "구버전 엑셀 .xls",
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
