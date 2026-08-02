// org_harness_asset — 하네스 자산(스킬·서브에이전트·커맨드) + per-member 오버라이드 org_asset_pref(#699).
//  org_asset_pref 동거 이유: listEnabledAssets/listEnabledHooks 의 유효성 병합 JOIN 짝(정책+오버라이드가 한 쿼리).
//  (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit, sha256, type WriteCtx } from "./audit.js";
import type { HookHarness } from "./hooks.js";

// ════════ 하네스 자산(스킬·서브에이전트·커맨드) — org_harness_asset ════════
// 훅과 같은 runtime 자산군이나 디스크 materialize 대상(하네스 스캔 발견). materializer(session-preload)가
//  런너 serve(listEnabledAssets)로 받아 ~/.claude|.codex/{skills,agents,commands} 에 비파괴 reconcile.
export type AssetKind = "skill" | "subagent" | "command";
export interface OrgHarnessAsset {
  id: string;
  kind: AssetKind;
  label: string | null;
  harness: HookHarness;
  description: string;
  // summary — 화면에 보이는 '쉬운 한 줄'(#1085). description 은 **하네스가 언제 이 스킬을 쓸지 판단하는 트리거
  //  문장**이라 길고 기술적이다. 그걸 그대로 사용자 화면에 깔면 무슨 기능인지 안 읽혀서, 표시용 문장을 따로 둔다.
  //  비어 있으면 화면이 description 첫 문장으로 폴백한다(지식의 summary 와 같은 관례).
  summary: string;
  body: string;
  frontmatter: Record<string, unknown>;
  target_members: string[] | null;
  paired_hook_id: string | null;
  enabled: boolean;
  sort: number;
  version: number;
  content_hash: string | null;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

function mapAsset(row: Record<string, unknown>): OrgHarnessAsset {
  const fm = row.frontmatter;
  const tm = row.target_members;
  return {
    id: row.id as string,
    kind: row.kind as AssetKind,
    label: (row.label as string) ?? null,
    harness: row.harness as HookHarness,
    description: (row.description as string) ?? "",
    summary: (row.summary as string) ?? "",
    body: (row.body as string) ?? "",
    frontmatter: fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {},
    target_members: Array.isArray(tm) ? (tm as string[]) : null,
    paired_hook_id: (row.paired_hook_id as string) ?? null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    content_hash: (row.content_hash as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const ASSET_COLS =
  "id, kind, label, harness, description, summary, body, frontmatter, target_members, paired_hook_id, enabled, sort, version, content_hash, created_by, updated_at, updated_by";
const ASSET_COLS_Q = ASSET_COLS.split(", ").map((c) => "a." + c).join(", "); // JOIN 용 정규화(updated_at/updated_by 모호성 회피, #699)

// content_hash — materialize 결과에 영향 주는 필드만 정규화 해시(클라 변경감지=재작성 skip). 관리메타(label·sort·enabled)는 제외.
//  export: 시딩(seed-content.ts)이 "손 안 댄 시드만 갱신"을 이 해시의 IS DISTINCT 로 판정한다(관리메타 제외라 토글·정렬 변경엔 재시딩 안 함, #878).
export function assetContentHash(a: { kind: string; harness: string; description: string; body: string; frontmatter: Record<string, unknown> }): string {
  const fmSorted: Record<string, unknown> = {};
  for (const k of Object.keys(a.frontmatter).sort()) fmSorted[k] = a.frontmatter[k];
  return sha256(JSON.stringify({ kind: a.kind, harness: a.harness, description: a.description, body: a.body, frontmatter: fmSorted }));
}

export async function listOrgHarnessAssets(): Promise<OrgHarnessAsset[]> {
  const r = await itemsPool.query(`SELECT ${ASSET_COLS} FROM org_harness_asset ORDER BY kind, sort, id`);
  return r.rows.map(mapAsset);
}

// materializer fetch 용 — enabled 자산만. harness(그 하네스 또는 'all'), kind 옵션, memberId 로 per-member 유효성.
//  #699: 개인 오버라이드(org_asset_pref) 있으면 그 state, 없으면 target_members(NULL/빈=전원, 지정 시 memberId 포함 —
//  익명/미지 멤버는 타깃 자산에서 제외 = 안전 기본). enabled=false 는 마스터킬(오버라이드 무시).
export async function listEnabledAssets(harness?: string, kind?: string, memberId?: string | null): Promise<OrgHarnessAsset[]> {
  const r = await itemsPool.query(
    `SELECT ${ASSET_COLS_Q} FROM org_harness_asset a
       LEFT JOIN org_asset_pref p ON p.target_kind='harness_asset' AND p.ref_id=a.id AND p.member_id=$3
      WHERE a.enabled=true
        AND ($1::text IS NULL OR a.harness=$1 OR a.harness='all')
        AND ($2::text IS NULL OR a.kind=$2)
        AND (CASE WHEN p.member_id IS NOT NULL THEN p.state
                  ELSE (a.target_members IS NULL OR jsonb_array_length(a.target_members)=0
                        OR ($3::text IS NOT NULL AND a.target_members @> to_jsonb($3::text))) END)
      ORDER BY a.kind, a.sort, a.id`,
    [harness ?? null, kind ?? null, memberId ?? null],
  );
  return r.rows.map(mapAsset);
}

export async function getOrgHarnessAsset(id: string): Promise<OrgHarnessAsset | null> {
  const r = await itemsPool.query(`SELECT ${ASSET_COLS} FROM org_harness_asset WHERE id=$1`, [id]);
  return r.rows[0] ? mapAsset(r.rows[0]) : null;
}

// 멤버가 올린 비활성 초안 개수(#990 셀프 업로드 쿼터) — created_by=멤버 AND enabled=false.
//  공유 테이블 무한 적재 + 관리 검토 화면(org_overview 가 전량 로드) DoS 를 막는 상한의 근거.
export async function countMemberDraftAssets(createdBy: string): Promise<number> {
  const r = await itemsPool.query(`SELECT count(*)::int AS n FROM org_harness_asset WHERE created_by=$1 AND enabled=false`, [createdBy]);
  return (r.rows[0]?.n as number) ?? 0;
}

export interface OrgHarnessAssetInput {
  id: string;
  kind?: AssetKind;
  label?: string | null;
  harness?: HookHarness;
  description?: string;
  summary?: string;            // 표시용 한 줄(#1085) — 미전송=보존
  body?: string;
  frontmatter?: Record<string, unknown>;
  target_members?: string[] | null;
  paired_hook_id?: string | null;
  enabled?: boolean;
  sort?: number;
}

export async function upsertOrgHarnessAsset(a: OrgHarnessAssetInput, ctx: WriteCtx = {}): Promise<OrgHarnessAsset> {
  const before = await getOrgHarnessAsset(a.id);
  const kind = a.kind ?? before?.kind ?? "skill";
  const harness = a.harness ?? before?.harness ?? "all";
  const description = a.description ?? before?.description ?? "";
  const summary = a.summary ?? before?.summary ?? "";   // 표시용 한 줄(#1085) — 미전송이면 보존
  const body = a.body ?? before?.body ?? "";
  const frontmatter = a.frontmatter ?? before?.frontmatter ?? {};
  const targetMembers = a.target_members === undefined ? (before?.target_members ?? null) : a.target_members;
  const contentHash = assetContentHash({ kind, harness, description, body, frontmatter });
  await itemsPool.query(
    `INSERT INTO org_harness_asset(id,kind,label,harness,description,summary,body,frontmatter,target_members,paired_hook_id,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$15,$6,$7::jsonb,$8::jsonb,$9,$10,$11,1,$12,$13,now(),$14)
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, label=EXCLUDED.label, harness=EXCLUDED.harness, description=EXCLUDED.description,
       summary=EXCLUDED.summary, body=EXCLUDED.body, frontmatter=EXCLUDED.frontmatter, target_members=EXCLUDED.target_members,
       paired_hook_id=EXCLUDED.paired_hook_id, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       content_hash=EXCLUDED.content_hash, version=org_harness_asset.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [a.id, kind, a.label ?? before?.label ?? null, harness, description, body,
     JSON.stringify(frontmatter), targetMembers === null ? null : JSON.stringify(targetMembers),
     a.paired_hook_id === undefined ? (before?.paired_hook_id ?? null) : a.paired_hook_id,
     a.enabled ?? before?.enabled ?? true, a.sort ?? before?.sort ?? 0, contentHash,
     before?.created_by ?? ctx.actor ?? null, ctx.actor ?? null, summary],
  );
  const after = await getOrgHarnessAsset(a.id);
  await audit("org_harness_asset", a.id, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgHarnessAsset;
}

export async function removeOrgHarnessAsset(id: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getOrgHarnessAsset(id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_harness_asset WHERE id=$1`, [id]);
  await audit("org_harness_asset", id, "delete", before, null, ctx.actor, ctx.source, ctx);
}

// ════════ per-member 개인 오버라이드 — org_asset_pref (#699) ════════
//  관리자 정책(enabled+target_members) 위에 얹는 멤버별 on/off. 유효성 병합은 listEnabledHooks/listEnabledAssets 참조.
//  target_kind='harness_asset'|'org_hook'. 행 없음=관리자 기본값 사용, state=true=강제 on(opt-in), false=강제 off(opt-out).
export type AssetPrefKind = "harness_asset" | "org_hook";
export interface OrgAssetPref {
  target_kind: AssetPrefKind;
  ref_id: string;
  member_id: string;
  state: boolean;
  updated_at: string | null;
  updated_by: string | null;
}
const PREF_COLS = "target_kind, ref_id, member_id, state, updated_at, updated_by";
function mapPref(row: Record<string, unknown>): OrgAssetPref {
  return {
    target_kind: row.target_kind as AssetPrefKind,
    ref_id: row.ref_id as string,
    member_id: row.member_id as string,
    state: row.state === true,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

export async function getAssetPref(target_kind: AssetPrefKind, ref_id: string, member_id: string): Promise<OrgAssetPref | null> {
  const r = await itemsPool.query(`SELECT ${PREF_COLS} FROM org_asset_pref WHERE target_kind=$1 AND ref_id=$2 AND member_id=$3`, [target_kind, ref_id, member_id]);
  return r.rows[0] ? mapPref(r.rows[0]) : null;
}

// 오버라이드 목록(관리자 '일괄 조회' / 멤버 본인분). 필터 옵션 전부 AND.
export async function listAssetPrefs(filter: { target_kind?: AssetPrefKind; ref_id?: string; member_id?: string } = {}): Promise<OrgAssetPref[]> {
  const r = await itemsPool.query(
    `SELECT ${PREF_COLS} FROM org_asset_pref
      WHERE ($1::text IS NULL OR target_kind=$1)
        AND ($2::text IS NULL OR ref_id=$2)
        AND ($3::text IS NULL OR member_id=$3)
      ORDER BY target_kind, ref_id, member_id`,
    [filter.target_kind ?? null, filter.ref_id ?? null, filter.member_id ?? null],
  );
  return r.rows.map(mapPref);
}

export async function setAssetPref(target_kind: AssetPrefKind, ref_id: string, member_id: string, state: boolean, ctx: WriteCtx = {}): Promise<OrgAssetPref> {
  const before = await getAssetPref(target_kind, ref_id, member_id);
  await itemsPool.query(
    `INSERT INTO org_asset_pref(target_kind, ref_id, member_id, state, updated_at, updated_by)
       VALUES($1,$2,$3,$4,now(),$5)
     ON CONFLICT (target_kind, ref_id, member_id) DO UPDATE SET
       state=EXCLUDED.state, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [target_kind, ref_id, member_id, state, ctx.actor ?? null],
  );
  const after = await getAssetPref(target_kind, ref_id, member_id);
  await audit("org_asset_pref", `${target_kind}:${ref_id}:${member_id}`, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgAssetPref;
}

// 기본값 복귀(오버라이드 제거).
export async function clearAssetPref(target_kind: AssetPrefKind, ref_id: string, member_id: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getAssetPref(target_kind, ref_id, member_id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_asset_pref WHERE target_kind=$1 AND ref_id=$2 AND member_id=$3`, [target_kind, ref_id, member_id]);
  await audit("org_asset_pref", `${target_kind}:${ref_id}:${member_id}`, "delete", before, null, ctx.actor, ctx.source, ctx);
}

// 자산/훅 1건의 오버라이드 전부 제거 — 관리탭 '전체 기본값 복귀'(전원이 정책을 따르게).
//  삭제는 DELETE 한 방(RETURNING)으로 원자적으로 하고, 감사만 지워진 행마다 남긴다(clearAssetPref 와 같은 입도 —
//  누가 누구의 예외를 언제 지웠는지). select-후-행별-delete 로 짜면 그 사이 멤버가 me_asset_pref 로 새로 만든
//  오버라이드가 스냅샷에 없어 조용히 살아남는다(TOCTOU) — '전원이 정책을 따른다'는 이 연산의 약속이 깨진다.
export async function clearAssetPrefs(target_kind: AssetPrefKind, ref_id: string, ctx: WriteCtx = {}): Promise<number> {
  const r = await itemsPool.query(
    `DELETE FROM org_asset_pref WHERE target_kind=$1 AND ref_id=$2 RETURNING ${PREF_COLS}`, [target_kind, ref_id]);
  for (const row of r.rows) {
    const before = mapPref(row);
    await audit("org_asset_pref", `${target_kind}:${ref_id}:${before.member_id}`, "delete", before, null, ctx.actor, ctx.source, ctx);
  }
  return r.rows.length;
}
