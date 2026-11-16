// 워크스페이스 간 옮기기(#5458) — 묶음 형식 v1: 무엇을 어떤 파일로 담나, 어떻게 읽나.
//
// 묶음 = zip(또는 비밀번호로 잠근 zip — seal.ts) 한 덩어리:
//   manifest.json          형식 이름·판 번호, 만든 워크스페이스, 담긴 수, 파일마다 sha256
//   README.txt             사람이 압축을 풀어 봤을 때 읽을 안내
//   categories.json        담긴 지식이 쓰는 분류의 정의(key·이름·설명·정의)
//   knowledge/<이름>.md    지식 한 건 = 앞머리(--- 사이, 줄마다 `키: JSON값`) + 본문
//   sources/<id>.json      (고를 때만) 담긴 지식에 연결된 자료
//
// 왜 DB 표가 아니라 이 단위인가: dev→매니지드 이관을 DB 복사로 세 번 했고(#1886·#1937·#3463) 판이 다르면
//  컬럼과 허용값이 달라 깨졌다. 묶음은 «지식 한 건에 무엇이 있나» 로 적고, 받는 쪽이 자기 판의 규칙으로 들인다.
//
// 앞머리 형식: YAML 처럼 보이지만 값이 전부 JSON 이다(JSON 은 YAML 1.2 의 부분집합이라 YAML 도구로도 읽힌다).
//  YAML 을 직접 해석하지 않으려는 선택 — 따옴표·여러 줄·특수문자를 손으로 다루다 생기는 해석 차이를 없앤다.
//  JSON.stringify 는 줄바꿈을 \n 으로 바꾸므로 값 한 개는 반드시 한 줄이고, 그래서 첫 `\n---\n` 이 앞머리의 끝이다.
import { createHash } from "node:crypto";
import { readZip, writeZip, looksLikeZip, ZipFormatError, type ZipEntryInput } from "./zip.js";
import { isSealed, openSealedBundle } from "./seal.js";

export const BUNDLE_FORMAT = "lively-transfer";
/** 형식 판. 같은 판 안에서는 키를 **보태기만** 한다(받는 쪽은 모르는 키를 무시). 뜻이 바뀌면 판을 올린다. */
export const BUNDLE_VERSION = 1;

export interface BundleOrigin {
  /** 만든 워크스페이스의 고유 id(store.ts getWorkspaceUid) — 셀프호스팅 기본 워크스페이스 id 는 박스마다 같은 값이라 쓰지 않는다. */
  workspace_uid: string;
  name: string | null;
  gateway_url: string | null;
  core_version: string | null;
}

export interface BundleLink { to: string; relation: string }
export interface BundleSourceRef { ref: string; relation: string }

export interface BundleKnowledge {
  /** 원래 이름 — 만든 워크스페이스 안에서 유일하다. 가져온 기록(org_transfer_origin)의 열쇠. */
  ref: string;
  title: string | null;
  body_md: string;
  type: string | null;
  /** 원래 분류 key(없으면 null — 미분류) */
  category: string | null;
  lifecycle: string;
  provenance: string;
  injection: string;
  confidence: string | null;
  summary: string | null;
  is_wiki: boolean;
  searchable: boolean;
  is_folder: boolean;
  /** 원래 상위 폴더 이름 */
  parent: string | null;
  sort: number;
  visibility: string;
  supersedes: string | null;
  fields: Record<string, unknown>;
  external_system: string | null;
  external_url: string | null;
  /** 본문 밖에 저장된 지식 간 연결(본문 [[…]] 에서 생긴 것은 본문이 진실이라 담지 않는다) */
  links: BundleLink[];
  sources: BundleSourceRef[];
  updated_at: string | null;
  version: number | null;
}

export interface BundleCategory {
  key: string;
  name: string | null;
  description: string | null;
  should: string | null;
  cross_cutting: boolean;
}

export interface BundleSource {
  ref: string;
  kind: string;
  title: string | null;
  body_md: string;
  fields: Record<string, unknown>;
  provenance: string;
  visibility: string;
  external_system: string | null;
  external_instance: string | null;
  external_id: string | null;
  external_url: string | null;
  parent_external_id: string | null;
  occurred_at: string | null;
  author: string | null;
}

export interface BundleSelection {
  all: boolean;
  categories: string[];
  knowledge: number;
  include_sources: boolean;
  include_archived: boolean;
}

