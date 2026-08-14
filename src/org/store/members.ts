// org_member — 구성원 CRUD + jsonb 부속(온보딩 보고·하네스 관측 스냅샷·머신 별명·로컬 토글 지시)
//  + person/person_identity 동기화. (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit } from "./audit.js";

export interface MemberIdentity {
  system: string;
  external_id: string;
  email?: string;
  instance?: string;
  display_name?: string;
}
export interface OrgMember {
  id: string;
  kind: "human" | "agent" | "system";
  display_name: string | null;
  nickname: string | null; // 표시 이름과 별개의 닉네임(#762). 활동 로그 등 캐주얼 표기용. null/''=display_name 폴백.
  email: string | null;
  identities: MemberIdentity[];
  body_md: string;
  avatar: string | null; // 프로필 이미지 data URL(셀프 업로드). null=이니셜+색상 자동생성.
  avatar_char: string | null; // 이미지 없을 때 쓸 커스텀 글자(1~3자). null=이름 이니셜 자동.
  avatar_color: string | null; // 이미지 없을 때 쓸 커스텀 배경색(#rrggbb). null=id 해시색 자동.
  state: "active" | "inactive";
  scopes: string[]; // 권한(발급 토큰의 scope)
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

// ── org_member ──
function mapMember(row: Record<string, unknown>): OrgMember {
  return {
    id: row.id as string,
    kind: row.kind as OrgMember["kind"],
    display_name: (row.display_name as string) ?? null,
    nickname: (row.nickname as string) ?? null,
    email: (row.email as string) ?? null,
    identities: (row.identities as MemberIdentity[]) ?? [],
    body_md: (row.body_md as string) ?? "",
    avatar: (row.avatar as string) ?? null,
    avatar_char: (row.avatar_char as string) ?? null,
    avatar_color: (row.avatar_color as string) ?? null,
    state: row.state as OrgMember["state"],
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const MEMBER_COLS = "id, kind, display_name, nickname, email, identities, body_md, avatar, avatar_char, avatar_color, state, scopes, sort, version, updated_at, updated_by";

export async function listMembers(): Promise<OrgMember[]> {
  const r = await itemsPool.query(`SELECT ${MEMBER_COLS} FROM org_member ORDER BY sort, id`);
  return r.rows.map(mapMember);
}

export async function getMember(id: string): Promise<OrgMember | null> {
  const r = await itemsPool.query(`SELECT ${MEMBER_COLS} FROM org_member WHERE id=$1`, [id]);
  return r.rows[0] ? mapMember(r.rows[0]) : null;
}

// ── 구성원 온보딩(#846/850) — **보고된** 상태만 담는다 ──────────────────────────────
//  자동 판정되는 것(MCP 호출 이력·자격 등록·레포 연결)은 여기 없다 — computeMemberOnboarding 이 조회
//  시점에 라이브 계산한다. 이 컬럼엔 서버가 **볼 수 없는 것**(그 사람 노트북의 로컬 이관 완료 — AI 스킬이
//  보고)과 사용자의 **의도적 오버라이드**(웹 ⋯ 메뉴)만 들어간다. 상태를 두 곳에 두면 반드시 어긋난다.
//  OrgMember 타입엔 넣지 않는다 — listMembers/admin 응답에 실릴 이유가 없다.
export interface ReportedStep { state: "done" | "skipped"; at: string; by: "ai" | "self"; note?: string }

export async function getMemberOnboarding(id: string): Promise<Record<string, ReportedStep>> {
  const r = await itemsPool.query(`SELECT onboarding FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.onboarding as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, ReportedStep> : {};
}

// 한 스텝만 갱신(다른 스텝 보존). patch=null 이면 그 키를 **삭제** = '다시 열기'(자동 판정으로 복귀).
//  jsonb_set 은 상위 키가 없으면 no-op 이라 shallow merge(`||`)를 쓴다.
export async function setMemberOnboardingStep(
  id: string, step: string, patch: ReportedStep | null,
): Promise<Record<string, ReportedStep>> {
  const r = patch
    ? await itemsPool.query(
      `UPDATE org_member SET onboarding = COALESCE(onboarding,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
         WHERE id=$1 RETURNING onboarding`, [id, step, JSON.stringify(patch)])
    : await itemsPool.query(
      `UPDATE org_member SET onboarding = COALESCE(onboarding,'{}'::jsonb) - $2::text
         WHERE id=$1 RETURNING onboarding`, [id, step]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  return (r.rows[0].onboarding ?? {}) as Record<string, ReportedStep>;
}

// ── 리브 프로필(#1631) — **리브가 이 사람에 대해 아는 것**이 사는 자리 ──────────────
//  리브의 기억은 대화가 아니라 여기 있다(세션은 교체 가능하다는 기획 불변식). 그래서 담는 것은
//  서버가 **볼 수 없는 것**뿐이다 — 온보딩·파이프라인·하네스 인벤토리는 각자 자기 자리에서 라이브
//  계산되므로 여기 복제하면 두 개의 진실이 생긴다(#850 이 온보딩에서 이미 내린 결론).
export interface LivWork { asis?: string; tobe?: string; at?: string; by?: "ai" | "self" }
export interface LivDecision { at: string; what: string; why?: string; by?: string }
/** 사람이 "그건 안 할게요"라고 한 것. `key` 는 카드 key(예: `org.embeddings`). */
export interface LivDeclined { at: string; key: string; why?: string }
export interface LivProfile { work?: LivWork; decisions?: LivDecision[]; declined?: LivDeclined[] }

const LIV_LIST_CAP = 50; // 결정·거절 이력 상한 — 오래된 것부터 버린다(프로필은 로그가 아니다)

export async function getLivProfile(id: string): Promise<LivProfile> {
  const r = await itemsPool.query(`SELECT liv_profile FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.liv_profile as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as LivProfile : {};
}

/**
 * 프로필을 **덧붙인다**(replace 아님).
 *
 * - `work` 는 주면 통째로 갈아끼운다(ASIS/TOBE 는 최신 하나만 의미가 있다).
 * - `decision`·`declined` 는 **뒤에 쌓는다**. 같은 key 의 거절이 이미 있으면 갱신한다 —
 *   두 번 거절했다고 두 줄이 남을 이유가 없고, 중복이 쌓이면 상한에 걸려 옛 결정이 밀려난다.
 */
export async function appendLivProfile(
  id: string, patch: { work?: LivWork; decision?: LivDecision; declined?: LivDeclined },
): Promise<LivProfile> {
  const cur = await getLivProfile(id);
  const next: LivProfile = { ...cur };
  if (patch.work) next.work = { ...patch.work, at: patch.work.at ?? new Date().toISOString() };
  if (patch.decision) next.decisions = [...(cur.decisions ?? []), patch.decision].slice(-LIV_LIST_CAP);
  if (patch.declined) {
    const rest = (cur.declined ?? []).filter((d) => d.key !== patch.declined!.key);
    next.declined = [...rest, patch.declined].slice(-LIV_LIST_CAP);
  }
  const r = await itemsPool.query(
    `UPDATE org_member SET liv_profile=$2::jsonb WHERE id=$1 RETURNING liv_profile`, [id, JSON.stringify(next)]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
  return (r.rows[0].liv_profile ?? {}) as LivProfile;
}

// ── 로컬 하네스 관측 스냅샷(#891 온보딩 C) — 세션훅이 push, 웹이 라이블리 자산과 대조 ──
//  ⚠ 관측이지 보고가 아니다(onboarding 과 별 컬럼). **메타만**(id·kind·managed) — 스킬 본문·메모리는 절대 안 담는다.
//  ⚠ **머신별 맵**이다 — 한 멤버가 PC 여러 대(집·회사)를 쓰면 각각 다른 로컬 환경이다. machine_id(훅이
//   ~/.lively/machine-id 에 UUID 로 1회 생성)를 키로 각 머신 관측을 따로 보관 → 새 머신이 남의 관측을 안 덮는다.
export interface HarnessSnapshotAsset { id: string; kind: string; managed: boolean }
export interface HarnessSnapshot { at?: string; host?: string; harness?: string; assets: HarnessSnapshotAsset[] }
export type HarnessSnapshots = Record<string, HarnessSnapshot>; // machine_id → 관측

export async function getHarnessSnapshots(id: string): Promise<HarnessSnapshots> {
  const r = await itemsPool.query(`SELECT harness_snapshot FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_snapshot as unknown;
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  // 각 키를 순회하되 **값이 {assets:[...]} 인 것만** 머신으로 취급 — 옛 단일 형태의 top-level 잔재
  //  (at/host/harness 문자열·assets 배열)는 값이 {assets} 아니라 자동으로 걸러진다(merge 로 공존해도 안전).
  const out: HarnessSnapshots = {};
  for (const [mid, snap] of Object.entries(v as Record<string, unknown>)) {
    if (snap && typeof snap === "object" && !Array.isArray(snap) && Array.isArray((snap as HarnessSnapshot).assets)) out[mid] = snap as HarnessSnapshot;
  }
  return out;
}

// 그 machine_id 키만 갱신(다른 머신 관측 보존) — jsonb shallow merge.
export async function setHarnessSnapshot(id: string, machineId: string, snap: HarnessSnapshot): Promise<void> {
  const r = await itemsPool.query(
    `UPDATE org_member SET harness_snapshot = COALESCE(harness_snapshot,'{}'::jsonb) || jsonb_build_object($2::text, $3::jsonb)
       WHERE id=$1 RETURNING id`, [id, machineId, JSON.stringify(snap)]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// 한 머신의 관측·토글지시를 통째로 제거(#893) — uninstall 싱크 + 웹 수동 '이 컴퓨터 지우기'.
//  ⚠ uninstall 시 ~/.lively/machine-id 가 지워져 재설치 때 새 UUID 가 생긴다 → 같은 host 가 중복으로 남는다.
//  그걸 정리하는 경로. harness_snapshot·harness_local_pref 양쪽에서 그 머신 키를 뺀다.
export async function removeHarnessMachine(id: string, machineId: string): Promise<void> {
  const r = await itemsPool.query(
    `UPDATE org_member
        SET harness_snapshot      = COALESCE(harness_snapshot,'{}'::jsonb)      - $2::text,
            harness_local_pref    = COALESCE(harness_local_pref,'{}'::jsonb)    - $2::text,
            harness_machine_alias = COALESCE(harness_machine_alias,'{}'::jsonb) - $2::text
      WHERE id=$1 RETURNING id`, [id, machineId]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// ── 머신 별명(#893 후속) — 사용자가 각 PC 에 붙이는 이름. 관측(host)과 별개, 세션 report 가 안 덮는다. ──
export type HarnessMachineAlias = Record<string, string>; // machine_id → 별명

export async function getHarnessMachineAlias(id: string): Promise<HarnessMachineAlias> {
  const r = await itemsPool.query(`SELECT harness_machine_alias FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_machine_alias as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as HarnessMachineAlias : {};
}

// 별명 지정(비우면 키 삭제 = 별명 해제).
export async function setHarnessMachineAlias(id: string, machineId: string, alias: string): Promise<void> {
  const trimmed = alias.trim();
  const sql = trimmed
    ? `UPDATE org_member SET harness_machine_alias =
         COALESCE(harness_machine_alias,'{}'::jsonb) || jsonb_build_object($2::text, $3::text)
       WHERE id=$1 RETURNING id`
    : `UPDATE org_member SET harness_machine_alias =
         COALESCE(harness_machine_alias,'{}'::jsonb) - $2::text
       WHERE id=$1 RETURNING id`;
  const r = await itemsPool.query(sql, trimmed ? [id, machineId, trimmed] : [id, machineId]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// ── 로컬 파일 토글 지시(#891 슬라이스 2) — 머신별. 세션훅이 자기 machine_id 지시를 pull 해 .disabled rename ──
//  라이블리 스킬 opt-out(me_asset_pref)과 다르다: 그건 멤버 단위(모든 머신 배포분), 이건 그 머신의 로컬 파일만.
export type HarnessLocalPref = Record<string, Record<string, boolean>>; // machine_id → { "<kind>:<id>": disabled }

export async function getHarnessLocalPref(id: string): Promise<HarnessLocalPref> {
  const r = await itemsPool.query(`SELECT harness_local_pref FROM org_member WHERE id=$1`, [id]);
  const v = r.rows[0]?.harness_local_pref as unknown;
  return (v && typeof v === "object" && !Array.isArray(v)) ? v as HarnessLocalPref : {};
}

// 한 머신의 한 자산 지시만 갱신(disabled=true) 또는 제거(false=다시 켜기 → 키 삭제).
export async function setHarnessLocalPref(id: string, machineId: string, assetKey: string, disabled: boolean): Promise<void> {
  const sql = disabled
    ? `UPDATE org_member SET harness_local_pref =
         jsonb_set(COALESCE(harness_local_pref,'{}'::jsonb), ARRAY[$2::text],
           COALESCE(harness_local_pref->$2::text,'{}'::jsonb) || jsonb_build_object($3::text, true), true)
       WHERE id=$1 RETURNING id`
    : `UPDATE org_member SET harness_local_pref =
         jsonb_set(COALESCE(harness_local_pref,'{}'::jsonb), ARRAY[$2::text],
           COALESCE(harness_local_pref->$2::text,'{}'::jsonb) - $3::text, true)
       WHERE id=$1 RETURNING id`;
  const r = await itemsPool.query(sql, [id, machineId, assetKey]);
  if (!r.rows[0]) throw new Error("구성원 정보를 찾을 수 없습니다");
}

// 주어진 id 중 **실재하는 활성 구성원**만 골라낸다(#1313 R45) — 공개범위 대상(audience) 검증 공용.
//  오타 id 로 잠그면 아무도 못 여는 리스트/폴더가 되므로, 잠그기 전에 대상이 실재하는지 이걸로 확인한다.
export async function activeMemberIdsAmong(ids: string[]): Promise<string[]> {
  const r = await itemsPool.query<{ id: string }>(
    `SELECT id FROM org_member WHERE id = ANY($1::text[]) AND state='active'`, [ids]);
  return r.rows.map((row) => String(row.id));
}

// 이메일로 멤버 id 조회(대소문자 무시) — 이메일=로그인 키라 유일성 검증용. 없으면 null.
export async function memberIdByEmail(email: string): Promise<string | null> {
  const r = await itemsPool.query(
    `SELECT id FROM org_member WHERE email IS NOT NULL AND email <> '' AND lower(email)=lower($1) LIMIT 1`, [email]);
  return r.rows[0] ? (r.rows[0] as { id: string }).id : null;
}

export interface MemberInput {
  id: string;
  kind?: "human" | "agent" | "system";
  display_name?: string | null;
  nickname?: string | null; // undefined=보존, null/''=닉네임 지움(→display_name 폴백).
  email?: string | null;
  identities?: MemberIdentity[];
  body_md?: string;
  avatar?: string | null; // 프로필 이미지 data URL. undefined=보존, null/''=이니셜로 되돌림.
  avatar_char?: string | null; // 커스텀 글자. undefined=보존, null/''=이니셜 자동으로 되돌림.
  avatar_color?: string | null; // 커스텀 배경색(#rrggbb). undefined=보존, null/''=해시색 자동으로 되돌림.
  state?: "active" | "inactive";
  scopes?: string[];
  sort?: number;
}

export async function upsertMember(m: MemberInput, actor?: string, source?: string): Promise<OrgMember> {
  const before = await getMember(m.id);
  const kind = m.kind ?? before?.kind ?? "human";
  const identities = m.identities ?? before?.identities ?? [];
  const scopes = m.scopes ?? before?.scopes ?? ["items", "context", "memory"];
  // avatar: undefined=보존, 그 외(null/''/문자열)=그대로 적용(빈값이면 null 로 정규화 → 이니셜 폴백).
  const avatar = m.avatar === undefined ? (before?.avatar ?? null) : (m.avatar || null);
  // 커스텀 글자(최대 3자)·배경색 — undefined=보존, 그 외=정규화. 색은 클라이언트 style 에 주입되므로 #rrggbb 형식만 허용(그 외 무시=null).
  const avatarChar = m.avatar_char === undefined ? (before?.avatar_char ?? null) : ((m.avatar_char || "").trim().slice(0, 3) || null);
  const avatarColor = m.avatar_color === undefined ? (before?.avatar_color ?? null)
    : (/^#[0-9a-fA-F]{6}$/.test((m.avatar_color || "").trim()) ? (m.avatar_color as string).trim() : null);
  // nickname — undefined=보존, 그 외=trim 후 빈값이면 null(→ display_name 폴백).
  const nickname = m.nickname === undefined ? (before?.nickname ?? null) : ((m.nickname || "").trim() || null);
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, nickname, email, identities, body_md, avatar, avatar_char, avatar_color, state, scopes, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12::jsonb,$13,1,now(),$14)
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, display_name=EXCLUDED.display_name, nickname=EXCLUDED.nickname, email=EXCLUDED.email,
       identities=EXCLUDED.identities, body_md=EXCLUDED.body_md, avatar=EXCLUDED.avatar,
       avatar_char=EXCLUDED.avatar_char, avatar_color=EXCLUDED.avatar_color, state=EXCLUDED.state, scopes=EXCLUDED.scopes, sort=EXCLUDED.sort,
       version=org_member.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.id, kind, m.display_name ?? before?.display_name ?? null, nickname, m.email ?? before?.email ?? null,
     JSON.stringify(identities), m.body_md ?? before?.body_md ?? "", avatar, avatarChar, avatarColor,
     m.state ?? before?.state ?? "active", JSON.stringify(scopes), m.sort ?? before?.sort ?? 0, actor ?? null],
  );
  const after = await getMember(m.id);
  await audit("org_member", m.id, before ? "update" : "insert", before, after, actor, source);
  // person/person_identity 동기화 — UI 편집이 즉시 게이트웨이 신원 매칭에 반영(load-bindings 와 동일 계약).
  if (after) await syncMemberToPerson(after);
  // (권한 토큰 전파 폐기 — P1) 유효 권한은 verifyDbToken 이 매 인증 시 intersection(토큰,멤버)로 계산한다.
  //  멤버 권한 하향은 즉시 모든 토큰에 반영(보안), 상향은 토큰 재발급으로(최소권한 보존) — 전파 함수 불필요.
  return after as OrgMember;
}

export async function removeMember(id: string, actor?: string, source?: string): Promise<void> {
  const before = await getMember(id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_member WHERE id=$1`, [id]);
  await audit("org_member", id, "delete", before, null, actor, source);
  // person 행은 보존(아이템 actor 참조 무결성) — 멤버 제거는 org_member 에서만. 신원 정리는 별도 큐레이션.
}

// 신원 '해제' 동기(#541) — identities 에서 뺀 행은 person_identity 에서도 지워야 커넥터 액터/어사이니
//  해소(person_identity JOIN org_member)에 실제 반영된다(syncMemberToPerson 은 upsert-only 라 잔존).
//  가드: 이 멤버 소유(person_id=id) + origin IN (manual, email-join) — 수동 매핑과 그로부터 파생된 이메일
//  자동조인 행까지 함께 제거(email-join 잔존 시 해제가 무효 — 다음 싱크가 재매핑). observed 신원은 보존.
//  before/after = 저장 전/후의 identities. 실제로 지워진 행만 person_identity_audit 에 남긴다.
export async function unbindMemberIdentities(
  id: string, before: MemberIdentity[], after: MemberIdentity[], actor: string | null,
): Promise<void> {
  const keep = new Set(after.map((i) => `${i.system}\u0000${i.external_id}`));
  for (const prev of before) {
    if (keep.has(`${prev.system}\u0000${prev.external_id}`)) continue;
    const del = await itemsPool.query(
      `DELETE FROM person_identity WHERE system=$1 AND external_id=$2 AND person_id=$3 AND origin IN ('manual','email-join')`,
      [prev.system, prev.external_id, id]);
    if ((del.rowCount ?? 0) > 0) {
      await itemsPool.query(
        `INSERT INTO person_identity_audit(action, person_id, system, external_id, detail, source)
         VALUES('identity-unbound',$1,$2,$3,$4::jsonb,'web')`,
        [id, prev.system, prev.external_id, JSON.stringify({ email: prev.email ?? null, actor })]);
    }
  }
}

// person/person_identity 동기화 — load-bindings.ts loadBindings() 의 upsert 계약을 그대로 미러.
async function syncMemberToPerson(m: OrgMember): Promise<void> {
  const dn = m.display_name ?? m.id;
  await itemsPool.query(
    `INSERT INTO person(id, display_name, kind) VALUES($1,$2,$3)
       ON CONFLICT (id) DO UPDATE SET display_name=EXCLUDED.display_name, kind=EXCLUDED.kind`,
    [m.id, dn, m.kind],
  );
  for (const idn of m.identities) {
    if (!idn.system || !idn.external_id) continue;
    await itemsPool.query(
      `INSERT INTO person_identity(person_id, system, instance, external_id, email, display_name, origin, state)
         VALUES($1,$2,$3,$4,$5,$6,'manual','confirmed')
       ON CONFLICT (system, external_id) DO UPDATE SET
         person_id=EXCLUDED.person_id,
         instance=COALESCE(EXCLUDED.instance, person_identity.instance),
         email=COALESCE(EXCLUDED.email, person_identity.email),
         display_name=COALESCE(EXCLUDED.display_name, person_identity.display_name),
         origin='manual', state='confirmed', updated_at=now()`,
      [m.id, idn.system, idn.instance ?? null, idn.external_id, idn.email ?? null, idn.display_name ?? null],
    );
  }
}
