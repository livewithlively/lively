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
import type { PoolClient } from "pg";
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
import { ensureLocalFilesDistillerOnce } from "../org/distill/local-preset.js";
import { keepEntry, entryFields, type UploadEntry } from "./upload-entry.js";   // #4233: 들어온 길(올린 자료 · AI가 만든 파일)   // #1881 L3: 첫 업로드 때 증류기 프리셋(꺼진 채)
import {
  LOCAL_SYSTEM, LOCAL_INSTANCE, type LocalRoot, type LocalIngestKind,
  localExternalId, parseLocalExternalId, normalizeLocalRel, classifyLocalPath, localChannelOf, localFileUrl, localMimeOf, personalRootMember,
  type FileTrashStamp, movedLocalRow, LOCAL_ASIDE_PREFIX, type LocalMove, type LocalRowForMove, BODY_HEAD_SQL, BODY_TAIL_SQL,
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
  /** 들어온 길(#4233): 사람이 올렸나(upload) · AI 세션이 만들었나(generated). 판정은 ingest/upload-entry.ts. */
  entry: UploadEntry;
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
  //  프로젝트 이름(#4233): 자료 상세의 «올린 곳 · 만든 곳» 한 줄과 목록의 원천 칸이 읽는다. 폴더 이름(container_name)은
  //   하위 폴더면 그 폴더라 프로젝트를 말하지 못한다. 못 읽으면 적지 않는다(화면이 «프로젝트 #id» 로 쓴다).
  if (u.root.kind === "project") {
    const pname = await getProjectRow(u.root.id).then((r) => r?.name ?? null).catch(() => null);
    if (pname) item.fields = { ...item.fields, project_name: pname };
  }

  const id = await withTx(async (client) => {
    //  들어온 길은 처음 한 번 정해진다(#4233): 사람이 올린 파일을 AI 가 고쳐 다시 올려도 「올린 자료」에 남는다.
    //   mirror 의 upsert 는 fields 를 통째로 바꾸므로 기존 값을 먼저 읽어 이어 준다.
    const prev = await client.query(
      `SELECT fields->>'entry' AS entry, fields->>'entry_session' AS entry_session FROM source
        WHERE external_system=$1 AND external_instance=$2 AND external_id=$3`,
      [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), extId]);
    item.fields = { ...item.fields, ...entryFields(keepEntry(prev.rows[0] as { entry?: unknown; entry_session?: unknown } | undefined, u.entry)) };
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

/**
 * 이름 바꾸기·옮기기 전파(#4688) — 그 경로(폴더면 하위 전부)의 살아 있는 자료를 **같은 행 그대로** 새 좌표로 옮긴다.
 *  파일 옮기기가 끝난 **뒤에** 부른다(지우기 전파와 같은 순서). 값 계산은 local-file-core movedLocalRow(순수).
 *  ★ 도착 좌표를 먼저 비운다 — 좌표 고유 색인(source_external_uidx)은 생애주기와 무관하게 좌표 하나에 행 하나라, 도착 자리에 남은
 *   다른 행(지운 파일의 닫힌 기록 · 휴지통 기록 · 셸에서 지워져 파일 없이 남은 행)과 부딪힌다. 지우면 그 행에 걸린 지식 근거가 CASCADE 로
 *   사라지므로 지우지 않고 비켜 둔다(LOCAL_ASIDE_PREFIX + 번호, 원래 좌표는 fields.aside_from). 파일 옮기기는 도착 자리에 파일이 없을 때만
 *   하므로(라우트가 409 로 막는다) 그 자리의 살아 있는 행은 파일 없이 남은 것이다 — 닫아서 비켜 둔다.
 *  휴지통에 든 행(이미 닫힌 행)은 옮기지 않는다 — 되살리면 원래 자리로 간다(도장의 경로가 그 자리다).
 *  본문은 통째로 읽지 않는다 — 바꿀 수 있는 두 자리(안내문 머리 줄 · 긴 본문 꼬리)만 읽고, 고치기는 SQL 이 그 자리에서 한다
 *   (local-file-core applyBodyEdits 와 같은 규칙). 큰 글이 많은 폴더를 옮겨도 게이트웨이로 본문이 오지 않는다.
 *  돌려주는 값 = 옮긴 자료 수 · 비켜 둔 행 수.
 */
export async function moveLocalPath(m: LocalMove): Promise<{ moved: number; aside: number }> {
  const fromKey = localExternalId(m.root, m.fromRel);
  const toKey = localExternalId(m.root, m.toRel);
  if (!normalizeLocalRel(m.fromRel) || !normalizeLocalRel(m.toRel) || fromKey === toKey) return { moved: 0, aside: 0 };
  const inst = normalizeExternalInstance(LOCAL_INSTANCE);
  return await withTx(async (client) => {
    const r = await client.query(
      `SELECT id, external_id, external_url, title, fields, ${BODY_HEAD_SQL} AS body_head, ${BODY_TAIL_SQL} AS body_tail FROM source
        WHERE external_system=$1 AND external_instance=$2 AND lifecycle='active'
          AND (external_id=$3 OR starts_with(external_id, $3 || '/'))
        ORDER BY id FOR UPDATE`,
      [LOCAL_SYSTEM, inst, fromKey]);
    const plans = (r.rows as Array<LocalRowForMove & { id: number }>)
      .map((row) => ({ id: Number(row.id), next: movedLocalRow(row, m) }))
      .filter((p): p is { id: number; next: NonNullable<ReturnType<typeof movedLocalRow>> } => p.next !== null);
    if (!plans.length) return { moved: 0, aside: 0 };
    const ids = plans.map((p) => p.id);
    const aside = await setLocalRowsAside(client, plans.map((p) => p.next.external_id), ids);
    //  ⚠ updated_at 은 그대로 — 증류기는 그 값을 «내용이 바뀐 시각» 으로 읽는다(distiller.ts). 이름·자리만 바뀌었다.
    //  본문 고치기는 그 자리가 글자 그대로 같을 때만(applyBodyEdits 와 같은 규칙) — 그새 본문이 바뀌었으면 손대지 않는다.
    await client.query(
      `UPDATE source s SET external_id = v.eid, external_url = v.url, title = v.title, fields = v.fields::jsonb,
              body_md = CASE
                WHEN v.head_from IS NOT NULL AND split_part(s.body_md, E'\\n', 1) = v.head_from
                  THEN v.head_to || substring(s.body_md from char_length(v.head_from) + 1)
                WHEN v.tail_from IS NOT NULL AND right(s.body_md, char_length(v.tail_from)) = v.tail_from
                  THEN left(s.body_md, char_length(s.body_md) - char_length(v.tail_from)) || v.tail_to
                ELSE s.body_md END
         FROM unnest($1::int[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[])
              AS v(id, eid, url, title, fields, head_from, head_to, tail_from, tail_to)
        WHERE s.id = v.id`,
      [ids, plans.map((p) => p.next.external_id), plans.map((p) => p.next.external_url), plans.map((p) => p.next.title),
       plans.map((p) => JSON.stringify(p.next.fields)),
       plans.map((p) => p.next.head?.from ?? null), plans.map((p) => p.next.head?.to ?? null),
       plans.map((p) => p.next.tail?.from ?? null), plans.map((p) => p.next.tail?.to ?? null)]);
    return { moved: plans.length, aside: aside };
  });
}

/**
 * 좌표를 비켜 준다(#4688) — 그 좌표들을 쥔 행(except 의 행은 빼고)을 닫고 LOCAL_ASIDE_PREFIX + 번호로 옮긴다. 원래 좌표는 fields.aside_from.
 *  지우지 않는 까닭: 그 행에 걸린 지식 근거가 CASCADE 로 사라진다. 휴지통 기록이면 휴지통에 그대로 남고, 되살릴 때 좌표를 되찾는다.
 *  돌려주는 값 = 비켜 둔 행 수.
 */
async function setLocalRowsAside(client: PoolClient, externalIds: string[], except: number[]): Promise<number> {
  if (!externalIds.length) return 0;
  const r = await client.query(
    `UPDATE source SET external_id = $5 || id::text, lifecycle = 'superseded',
            fields = COALESCE(fields, '{}'::jsonb) || jsonb_build_object('aside_from', external_id)
      WHERE external_system=$1 AND external_instance=$2 AND external_id = ANY($3::text[]) AND id <> ALL($4::int[])`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), externalIds, except, LOCAL_ASIDE_PREFIX]);
  return r.rowCount ?? 0;
}