export interface BundleManifest {
  format: typeof BUNDLE_FORMAT;
  version: number;
  created_at: string;
  origin: BundleOrigin;
  exported_by: string | null;
  counts: { knowledge: number; categories: number; sources: number };
  selection: BundleSelection;
  /** 파일 경로 → sha256·크기. manifest.json 자신은 빠진다. */
  files: Record<string, { sha256: string; bytes: number }>;
}

export interface Bundle {
  manifest: BundleManifest;
  knowledge: BundleKnowledge[];
  categories: BundleCategory[];
  sources: BundleSource[];
}

/** 묶음을 읽다 건너뛴 항목 — 미리보기 경고로 보여 준다(묶음 전체를 버리지 않는다). */
export interface BundleProblem { path: string; reason: string }

export class BundleFormatError extends Error {}
/** 잠긴 묶음인데 비밀번호가 없다 — 화면이 비밀번호 칸을 띄우는 신호(code 로 가른다). */
export class BundlePasswordRequiredError extends Error {
  readonly code = "password_required";
  constructor() { super("비밀번호를 건 파일입니다 — 내보낼 때 정한 비밀번호를 넣어 주세요"); }
}

export const sha256Hex = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

// ── 정규화 JSON · 내용 지문 ──────────────────────────────────────────────────────────────

/** 키 순서를 정렬한 JSON — 같은 내용이면 같은 문자열(jsonb 는 키 순서를 보존하지 않는다). */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** 지문을 낼 내용 — 다시 가져올 때 «바뀌었나» 를 판정하는 칸만. 원본 쪽(묶음)과 받는 쪽(행)이 같은 모양으로 넣는다. */
export interface ContentShape {
  title: string | null;
  body_md: string;
  type: string | null;
  category: string | null;
  summary: string | null;
  is_folder: boolean;
  parent: string | null;
  fields: Record<string, unknown>;
}

export function contentHash(c: ContentShape): string {
  return sha256Hex(canonicalJson({
    title: c.title ?? null, body_md: c.body_md ?? "", type: c.type ?? null, category: c.category ?? null,
    summary: c.summary ?? null, is_folder: !!c.is_folder, parent: c.parent ?? null, fields: c.fields ?? {},
  }));
}

export const bundleContentHash = (k: BundleKnowledge): string => contentHash({
  title: k.title, body_md: k.body_md, type: k.type, category: k.category, summary: k.summary,
  is_folder: k.is_folder, parent: k.parent, fields: k.fields,
});

// ── 앞머리 ───────────────────────────────────────────────────────────────────────────

const META_KEY_RE = /^[a-z_]{1,40}$/;

/** 지식 한 건 → md 글(앞머리 + 본문). 본문은 한 글자도 바꾸지 않는다. */
export function knowledgeToMarkdown(k: BundleKnowledge): string {
  const meta: Array<[string, unknown]> = [
    ["lively", BUNDLE_VERSION],
    ["ref", k.ref], ["title", k.title], ["type", k.type], ["category", k.category],
    ["lifecycle", k.lifecycle], ["provenance", k.provenance], ["injection", k.injection], ["confidence", k.confidence],
    ["summary", k.summary], ["is_wiki", k.is_wiki], ["searchable", k.searchable], ["is_folder", k.is_folder],
    ["parent", k.parent], ["sort", k.sort], ["visibility", k.visibility], ["supersedes", k.supersedes],
    ["fields", k.fields], ["external_system", k.external_system], ["external_url", k.external_url],
    ["links", k.links], ["sources", k.sources], ["updated_at", k.updated_at], ["version", k.version],
  ];
  const lines = meta.map(([key, v]) => `${key}: ${JSON.stringify(v ?? null)}`);
  return `---\n${lines.join("\n")}\n---\n${k.body_md}`;
}

/** md 글 → 앞머리 값들 + 본문. 형식이 어긋나면 BundleFormatError. */
export function parseFrontMatter(text: string): { meta: Record<string, unknown>; body: string } {
  const src = text.startsWith("﻿") ? text.slice(1) : text;
  if (!src.startsWith("---\n")) throw new BundleFormatError("앞머리(---)로 시작하지 않습니다");
  const end = src.indexOf("\n---\n", 3);
  // 본문이 비어 파일이 `---` 로 끝나는 경우(폴더)
  const endAtEof = end < 0 && src.endsWith("\n---") ? src.length - 4 : -1;
  const close = end >= 0 ? end : endAtEof;
  if (close < 0) throw new BundleFormatError("앞머리가 닫히지 않았습니다");
  const meta: Record<string, unknown> = {};
  for (const line of src.slice(4, close).split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(": ");
    if (i <= 0) throw new BundleFormatError(`앞머리 줄 형식이 아닙니다: ${line.slice(0, 60)}`);
    const key = line.slice(0, i);
    if (!META_KEY_RE.test(key)) throw new BundleFormatError(`앞머리 키 이름이 잘못되었습니다: ${key.slice(0, 40)}`);
    try { meta[key] = JSON.parse(line.slice(i + 2)); }
    catch { throw new BundleFormatError(`앞머리 값이 JSON 이 아닙니다(${key})`); }
  }
  const body = end >= 0 ? src.slice(end + 5) : "";
  return { meta, body };
}

