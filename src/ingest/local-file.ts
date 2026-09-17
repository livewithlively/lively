// 로컬(내 컴퓨터) 업로드 → 자료(source) 브리지 (#1881 L1) — "올린 파일 1개 = 자료 1건".
//  왜: 종전엔 폴더에 올린 파일을 그 세션이 절대경로로 한 번 읽고 끝이었다 — 자료 테이블에 없으니 근거(derived_from)로
//   남지 않고 증류 대상도 아니었다. 다른 수집기(슬랙·드라이브)와 **같은 길**(source → 증류기 → 지식)로 태운다.
//  적재는 mirrorSourceV6 재사용(새 insert 경로 없음): 좌표 upsert · redact · 공개범위 스탬프 · audit 노이즈 게이트가 그대로 적용된다.
//  본문: 텍스트는 즉시, OOXML(+hwpx)·한글 hwp 는 zero-dep 추출, PDF·이미지는 [BINARY] 스텁(증류 세션이 source_artifact 로 받아 Read),
//   구버전 오피스(.doc/.xls/.ppt)는 "읽을 수 없음" 스텁, 실행파일·아카이브·미디어는 자료를 만들지 않는다(파일은 폴더에 남는다).
//  ⚠ 경로 가드: 점파일·node_modules·provision 워크트리(.git 보유 조상) 하위는 자료 아님 — 코드는 git 소유(#714·#828).
//  ⚠ 실패해도 업로드는 성공이다 — 호출부는 catch 해 로그만 남긴다(자료 등록은 best-effort).
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { PassThrough, type Readable } from "node:stream";
import { withTx, itemsPool } from "../db/client.js";
import type { RawItem } from "../items/store.js";
import type { LivelyUser } from "../context.js";
import { mirrorSourceV6 } from "../v6/mirror/mirror-source.js";
import { normalizeExternalInstance } from "../org/ingest/external-identity.js";
import { getProjectRow } from "../v6/project-store.js";
import { projectStorage } from "../project/project-storage.js";   // #4064 — 프로젝트 파일의 자리·실행 주체
import { isGitRepoRoot } from "../project/project-manifest.js";
import { extractOoxml, ooxmlKindFromName, printableRatio } from "../connectors/ooxml.js";
import { extractHwp } from "../connectors/hwp.js";   // #3778 — 한글 .hwp 본문(OLE2 + BodyText 레코드)
import { memberReadRange, memberReadTo, memberStat } from "../terminal/terminal-member-fs.js";
import { resolveRootPath, userSlug } from "../terminal/profiles.js";
import { resolveMemberOsUser } from "../terminal/terminal-isolation.js";
import { ensureLocalFilesDistillerOnce } from "../org/distill/local-preset.js";   // #1881 L3 — 첫 업로드 때 증류기 프리셋(꺼진 채)
import {
  LOCAL_SYSTEM, LOCAL_INSTANCE, type LocalRoot, type LocalIngestKind,
  localExternalId, parseLocalExternalId, normalizeLocalRel, classifyLocalPath, localChannelOf, localFileUrl, localMimeOf,
  buildLocalBinaryStub, STUB_NOTE_VISION, stubNoteUnreadable, stubNoteExtractFailed, decodeLocalText, looksLikeText,
} from "./local-file-core.js";

export * from "./local-file-core.js";

const MAX_TEXT_BYTES = 4_000_000;     // 텍스트 원본 읽기 상한(4MB) — 넘으면 앞부분만
const MAX_BODY_CHARS = 1_000_000;     // 본문 저장 상한(gdrive 와 동일)
const MAX_OOXML_BYTES = 30_000_000;   // OOXML 추출용 바이트 상한(gdrive MAX_BINARY_BYTES 와 동일)