/**
 * supersedeLocalPath 의 역 — **그 좌표 한 건만** 다시 살린다(#4302 첨부 되돌리기: 파일이 원래 자리로 돌아왔다).
 *  하위 경로는 건드리지 않고, 휴지통 도장이 찍힌 행(사람이 지운 것)은 되살리지 않는다.
 */
export async function reactivateLocalPath(root: LocalRoot, rel: string): Promise<number> {
  const key = localExternalId(root, rel);
  const r = await itemsPool.query(
    `UPDATE source SET lifecycle='active', updated_at=now()
      WHERE external_system=$1 AND external_instance=$2 AND external_id=$3 AND lifecycle='superseded'
        AND NOT (COALESCE(fields, '{}'::jsonb) ? 'trash')
      RETURNING id`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), key]);
  return r.rowCount ?? 0;
}

// ── 파일 휴지통(#3778) ─────────────────────────────────────────────────────────────────────────────
//  원준 2026-09-20: 휴지통에 「자료」 탭 — «지운 자료도 되살릴 수 있어야 한다». 종전 파일 삭제는 디스크에서 바로 지웠고(rm),
//  자료 행만 superseded 로 숨었다 — 되살릴 바이트가 없었다. 이제 **자료가 달린 경로**는 지우는 대신 프로젝트 폴더 안
//  숨김 자리(`.lively/trash/<batch>/`)로 **옮기고**, 그 아래 자료마다 «어디서 어디로 갔나» 도장(fields.trash)을 찍는다.
//   · 숨김 자리인 이유: 목록·검색·동기화 매니페스트가 점으로 시작하는 이름을 전부 건너뛴다(project-storage·project-manifest) —
//     새 규칙 없이 화면과 로컬 PC 동기화에서 빠진다.
//   · 도장이 자료 행에 사는 이유: 휴지통 화면은 프로젝트를 가로질러 한 번에 읽어야 한다. 디스크를 프로젝트마다 훑을 수는 없다.
//   · 자료가 하나도 없는 경로(코드 폴더·node_modules·빈 폴더)는 종전대로 바로 지운다 — 휴지통에 세울 줄이 없는 것을
//     숨김 자리에 쌓으면 아무도 못 비우는 용량만 남는다.
/** 그 경로(폴더면 하위 전부)에 살아 있는 자료가 몇 건인가 — 0 이면 휴지통에 세울 것이 없다(종전대로 바로 지운다). */
export async function countActiveLocalUnder(root: LocalRoot, rel: string): Promise<number> {
  const key = localExternalId(root, rel);
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n FROM source
      WHERE external_system=$1 AND external_instance=$2 AND lifecycle='active'
        AND (external_id=$3 OR starts_with(external_id, $3 || '/'))`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), key]);
  return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

/** 옮긴 뒤에 찍는 도장 — supersedeLocalPath 와 같은 대상에 lifecycle='superseded' + fields.trash. 돌려주는 값 = 도장 찍힌 자료 수. */
export async function stampTrashedLocalPath(root: LocalRoot, rel: string, stamp: FileTrashStamp): Promise<number> {
  const key = localExternalId(root, rel);
  const r = await itemsPool.query(
    `UPDATE source SET lifecycle='superseded', updated_at=now(),
            fields = COALESCE(fields, '{}'::jsonb) || jsonb_build_object('trash', $4::jsonb)
      WHERE external_system=$1 AND external_instance=$2 AND lifecycle='active'
        AND (external_id=$3 OR starts_with(external_id, $3 || '/'))
      RETURNING id`,
    [LOCAL_SYSTEM, normalizeExternalInstance(LOCAL_INSTANCE), key, JSON.stringify(stamp)]);
  return r.rowCount ?? 0;
}

export interface TrashedFileRow { id: number; title: string | null; path: string; stamp: FileTrashStamp }
/** 휴지통의 파일 자료 한 건 — 도장이 없으면(이미 되살렸거나 옛 방식으로 지운 것) undefined. */
export async function getTrashedFile(sourceId: number): Promise<TrashedFileRow | undefined> {
  const r = await itemsPool.query(
    `SELECT id, title, fields FROM source WHERE id=$1 AND external_system=$2 AND lifecycle='superseded' AND fields ? 'trash'`,
    [sourceId, LOCAL_SYSTEM]);
  const row = r.rows[0] as { id: number; title: string | null; fields: Record<string, unknown> } | undefined;
  const stamp = row?.fields?.trash as FileTrashStamp | undefined;
  const p = typeof row?.fields?.path === "string" ? String(row.fields.path) : "";
  if (!row || !stamp || !stamp.held_rel || !p) return undefined;
  return { id: Number(row.id), title: row.title, path: p, stamp };
}

/**
 * 되살린 뒤 — 도장을 떼고 다시 active.
 *  #4688 — 휴지통에 있는 동안 다른 파일이 그 이름으로 옮겨 와 좌표를 비켜 줬던 행(fields.aside_from)이면 **원래 좌표를 되찾는다.**
 *   되살리기는 원래 자리에 파일이 없을 때만 일어나므로(라우트가 409 로 막는다) 그새 그 좌표를 쥔 다른 행은 파일 없이 남은 것이다 — 비켜 둔다.
 */
export async function reviveTrashedFile(sourceId: number): Promise<void> {
  await withTx(async (client) => {
    const r = await client.query(`SELECT fields->>'aside_from' AS back FROM source WHERE id=$1 FOR UPDATE`, [sourceId]);
    const back = (r.rows[0] as { back?: string | null } | undefined)?.back ?? null;
    if (!back) {
      await client.query(`UPDATE source SET lifecycle='active', updated_at=now(), fields = fields - 'trash' WHERE id=$1`, [sourceId]);
      return;
    }
    await setLocalRowsAside(client, [back], [sourceId]);
    await client.query(
      `UPDATE source SET lifecycle='active', updated_at=now(), external_id=$2, fields = fields - 'trash' - 'aside_from' WHERE id=$1`,
      [sourceId, back]);
  });
}

/** 같은 보관 묶음에 아직 도장 찍힌 자료가 몇 건 남았나 — 0 이면 묶음 폴더를 통째로 치워도 된다(자료 아닌 동행 파일 포함). */
export async function fileTrashBatchRemaining(batch: string): Promise<number> {
  const r = await itemsPool.query(
    `SELECT count(*)::int AS n FROM source WHERE external_system=$1 AND fields->'trash'->>'batch' = $2`, [LOCAL_SYSTEM, batch]);
  return Number((r.rows[0] as { n?: number } | undefined)?.n ?? 0);
}

// ── 브라우즈 라우트(개인/공유 루트) → 로컬 루트 좌표. 공유 루트 아래 project/<id>/… 는 프로젝트 좌표로 접는다(같은 파일 = 같은 자료). ──
export async function localRootForBrowse(rootKey: string, user: LivelyUser, base: string, abs: string)
  : Promise<{ root: LocalRoot; base: string; folder?: string | null; channelFallback: string } | null> {
  if (rootKey === "personal") {
    return { root: { kind: "personal", member: personalRootMember(user) || userSlug(user) }, base, channelFallback: "uploads" };
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