// ── 값 다듬기(남이 만든 파일이다 — 모양을 믿지 않는다) ──────────────────────────────────

const str = (v: unknown, max = 100_000): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const bool = (v: unknown, dflt: boolean): boolean => (typeof v === "boolean" ? v : dflt);
const int = (v: unknown, dflt: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : dflt);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function knowledgeFromMeta(meta: Record<string, unknown>, body: string): BundleKnowledge {
  const ref = str(meta.ref, 200);
  if (!ref) throw new BundleFormatError("ref(원래 이름)가 없습니다");
  const links = Array.isArray(meta.links) ? meta.links : [];
  const sources = Array.isArray(meta.sources) ? meta.sources : [];
  return {
    ref,
    title: str(meta.title, 2000),
    body_md: body,
    type: str(meta.type, 40),
    category: str(meta.category, 200),
    lifecycle: str(meta.lifecycle, 40) ?? "active",
    provenance: str(meta.provenance, 40) ?? "authored",
    injection: str(meta.injection, 40) ?? "recalled",
    confidence: str(meta.confidence, 40),
    summary: str(meta.summary, 20_000),
    is_wiki: bool(meta.is_wiki, false),
    searchable: bool(meta.searchable, true),
    is_folder: bool(meta.is_folder, false),
    parent: str(meta.parent, 200),
    sort: int(meta.sort, 0),
    visibility: str(meta.visibility, 40) ?? "open",
    supersedes: str(meta.supersedes, 200),
    fields: obj(meta.fields),
    external_system: str(meta.external_system, 200),
    external_url: str(meta.external_url, 4000),
    links: links
      .map((l) => obj(l))
      .filter((l) => typeof l.to === "string" && l.to)
      .map((l) => ({ to: String(l.to).slice(0, 200), relation: typeof l.relation === "string" ? l.relation.slice(0, 40) : "related" })),
    sources: sources
      .map((s) => obj(s))
      .filter((s) => (typeof s.ref === "string" || typeof s.ref === "number") && String(s.ref))
      .map((s) => ({ ref: String(s.ref).slice(0, 200), relation: typeof s.relation === "string" ? s.relation.slice(0, 40) : "cites" })),
    updated_at: str(meta.updated_at, 64),
    version: typeof meta.version === "number" ? int(meta.version, 0) : null,
  };
}

function categoryFrom(v: unknown): BundleCategory | null {
  const o = obj(v);
  const key = str(o.key, 200);
  if (!key) return null;
  return { key, name: str(o.name, 500), description: str(o.description, 20_000), should: str(o.should, 20_000), cross_cutting: bool(o.cross_cutting, false) };
}

function sourceFrom(v: unknown): BundleSource {
  const o = obj(v);
  const ref = o.ref == null ? null : String(o.ref).slice(0, 200);
  if (!ref) throw new BundleFormatError("자료 ref 가 없습니다");
  return {
    ref,
    kind: str(o.kind, 80) ?? "other",
    title: str(o.title, 2000),
    body_md: str(o.body_md, 50_000_000) ?? "",
    fields: obj(o.fields),
    provenance: str(o.provenance, 40) ?? "observed",
    visibility: str(o.visibility, 40) ?? "open",
    external_system: str(o.external_system, 200),
    external_instance: str(o.external_instance, 500),
    external_id: str(o.external_id, 1000),
    external_url: str(o.external_url, 4000),
    parent_external_id: str(o.parent_external_id, 1000),
    occurred_at: str(o.occurred_at, 64),
    author: str(o.author, 500),
  };
}

// ── 파일 이름 ────────────────────────────────────────────────────────────────────────