export interface LocalUploadInput {
  root: LocalRoot;
  /** 프로젝트 폴더(project/<id>) — 원본 링크 구성용. 개인·shared 는 생략. */
  folder?: string | null;
  /** 루트 절대경로(상대경로의 기준) */
  base: string;
  /** 올린 파일 절대경로 */
  abs: string;
  /** 격리 멤버(#524)면 그 uid — 파일 소유자가 멤버라 게이트웨이가 직접 못 읽는다 */
  osUser: string | null;
  uploader: { id: string | null; name?: string | null };
  /** 채널(최상위 폴더)이 없을 때의 채널명 — 프로젝트명·'uploads' 등 */
  channelFallback: string;
}
export interface LocalIngestResult {
  ingested: boolean; kind: LocalIngestKind; reason?: string; source_id?: number; external_id?: string;
}

const relOf = (base: string, abs: string): string => normalizeLocalRel(path.relative(base, abs));

// 조상 중 git 레포 루트가 있나(base 까지) — provision 워크트리 안의 파일은 자료가 아니다(#828 매니페스트와 같은 판정).
async function insideGitRepo(base: string, abs: string): Promise<boolean> {
  let dir = path.dirname(abs);
  const stop = path.resolve(base);
  while (dir.startsWith(stop) && dir !== stop) {
    if (await isGitRepoRoot(dir)) return true;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return false;
}

async function statOf(abs: string, osUser: string | null): Promise<{ size: number; mtime: string | null } | null> {
  if (osUser) {
    const st = await memberStat(osUser, abs);
    if (!st?.file) return null;
    // 멤버 소유 파일의 mtime 은 게이트웨이가 stat 못 할 수 있다 — 되면 쓰고, 안 되면 null(occurred_at 은 비운다).
    const m = await fsp.stat(abs).then((s) => s.mtime.toISOString()).catch(() => null);
    return { size: st.size, mtime: m };
  }
  const st = await fsp.stat(abs).catch(() => null);
  if (!st?.isFile()) return null;
  return { size: st.size, mtime: st.mtime.toISOString() };
}

// 앞 maxBytes 만 읽는다(멤버 소유면 uid 로). 전체 크기는 statOf 가 준다.
async function readHead(abs: string, osUser: string | null, size: number, maxBytes: number): Promise<Buffer> {
  const n = Math.min(size, maxBytes);
  if (osUser) return n > 0 ? memberReadRange(osUser, abs, 0, n) : Buffer.alloc(0);
  const fh = await fsp.open(abs, "r");
  try {
    const buf = Buffer.alloc(n);
    let off = 0;
    while (off < n) {
      const r = await fh.read(buf, off, n - off, off);
      if (r.bytesRead === 0) break;
      off += r.bytesRead;
    }
    return off === n ? buf : buf.subarray(0, off);
  } finally { await fh.close(); }
}

async function buildBody(u: LocalUploadInput, rel: string, name: string, size: number, mtime: string | null)
  : Promise<{ body: string; extracted: boolean; kind: LocalIngestKind; reason?: string }> {
  const c = classifyLocalPath(rel);
  const mime = localMimeOf(name);
  const url = localFileUrl(u.root, rel, u.folder);
  const stub = (note: string): string => buildLocalBinaryStub({ filename: name, mime, size, url, modified: mtime, note });

  if (c.kind === "vision") return { body: stub(STUB_NOTE_VISION), extracted: false, kind: c.kind };
  if (c.kind === "unreadable") return { body: stub(stubNoteUnreadable(c.reason ?? c.ext, c.ext)), extracted: false, kind: c.kind };
  if (c.kind === "ooxml") {
    const ok = ooxmlKindFromName(name)!;
    if (size > MAX_OOXML_BYTES) return { body: stub(stubNoteExtractFailed(`${Math.round(size / 1e6)}MB — 30MB 초과`)), extracted: false, kind: c.kind, reason: "too-large" };
    try {
      const text = extractOoxml(ok, await readHead(u.abs, u.osUser, size, size));
      if (!text || printableRatio(text) < 0.6) return { body: stub(stubNoteExtractFailed("빈 결과 또는 깨진 추출")), extracted: false, kind: c.kind, reason: "empty" };
      return { body: text.slice(0, MAX_BODY_CHARS), extracted: true, kind: c.kind };
    } catch (e) {
      return { body: stub(stubNoteExtractFailed((e as Error)?.message ?? String(e))), extracted: false, kind: c.kind, reason: "extract-error" };
    }
  }
  //  한글 .hwp (#3778) — 종전엔 「읽을 수 없음」 스텁이었다. 실은 읽을 수 있었고, 그래서 한국 고객의 자료가
  //   통째로 검색·증류 밖에 있었다. OOXML 과 같은 관문(크기 상한 → 추출 → printableRatio 가드 → 스텁 폴백)을 탄다.
  if (c.kind === "hwp") {
    if (size > MAX_OOXML_BYTES) return { body: stub(stubNoteExtractFailed(`${Math.round(size / 1e6)}MB — 30MB 초과`)), extracted: false, kind: c.kind, reason: "too-large" };
    try {
      const text = extractHwp(await readHead(u.abs, u.osUser, size, size));
      if (!text || printableRatio(text) < 0.6) return { body: stub(stubNoteExtractFailed("빈 결과 또는 깨진 추출")), extracted: false, kind: c.kind, reason: "empty" };
      return { body: text.slice(0, MAX_BODY_CHARS), extracted: true, kind: c.kind };
    } catch (e) {
      return { body: stub(stubNoteExtractFailed((e as Error)?.message ?? String(e))), extracted: false, kind: c.kind, reason: "extract-error" };
    }
  }
  // text | sniff
  const head = await readHead(u.abs, u.osUser, size, MAX_TEXT_BYTES);
  if (c.kind === "sniff" && !looksLikeText(head)) {
    return { body: stub("형식을 알 수 없는 바이너리 — Read 로 본문이 나오지 않습니다. fetch 없이 skip 하세요."), extracted: false, kind: "sniff", reason: "binary" };
  }
  const text = decodeLocalText(head);
  const truncated = size > head.length || text.length > MAX_BODY_CHARS;
  const body = text.slice(0, MAX_BODY_CHARS) + (truncated ? `\n\n[… 본문이 길어 앞 ${MAX_BODY_CHARS.toLocaleString()}자까지만 실었습니다 — 전문은 ${url}]` : "");
  return { body, extracted: true, kind: c.kind === "sniff" ? "text" : c.kind };
}

/**
 * 올린 파일 1개를 자료 1건으로. 라우트가 receiveUpload 를 끝낸 **뒤** 부른다(목적지 파일이 완성된 상태).
 *  같은 경로 재업로드는 upsert(자료 1건 유지) + 지워졌던 것이면 다시 active. 개인 폴더는 올린 사람 self-only(#1881 열린 결정 2).
 */
export async function ingestLocalUpload(u: LocalUploadInput): Promise<LocalIngestResult> {
  const rel = relOf(u.base, u.abs);
  if (!rel || rel.startsWith("../")) return { ingested: false, kind: "skip", reason: "outside-root" };
  const c = classifyLocalPath(rel);
  if (c.kind === "skip") return { ingested: false, kind: "skip", reason: c.reason };
  if (await insideGitRepo(u.base, u.abs)) return { ingested: false, kind: "skip", reason: "repo" };

  const st = await statOf(u.abs, u.osUser);
  if (!st) return { ingested: false, kind: "skip", reason: "not-a-file" };
  const name = path.basename(u.abs);
  const built = await buildBody(u, rel, name, st.size, st.mtime);
  const extId = localExternalId(u.root, rel);
  const item: RawItem = {
    type: "note",
    provenance: { category: "local", system: LOCAL_SYSTEM, instance: LOCAL_INSTANCE, external_id: extId, external_url: localFileUrl(u.root, rel, u.folder) },
    actor: { external_id: u.uploader.id ?? undefined, display_name: u.uploader.name ?? undefined, is_bot: false },
    container_ref: extId.slice(0, extId.indexOf("/")),
    container_name: localChannelOf(u.root, rel, u.channelFallback),
    title: name,
    body: built.body,
    occurred_at: st.mtime ?? undefined,
    updated_at: st.mtime ?? undefined,
    fields: { path: rel, root: u.root.kind, ext: c.ext, bytes: st.size, extracted: built.extracted, local_kind: built.kind, ...(built.reason ? { local_reason: built.reason } : {}) },
  };

  const id = await withTx(async (client) => {
    await mirrorSourceV6(client, item, LOCAL_SYSTEM, extId);
    const r = await client.query(
      `SELECT id, lifecycle FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
      [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), extId]);
    const row = r.rows[0] as { id: number; lifecycle: string } | undefined;
    if (!row) throw new Error("자료 행을 찾지 못했습니다(upsert 직후)");
    // 지웠다가 다시 올린 파일 — mirror 의 upsert 는 lifecycle 을 안 건드리므로 여기서 되살린다.
    if (row.lifecycle !== "active") await client.query(`UPDATE source SET lifecycle='active', updated_at=now() WHERE id=$1`, [row.id]);
    // ⚠ (#4007) 여기서 «올린 사람만» 으로 잠그지 않는다 — 되살리지 마라.
    //  종전(#1436·#1631)엔 개인 루트 업로드를 무조건 업로더 1인으로 잠갔다. 그런데 **자료·지식은 이미
    //  워크스페이스로 갈린다**(tenant_id + RLS `tenant_isolation`; db/tenant-column.ts 의 IDENTITY_GLOBAL_TABLES 에
    //  source·knowledge 가 없다. #1875 실측: 자료 100 vs 0, 겹침 0). 개인 프라이버시는 개인 워크스페이스가 받는
    //  축이라, 그 위에 워크스페이스 **안쪽** 잠금을 또 두면 같은 걱정을 두 번 처리하면서 부작용만 남는다.
    //  실제로 부작용만 나왔다(2026-09-16 실측): 정책 0개인 조직에 잠긴 자료 69건 · 공개 포스터에서 뽑은 지식이
    //  derived_from 상속으로 잠김 · anyLockedContext() 가 참이 되어 조직 전체 db_query self 차단.
    //  워크스페이스 안에서 자료를 가르고 싶으면 그건 부서 구분이고, 도구는 org_source_vis_policy(EE)다 —
    //  로컬 업로드도 mirrorSourceV6 → stampSourceVisibility 를 지나므로 match_system='local' 정책이 그대로 먹는다.
    //  ★ 그 경로는 axisOn('source') 를 본다. 여기서 applyVisibility 를 직접 부르면 그 가드를 우회한다(종전의 실제 결함).
    return row.id;
  });
  // 자료가 생겼으면 그걸 지식으로 만들 증류기가 있어야 한다 — 없으면 꺼진 채로 만들어 둔다(승인 때 켠다). 실패해도 자료 등록엔 무관.
  void ensureLocalFilesDistillerOnce(u.uploader.id);
  return { ingested: true, kind: built.kind, reason: built.reason, source_id: id, external_id: extId };
}

/** 파일/폴더 삭제 전파 — 그 경로(폴더면 하위 전부)의 자료를 superseded 로. 파생 지식은 그대로(지식은 사람 결정). */
export async function supersedeLocalPath(root: LocalRoot, rel: string): Promise<number> {
  const key = localExternalId(root, rel);
  const r = await itemsPool.query(
    `UPDATE source SET lifecycle='superseded', updated_at=now()
      WHERE external_system=$1 AND external_instance=$2 AND lifecycle='active'
        AND (external_id=$3 OR starts_with(external_id, $3 || '/'))
      RETURNING id`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), key]);
  return r.rowCount ?? 0;
}

// ── 브라우즈 라우트(개인/공유 루트) → 로컬 루트 좌표. 공유 루트 아래 project/<id>/… 는 프로젝트 좌표로 접는다(같은 파일 = 같은 자료). ──
export async function localRootForBrowse(rootKey: string, user: LivelyUser, base: string, abs: string)
  : Promise<{ root: LocalRoot; base: string; folder?: string | null; channelFallback: string } | null> {
  if (rootKey === "personal") {
    return { root: { kind: "personal", member: user.userId || user.email || userSlug(user) }, base, channelFallback: "uploads" };
  }
  if (rootKey === "shared") {
    const rel = relOf(base, abs);
    const m = rel.match(/^(project|legacy-project)\/(\d+)\/(.+)$/);
    if (m) {
      const id = Number(m[2]);
      const folder = `${m[1]}/${m[2]}`;
      const row = await getProjectRow(id).catch(() => undefined);
      return { root: { kind: "project", id }, base: path.join(base, folder), folder, channelFallback: row?.name ?? folder };
    }
    return { root: { kind: "shared" }, base, channelFallback: "shared" };
  }
  return null;
}

// ── 좌표 → 파일 위치(source_artifact 용). ──
const userFor = (member: string): LivelyUser => ({ userId: member, email: "", scopes: [], projects: [] } as unknown as LivelyUser);

export async function resolveLocalFile(p: { root: LocalRoot; rel: string }, uploaderHint?: string | null)
  : Promise<{ abs: string; osUser: string | null } | null> {
  const rel = normalizeLocalRel(p.rel);
  if (!rel || rel.split("/").some((s) => s === "..")) return null;
  if (p.root.kind === "project") {
    const row = await getProjectRow(p.root.id);
    if (!row?.folder) return null;
    //  자리는 프로젝트 저장소가 정한다(#4064) — 저장소가 붙은 배포면 종전처럼 게이트웨이 로컬(그룹 rw 라 직접 읽는다),
    //  분리된 배포면 멤버 저장소를 올린 사람(없으면 만든 사람) 권한으로 읽는다.
    const who = uploaderHint || row.created_by || null;
    const store = await projectStorage(row.folder, who ? { memberId: who } : null, { id: row.id, name: row.name }).catch(() => null);
    if (!store) return null;
    const abs = path.resolve(store.base, rel);
    if (abs !== store.base && !abs.startsWith(store.base + path.sep)) return null;
    //  멤버 저장소는 세션이 마음대로 쓰는 자리다 — 링크를 해소한 뒤에도 그 안인지 본다(브라우즈 라우트와 같은 관문).
    if (store.osUser && !(await store.confined(abs).catch(() => false))) return null;
    return { abs, osUser: store.osUser };
  }
  const member = p.root.kind === "personal" ? p.root.member : (uploaderHint ?? null);
  const user = userFor(member ?? "user");
  const osUser = member ? await resolveMemberOsUser(userSlug(user)) : null;
  const { abs } = await resolveRootPath(user, p.root.kind === "personal" ? "personal" : "shared", rel, osUser);
  return { abs, osUser: p.root.kind === "personal" ? osUser : null };
}

/** connectors.local.fetchArtifact — external_id → 원본 스트림. 파일이 사라졌으면 null(→ unavailable → 증류가 skip). */
export async function openLocalArtifact(externalId: string)
  : Promise<{ stream: Readable | Buffer; mime: string; filename?: string; size?: number } | null> {
  const p = parseLocalExternalId(externalId);
  if (!p) return null;
  let hint: string | null = null;
  if (p.root.kind === "shared" || p.root.kind === "project") {
    // shared·project 루트는 격리 여부에 따라 베이스가 갈린다 — 올린 사람으로 판정한다(자료 fields 에 남겨 둔 값).
    const r = await itemsPool.query(
      `SELECT fields->>'author_external_id' AS m FROM source WHERE external_system=$1 AND external_instance=$2 AND external_id=$3 LIMIT 1`,
      [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), externalId]);
    hint = (r.rows[0] as { m?: string } | undefined)?.m ?? null;
  }
  const loc = await resolveLocalFile(p, hint);
  if (!loc) return null;
  const filename = path.basename(loc.abs);
  const mime = localMimeOf(filename);
  if (loc.osUser) {
    const st = await memberStat(loc.osUser, loc.abs);
    if (!st?.file) return null;
    const pt = new PassThrough();
    memberReadTo(loc.osUser, loc.abs, pt).catch((e) => pt.destroy(e as Error));
    return { stream: pt, mime, filename, size: st.size };
  }
  const st = await fsp.stat(loc.abs).catch(() => null);
  if (!st?.isFile()) return null;
  return { stream: fs.createReadStream(loc.abs), mime, filename, size: st.size };
}