/** 지식 이름 → 묶음 안 파일 경로. 이름은 슬러그(영숫자·한글·하이픈)지만, 남이 만든 이름일 수 있어 한 번 더 거른다. */
export function knowledgePath(ref: string): string {
  const safe = ref.replace(/[^A-Za-z0-9가-힣._-]/g, "_").slice(0, 120) || "untitled";
  return `knowledge/${safe}.md`;
}
export const sourcePath = (ref: string): string => `sources/${ref.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120)}.json`;

// ── 쓰기 ─────────────────────────────────────────────────────────────────────────────

function readme(m: Omit<BundleManifest, "files">): string {
  const where = [m.origin.name, m.origin.gateway_url ? `(${m.origin.gateway_url})` : ""].filter(Boolean).join(" ");
  return [
    "이 파일은 라이블리 «워크스페이스 간 옮기기» 묶음입니다.",
    "",
    `- 만든 곳: ${where || "(이름 없음)"}`,
    `- 만든 때: ${m.created_at}`,
    `- 담긴 것: 지식 ${m.counts.knowledge}건 · 분류 ${m.counts.categories}개 · 자료 ${m.counts.sources}건`,
    "",
    "받는 워크스페이스의 [워크스페이스 설정 ▸ 옮기기 ▸ 가져오기]에서 이 파일을 올리면,",
    "적용하기 전에 무엇이 새로 들어오고 무엇이 겹치는지 미리보기로 보여 줍니다.",
    "",
    "knowledge 폴더의 .md 파일이 지식 한 건씩입니다. 맨 위 --- 사이는 분류·종류 같은 정보이고, 그 아래가 본문입니다.",
    "",
  ].join("\n");
}

/** 묶음 → zip 바이트. 같은 묶음이면 manifest.files 의 지문이 같다(만든 때·순서와 무관하게 내용으로 대조할 수 있게). */
export function writeBundleZip(b: Omit<Bundle, "manifest"> & { manifest: Omit<BundleManifest, "files" | "counts"> }, at = new Date()): { zip: Buffer; manifest: BundleManifest } {
  const entries: ZipEntryInput[] = [];
  const used = new Set<string>();
  //  경로는 **대소문자 없이도** 겹치지 않게 한다 — 이름이 대소문자만 다른 지식이 실재하고(2026-06-11-PM툴… / …-pm툴…, 2026-11-09
  //   stage 실측), macOS·Windows 기본 파일 시스템은 대소문자를 가리지 않아 압축을 풀면 한쪽이 덮어써진다. 라이블리 가져오기는
  //   메모리에서 읽으므로 상관없지만, 사람이 풀어 볼 때 한 건이 사라져 보인다. 진짜 이름은 앞머리의 ref 다 — 경로는 담는 자리일 뿐.
  const uniquePath = (path: string): string => {
    if (!used.has(path.toLowerCase())) return path;
    const dot = path.lastIndexOf(".");
    for (let i = 2; ; i++) {
      const cand = `${path.slice(0, dot)}~${i}${path.slice(dot)}`;
      if (!used.has(cand.toLowerCase())) return cand;
    }
  };
  const add = (path: string, data: Buffer): void => {
    if (used.has(path.toLowerCase())) throw new BundleFormatError(`같은 파일 이름이 두 번 나왔습니다: ${path}`);
    used.add(path.toLowerCase());
    entries.push({ path, data });
  };
  add("categories.json", Buffer.from(JSON.stringify(b.categories, null, 2) + "\n", "utf8"));
  for (const k of b.knowledge) add(uniquePath(knowledgePath(k.ref)), Buffer.from(knowledgeToMarkdown(k), "utf8"));
  for (const s of b.sources) add(sourcePath(s.ref), Buffer.from(JSON.stringify(s, null, 2) + "\n", "utf8"));
  const counts = { knowledge: b.knowledge.length, categories: b.categories.length, sources: b.sources.length };
  const base = { ...b.manifest, counts };
  add("README.txt", Buffer.from(readme(base), "utf8"));
  const files: BundleManifest["files"] = {};
  for (const e of entries) files[e.path] = { sha256: sha256Hex(e.data), bytes: e.data.length };
  const manifest: BundleManifest = { ...base, files };
  const all = [{ path: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8") }, ...entries];
  return { zip: writeZip(all, at), manifest };
}

// ── 읽기 ─────────────────────────────────────────────────────────────────────────────

/** 파일 바이트(zip 또는 잠긴 묶음) → 묶음. 잠겼는데 비밀번호가 없으면 BundlePasswordRequiredError.
 *  zip = 잠금을 푼 zip 바이트(적용 때 다시 읽으려고 보관한다 — 비밀번호를 다시 묻지 않게). */
export async function readBundle(buf: Buffer, password?: string | null): Promise<{ bundle: Bundle; problems: BundleProblem[]; sealed: boolean; zip: Buffer }> {
  let zip = buf;
  const sealed = isSealed(buf);
  if (sealed) {
    if (!password) throw new BundlePasswordRequiredError();
    zip = await openSealedBundle(buf, password);
  }
  if (!looksLikeZip(zip)) throw new BundleFormatError("라이블리 옮기기 묶음 파일이 아닙니다 — 내보내기로 받은 .zip 또는 .lively 파일을 올려 주세요");
  let files: Map<string, Buffer>;
  try { files = readZip(zip); }
  catch (e) { if (e instanceof ZipFormatError) throw new BundleFormatError(e.message); throw e; }

  const mraw = files.get("manifest.json");
  if (!mraw) throw new BundleFormatError("manifest.json 이 없습니다 — 라이블리 옮기기 묶음이 아닙니다");
  let manifest: BundleManifest;
  try { manifest = JSON.parse(mraw.toString("utf8")) as BundleManifest; }
  catch { throw new BundleFormatError("manifest.json 을 읽지 못했습니다"); }
  if (manifest?.format !== BUNDLE_FORMAT) throw new BundleFormatError("라이블리 옮기기 묶음이 아닙니다(형식 이름이 다릅니다)");
  if (!Number.isInteger(manifest.version) || manifest.version < 1) throw new BundleFormatError("묶음 판 번호가 잘못되었습니다");
  if (manifest.version > BUNDLE_VERSION) {
    throw new BundleFormatError(`이 파일은 더 새 라이블리에서 만들어졌습니다(묶음 판 ${manifest.version}) — 받는 쪽 라이블리를 업데이트한 뒤 가져와 주세요`);
  }
  const uid = str(manifest.origin?.workspace_uid, 200);
  if (!uid) throw new BundleFormatError("만든 워크스페이스 id 가 없습니다");

  // 무결성 — 목록에 있는 파일만 읽고, 지문이 맞는지 본다(목록에 없는 파일은 읽지 않는다).
  const listed = obj(manifest.files) as BundleManifest["files"];
  for (const [path, meta] of Object.entries(listed)) {
    const data = files.get(path);
    if (!data) throw new BundleFormatError(`목록에 있는 파일이 없습니다: ${path} — 파일이 망가졌습니다`);
    if (sha256Hex(data) !== String(meta?.sha256 ?? "")) throw new BundleFormatError(`파일 내용이 목록과 다릅니다: ${path} — 내보낸 뒤 바뀌었거나 망가졌습니다`);
  }

  const problems: BundleProblem[] = [];
  const categories: BundleCategory[] = [];
  const craw = listed["categories.json"] ? files.get("categories.json") : undefined;
  if (craw) {
    let arr: unknown;
    try { arr = JSON.parse(craw.toString("utf8")); } catch { throw new BundleFormatError("categories.json 을 읽지 못했습니다"); }
    for (const c of Array.isArray(arr) ? arr : []) {
      const cat = categoryFrom(c);
      if (cat) categories.push(cat); else problems.push({ path: "categories.json", reason: "key 가 없는 분류를 건너뛰었습니다" });
    }
  }

  const knowledge: BundleKnowledge[] = [];
  const seenRefs = new Set<string>();
  const sources: BundleSource[] = [];
  for (const path of Object.keys(listed).sort()) {
    if (path.startsWith("knowledge/") && path.endsWith(".md")) {
      try {
        const { meta, body } = parseFrontMatter(files.get(path)!.toString("utf8"));
        const k = knowledgeFromMeta(meta, body);
        if (seenRefs.has(k.ref)) { problems.push({ path, reason: `같은 지식(${k.ref})이 두 번 들어 있어 뒤의 것을 건너뛰었습니다` }); continue; }
        seenRefs.add(k.ref);
        knowledge.push(k);
      } catch (e) {
        problems.push({ path, reason: (e as Error).message });
      }
    } else if (path.startsWith("sources/") && path.endsWith(".json")) {
      try { sources.push(sourceFrom(JSON.parse(files.get(path)!.toString("utf8")))); }
      catch (e) { problems.push({ path, reason: e instanceof SyntaxError ? "JSON 을 읽지 못했습니다" : (e as Error).message }); }
    }
  }
  return { bundle: { manifest, knowledge, categories, sources }, problems, sealed, zip };
}
