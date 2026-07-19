// org-content 읽기/쓰기 — 전달 서브시스템의 진실원천 접근 계층.
// 모든 쓰기는 org_content_audit 에 before/after 를 남기고 version 을 올린다(낙관적 잠금 토대).
// 멤버 쓰기는 person/person_identity 로도 동기화 → 비개발자의 UI 편집이 즉시 게이트웨이 신원 매칭에 반영.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool } from "../items/store.js";
import { CONNECTOR_SPECS, type ConnectorField } from "../connectors/config.js";
import { encryptSecret, secretsEnabled } from "./secret-box.js";
import { isScope } from "../capabilities/scopes.js";
import { redactDeep } from "./redact.js";
import { invalidateIngestPolicyCache } from "./ingest-policy-load.js";   // #783 정책 쓰기 → 캐시 즉시 무효화(스위치가 곧바로 먹게)
// WIKI 인덱스(팀 메모리)·섹션 모두 v6 knowledge 사용(knowledge_unit 컷오버 완료 2026-06-24).
import {
  listKnowledge as listK6, upsertKnowledge as upsertK6,
  type KnowledgeRow,
} from "../v6/knowledge-store.js";
// 임베딩(벡터검색 #172) config seam — embedding_config 정규화/병합(env 시드 + DB 우선). 무순환(provider 모듈은 store 미import).
import {
  type EmbeddingConfig, type EmbeddingConfigPatch, resolveEmbeddingConfig, normalizeEmbeddingConfig,
  isExplicitEmbeddingOff, embeddingConfigSource, EMBEDDING_OFF,
} from "../v6/embedding-provider.js";
import { invalidateOrgTimezone } from "./timezone.js"; // #778 시간대 캐시 무효화(프로필 저장 시)
// 박스 저장소 정책(#813) — 로그 상한·디스크 임계치. embedding_config 와 같은 seam(env 시드 + DB 우선).
import {
  type StoragePolicy, type StoragePolicyPatch, resolveStoragePolicy, normalizeStoragePolicy,
  storagePolicySource, invalidateStoragePolicyCache,
} from "./storage-policy.js";
// 세션 공유(세션이력 캡처) 정책(#905 C1) — 관리탭 ▸ 세션 공유. storage_policy 와 같은 seam(DB 우선, 비면 기본값).
import { type SessionShareConfig, type SessionSharePatch, resolveSessionShare, normalizeSessionShare } from "./session-share.js";

// 쓰기 호출 맥락 — 감사 보강(누가/어느 토큰/어디서). delivery 핸들러가 web.ts 의 ctx 에서 구성해 전달.
export interface WriteCtx { actor?: string; source?: string; tokenHashPrefix?: string | null; ip?: string | null }

export interface OrgProfile {
  name: string | null;
  display_name: string | null;
  gateway_url: string | null;
  timezone: string | null; // #778 조직 시간대(IANA). NULL=미설정 → org/timezone.ts DEFAULT_TZ.
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}
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
export interface OrgMemory {
  name: string;
  title: string | null;
  summary: string | null;      // 카드 표시용 '쉬운 한 줄' 요약(NULL 이면 title 폴백). 실제 제목·본문과 별개.
  body_md: string;
  sort: number;
  domain_key: string | null;   // v6: 대표 category.key(표시용). 구 domainmap 도메인 약결합의 후신.
  domain_repo: string | null;  // v6 미사용(항상 null) — category 는 repo 비종속. 호환 위해 필드 유지.
  is_wiki: boolean;            // WIKI 핀 — 제목+메타가 가이드 ${wiki} 로 항상-주입(본문 제외).
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}
export interface OrgSection {
  section: string;
  body_md: string;
  version: number;
  sort: number;
  updated_at: string | null;
  updated_by: string | null;
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// 감사 채널(#549) — source 리터럴을 org_content_audit.channel enum(mcp|web|connector|cli|migration|unknown)으로 정규화.
//  '어떤 경로로 이 변경이 일어났나'. mcp=에이전트 MCP, web=웹 관리탭(web-self 포함), connector=커넥터 미러, migration=마이그레이션.
function sourceToChannel(source: string | undefined): string | null {
  if (!source) return null;
  if (source === "mcp") return "mcp";
  if (source === "web" || source === "web-self") return "web";
  if (source === "connector") return "connector";
  if (source === "cli") return "cli";
  if (source === "migrate" || source === "migration") return "migration";
  return "unknown";
}

// ── 감사 (append-only) ──
async function audit(
  entity: string,
  key: string | null,
  op: string,
  before: unknown,
  after: unknown,
  actor: string | undefined,
  source: string | undefined,
  meta?: { tokenHashPrefix?: string | null; ip?: string | null } | pg.PoolClient,
): Promise<void> {
  // #880: 마지막 인자로 PoolClient 를 주면 그 트랜잭션에서 INSERT(호출부의 BEGIN/COMMIT 원자성). 그 외는 meta.
  const client = (meta && typeof (meta as pg.PoolClient).query === "function") ? (meta as pg.PoolClient) : undefined;
  const m = client ? undefined : (meta as { tokenHashPrefix?: string | null; ip?: string | null } | undefined);
  const exec = client ?? itemsPool;
  // B20: before/after 를 굳히기 전 시크릿 redaction — 감사 로그가 평문 토큰/키의 사본이 되지 않게.
  const b = before == null ? null : JSON.stringify(redactDeep(before));
  const a = after == null ? null : JSON.stringify(redactDeep(after));
  // #549(윤상민 요구 "누가 사람/AI·어떤 경로·언제·내용"): actor_kind = 누가 바꿨나(사람/AI/시스템). 진실원천은
  //  org_member.kind(신원)지 채널이 아니다(yoon 이 mcp 로 써도 human) → actor(=member id)로 조인 파생(agent→ai).
  //  actor 지정됐는데 멤버 아님=unknown, 미지정=NULL. channel(어떤 경로)은 source 에서 정규화. 에이전트가 MCP 로
  //  관리기능을 만지게 열렸으므로(#549) 이 두 컬럼이 'AI 가 관리탭을 바꿨다'를 감사에 드러낸다.
  await exec.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, token_hash_prefix, req_ip, actor_kind, channel)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9,
       CASE WHEN $6::text IS NULL THEN NULL
            ELSE COALESCE((SELECT CASE m.kind WHEN 'agent' THEN 'ai' WHEN 'system' THEN 'system' WHEN 'human' THEN 'human' ELSE 'unknown' END
                             FROM org_member m WHERE m.id = $6), 'unknown') END,
       $10)`,
    [entity, key, op, b, a, actor ?? null, source ?? null,
     m?.tokenHashPrefix ?? null, m?.ip ?? null, sourceToChannel(source)],
  );
}

// ── org 관리 변경 감사 조회(#549) — org_content_audit(append-only 단일 소스)를 필터·페이징으로 읽는다. ──
//  '민감한' 관리 엔티티(멤버·권한·런타임·데이터소스·훅·툴 등)가 기본 스코프. knowledge/project/category 등 일반
//  콘텐츠 변경은 각 화면에 전용 이력(도메인 should·태스크 피드)이 있어 기본 제외(entity 지정 시엔 조회 가능).
//  before/after 는 저장 시 이미 redactDeep(시크릿 마스킹)된 스냅샷 — 조회는 admin 전용(delivery.ts org_audit_list).
export const ADMIN_AUDIT_ENTITIES = [
  "org_member", "auth_token", "org_profile", "org_section",
  "org_runtime_config", "org_connector", "org_mcp_server", "org_hook", "org_tool", "org_harness_asset", "org_asset_pref",
  "org_db_source", "org_db_table_policy", "org_db_column_mask",
] as const;

export interface ContentAuditRow {
  id: number; at: string; entity: string; entity_key: string | null; op: string;
  before: unknown; after: unknown;
  actor: string | null; actor_kind: string | null; actor_display: string | null;
  source: string | null; channel: string | null; token_hash_prefix: string | null; req_ip: string | null;
}
export interface ContentAuditFilter {
  entities?: string[] | null;   // null/빈 = 엔티티 제약 없음(전체)
  entity_key?: string | null;
  actor?: string | null;
  actor_kind?: string | null;
  channel?: string | null;
  op?: string | null;
  since?: string | null;        // ISO(inclusive)
  until?: string | null;
  limit?: number;
  offset?: number;
}

// 필터 = 파라미터화(엔티티 배열은 ANY, 나머지는 'null=제약없음'). rows(before/after 포함) + total(같은 WHERE count).
//  actor 는 org_member 조인으로 표시이름(actor_display) 파생 — 목록에서 'yoon' 대신 '윤상민'.
export async function listContentAudit(f: ContentAuditFilter): Promise<{ rows: ContentAuditRow[]; total: number }> {
  const limit = Math.min(Math.max(Number(f.limit) || 50, 1), 500);
  const offset = Math.min(Math.max(Number(f.offset) || 0, 0), 1_000_000);
  const entities = f.entities && f.entities.length ? f.entities : null;
  const where = `WHERE ($1::text[] IS NULL OR a.entity = ANY($1))
                   AND ($2::text IS NULL OR a.entity_key = $2)
                   AND ($3::text IS NULL OR a.actor = $3)
                   AND ($4::text IS NULL OR a.actor_kind = $4)
                   AND ($5::text IS NULL OR a.channel = $5)
                   AND ($6::text IS NULL OR a.op = $6)
                   AND ($7::timestamptz IS NULL OR a.at >= $7::timestamptz)
                   AND ($8::timestamptz IS NULL OR a.at <= $8::timestamptz)`;
  const params: unknown[] = [
    entities, f.entity_key || null, f.actor || null, f.actor_kind || null,
    f.channel || null, f.op || null, f.since || null, f.until || null,
  ];
  const [rowsRes, countRes] = await Promise.all([
    itemsPool.query(
      `SELECT a.id, a.at, a.entity, a.entity_key, a.op, a.before, a.after,
              a.actor, a.actor_kind, a.source, a.channel, a.token_hash_prefix, a.req_ip,
              m.display_name AS actor_display
         FROM org_content_audit a
         LEFT JOIN org_member m ON m.id = a.actor
         ${where}
        ORDER BY a.at DESC, a.id DESC
        LIMIT $9 OFFSET $10`,
      [...params, limit, offset],
    ),
    itemsPool.query(`SELECT count(*)::int AS total FROM org_content_audit a ${where}`, params),
  ]);
  return {
    rows: rowsRes.rows as ContentAuditRow[],
    total: (countRes.rows[0] as { total: number } | undefined)?.total ?? 0,
  };
}

// ── org_profile ──
export async function getOrgProfile(): Promise<OrgProfile> {
  const r = await itemsPool.query(
    `SELECT name, display_name, gateway_url, timezone, version, updated_at, updated_by FROM org_profile WHERE id=1`,
  );
  return (r.rows[0] as OrgProfile) ?? {
    name: null, display_name: null, gateway_url: null, timezone: null, version: 1, updated_at: null, updated_by: null,
  };
}

export async function updateOrgProfile(
  patch: Partial<Pick<OrgProfile, "name" | "display_name" | "gateway_url" | "timezone">>,
  actor?: string,
  source?: string,
): Promise<OrgProfile> {
  const before = await getOrgProfile();
  await itemsPool.query(
    `UPDATE org_profile SET
       name = COALESCE($1, name),
       display_name = COALESCE($2, display_name),
       gateway_url = COALESCE($3, gateway_url),
       timezone = COALESCE($4, timezone),
       version = version + 1,
       updated_at = now(),
       updated_by = $5
     WHERE id=1`,
    [patch.name ?? null, patch.display_name ?? null, patch.gateway_url ?? null, patch.timezone ?? null, actor ?? null],
  );
  invalidateOrgTimezone(); // #778: 다음 cron 틱·세션 생성이 새 시간대를 즉시 쓰게(TTL 대기 없이).
  const after = await getOrgProfile();
  await audit("org_profile", "1", "update", before, after, actor, source);
  return after;
}

// ── org 섹션(규칙·페르소나 markdown) — v6 knowledge 테이블 injection='always' 위 얇은 래퍼(캐노니컬 단일진실). ──
//  매핑: section ↔ name(=section), injection='always'. 섹션은 분류대상이 아니라 category 없이 존재(주입 설정 — managed-policy/org-defaults/가이드).
//  v6 컷오버(2026-06-24): 구 knowledge_unit kind='R' → knowledge injection='always'. 반환 shape(OrgSection) 불변(소비자 무수정).
//  v6 upsertKnowledge 는 신규에 category 필수라 섹션엔 부적합 → 직접 SQL(injection='always', 분류 없음).
const SECTION_COLS = "name, body_md, version, sort, updated_at, updated_by";
function rowToSection(r: Record<string, unknown>): OrgSection {
  return {
    section: r.name as string, body_md: (r.body_md as string) ?? "",
    version: (r.version as number) ?? 1, sort: (r.sort as number) ?? 0,
    updated_at: (r.updated_at as string) ?? null, updated_by: (r.updated_by as string) ?? null,
  };
}

export async function getSection(section: string): Promise<OrgSection | null> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE name=$1 AND injection='always' AND lifecycle='active'`, [section]);
  return r.rows[0] ? rowToSection(r.rows[0]) : null;
}

// 항상-주입 섹션 전체(=injection='always' 행) — sort 우선, 동률이면 name. #335: 섹션이 곧 항상-주입의 전부(N개 관리형).
export async function listSections(): Promise<OrgSection[]> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE injection='always' AND lifecycle='active' ORDER BY sort, name`);
  return r.rows.map(rowToSection);
}

// 섹션 upsert(생성/편집) — injection='always' 고정, 분류 없음. 신규는 sort=말미(max+1), 기존은 sort 보존. version 증가·감사.
//  #669: 본문 실변경 시 embedding_* 리셋 — 섹션도 knowledge 행이라 검색 임베딩 대상. 재임베딩은 자동 pending 백필이 줍는다.
export async function updateSection(
  section: string,
  body_md: string,
  actor?: string,
  source?: string,
): Promise<OrgSection> {
  const before = await getSection(section);
  await itemsPool.query(
    `INSERT INTO knowledge(name, body_md, injection, provenance, lifecycle, confidence, source, sort, version, updated_at, updated_by)
     VALUES($1,$2,'always','authored','active',$3,$4,
       COALESCE((SELECT MAX(sort) FROM knowledge WHERE injection='always' AND lifecycle='active'),-1)+1,
       1,now(),$5)
     ON CONFLICT (name) DO UPDATE SET
       body_md=EXCLUDED.body_md, injection='always', lifecycle='active',
       embedding_vector=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_vector END,
       embedding_model=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_model END,
       embedding_updated_at=CASE WHEN knowledge.body_md IS DISTINCT FROM EXCLUDED.body_md THEN NULL ELSE knowledge.embedding_updated_at END,
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [section, body_md, source === "mcp" ? "ai" : "human", source ?? "web", actor ?? null]);
  const after = await getSection(section);
  await audit("org_section", section, before ? "update" : "insert", before, after, actor, source);
  return after!;
}

// 섹션 삭제 — 행 제거(감사 스냅샷 before 보존, content_restore 복원가능). 섹션은 카테고리·프로젝트 링크가 없어 CASCADE 영향 없음.
export async function deleteSection(section: string, actor?: string, source?: string): Promise<boolean> {
  const before = await getSection(section);
  if (!before) return false;
  await itemsPool.query(`DELETE FROM knowledge WHERE name=$1 AND injection='always'`, [section]);
  await audit("org_section", section, "delete", before, null, actor, source);
  return true;
}

// 섹션 이름 충돌 검사 — 같은 name 이 이미 '일반 지식'(injection!='always')이면 섹션화 시 그 지식을 덮어쓸 위험 → 차단용.
//  반환: 'section'(이미 섹션)·'knowledge'(일반 지식 충돌)·null(미사용).
export async function sectionNameInUse(name: string): Promise<"section" | "knowledge" | null> {
  const r = await itemsPool.query(`SELECT injection FROM knowledge WHERE name=$1`, [name]);
  if (!r.rows[0]) return null;
  return r.rows[0].injection === "always" ? "section" : "knowledge";
}

// 섹션 주입 순서 일괄 설정 — orderedNames 순서대로 sort=0,1,2…(=조립 순서). 목록에 없는 섹션은 그대로(뒤로 밀림).
export async function setSectionsOrder(orderedNames: string[], actor?: string, source?: string): Promise<void> {
  for (let i = 0; i < orderedNames.length; i++) {
    await itemsPool.query(
      `UPDATE knowledge SET sort=$2, updated_at=now() WHERE name=$1 AND injection='always' AND lifecycle='active'`,
      [orderedNames[i], i]);
  }
  await audit("org_section", null, "reorder", null, { order: orderedNames }, actor, source);
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

// ── org_memory(WIKI 인덱스) — v6 knowledge 위 얇은 래퍼(2026-06-23 cutover). 진실원천=v6 knowledge. ──
//  매핑: memory ↔ injection='recalled'(규칙 아님) ∧ provenance='authored'(외부 미러 아님). 신규 메모=recalled/authored.
//  구 kind<>'R' ∧ confidence<>'observed' 와 동치. OrgMemory shape 불변(delivery·UI·MCP 무수정) — domain_key=대표 category.key.
function knowledgeToMemory(k: KnowledgeRow, domainKey: string | null = null): OrgMemory {
  return {
    name: k.name, title: k.title, summary: k.summary, body_md: k.body_md, sort: Number(k.sort) || 0,
    domain_key: domainKey, domain_repo: null, is_wiki: !!k.is_wiki,
    version: k.version, updated_at: k.updated_at as string | null, updated_by: k.updated_by as string | null,
  };
}

// 여러 지식의 대표 category.key(confirmed 우선, 교차관심사 우선) — 카드 domain 칩 표시용. knowledge_category ⋈ category.
async function repCategoryKeys(names: string[]): Promise<Map<string, string>> {
  if (!names.length) return new Map();
  const r = await itemsPool.query(
    `SELECT DISTINCT ON (kc.name) kc.name, c.key
       FROM knowledge_category kc JOIN category c ON c.id = kc.category_id
      WHERE kc.name = ANY($1) AND kc.state <> 'rejected' AND c.state <> 'merged'
      ORDER BY kc.name, (kc.state = 'confirmed') DESC, c.cross_cutting DESC, kc.category_id`,
    [names]);
  const m = new Map<string, string>();
  for (const row of r.rows) m.set(row.name as string, row.key as string);
  return m;
}

export async function listMemory(): Promise<OrgMemory[]> {
  // WIKI 인덱스 = injection≠'always'(규칙·페르소나)만 제외. provenance 필터 없음 — authored·observed(외부 미러) 둘 다 포함(윤상민 2026-06-24).
  const rows = await listK6({ injection: "recalled", lifecycle: "active", limit: 500 });
  const cats = await repCategoryKeys(rows.map((r) => r.name));
  return rows.map((k) => knowledgeToMemory(k, cats.get(k.name) ?? null));
}

export interface MemoryInput {
  name: string;
  title?: string | null;
  summary?: string | null;     // 카드 표시용 '쉬운 한 줄'(미전송=보존, null=클리어 → title 폴백)
  body_md?: string;
  sort?: number;
  domain_key?: string | null;
  domain_repo?: string | null;
}

export async function upsertMemory(mem: MemoryInput, actor?: string, source?: string): Promise<OrgMemory> {
  // 메모는 항상 recalled/authored(규칙·미러 아님). summary/sort 는 v6 컬럼에 직접 보존.
  // 미분류 금지: domain_key(=category.key)를 upsertK6 category 로 넘겨 신규 시 category 강제
  //  (upsertK6 가 key→id 해소·link·미분류 throw 를 일원 처리). 갱신 시 domain_key 없으면 기존 매핑 보존.
  const k = await upsertK6({
    name: mem.name, title: mem.title ?? undefined, body_md: mem.body_md ?? "",
    summary: mem.summary, sort: mem.sort, injection: "recalled", provenance: "authored",
    category: mem.domain_key ? [mem.domain_key] : undefined,
  }, { actor: actor ?? null, source });
  return knowledgeToMemory(k, mem.domain_key ?? null);
}

// (removeMemory 는 #536 에서 제거 — 유일 소비자였던 org_memory_remove 엔드포인트가 사라짐.
//  메모리 삭제는 knowledge_delete 로 일원화. 읽기 listMemory·쓰기 upsertMemory(migrate)는 유지.)

// ── auth_token (DB 기반 bearer) ──
// 발급 — 평문 토큰을 1회 반환(저장은 해시만). prefix 'lvk_' 로 verifyDbToken 의 빠른 게이팅 가능.
// email 은 토큰에 저장하지 않는다 — 귀속/표시용 email 은 member_id → org_member 에서 파생(중복·stale 제거).
// client 를 넘기면 그 커넥션(트랜잭션 중)에서 INSERT+audit 을 실행한다(#880 device flow: consume-UPDATE 와
//  같은 BEGIN/COMMIT 원자성 — 안 그러면 토큰이 독립 커밋돼 COMMIT 실패 시 orphan 토큰 누수). 기본은 풀(autocommit).
export async function mintToken(input: {
  userId: string;
  scopes: string[];
  projects?: string[];
  label?: string | null;
  memberId?: string | null;
}, actor?: string, source?: string, client?: pg.PoolClient): Promise<{ token: string; tokenHash: string }> {
  const exec = client ?? itemsPool;
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  await exec.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)`,
    [tokenHash, input.userId, JSON.stringify(input.scopes),
     JSON.stringify(input.projects ?? ["*"]), input.label ?? null, input.memberId ?? null, actor ?? null],
  );
  await audit("auth_token", input.userId, "mint",
    null, { userId: input.userId, scopes: input.scopes, label: input.label, memberId: input.memberId }, actor, source, client);
  return { token, tokenHash };
}

export interface TokenMeta {
  token_hash: string;
  user_id: string;
  scopes: string[];
  label: string | null;
  member_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listTokens(): Promise<TokenMeta[]> {
  const r = await itemsPool.query(
    `SELECT token_hash, user_id, scopes, label, member_id, created_at, last_used_at, revoked_at
       FROM auth_token ORDER BY created_at DESC`,
  );
  return r.rows as TokenMeta[];
}

export async function revokeToken(tokenHash: string, actor?: string, source?: string): Promise<void> {
  await itemsPool.query(
    `UPDATE auth_token SET revoked_at = now() WHERE token_hash=$1 AND revoked_at IS NULL`,
    [tokenHash],
  );
  await audit("auth_token", tokenHash, "revoke", null, null, actor, source); // 전체 해시 기록(상관추적용 — 해시는 비밀 아님)
}

// 유효 권한 계산(순수 함수 — 단위 테스트 대상). 토큰은 '발급된 상한', 멤버는 '라이브 상한' →
//  유효 = 둘의 intersection. 멤버 연결 토큰(member_id 있음)인데 멤버가 active 가 아니면(비활성/삭제 → LEFT JOIN
//  state=null) null=거부 → 퇴사·강등이 즉시 모든 토큰을 무효화(보안 핵심). member_id 없는 서비스/레거시 토큰은
//  교집합 대상이 없어 토큰 scope 그대로. (상향은 토큰 재발급으로 — 최소권한 보존, 자동 확대 안 함.)
export function computeEffectiveScopes(opts: {
  memberId: string | null;
  memberState: string | null;
  tokenScopes: string[];
  memberScopes: string[];
}): string[] | null {
  // B4: 허용 scope 만(JSONB 손상·마이그레이션·위조로 admin/runtime 섞여 들어와도 여기서 떨군다).
  const tokenScopes = opts.tokenScopes.filter(isScope);
  if (!opts.memberId) return tokenScopes;
  if (opts.memberState !== "active") return null;
  const memberScopes = new Set(opts.memberScopes.filter(isScope));
  return tokenScopes.filter((s) => memberScopes.has(s));
}

// 인증 경로(bearer.ts) — 평문 토큰 → 해시 조회. revoked 아니면 LivelyUser shape 반환, 아니면 null.
// ITEMS_DATABASE_URL 미설정/오류 시 null(fail-closed: 무효 토큰 취급).
export async function verifyDbToken(token: string): Promise<{ userId: string; email: string; scopes: string[]; projects: string[] } | null> {
  if (!process.env.ITEMS_DATABASE_URL) return null;
  try {
    // email·권한 상한 모두 토큰이 아니라 구성원에서 파생(같은 쿼리 LEFT JOIN — 라운드트립 0, 항상 최신).
    const r = await itemsPool.query(
      `SELECT t.user_id, t.member_id, m.email AS email, m.state AS member_state,
              t.scopes AS token_scopes, m.scopes AS member_scopes, t.projects
         FROM auth_token t LEFT JOIN org_member m ON m.id = t.member_id
        WHERE t.token_hash=$1 AND t.revoked_at IS NULL`,
      [sha256(token)],
    );
    const row = r.rows[0] as {
      user_id: string; member_id: string | null; email: string | null;
      member_state: string | null; token_scopes: unknown; member_scopes: unknown; projects: unknown;
    } | undefined;
    if (!row) return null;
    // JSONB scopes/projects 는 런타임에 무엇이든 될 수 있다(마이그레이션 버그·손상) → 보안 경계에서
    //  .includes() 가 깨지지 않게 '문자열 배열'로 강제 정규화(비배열/비문자 원소는 버린다).
    const strArr = (v: unknown, fb: string[]): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;
    // 유효 권한 = intersection(토큰 scope, 멤버 scope). 멤버가 '라이브 상한' — 비활성/삭제면 거부.
    const scopes = computeEffectiveScopes({
      memberId: row.member_id,
      memberState: row.member_state,
      tokenScopes: strArr(row.token_scopes, []),
      memberScopes: strArr(row.member_scopes, []),
    });
    if (scopes === null) return null; // 멤버 비활성/삭제 → 토큰 무효(→ 401)
    // last_used 갱신은 베스트에포트(인증 핫패스 — 실패 무시).
    itemsPool.query(`UPDATE auth_token SET last_used_at=now() WHERE token_hash=$1`, [sha256(token)]).catch(() => {});
    return { userId: row.user_id, email: row.email ?? "", scopes, projects: strArr(row.projects, ["*"]) };
  } catch {
    return null;
  }
}

// 멤버의 활성 install 토큰 존재 여부(웹 '구성원' 상태 칩용).
export async function memberHasActiveToken(memberId: string): Promise<boolean> {
  if (!process.env.ITEMS_DATABASE_URL) return false;
  try {
    const r = await itemsPool.query(
      `SELECT 1 FROM auth_token WHERE member_id=$1 AND revoked_at IS NULL LIMIT 1`, [memberId],
    );
    return (r.rowCount ?? 0) > 0;
  } catch {
    return false;
  }
}

// ════════ 런타임 설정(훅 on/off · work-roots · writeback 너지) — org_runtime_config 단일행 ════════
export interface OrgRuntimeConfig {
  // self_update(#858): 멤버 키트(훅 코드·배선) 자동 업데이트. 끄면 멤버는 수동 업데이트 명령이 유일한 경로.
  hooks: { session_preload: boolean; work_flag: boolean; stop_writeback_gate: boolean; self_update: boolean };
  writeback_notice: string | null;
  work_roots: string[];
  allowed_auth_envs: string[]; // http_proxy 툴이 참조 가능한 환경변수 '이름' 화이트리스트(B15)
  url_allowlist: string[];     // http_proxy 호출 허용 호스트(소문자, deny-all 기본)
  allowed_db_secret_refs: string[]; // db 소스가 참조 가능한 시크릿 env '이름' 화이트리스트(deny-all 기본)
  allowed_db_hosts: string[]; // db 소스가 접속 가능한 host 화이트리스트(소문자, deny-all 기본) — 사설/localhost SSRF 면제 대상
  allowed_internal_hosts: string[]; // MCP 프록시가 접속 가능한 내부(사설/localhost) host 화이트리스트(소문자, deny-all 기본) — #746 T1
  write_tools: string[]; // work-flag 가 '기록함(writeback)'으로 인정할 lively MCP 툴 목록(비면 훅 내장 v6 기본)
  pull_tools: string[]; // work-flag 가 '외부 맥락 인입'으로 볼 MCP 툴 이름 prefix 목록(#906) — write_tools 와 달리 **비면 끔**
  embedding_config: EmbeddingConfig; // 벡터검색(#172) 추론 seam 설정 — 기본 off(현행 grep/ILIKE). DB 우선, 비면 env(EMBEDDINGS_*) 시드
  storage_policy: StoragePolicy; // 박스 저장소 정책(#813) — 로그 상한·디스크 임계치. DB 우선, 비면 env 시드 → 기본값
  hook_relay_decisions: HookRelayDecision[]; // 러너가 PreToolUse 에서 전파할 결정(#892). 기본 deny/ask/defer — allow 는 명시 opt-in
  session_share: SessionShareConfig; // 세션이력 캡처 정책(#905 C1). 기본 enabled=false(롤아웃 꺼둠). 관리탭 ▸ 세션 공유.
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const strArrSafe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

// PreToolUse 결정 전파 정책(#892) — Claude Code 의 permissionDecision 값 집합.
export const HOOK_RELAY_DECISIONS = ["deny", "defer", "ask", "allow"] as const;
export type HookRelayDecision = (typeof HOOK_RELAY_DECISIONS)[number];
export const DEFAULT_HOOK_RELAY_DECISIONS: HookRelayDecision[] = ["deny", "ask", "defer"];
// 컬럼 부재(구 DB)·잡값이면 기본값으로 접는다 — 빈 배열은 '전파 안 함'이라는 의도된 상태라 그대로 둔다.
const relayDecisionsSafe = (v: unknown): HookRelayDecision[] => {
  if (!Array.isArray(v)) return DEFAULT_HOOK_RELAY_DECISIONS;
  return v.filter((x): x is HookRelayDecision => HOOK_RELAY_DECISIONS.includes(x as HookRelayDecision));
};

export async function getRuntimeConfig(): Promise<OrgRuntimeConfig> {
  const r = await itemsPool.query(
    `SELECT hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, allowed_internal_hosts, write_tools, pull_tools, embedding_config, storage_policy, hook_relay_decisions, session_share, version, updated_at, updated_by
       FROM org_runtime_config WHERE id=1`,
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  const hooksRaw = (row?.hooks ?? {}) as Record<string, unknown>;
  return {
    hooks: {
      session_preload: hooksRaw.session_preload !== false,
      work_flag: hooksRaw.work_flag !== false,
      stop_writeback_gate: hooksRaw.stop_writeback_gate !== false,
      // 기존 org 행엔 이 키가 없다 — `!== false` 규약이 곧 '없으면 켜짐'이라 마이그레이션 없이 전원 활성.
      self_update: hooksRaw.self_update !== false,
    },
    writeback_notice: (row?.writeback_notice as string) ?? null,
    work_roots: strArrSafe(row?.work_roots),
    allowed_auth_envs: strArrSafe(row?.allowed_auth_envs),
    url_allowlist: strArrSafe(row?.url_allowlist).map((s) => s.toLowerCase()),
    allowed_db_secret_refs: strArrSafe(row?.allowed_db_secret_refs),
    allowed_db_hosts: strArrSafe(row?.allowed_db_hosts).map((s) => s.toLowerCase()),
    allowed_internal_hosts: strArrSafe(row?.allowed_internal_hosts).map((s) => s.toLowerCase()),
    write_tools: strArrSafe(row?.write_tools),
    // #906 — 컬럼 부재(구 DB)면 [] = 꺼짐. 마이그레이션이 ADD COLUMN DEFAULT 로 기존 행까지 켜준다.
    pull_tools: strArrSafe(row?.pull_tools),
    embedding_config: resolveEmbeddingConfig(row?.embedding_config), // DB 우선, off/미설정이면 env(EMBEDDINGS_*) 시드
    storage_policy: resolveStoragePolicy(row?.storage_policy), // DB 우선, 비면 env 시드 → 코드 기본값(#813)
    hook_relay_decisions: relayDecisionsSafe(row?.hook_relay_decisions), // #892 — 구 DB(컬럼 부재)면 기본값
    session_share: resolveSessionShare(row?.session_share), // #905 C1 — 구 DB(컬럼 부재)면 기본값(enabled=false)
    version: (row?.version as number) ?? 1,
    updated_at: (row?.updated_at as string) ?? null,
    updated_by: (row?.updated_by as string) ?? null,
  };
}

export async function updateRuntimeConfig(
  patch: {
    hooks?: Partial<OrgRuntimeConfig["hooks"]>;
    writeback_notice?: string | null;
    work_roots?: string[];
    allowed_auth_envs?: string[];
    url_allowlist?: string[];
    allowed_db_secret_refs?: string[];
    allowed_db_hosts?: string[];
    allowed_internal_hosts?: string[];
    write_tools?: string[];
    pull_tools?: string[];
    embedding_config?: EmbeddingConfigPatch;
    storage_policy?: StoragePolicyPatch;
    hook_relay_decisions?: HookRelayDecision[];
    session_share?: SessionSharePatch;
  },
  actor?: string,
  source?: string,
  meta?: { tokenHashPrefix?: string | null; ip?: string | null },
): Promise<OrgRuntimeConfig> {
  const before = await getRuntimeConfig();
  const hooks = { ...before.hooks, ...(patch.hooks ?? {}) };
  const writebackNotice = patch.writeback_notice !== undefined ? patch.writeback_notice : before.writeback_notice;
  const workRoots = patch.work_roots !== undefined ? patch.work_roots : before.work_roots;
  const allowedAuthEnvs = patch.allowed_auth_envs !== undefined ? patch.allowed_auth_envs : before.allowed_auth_envs;
  const urlAllowlist = patch.url_allowlist !== undefined ? patch.url_allowlist.map((s) => s.toLowerCase()) : before.url_allowlist;
  const allowedDbSecretRefs = patch.allowed_db_secret_refs !== undefined ? patch.allowed_db_secret_refs : before.allowed_db_secret_refs;
  const allowedDbHosts = patch.allowed_db_hosts !== undefined ? patch.allowed_db_hosts.map((s) => s.toLowerCase()) : before.allowed_db_hosts;
  const allowedInternalHosts = patch.allowed_internal_hosts !== undefined ? patch.allowed_internal_hosts.map((s) => s.toLowerCase()) : before.allowed_internal_hosts;
  const writeTools = patch.write_tools !== undefined ? patch.write_tools : before.write_tools;
  const pullTools = patch.pull_tools !== undefined ? patch.pull_tools : before.pull_tools;
  // #892 — before 는 이미 resolve 된 값이라 되써도 기본값이 굳는 문제가 없다(embedding/storage 와 달리
  //  '미설정' 과 '기본값' 을 구분할 이유가 없는 단순 화이트리스트).
  const relayDecisions = patch.hook_relay_decisions !== undefined ? patch.hook_relay_decisions : before.hook_relay_decisions;
  // 임베딩 설정 — 저장 시 정규화(잡값/알 수 없는 provider → off). 시크릿 미저장(auth_env_ref=env 이름만).
  //  #688 두 가지 보존: ① '명시적 끄기'({provider:'off',explicit:true})는 normalize 로 마커를 벗기지 않고 그대로 저장
  //  (env 시드 부활 금지). ② embedding_config 를 안 건드린 저장은 DB '원본'을 유지 — before(resolved)를 되쓰면
  //  env 시드 값이 DB 로 굳고(미설정→영구화) 명시적 off 마커도 소실된다(둘 다 실제로 겪은 함정).
  let embeddingConfig: unknown;
  if (patch.embedding_config !== undefined) {
    embeddingConfig = isExplicitEmbeddingOff(patch.embedding_config)
      ? { ...EMBEDDING_OFF, explicit: true }
      : normalizeEmbeddingConfig(patch.embedding_config);
  } else {
    const raw = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    embeddingConfig = (raw.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config ?? null;
  }
  // 저장소 정책(#813) — embedding_config 와 같은 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다.**
  //  before(resolved)를 되쓰면 env 시드/기본값이 DB 로 굳어 '미설정' 상태가 영구히 사라진다(#688 에서 겪은 함정).
  let storagePolicy: unknown;
  if (patch.storage_policy !== undefined) {
    storagePolicy = normalizeStoragePolicy({ ...before.storage_policy, ...patch.storage_policy });
  } else {
    const raw = await itemsPool.query(`SELECT storage_policy FROM org_runtime_config WHERE id=1`);
    storagePolicy = (raw.rows[0] as { storage_policy?: unknown } | undefined)?.storage_policy ?? {};
  }
  // 세션 공유(#905 C1) — storage_policy 와 동일 규칙: **안 건드린 저장은 DB 원본을 그대로 둔다**(before 되쓰기 금지).
  //  건드리면 before(resolved) 위에 patch 를 얹어 정규화(잡값·미지원 하네스·범위초과 방어).
  let sessionShare: unknown;
  if (patch.session_share !== undefined) {
    sessionShare = normalizeSessionShare(before.session_share, patch.session_share);
  } else {
    const raw = await itemsPool.query(`SELECT session_share FROM org_runtime_config WHERE id=1`);
    sessionShare = (raw.rows[0] as { session_share?: unknown } | undefined)?.session_share ?? null;
  }
  await itemsPool.query(
    `INSERT INTO org_runtime_config(id, hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, allowed_internal_hosts, write_tools, pull_tools, embedding_config, storage_policy, hook_relay_decisions, session_share, version, updated_at, updated_by)
       VALUES(1,$1::jsonb,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$14::jsonb,$15::jsonb,1,now(),$13)
     ON CONFLICT (id) DO UPDATE SET hooks=EXCLUDED.hooks, writeback_notice=EXCLUDED.writeback_notice,
       work_roots=EXCLUDED.work_roots, allowed_auth_envs=EXCLUDED.allowed_auth_envs, url_allowlist=EXCLUDED.url_allowlist,
       allowed_db_secret_refs=EXCLUDED.allowed_db_secret_refs, allowed_db_hosts=EXCLUDED.allowed_db_hosts,
       allowed_internal_hosts=EXCLUDED.allowed_internal_hosts,
       write_tools=EXCLUDED.write_tools, pull_tools=EXCLUDED.pull_tools, embedding_config=EXCLUDED.embedding_config,
       storage_policy=EXCLUDED.storage_policy, hook_relay_decisions=EXCLUDED.hook_relay_decisions,
       session_share=EXCLUDED.session_share,
       version=org_runtime_config.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(hooks), writebackNotice, JSON.stringify(workRoots),
     JSON.stringify(allowedAuthEnvs), JSON.stringify(urlAllowlist), JSON.stringify(allowedDbSecretRefs), JSON.stringify(allowedDbHosts), JSON.stringify(allowedInternalHosts), JSON.stringify(writeTools), JSON.stringify(pullTools), JSON.stringify(embeddingConfig), JSON.stringify(storagePolicy), actor ?? null, JSON.stringify(relayDecisions), JSON.stringify(sessionShare)],
  );
  // 저장 즉시 반영 — /readyz 임계치·로그 재니터가 캐시를 들고 있다(게이트웨이 재시작 없이 먹어야 한다).
  if (patch.storage_policy !== undefined) invalidateStoragePolicyCache();
  const after = await getRuntimeConfig();
  await audit("org_runtime_config", "1", "update", before, after, actor, source, meta);
  return after;
}

// #688 유효 임베딩 설정의 출처(관리 UI 안내) — db(관리탭 on)·db-off(명시적 끄기)·env(.env 시드)·off(미설정).
//  getRuntimeConfig 는 resolved 만 주므로 출처 판정은 DB 원본으로 별도 조회.
export async function getEmbeddingConfigSource(): Promise<"db" | "db-off" | "env" | "off"> {
  try {
    const r = await itemsPool.query(`SELECT embedding_config FROM org_runtime_config WHERE id=1`);
    return embeddingConfigSource((r.rows[0] as { embedding_config?: unknown } | undefined)?.embedding_config ?? null);
  } catch {
    return embeddingConfigSource(null); // 테이블 부재(부트스트랩 전) — env/off 로 판정
  }
}

// 저장소 정책(#813)의 출처(관리 UI 안내) — db(관리탭 저장)·env(.env 시드)·default(코드 기본값).
//  getRuntimeConfig 는 resolved 만 주므로 출처 판정은 DB 원본으로 별도 조회(임베딩과 같은 방식).
export async function getStoragePolicySource(): Promise<"db" | "env" | "default"> {
  try {
    const r = await itemsPool.query(`SELECT storage_policy FROM org_runtime_config WHERE id=1`);
    return storagePolicySource((r.rows[0] as { storage_policy?: unknown } | undefined)?.storage_policy ?? null);
  } catch {
    return storagePolicySource(null); // 테이블 부재(부트스트랩 전)
  }
}

// ════════ MCP 서버 레지스트리 — org_mcp_server ════════
export interface McpServer {
  name: string;
  transport: "http" | "stdio";
  url: string | null;
  command: string | null;
  auth_env: string | null;
  note: string | null;
  enabled: boolean;
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
  // A-어댑터 프록시(#746 T1)
  mode: "client" | "proxy";
  tools_snapshot: Array<{ name: string; description?: string; inputSchema?: unknown }> | null;
  snapshot_at: string | null;
  scope: string | null;
  level: "L0" | "L1" | "L2" | null;
  pii_scrub: boolean;
  auth_kind: string | null;
  auth_scope_key: string | null;
  auth_mode: "bearer" | "oauth" | "sigv4" | null; // null/bearer=정적토큰, oauth=per-member OAuth(T2), sigv4=AWS 요청서명(#746)
}

function mapMcp(row: Record<string, unknown>): McpServer {
  return {
    name: row.name as string,
    transport: row.transport as McpServer["transport"],
    url: (row.url as string) ?? null,
    command: (row.command as string) ?? null,
    auth_env: (row.auth_env as string) ?? null,
    note: (row.note as string) ?? null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
    mode: (row.mode as McpServer["mode"]) ?? "client",
    tools_snapshot: Array.isArray(row.tools_snapshot) ? (row.tools_snapshot as McpServer["tools_snapshot"]) : null,
    snapshot_at: (row.snapshot_at as string) ?? null,
    scope: (row.scope as string) ?? null,
    level: (row.level as McpServer["level"]) ?? null,
    pii_scrub: row.pii_scrub === true,
    auth_kind: (row.auth_kind as string) ?? null,
    auth_scope_key: (row.auth_scope_key as string) ?? null,
    auth_mode: (row.auth_mode as McpServer["auth_mode"]) ?? null,
  };
}

const MCP_COLS = "name, transport, url, command, auth_env, note, enabled, sort, version, updated_at, updated_by, mode, tools_snapshot, snapshot_at, scope, level, pii_scrub, auth_kind, auth_scope_key, auth_mode";

export async function listMcpServers(): Promise<McpServer[]> {
  const r = await itemsPool.query(`SELECT ${MCP_COLS} FROM org_mcp_server ORDER BY sort, name`);
  return r.rows.map(mapMcp);
}

export async function getMcpServer(name: string): Promise<McpServer | null> {
  const r = await itemsPool.query(`SELECT ${MCP_COLS} FROM org_mcp_server WHERE name=$1`, [name]);
  return r.rows[0] ? mapMcp(r.rows[0]) : null;
}

export interface McpServerInput {
  name: string;
  transport?: "http" | "stdio";
  url?: string | null;
  command?: string | null;
  auth_env?: string | null;
  note?: string | null;
  enabled?: boolean;
  sort?: number;
  mode?: "client" | "proxy";
  scope?: string | null;
  level?: "L0" | "L1" | "L2" | null;
  pii_scrub?: boolean;
  auth_kind?: string | null;
  auth_scope_key?: string | null;
  auth_mode?: "bearer" | "oauth" | "sigv4" | null;
}

export async function upsertMcpServer(m: McpServerInput, actor?: string, source?: string): Promise<McpServer> {
  const before = await getMcpServer(m.name);
  const transport = m.transport ?? before?.transport ?? "http";
  // transport 와 맞지 않는 필드는 비운다(http↔stdio 전환 시 옛 url/command 잔류로 인한 잘못된 상태 방지).
  const url = transport === "http" ? (m.url ?? before?.url ?? null) : null;
  const command = transport === "stdio" ? (m.command ?? before?.command ?? null) : null;
  const mode = m.mode ?? before?.mode ?? "client";
  // proxy 는 http 전송 전제(상류 remote MCP). auth_kind 지정 시 auth_env 는 비운다(인증 출처 하나 — org_tool 배타와 동일).
  const authKind = m.auth_kind !== undefined ? (m.auth_kind || null) : (before?.auth_kind ?? null);
  const authEnv = authKind ? null : (m.auth_env ?? before?.auth_env ?? null);
  const authMode = m.auth_mode !== undefined ? (m.auth_mode || null) : (before?.auth_mode ?? null);
  // auth_mode=oauth 는 auth_kind(vault 토큰 슬롯 kind) 필수(#746 리뷰 #3) — 없으면 연결/호출 시점까지 오류가 늦어진다.
  if (authMode === "oauth" && !authKind) throw new Error("auth_mode=oauth 는 auth_kind(자격 종류)가 필요합니다");
  await itemsPool.query(
    `INSERT INTO org_mcp_server(name, transport, url, command, auth_env, note, enabled, sort, mode, scope, level, pii_scrub, auth_kind, auth_scope_key, auth_mode, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,1,now(),$16)
     ON CONFLICT (name) DO UPDATE SET
       transport=EXCLUDED.transport, url=EXCLUDED.url, command=EXCLUDED.command, auth_env=EXCLUDED.auth_env,
       note=EXCLUDED.note, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       mode=EXCLUDED.mode, scope=EXCLUDED.scope, level=EXCLUDED.level, pii_scrub=EXCLUDED.pii_scrub,
       auth_kind=EXCLUDED.auth_kind, auth_scope_key=EXCLUDED.auth_scope_key, auth_mode=EXCLUDED.auth_mode,
       version=org_mcp_server.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.name, transport, url, command,
     authEnv, m.note ?? before?.note ?? null,
     m.enabled ?? before?.enabled ?? true, m.sort ?? before?.sort ?? 0,
     mode, m.scope !== undefined ? m.scope : (before?.scope ?? null),
     m.level !== undefined ? m.level : (before?.level ?? null),
     m.pii_scrub !== undefined ? !!m.pii_scrub : (before?.pii_scrub ?? false),
     authKind, m.auth_scope_key !== undefined ? (m.auth_scope_key || null) : (before?.auth_scope_key ?? null),
     authMode,
     actor ?? null],
  );
  // url/mode 변경 시 pinned tools_snapshot 무효화(#746 리뷰) — 옛 상류 기준 툴 정체성/목적지 불일치 방지.
  //  listProxyServers 는 snapshot NOT NULL 만 노출하므로, 재발행(refresh)까지 이 서버는 프록시 등록에서 빠진다(fail-safe).
  if (before && (before.url !== url || before.mode !== mode)) {
    await itemsPool.query(`UPDATE org_mcp_server SET tools_snapshot=NULL, snapshot_at=NULL WHERE name=$1`, [m.name]);
  }
  const after = await getMcpServer(m.name);
  await audit("org_mcp_server", m.name, before ? "update" : "insert", before, after, actor, source);
  return after as McpServer;
}

export async function removeMcpServer(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getMcpServer(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_mcp_server WHERE name=$1`, [name]);
  await audit("org_mcp_server", name, "delete", before, null, actor, source);
}

// A-어댑터(#746 T1) — 발행 시 상류 tools/list 스냅샷(핀) 저장. 관리자 '새로고침/버전업' 액션이 호출.
export async function setMcpToolsSnapshot(name: string, tools: Array<{ name: string; description?: string; inputSchema?: unknown }>, actor?: string): Promise<void> {
  const before = await getMcpServer(name);
  if (!before) throw new Error(`MCP 서버 없음: ${name}`);
  await itemsPool.query(
    `UPDATE org_mcp_server SET tools_snapshot=$2::jsonb, snapshot_at=now(), version=version+1, updated_at=now(), updated_by=$3 WHERE name=$1`,
    [name, JSON.stringify(tools), actor ?? null],
  );
  await audit("org_mcp_server", name, "update", { tool_count: before.tools_snapshot?.length ?? 0 }, { tool_count: tools.length, action: "snapshot" }, actor, "web");
}

// /mcp 프록시 등록용 — enabled + mode='proxy' + 스냅샷 보유(발행됨) 서버만. buildServer 가 이 스냅샷으로 툴을 재노출한다.
export async function listProxyServers(): Promise<McpServer[]> {
  const r = await itemsPool.query(
    `SELECT ${MCP_COLS} FROM org_mcp_server WHERE enabled=true AND mode='proxy' AND tools_snapshot IS NOT NULL ORDER BY sort, name`);
  return r.rows.map(mapMcp);
}

// ════════ 커넥터 설정/토큰 레지스트리 — org_connector (프로젝트 #541) ════════
//  CONNECTOR_SPECS(connectors/config.ts)가 필드 SoT. config=평문 설정(secret=false), secrets=암호화(secret-box).
//  뷰는 시크릿 '값'을 절대 노출하지 않고 설정 여부(secretsSet)만 준다. 해소(런타임 실사용)는 connectors/config.ts.

/** 관리탭·aggregate 용 커넥터 뷰 — 시크릿 값 없음(설정 여부만). fields 는 프론트 동적 폼용 스펙. */
export interface ConnectorView {
  system: string;
  label: string;
  fields: ConnectorField[];
  enabled: boolean;
  config: Record<string, string>;       // 평문 설정값(secret=false 필드)
  secretsSet: Record<string, boolean>;  // 시크릿 설정 여부(값 노출 안 함)
  note: string | null;
  updated_at: string | null;
  secrets_enabled: boolean;             // 마스터키(CONNECTOR_SECRET_KEY) 설정 여부 — 관리탭 안내용
  guide?: { intro?: string; steps: string[]; url?: string }; // 토큰 발급 가이드(#586 — 폼 상단 안내)
  sync_job?: { enabled: boolean; interval_sec: number } | null; // 자동 싱크 잡 상태(#586)
}

export async function listConnectors(): Promise<ConnectorView[]> {
  const r = await itemsPool.query(`SELECT system, enabled, config, secrets, note, updated_at FROM org_connector`);
  const byId = new Map<string, Record<string, unknown>>(r.rows.map((x) => [x.system as string, x]));
  // 자동 싱크 잡 상태(#586) — sync-<system> 잡을 함께 보여줘 '커넥터 켬=싱크 돎'이 화면에서 검증되게.
  const jobs = new Map<string, { enabled: boolean; interval_sec: number }>();
  try {
    const jr = await itemsPool.query(`SELECT id, enabled, interval_sec FROM org_cron WHERE id LIKE 'sync-%'`);
    for (const row of jr.rows as Array<{ id: string; enabled: boolean; interval_sec: number }>) {
      jobs.set(row.id.replace(/^sync-/, ""), { enabled: row.enabled, interval_sec: row.interval_sec });
    }
  } catch { /* org_cron 미생성 — 무시 */ }
  const secEnabled = secretsEnabled();
  return Object.values(CONNECTOR_SPECS).map((spec) => {
    const row = byId.get(spec.system);
    const rowConfig = (row?.config as Record<string, unknown>) ?? {};
    const rowSecrets = (row?.secrets as Record<string, unknown>) ?? {};
    const config: Record<string, string> = {};
    const secretsSet: Record<string, boolean> = {};
    for (const f of spec.fields) {
      if (f.secret) secretsSet[f.key] = Boolean(rowSecrets[f.key]);
      else config[f.key] = String(rowConfig[f.key] ?? "");
    }
    return {
      system: spec.system, label: spec.label, fields: spec.fields, guide: spec.guide,
      enabled: Boolean(row?.enabled), config, secretsSet,
      note: (row?.note as string) ?? null, updated_at: (row?.updated_at as string) ?? null,
      secrets_enabled: secEnabled,
      sync_job: jobs.get(spec.system) ?? null,
    };
  });
}

export interface ConnectorUpsertInput {
  system: string;
  enabled?: boolean;
  config?: Record<string, string>;   // 평문 설정(secret=false 필드만 반영)
  secrets?: Record<string, string>;  // 시크릿 평문(미전송/빈="미변경", 값=암호화 갱신)
  note?: string | null;
}

export async function upsertConnector(input: ConnectorUpsertInput, actor?: string, source?: string): Promise<ConnectorView> {
  const spec = CONNECTOR_SPECS[input.system];
  if (!spec) throw new Error(`알 수 없는 커넥터: ${input.system}`);
  const cur = await itemsPool.query(`SELECT enabled, config, secrets, note FROM org_connector WHERE system=$1`, [input.system]);
  const before = cur.rows[0] as { enabled: boolean; config: Record<string, unknown>; secrets: Record<string, unknown>; note: string | null } | undefined;

  const config: Record<string, unknown> = { ...(before?.config ?? {}) };
  const secrets: Record<string, unknown> = { ...(before?.secrets ?? {}) };
  for (const f of spec.fields) {
    if (f.secret) {
      const v = input.secrets?.[f.key];
      if (v === undefined || v === "") continue; // 미전송/빈 = 미변경(기존 암호문 유지 — 실수로 지우지 않음)
      if (!secretsEnabled()) throw new Error("CONNECTOR_SECRET_KEY 미설정 — 시크릿을 저장하려면 게이트웨이 .env 에 설정하세요 (openssl rand -hex 32).");
      secrets[f.key] = encryptSecret(v);
    } else {
      const v = input.config?.[f.key];
      if (v === undefined) continue;
      if (v === "") delete config[f.key]; else config[f.key] = v;
    }
  }
  const enabled = input.enabled ?? before?.enabled ?? false;
  const note = input.note === undefined ? (before?.note ?? null) : input.note;

  await itemsPool.query(
    `INSERT INTO org_connector(system, enabled, config, secrets, note, version, updated_at, updated_by)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,1,now(),$6)
     ON CONFLICT (system) DO UPDATE SET
       enabled=EXCLUDED.enabled, config=EXCLUDED.config, secrets=EXCLUDED.secrets, note=EXCLUDED.note,
       version=org_connector.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [input.system, enabled, JSON.stringify(config), JSON.stringify(secrets), note, actor ?? null],
  );

  // ── #586 커넥터 활성화 = 싱크 자동 — sync-<system> 크론 잡을 자동 등록/해제(스케줄러 별도 등록 불필요). ──
  //  이미 있으면 enabled 만 토글(관리자가 조정한 주기·파라미터 보존). org_cron 부재 등은 비치명(커넥터 저장은 성공).
  try {
    if (enabled) {
      await itemsPool.query(
        `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
           VALUES($1,$2,'connector_sync',$3::jsonb,600,true,$4)
         ON CONFLICT (id) DO UPDATE SET enabled=true`,
        [`sync-${input.system}`, `${spec.label} 자동 싱크`, JSON.stringify({ system: input.system }), actor ?? null]);
      // 일일 full 스윕(#586, notion) — 증분 델타가 구조적으로 못 보는 것들(댓글 단독 변경·멘션 제목 캐시·
      //  아카이브 전파·search 인덱싱 장기 지연)의 수렴 경로. 주기·활성은 관리자가 조정 가능(DO NOTHING).
      if (input.system === "notion") {
        await itemsPool.query(
          `INSERT INTO org_cron(id, label, action, params, interval_sec, enabled, created_by)
             VALUES($1,$2,'connector_sync',$3::jsonb,86400,true,$4)
           ON CONFLICT (id) DO UPDATE SET enabled=true`, // off→on 사이클에서 되살아나야(리뷰: DO NOTHING 은 영구 비활성)
          [`sync-${input.system}-full`, `${spec.label} 일일 전체 스윕(아카이브·완결성)`, JSON.stringify({ system: input.system, full: true }), actor ?? null]);
      }
    } else {
      await itemsPool.query(`UPDATE org_cron SET enabled=false WHERE id = ANY($1::text[])`, [[`sync-${input.system}`, `sync-${input.system}-full`]]);
    }
  } catch (e) {
    console.warn(`[connector] 자동 싱크 잡 등록 실패(비치명) ${input.system}:`, (e as Error)?.message);
  }
  // 감사 — 시크릿 '값'은 스냅샷에 넣지 않는다(설정된 키 목록만).
  const auditBefore = before ? { enabled: before.enabled, config: before.config, secretKeys: Object.keys(before.secrets ?? {}), note: before.note } : null;
  const auditAfter = { enabled, config, secretKeys: Object.keys(secrets), note };
  await audit("org_connector", input.system, before ? "update" : "insert", auditBefore, auditAfter, actor, source);

  const view = (await listConnectors()).find((c) => c.system === input.system);
  return view as ConnectorView;
}

export async function removeConnector(system: string, actor?: string, source?: string): Promise<void> {
  const cur = await itemsPool.query(`SELECT enabled, config, note FROM org_connector WHERE system=$1`, [system]);
  if (!cur.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_connector WHERE system=$1`, [system]);
  await audit("org_connector", system, "delete", cur.rows[0], null, actor, source);
}

// ════════ 자동 인입 허용선 정책 — org_ingest_policy (프로젝트 #638) ════════
//  distill/mirror 가 지식을 auto(즉시 active)|confirm(pending 격리→검토 큐)|drop(미적재) 중 어디로 보낼지 오너가 조절.
//  평가는 순수함수 resolveIngestPolicy(org/ingest-policy.ts) — 여기선 CRUD 만. 디폴트(규칙 0)=auto(현행 무변).

export interface IngestPolicyRow {
  id: number; enabled: boolean;
  match_category: string | null; match_system: string | null; match_channel: string | null;
  match_provenance: string | null; match_sensitive: string | null;
  match_actor_kind: string | null; match_agent: string | null; match_type: string | null;
  action: string; action_update: string; is_exception: boolean; preset: string | null;
  priority: number; note: string | null; updated_at: string | null;
}
const IPOL_SEL = `id, enabled, match_category, match_system, match_channel, match_provenance, match_sensitive,
  match_actor_kind, match_agent, match_type, action, action_update, is_exception, preset, priority, note, updated_at`;

export async function listIngestPolicies(): Promise<IngestPolicyRow[]> {
  const r = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy ORDER BY priority DESC, id`);
  return r.rows;
}

export interface IngestPolicyUpsertInput {
  id?: number; enabled?: boolean;
  match_category?: string | null; match_system?: string | null; match_channel?: string | null;
  match_provenance?: string | null; match_sensitive?: string | null;
  match_actor_kind?: string | null; match_agent?: string | null; match_type?: string | null;
  action?: string; action_update?: string; is_exception?: boolean; preset?: string | null;
  priority?: number; note?: string | null;
}

// 매치 축 정규화 — 빈 문자열/undefined/null → null(any). axisMatch(ingest-policy.ts) 와 일관되게 '없음'은 항상 null 로 저장.
function normMatch(v: string | null | undefined): string | null {
  if (v === undefined || v === null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// #783 프리셋 규칙(관리탭 스위치가 관리)은 id 없이도 preset 키로 찾아 갱신한다 — 스위치 토글이 중복 행을 만들지 않게.
export async function upsertIngestPolicy(input: IngestPolicyUpsertInput, actor?: string, source?: string): Promise<IngestPolicyRow> {
  const action = input.action ?? "confirm";
  if (!["auto", "confirm", "drop"].includes(action)) throw new Error("action 은 auto|confirm|drop");
  const actionUpdate = input.action_update ?? "auto";
  if (!["auto", "review", "stage", "drop"].includes(actionUpdate)) throw new Error("action_update 는 auto|review|stage|drop");
  const prov = normMatch(input.match_provenance);
  if (prov !== null && !["authored", "observed"].includes(prov)) throw new Error("match_provenance 는 authored|observed 또는 비움");
  const actorKind = normMatch(input.match_actor_kind);
  if (actorKind !== null && !["ai", "human"].includes(actorKind)) throw new Error("match_actor_kind 는 ai|human 또는 비움");
  const vals = {
    enabled: input.enabled ?? true,
    match_category: normMatch(input.match_category),
    match_system: normMatch(input.match_system),
    match_channel: normMatch(input.match_channel),
    match_provenance: prov,
    match_sensitive: normMatch(input.match_sensitive),
    match_actor_kind: actorKind,
    match_agent: normMatch(input.match_agent),
    match_type: normMatch(input.match_type),
    action,
    action_update: actionUpdate,
    is_exception: input.is_exception ?? false,
    preset: normMatch(input.preset),
    priority: Number.isFinite(input.priority) ? Math.trunc(input.priority as number) : 0,
    note: input.note === undefined || input.note === "" ? null : input.note,
  };
  // 대상 행 결정 — id 우선, 없으면 preset 키(스위치 경로).
  let targetId = input.id ?? null;
  if (!targetId && vals.preset) {
    const p = await itemsPool.query(`SELECT id FROM org_ingest_policy WHERE preset=$1`, [vals.preset]);
    targetId = p.rows[0]?.id ?? null;
  }
  if (targetId) {
    const cur = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy WHERE id=$1`, [targetId]);
    const before = cur.rows[0];
    if (!before) throw new Error(`org_ingest_policy #${targetId} 없음`);
    const r = await itemsPool.query(
      `UPDATE org_ingest_policy SET enabled=$2, match_category=$3, match_system=$4, match_channel=$5,
         match_provenance=$6, match_sensitive=$7, action=$8, priority=$9, note=$10,
         match_actor_kind=$12, match_agent=$13, match_type=$14, action_update=$15, is_exception=$16, preset=$17,
         version=version+1, updated_at=now(), updated_by=$11
       WHERE id=$1 RETURNING ${IPOL_SEL}`,
      [targetId, vals.enabled, vals.match_category, vals.match_system, vals.match_channel, vals.match_provenance,
       vals.match_sensitive, vals.action, vals.priority, vals.note, actor ?? null,
       vals.match_actor_kind, vals.match_agent, vals.match_type, vals.action_update, vals.is_exception, vals.preset]);
    await audit("org_ingest_policy", String(targetId), "update", before, r.rows[0], actor, source);
    invalidateIngestPolicyCache();   // 관리탭 저장 즉시 반영(캐시 TTL 대기 없이)
    return r.rows[0];
  }
  const r = await itemsPool.query(
    `INSERT INTO org_ingest_policy(enabled, match_category, match_system, match_channel, match_provenance, match_sensitive,
       action, priority, note, created_by, updated_by, match_actor_kind, match_agent, match_type, action_update, is_exception, preset)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,$12,$13,$14,$15,$16) RETURNING ${IPOL_SEL}`,
    [vals.enabled, vals.match_category, vals.match_system, vals.match_channel, vals.match_provenance, vals.match_sensitive,
     vals.action, vals.priority, vals.note, actor ?? null,
     vals.match_actor_kind, vals.match_agent, vals.match_type, vals.action_update, vals.is_exception, vals.preset]);
  await audit("org_ingest_policy", String(r.rows[0].id), "insert", null, r.rows[0], actor, source);
  invalidateIngestPolicyCache();
  return r.rows[0];
}

export async function removeIngestPolicy(id: number, actor?: string, source?: string): Promise<void> {
  const cur = await itemsPool.query(`SELECT ${IPOL_SEL} FROM org_ingest_policy WHERE id=$1`, [id]);
  if (!cur.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_ingest_policy WHERE id=$1`, [id]);
  await audit("org_ingest_policy", String(id), "delete", cur.rows[0], null, actor, source);
  invalidateIngestPolicyCache();
}

// #656 인입 게이트 관측 — org_content_audit(knowledge insert/set_lifecycle/delete) + pending 카운트를 집계.
//  파일럿 1순위 지표('오너가 어디까지 자동 허용하나')의 데이터화. after/before 스냅샷의 lifecycle 로 auto/pending 판별.
//  · mirror_auto = 커넥터 미러가 즉시 active 로 적재(자동 통과). channel='connector' AND after.lifecycle='active'.
//  · pending_created = 게이트가 검토 큐로 보낸 것(정책 confirm). after.lifecycle='pending' AND 자동경로(connector 또는 ai).
//  · approved/rejected = pending 을 승인(set_lifecycle→active)/반려(delete). before.lifecycle='pending'.
//  · pending_now = 현재 검토 대기(knowledge.lifecycle='pending').
//  #783 추가 축(에이전트 저작 — 게이트의 실제 대상):
//   · agent_auto = 에이전트(MCP)가 쓴 신규 지식이 게이트 없이 즉시 active(=지금 무검증으로 라이브에 박히는 양. 게이트를 켜야 할 이유의 크기).
//   · rev_pending = 검토 대기 '수정' 건수 · rev_approved/rev_rejected = 기간 내 처리량.
export interface IngestObservability {
  days: number; mirror_auto: number; pending_created: number; approved: number; rejected: number; pending_now: number;
  agent_auto: number; rev_pending: number; rev_approved: number; rev_rejected: number;
}
export async function ingestObservability(days = 30): Promise<IngestObservability> {
  const d = Math.max(1, Math.min(365, Math.trunc(Number(days) || 30)));
  const iv = `${d} days`;
  const one = async (sql: string, params: unknown[] = [iv]): Promise<number> =>
    Number((await itemsPool.query(sql, params)).rows[0]?.n ?? 0);
  const zero = async (sql: string, params: unknown[] = [iv]): Promise<number> => {
    try { return await one(sql, params); } catch { return 0; }   // knowledge_revision 미생성(구 DB) → 0
  };
  const [mirror_auto, pending_created, approved, rejected, pending_now, agent_auto, rev_pending, rev_approved, rev_rejected] = await Promise.all([
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='active' AND channel='connector'`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='pending' AND (channel='connector' OR actor_kind='ai')`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='set_lifecycle' AND at >= now() - $1::interval
           AND (before->>'lifecycle')='pending' AND (after->>'lifecycle')='active'`),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='delete' AND at >= now() - $1::interval
           AND (before->>'lifecycle')='pending'`),
    one(`SELECT count(*)::int AS n FROM knowledge WHERE lifecycle='pending'`, []),
    one(`SELECT count(*)::int AS n FROM org_content_audit
         WHERE entity='knowledge' AND op='insert' AND at >= now() - $1::interval
           AND (after->>'lifecycle')='active' AND actor_kind='ai' AND channel='mcp'`),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='pending'`, []),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='approved' AND reviewed_at >= now() - $1::interval`),
    zero(`SELECT count(*)::int AS n FROM knowledge_revision WHERE status='rejected' AND reviewed_at >= now() - $1::interval`),
  ]);
  return { days: d, mirror_auto, pending_created, approved, rejected, pending_now, agent_auto, rev_pending, rev_approved, rev_rejected };
}

// ════════ DB 데이터소스 레지스트리 — org_db_source ════════
// 시크릿 미저장: url 은 비밀번호 없는 접속문자열, 인증은 auth_mode + auth_ref(참조)만. db_query 가 매 호출
//  병합 로드(env∪DB) → upsert/remove 는 무재시작 반영(src/db/sources.ts refreshSources + pool.invalidate).
export interface DbSourceRow {
  name: string;
  driver: string;
  url: string | null;
  auth_mode: "password" | "iam" | "mtls" | "vault";
  auth_ref: string | null;
  rls: string | null;
  max_rows: number | null;
  timeout_ms: number | null;
  note: string | null;
  enabled: boolean;
  table_default: "allow" | "deny"; // 소스별 테이블 기본자세 — allow=deny-list(후방호환) / deny=allow-list(컴플라이언스) (#186)
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

function mapDbSource(row: Record<string, unknown>): DbSourceRow {
  return {
    name: row.name as string,
    driver: (row.driver as string) ?? "postgres",
    url: (row.url as string) ?? null,
    auth_mode: (row.auth_mode as DbSourceRow["auth_mode"]) ?? "password",
    auth_ref: (row.auth_ref as string) ?? null,
    rls: (row.rls as string) ?? null,
    max_rows: typeof row.max_rows === "number" ? row.max_rows : null,
    timeout_ms: typeof row.timeout_ms === "number" ? row.timeout_ms : null,
    note: (row.note as string) ?? null,
    enabled: row.enabled !== false,
    table_default: row.table_default === "deny" ? "deny" : "allow",
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const DBSRC_COLS = "name, driver, url, auth_mode, auth_ref, rls, max_rows, timeout_ms, note, enabled, table_default, sort, version, updated_at, updated_by";

export async function listDbSources(): Promise<DbSourceRow[]> {
  const r = await itemsPool.query(`SELECT ${DBSRC_COLS} FROM org_db_source ORDER BY sort, name`);
  return r.rows.map(mapDbSource);
}

export async function getDbSource(name: string): Promise<DbSourceRow | null> {
  const r = await itemsPool.query(`SELECT ${DBSRC_COLS} FROM org_db_source WHERE name=$1`, [name]);
  return r.rows[0] ? mapDbSource(r.rows[0]) : null;
}

export interface DbSourceInput {
  name: string;
  driver?: string;
  url?: string | null;
  auth_mode?: "password" | "iam" | "mtls" | "vault";
  auth_ref?: string | null;
  rls?: string | null;
  max_rows?: number | null;
  timeout_ms?: number | null;
  note?: string | null;
  enabled?: boolean;
  table_default?: "allow" | "deny";
  sort?: number;
}

export async function upsertDbSource(s: DbSourceInput, actor?: string, source?: string): Promise<DbSourceRow> {
  const before = await getDbSource(s.name);
  // undefined = 미변경(이전값 유지), 명시 null = 클리어(rls 끄기 등) — null 의미를 보존한다.
  const keep = <T>(v: T | null | undefined, prev: T | null | undefined): T | null =>
    v !== undefined ? (v ?? null) : (prev ?? null);
  const driver = s.driver ?? before?.driver ?? "postgres";
  const authMode = s.auth_mode ?? before?.auth_mode ?? "password";
  const enabled = s.enabled ?? before?.enabled ?? true;
  const tableDefault = s.table_default ?? before?.table_default ?? "allow";
  const sort = s.sort ?? before?.sort ?? 0;
  await itemsPool.query(
    `INSERT INTO org_db_source(name, driver, url, auth_mode, auth_ref, rls, max_rows, timeout_ms, note, enabled, table_default, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,now(),$13)
     ON CONFLICT (name) DO UPDATE SET
       driver=EXCLUDED.driver, url=EXCLUDED.url, auth_mode=EXCLUDED.auth_mode, auth_ref=EXCLUDED.auth_ref,
       rls=EXCLUDED.rls, max_rows=EXCLUDED.max_rows, timeout_ms=EXCLUDED.timeout_ms, note=EXCLUDED.note,
       enabled=EXCLUDED.enabled, table_default=EXCLUDED.table_default, sort=EXCLUDED.sort,
       version=org_db_source.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [s.name, driver, keep(s.url, before?.url), authMode, keep(s.auth_ref, before?.auth_ref),
     keep(s.rls, before?.rls), keep(s.max_rows, before?.max_rows), keep(s.timeout_ms, before?.timeout_ms),
     keep(s.note, before?.note), enabled, tableDefault, sort, actor ?? null],
  );
  const after = await getDbSource(s.name);
  await audit("org_db_source", s.name, before ? "update" : "insert", before, after, actor, source);
  return after as DbSourceRow;
}

export async function removeDbSource(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getDbSource(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_db_source WHERE name=$1`, [name]);
  await audit("org_db_source", name, "delete", before, null, actor, source);
}

// ════════ db_query 테이블 정책 · 컬럼 마스킹 (org_db_table_policy · org_db_column_mask) — 웹 관리 (#186) ════════
//  라이브 스키마 위 오버레이(스키마 사본 미저장). db_query 가 매 호출 병합 로드(src/db/policy.ts, TTL 스냅샷) → 무재시작 반영.
export interface DbTablePolicyRow {
  source: string;
  table_name: string;
  mode: "allow" | "deny";
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
}
export interface DbColumnMaskRow {
  source: string;
  table_name: string;
  column_name: string;
  style: "full" | "partial" | "email" | "hash" | "null";
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export async function listTablePolicies(source?: string): Promise<DbTablePolicyRow[]> {
  const r = source
    ? await itemsPool.query(`SELECT source, table_name, mode, note, updated_at, updated_by FROM org_db_table_policy WHERE source=$1 ORDER BY table_name`, [source])
    : await itemsPool.query(`SELECT source, table_name, mode, note, updated_at, updated_by FROM org_db_table_policy ORDER BY source, table_name`);
  return r.rows as DbTablePolicyRow[];
}

export async function upsertTablePolicy(p: { source: string; table_name: string; mode: "allow" | "deny"; note?: string | null }, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_table_policy WHERE source=$1 AND table_name=$2`, [p.source, p.table_name]);
  await itemsPool.query(
    `INSERT INTO org_db_table_policy(source, table_name, mode, note, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,1,now(),$5)
     ON CONFLICT (source, table_name) DO UPDATE SET
       mode=EXCLUDED.mode, note=EXCLUDED.note, version=org_db_table_policy.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [p.source, p.table_name, p.mode, p.note ?? null, actor ?? null],
  );
  await audit("org_db_table_policy", `${p.source}.${p.table_name}`, before.rows[0] ? "update" : "insert", before.rows[0] ?? null, p, actor, "web");
}

export async function removeTablePolicy(source: string, table_name: string, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_table_policy WHERE source=$1 AND table_name=$2`, [source, table_name]);
  if (!before.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_db_table_policy WHERE source=$1 AND table_name=$2`, [source, table_name]);
  await audit("org_db_table_policy", `${source}.${table_name}`, "delete", before.rows[0], null, actor, "web");
}

export async function listColumnMasks(source?: string): Promise<DbColumnMaskRow[]> {
  const r = source
    ? await itemsPool.query(`SELECT source, table_name, column_name, style, note, updated_at, updated_by FROM org_db_column_mask WHERE source=$1 ORDER BY table_name, column_name`, [source])
    : await itemsPool.query(`SELECT source, table_name, column_name, style, note, updated_at, updated_by FROM org_db_column_mask ORDER BY source, table_name, column_name`);
  return r.rows as DbColumnMaskRow[];
}

export async function upsertColumnMask(m: { source: string; table_name: string; column_name: string; style: DbColumnMaskRow["style"]; note?: string | null }, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_column_mask WHERE source=$1 AND table_name=$2 AND column_name=$3`, [m.source, m.table_name, m.column_name]);
  await itemsPool.query(
    `INSERT INTO org_db_column_mask(source, table_name, column_name, style, note, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,1,now(),$6)
     ON CONFLICT (source, table_name, column_name) DO UPDATE SET
       style=EXCLUDED.style, note=EXCLUDED.note, version=org_db_column_mask.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.source, m.table_name, m.column_name, m.style, m.note ?? null, actor ?? null],
  );
  await audit("org_db_column_mask", `${m.source}.${m.table_name}.${m.column_name}`, before.rows[0] ? "update" : "insert", before.rows[0] ?? null, m, actor, "web");
}

export async function removeColumnMask(source: string, table_name: string, column_name: string, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_column_mask WHERE source=$1 AND table_name=$2 AND column_name=$3`, [source, table_name, column_name]);
  if (!before.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_db_column_mask WHERE source=$1 AND table_name=$2 AND column_name=$3`, [source, table_name, column_name]);
  await audit("org_db_column_mask", `${source}.${table_name}.${column_name}`, "delete", before.rows[0], null, actor, "web");
}

// ── org_db_subject_key — db 접근 감사(P5, #746)의 '조회 대상 식별자' 컬럼 지정. 정책 오버레이(FK 없음)라
//    소스 연결 전 사전작성 가능(table_policy/column_mask 와 동일 모델). ⚠ 민감 원값 컬럼 지정 금지(운영 규약).
export interface DbSubjectKeyRow {
  source: string;
  table_name: string;
  column_name: string;
  note: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

export async function listSubjectKeys(source?: string): Promise<DbSubjectKeyRow[]> {
  const r = source
    ? await itemsPool.query(`SELECT source, table_name, column_name, note, updated_at, updated_by FROM org_db_subject_key WHERE source=$1 ORDER BY table_name, column_name`, [source])
    : await itemsPool.query(`SELECT source, table_name, column_name, note, updated_at, updated_by FROM org_db_subject_key ORDER BY source, table_name, column_name`);
  return r.rows as DbSubjectKeyRow[];
}

export async function upsertSubjectKey(k: { source: string; table_name: string; column_name: string; note?: string | null }, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_subject_key WHERE source=$1 AND table_name=$2 AND column_name=$3`, [k.source, k.table_name, k.column_name]);
  await itemsPool.query(
    `INSERT INTO org_db_subject_key(source, table_name, column_name, note, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,1,now(),$5)
     ON CONFLICT (source, table_name, column_name) DO UPDATE SET
       note=EXCLUDED.note, version=org_db_subject_key.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [k.source, k.table_name, k.column_name, k.note ?? null, actor ?? null],
  );
  await audit("org_db_subject_key", `${k.source}.${k.table_name}.${k.column_name}`, before.rows[0] ? "update" : "insert", before.rows[0] ?? null, k, actor, "web");
}

export async function removeSubjectKey(source: string, table_name: string, column_name: string, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_subject_key WHERE source=$1 AND table_name=$2 AND column_name=$3`, [source, table_name, column_name]);
  if (!before.rows[0]) return;
  await itemsPool.query(`DELETE FROM org_db_subject_key WHERE source=$1 AND table_name=$2 AND column_name=$3`, [source, table_name, column_name]);
  await audit("org_db_subject_key", `${source}.${table_name}.${column_name}`, "delete", before.rows[0], null, actor, "web");
}

// ── org_db_unmask_grant — raw-PII 언마스크 권한(P4, #746). 직무 RBAC + JIT + maker-checker. ──
export interface DbUnmaskGrantRow {
  id: string;
  member_id: string;
  source: string;
  table_name: string;
  column_name: string; // '*' = 테이블 내 전체 마스킹 컬럼
  reason: string | null;
  approved_by: string | null;
  granted_by: string | null;
  expires_at: string | null;
  created_at: string;
  revoked_at: string | null;
  revoked_by: string | null;
}

// 유효(활성) grant 만 — 특정 멤버·소스. db_query 언마스크 해소(policy.ts)가 쓴다. revoke·만료 즉시 반영.
export async function listActiveUnmaskGrants(memberId: string, source: string): Promise<DbUnmaskGrantRow[]> {
  const r = await itemsPool.query(
    `SELECT id, member_id, source, table_name, column_name, reason, approved_by, granted_by,
            expires_at, created_at, revoked_at, revoked_by
       FROM org_db_unmask_grant
      WHERE member_id=$1 AND source=$2 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())
      ORDER BY table_name, column_name`,
    [memberId, source],
  );
  return r.rows as DbUnmaskGrantRow[];
}

// 관리 목록 — 필터(멤버·소스·활성만). 관리탭/감사가 쓴다.
export async function listUnmaskGrants(opts?: { memberId?: string; source?: string; activeOnly?: boolean }): Promise<DbUnmaskGrantRow[]> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (opts?.memberId) { params.push(opts.memberId); conds.push(`member_id=$${params.length}`); }
  if (opts?.source) { params.push(opts.source); conds.push(`source=$${params.length}`); }
  if (opts?.activeOnly) conds.push(`revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`);
  const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
  const r = await itemsPool.query(
    `SELECT id, member_id, source, table_name, column_name, reason, approved_by, granted_by,
            expires_at, created_at, revoked_at, revoked_by
       FROM org_db_unmask_grant ${where} ORDER BY created_at DESC`,
    params,
  );
  return r.rows as DbUnmaskGrantRow[];
}

export async function createUnmaskGrant(g: {
  member_id: string; source: string; table_name: string; column_name?: string;
  reason?: string | null; approved_by?: string | null; expires_at?: string | null;
}, actor?: string): Promise<DbUnmaskGrantRow> {
  const r = await itemsPool.query(
    `INSERT INTO org_db_unmask_grant(member_id, source, table_name, column_name, reason, approved_by, granted_by, expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [g.member_id, g.source, g.table_name.toLowerCase(), (g.column_name ?? "*").toLowerCase(),
     g.reason ?? null, g.approved_by ?? null, actor ?? null, g.expires_at ?? null],
  );
  const row = r.rows[0] as DbUnmaskGrantRow;
  await audit("org_db_unmask_grant", String(row.id), "insert", null, row, actor, "web");
  return row;
}

export async function revokeUnmaskGrant(id: string, actor?: string): Promise<void> {
  const before = await itemsPool.query(`SELECT * FROM org_db_unmask_grant WHERE id=$1`, [id]);
  if (!before.rows[0]) throw new Error(`언마스크 grant 없음: ${id}`);
  if ((before.rows[0] as DbUnmaskGrantRow).revoked_at) return; // 멱등
  await itemsPool.query(`UPDATE org_db_unmask_grant SET revoked_at=now(), revoked_by=$2 WHERE id=$1`, [id, actor ?? null]);
  const after = await itemsPool.query(`SELECT * FROM org_db_unmask_grant WHERE id=$1`, [id]);
  await audit("org_db_unmask_grant", String(id), "update", before.rows[0], after.rows[0], actor, "web");
}

// ════════ 커스텀 훅 — org_hook ════════
export type HookHarness = "claude" | "codex" | "openclaw" | "all";
export interface OrgHook {
  id: string;
  label: string | null;
  harness: HookHarness;
  event: string;
  matcher: string | null;
  source_code: string;
  timeout_sec: number;
  note: string | null;
  target_members: string[] | null; // #699: NULL/빈=전원, 배열=그 멤버만(org_harness_asset 와 대칭)
  enabled: boolean;
  sort: number;
  version: number;
  content_hash: string | null;
  health: Record<string, OrgHookHealth>; // #892: member_id → 마지막 실패. 정상이면 {} (실패 시에만 기록)
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

// 훅 실행 실패 1건(멤버 러너 보고, #892). 성공은 기록하지 않는다 — '조용한 죽음'만 드러내면 된다.
export interface OrgHookHealth {
  at: string;               // ISO
  reason: string;           // crash | timeout | hash_mismatch | spawn_error
  exit_code: number | null;
  stderr: string;           // 꼬리 일부(진단용)
}

function mapHook(row: Record<string, unknown>): OrgHook {
  const tm = row.target_members;
  return {
    id: row.id as string,
    label: (row.label as string) ?? null,
    harness: row.harness as HookHarness,
    event: row.event as string,
    matcher: (row.matcher as string) ?? null,
    source_code: (row.source_code as string) ?? "",
    timeout_sec: (row.timeout_sec as number) ?? 10,
    note: (row.note as string) ?? null,
    target_members: Array.isArray(tm) ? (tm as string[]) : null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    content_hash: (row.content_hash as string) ?? null,
    health: (row.health && typeof row.health === "object" && !Array.isArray(row.health))
      ? (row.health as Record<string, OrgHookHealth>) : {},
    created_by: (row.created_by as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const HOOK_COLS = "id, label, harness, event, matcher, source_code, timeout_sec, note, target_members, enabled, sort, version, content_hash, health, created_by, updated_at, updated_by";
const HOOK_COLS_Q = HOOK_COLS.split(", ").map((c) => "h." + c).join(", "); // JOIN 용 정규화(updated_at/updated_by 모호성 회피, #699)

export async function listOrgHooks(): Promise<OrgHook[]> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook ORDER BY sort, id`);
  return r.rows.map(mapHook);
}

// 런너 fetch 용 — enabled 훅만. harness 지정 시 그 하네스 또는 'all' 만. memberId 지정 시 per-member 유효성
//  적용(#699): 개인 오버라이드(org_asset_pref) 있으면 그 state, 없으면 target_members(NULL/빈=전원). enabled=false=마스터킬.
export async function listEnabledHooks(harness?: string, memberId?: string | null): Promise<OrgHook[]> {
  const r = await itemsPool.query(
    `SELECT ${HOOK_COLS_Q} FROM org_hook h
       LEFT JOIN org_asset_pref p ON p.target_kind='org_hook' AND p.ref_id=h.id AND p.member_id=$2
      WHERE h.enabled=true
        AND ($1::text IS NULL OR h.harness=$1 OR h.harness='all')
        AND (CASE WHEN p.member_id IS NOT NULL THEN p.state
                  ELSE (h.target_members IS NULL OR jsonb_array_length(h.target_members)=0
                        OR ($2::text IS NOT NULL AND h.target_members @> to_jsonb($2::text))) END)
      ORDER BY h.sort, h.id`,
    [harness ?? null, memberId ?? null],
  );
  return r.rows.map(mapHook);
}

export async function getOrgHook(id: string): Promise<OrgHook | null> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook WHERE id=$1`, [id]);
  return r.rows[0] ? mapHook(r.rows[0]) : null;
}

// 멤버 러너가 보고한 훅 실행 실패를 health 에 기록(#892). 멤버당 마지막 1건만 — 멤버 수로 유계라 정리 불요.
//  audit 은 남기지 않는다: 설정 변경이 아니라 런타임 텔레메트리이고, 크래시마다 감사로그를 채우면 노이즈다.
//  존재하지 않는 hook_id 는 UPDATE 가 0행으로 조용히 무시한다(멤버가 임의 키를 심을 수 없다).
export async function recordHookFailures(
  memberId: string,
  failures: { hook_id: string; reason: string; exit_code?: number | null; stderr?: string }[],
): Promise<void> {
  for (const f of failures) {
    const entry: OrgHookHealth = {
      at: new Date().toISOString(),
      reason: f.reason,
      exit_code: f.exit_code ?? null,
      stderr: (f.stderr ?? "").slice(-800),
    };
    await itemsPool.query(
      `UPDATE org_hook SET health = jsonb_set(COALESCE(health,'{}'::jsonb), ARRAY[$2::text], $3::jsonb, true) WHERE id=$1`,
      [f.hook_id, memberId, JSON.stringify(entry)],
    );
  }
}

export interface OrgHookInput {
  id: string;
  label?: string | null;
  harness?: HookHarness;
  event?: string;
  matcher?: string | null;
  source_code?: string;
  timeout_sec?: number;
  note?: string | null;
  target_members?: string[] | null; // #699: undefined=보존, null/빈=전원, 배열=지정
  enabled?: boolean;
  sort?: number;
}

export async function upsertOrgHook(h: OrgHookInput, ctx: WriteCtx = {}): Promise<OrgHook> {
  const before = await getOrgHook(h.id);
  const harness = h.harness ?? before?.harness ?? "all";
  const event = h.event ?? before?.event;
  if (!event) throw new Error("event 필수"); // delivery 가 먼저 검증하지만 store 계층 방어
  const sourceCode = h.source_code ?? before?.source_code ?? "";
  const contentHash = sha256(sourceCode);
  const targetMembers = h.target_members === undefined ? (before?.target_members ?? null) : h.target_members;
  // matcher — target_members 와 동형(#970): null 은 '전체 매칭'이라는 의미 있는 값이라 `?? before`(nullish 보존)로는
  //  '명시적 전체매칭'과 '미지정'을 못 가른다. undefined(미지정)만 보존, null/문자열은 그 값을 그대로 쓴다.
  const matcher = h.matcher === undefined ? (before?.matcher ?? null) : h.matcher;
  await itemsPool.query(
    `INSERT INTO org_hook(id,label,harness,event,matcher,source_code,timeout_sec,note,target_members,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$14,$9,$10,1,$11,$12,now(),$13)
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label, harness=EXCLUDED.harness, event=EXCLUDED.event, matcher=EXCLUDED.matcher,
       source_code=EXCLUDED.source_code, timeout_sec=EXCLUDED.timeout_sec, note=EXCLUDED.note,
       target_members=EXCLUDED.target_members, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort, content_hash=EXCLUDED.content_hash,
       -- 본문이 바뀌면 건강 기록을 비운다(#892): 옛 본문의 실패는 새 본문과 무관한데, 안 지우면 고친 뒤에도
       -- '⚠ 실패' 배지가 영영 남아 지표를 못 믿게 된다(경보 피로). 본문이 그대로면(토글·라벨만 수정) 유지.
       health=CASE WHEN org_hook.content_hash IS DISTINCT FROM EXCLUDED.content_hash THEN '{}'::jsonb ELSE org_hook.health END,
       version=org_hook.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [h.id, h.label ?? before?.label ?? null, harness, event, matcher,
     sourceCode, h.timeout_sec ?? before?.timeout_sec ?? 10, h.note ?? before?.note ?? null,
     h.enabled ?? before?.enabled ?? true, h.sort ?? before?.sort ?? 0, contentHash,
     before?.created_by ?? ctx.actor ?? null, ctx.actor ?? null,
     targetMembers === null ? null : JSON.stringify(targetMembers)],
  );
  const after = await getOrgHook(h.id);
  await audit("org_hook", h.id, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgHook;
}

export async function removeOrgHook(id: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getOrgHook(id);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_hook WHERE id=$1`, [id]);
  await audit("org_hook", id, "delete", before, null, ctx.actor, ctx.source, ctx);
}

// ════════ 조직 정의 MCP 툴 — org_tool ════════
export type ToolKind = "http_proxy" | "builtin" | "prompt";
export interface OrgTool {
  name: string;
  kind: ToolKind;
  enabled: boolean;
  title: string | null;
  description: string;
  scope: string | null;
  input_schema: unknown;
  method: string | null;
  url: string | null;
  auth_env: string | null;
  auto_approve: boolean;
  always_load: boolean | null; // 주입모드 override(#187): null=코드기본, true=항상 주입, false=deferred. Claude Code _meta(anthropic/alwaysLoad)로 변환.
  level: "L0" | "L1" | "L2" | null; // 권한 등급(P2 #746): L0 조회 / L1 제안 / L2 집행. L2 는 auto-approve 강제 제외. null=코드기본(L0).
  auth_kind: string | null; // P1(#746): 설정 시 http_proxy 가 member_secret(호출자 개인 자격 우선)로 인증. null=auth_env(조직 공용) 사용.
  auth_scope_key: string | null; // vault 조회 scope_key(예 host)
  pii_scrub: boolean; // P3(#746): true 면 응답 본문(문자열)에 scrubPii(비정형 PII 마스킹)
  note: string | null;
  sort: number;
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const DEFAULT_INPUT_SCHEMA = { type: "object", properties: {}, additionalProperties: false };

function mapTool(row: Record<string, unknown>): OrgTool {
  return {
    name: row.name as string,
    kind: row.kind as ToolKind,
    enabled: row.enabled !== false,
    title: (row.title as string) ?? null,
    description: (row.description as string) ?? "",
    scope: (row.scope as string) ?? null,
    input_schema: row.input_schema ?? DEFAULT_INPUT_SCHEMA,
    method: (row.method as string) ?? null,
    url: (row.url as string) ?? null,
    auth_env: (row.auth_env as string) ?? null,
    auto_approve: row.auto_approve === true,
    always_load: row.always_load == null ? null : row.always_load === true,
    level: (row.level as "L0" | "L1" | "L2" | null) ?? null,
    auth_kind: (row.auth_kind as string) ?? null,
    auth_scope_key: (row.auth_scope_key as string) ?? null,
    pii_scrub: row.pii_scrub === true,
    note: (row.note as string) ?? null,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const TOOL_COLS = "name, kind, enabled, title, description, scope, input_schema, method, url, auth_env, auto_approve, always_load, level, auth_kind, auth_scope_key, pii_scrub, note, sort, version, updated_at, updated_by";

export async function listTools(): Promise<OrgTool[]> {
  const r = await itemsPool.query(`SELECT ${TOOL_COLS} FROM org_tool ORDER BY sort, name`);
  return r.rows.map(mapTool);
}

// /mcp 동적 등록용 — enabled 인 http_proxy 툴만.
export async function listEnabledProxyTools(): Promise<OrgTool[]> {
  const r = await itemsPool.query(
    `SELECT ${TOOL_COLS} FROM org_tool WHERE enabled=true AND kind='http_proxy' ORDER BY sort, name`);
  return r.rows.map(mapTool);
}

// (A) 빌트인 게이팅 — 비활성화된 빌트인 툴 이름 집합(buildServer 가 등록 제외).
export async function listDisabledBuiltins(): Promise<Set<string>> {
  const r = await itemsPool.query(`SELECT name FROM org_tool WHERE kind='builtin' AND enabled=false`);
  return new Set(r.rows.map((row) => (row as { name: string }).name));
}

// (A') 빌트인 노출 override — kind='builtin' 행 전체(name→enabled). 운영자가 웹에서 설정한 양방향 재정의.
//  행이 있으면 그 enabled 가 코드 기본값(expose.mcp)을 덮어쓴다(미노출→켜기, 노출→끄기 둘 다). 행 없으면 기본값 유지.
export async function listBuiltinOverrides(): Promise<Map<string, boolean>> {
  const r = await itemsPool.query(`SELECT name, enabled FROM org_tool WHERE kind='builtin'`);
  return new Map(r.rows.map((row) => {
    const rr = row as { name: string; enabled: boolean };
    return [rr.name, rr.enabled !== false] as [string, boolean];
  }));
}

// (A'') 빌트인 주입모드 override — kind='builtin' 행 중 always_load 가 명시(NOT NULL)된 것만(name→bool). #187.
//  null(미설정)은 코드 기본값(cap.meta 의 anthropic/alwaysLoad)을 그대로 두므로 여기 담지 않는다(map.has 로 override 유무 판정).
//  resolveToolMeta 가 이 map 으로 Claude Code _meta(anthropic/alwaysLoad)를 하네스별 emit/생략한다.
export async function listBuiltinAlwaysLoad(): Promise<Map<string, boolean>> {
  const r = await itemsPool.query(`SELECT name, always_load FROM org_tool WHERE kind='builtin' AND always_load IS NOT NULL`);
  return new Map(r.rows.map((row) => {
    const rr = row as { name: string; always_load: boolean };
    return [rr.name, rr.always_load === true] as [string, boolean];
  }));
}

// 설치 번들용 — auto_approve 가 켜진(그리고 enabled) 툴 이름. 멤버 settings 의 무확인 실행 허용목록에 들어간다.
export async function listAutoApproveTools(): Promise<{ name: string; kind: ToolKind }[]> {
  const r = await itemsPool.query(
    // P2(#746): L2(집행) 툴은 auto_approve 가 켜져 있어도 무확인 실행 목록에서 강제 제외 — 하네스 인터랙티브 컨펌 강제.
    `SELECT name, kind FROM org_tool WHERE auto_approve=true AND enabled=true AND (level IS NULL OR level <> 'L2') ORDER BY name`);
  return r.rows.map((row) => ({ name: (row as { name: string }).name, kind: (row as { kind: ToolKind }).kind }));
}

export async function getTool(name: string): Promise<OrgTool | null> {
  const r = await itemsPool.query(`SELECT ${TOOL_COLS} FROM org_tool WHERE name=$1`, [name]);
  return r.rows[0] ? mapTool(r.rows[0]) : null;
}

export interface OrgToolInput {
  name: string;
  kind?: ToolKind;
  enabled?: boolean;
  title?: string | null;
  description?: string;
  scope?: string | null;
  input_schema?: unknown;
  method?: string | null;
  url?: string | null;
  auth_env?: string | null;
  auto_approve?: boolean;
  always_load?: boolean | null; // #187 주입모드: undefined=유지, null=코드기본 복귀, true=항상, false=deferred.
  level?: "L0" | "L1" | "L2" | null; // P2(#746) 등급: undefined=유지, null=코드기본, L0/L1/L2 명시.
  auth_kind?: string | null; // P1(#746) vault 인증 kind: undefined=유지, null/""=env 사용, 값=member_secret 해소.
  auth_scope_key?: string | null;
  pii_scrub?: boolean; // P3(#746) 응답 PII 마스킹
  note?: string | null;
  sort?: number;
}

export async function upsertTool(t: OrgToolInput, ctx: WriteCtx = {}): Promise<OrgTool> {
  const before = await getTool(t.name);
  const kind = t.kind ?? before?.kind ?? "http_proxy";
  const isProxy = kind === "http_proxy";
  // http_proxy 가 아닌 행(빌트인 게이팅)은 url/method/auth_env/scope/input_schema 를 비운다(잔류 방지).
  const url = isProxy ? (t.url ?? before?.url ?? null) : null;
  const method = isProxy ? (t.method ?? before?.method ?? null) : null;
  const scope = isProxy ? (t.scope ?? before?.scope ?? null) : null;
  const inputSchema = isProxy ? (t.input_schema ?? before?.input_schema ?? DEFAULT_INPUT_SCHEMA) : DEFAULT_INPUT_SCHEMA;
  // 주입모드(#187): undefined=기존 유지, null=코드기본 복귀, true/false=명시. ??-병합은 null 을 흘려보내므로 직접 분기.
  const alwaysLoad = t.always_load !== undefined ? t.always_load : (before?.always_load ?? null);
  const level = t.level !== undefined ? t.level : (before?.level ?? null);
  // 커넥터 자격/마스킹(P1·P3 #746) — http_proxy 에만 유효(빌트인 게이팅 행은 비움). null/"" 이면 env 인증(기존).
  const authKind = isProxy ? (t.auth_kind !== undefined ? (t.auth_kind || null) : (before?.auth_kind ?? null)) : null;
  // 배타(리뷰 blocking①): authKind 가 있으면 authEnv 는 강제 null — 저장된 stale auth_env 잔류/이중 인증출처 방지(?? 병합의 함정).
  const authEnv = isProxy ? (authKind ? null : (t.auth_env ?? before?.auth_env ?? null)) : null;
  const authScopeKey = isProxy ? (t.auth_scope_key !== undefined ? (t.auth_scope_key || null) : (before?.auth_scope_key ?? null)) : null;
  const piiScrub = isProxy ? (t.pii_scrub !== undefined ? !!t.pii_scrub : (before?.pii_scrub ?? false)) : false;
  await itemsPool.query(
    `INSERT INTO org_tool(name,kind,enabled,title,description,scope,input_schema,method,url,auth_env,auto_approve,always_load,level,auth_kind,auth_scope_key,pii_scrub,note,sort,version,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,1,now(),$19)
     ON CONFLICT (name) DO UPDATE SET
       kind=EXCLUDED.kind, enabled=EXCLUDED.enabled, title=EXCLUDED.title, description=EXCLUDED.description,
       scope=EXCLUDED.scope, input_schema=EXCLUDED.input_schema, method=EXCLUDED.method, url=EXCLUDED.url,
       auth_env=EXCLUDED.auth_env, auto_approve=EXCLUDED.auto_approve, always_load=EXCLUDED.always_load, level=EXCLUDED.level,
       auth_kind=EXCLUDED.auth_kind, auth_scope_key=EXCLUDED.auth_scope_key, pii_scrub=EXCLUDED.pii_scrub, note=EXCLUDED.note, sort=EXCLUDED.sort,
       version=org_tool.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [t.name, kind, t.enabled ?? before?.enabled ?? true, t.title ?? before?.title ?? null,
     t.description ?? before?.description ?? "", scope, JSON.stringify(inputSchema), method, url, authEnv,
     t.auto_approve ?? before?.auto_approve ?? false, alwaysLoad, level, authKind, authScopeKey, piiScrub,
     t.note ?? before?.note ?? null, t.sort ?? before?.sort ?? 0, ctx.actor ?? null],
  );
  const after = await getTool(t.name);
  await audit("org_tool", t.name, before ? "update" : "insert", before, after, ctx.actor, ctx.source, ctx);
  return after as OrgTool;
}

export async function removeTool(name: string, ctx: WriteCtx = {}): Promise<void> {
  const before = await getTool(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_tool WHERE name=$1`, [name]);
  await audit("org_tool", name, "delete", before, null, ctx.actor, ctx.source, ctx);
}

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
  "id, kind, label, harness, description, body, frontmatter, target_members, paired_hook_id, enabled, sort, version, content_hash, created_by, updated_at, updated_by";
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
  const body = a.body ?? before?.body ?? "";
  const frontmatter = a.frontmatter ?? before?.frontmatter ?? {};
  const targetMembers = a.target_members === undefined ? (before?.target_members ?? null) : a.target_members;
  const contentHash = assetContentHash({ kind, harness, description, body, frontmatter });
  await itemsPool.query(
    `INSERT INTO org_harness_asset(id,kind,label,harness,description,body,frontmatter,target_members,paired_hook_id,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9,$10,$11,1,$12,$13,now(),$14)
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, label=EXCLUDED.label, harness=EXCLUDED.harness, description=EXCLUDED.description,
       body=EXCLUDED.body, frontmatter=EXCLUDED.frontmatter, target_members=EXCLUDED.target_members,
       paired_hook_id=EXCLUDED.paired_hook_id, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       content_hash=EXCLUDED.content_hash, version=org_harness_asset.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [a.id, kind, a.label ?? before?.label ?? null, harness, description, body,
     JSON.stringify(frontmatter), targetMembers === null ? null : JSON.stringify(targetMembers),
     a.paired_hook_id === undefined ? (before?.paired_hook_id ?? null) : a.paired_hook_id,
     a.enabled ?? before?.enabled ?? true, a.sort ?? before?.sort ?? 0, contentHash,
     before?.created_by ?? ctx.actor ?? null, ctx.actor ?? null],
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


// ── 프로젝트 타임라인 — 이 프로젝트 팀원들이 한 작업(activity). authorPerson 지정 시 그 사람만. ──
//  activity 는 itemsPool 동일 DB(지식참조=activity_knowledge→knowledge FK). project_member.member_id ↔ activity.author_person 조인.
export interface ProjectActivity {
  id: number; type: string; title: string | null; summary: string | null; body: string | null;
  author_person: string | null; author_agent: string | null;
  commit_sha: string | null; committed_at: string | null; created_at: string | null;
  should_review: string | null; is_review: string | null; repo: string | null;
  external_system: string | null; external_url: string | null;
  refs: { name: string; title: string | null; relation: string }[];
  touchCount: number;
}
export async function listProjectActivities(
  projectId: number, authorPerson?: string, limit = 100, offset = 0,
): Promise<ProjectActivity[]> {
  const params: unknown[] = [projectId];
  let personFilter = "";
  if (authorPerson) { params.push(authorPerson); personFilter = ` AND a.author_person = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 200)); const limP = `$${params.length}`;
  params.push(Math.min(Math.max(Number(offset) || 0, 0), 1_000_000)); const offP = `$${params.length}`;   // #709 offset — 최신 N건 너머 과거 타임라인
  // 이 프로젝트에 연결된 작업 — 둘 중 하나면 포함:
  //  ① activity.project_id 가 이 프로젝트(명시적 링크 — activity_log 가 직접 박는 가장 권위 있는 신호), 또는
  //  ② activity.session_id 가 이 프로젝트의 세션 **구간**에 드는 것(세션 추론, 시간구간): 작업 발생시각이 이 프로젝트
  //     구간 [valid_from, 다음 구간) 안이면 귀속. 세션이 나중에 재바인딩돼도 과거 작업은 옛 프로젝트 구간에 남는다(#905 C1).
  //     단 **명시 project_id 가 있는 작업은 세션추론에서 제외**(명시가 권위) — 안 그러면 A 세션에서 B 로 명시 기록한
  //     작업이 A·B 양쪽에 이중 귀속된다. 세션추론은 project_id 가 비어 귀속처가 없는 작업의 폴백일 뿐.
  //  (예전엔 author_person 조인으로 팀원이 한 모든 작업을 보여줘서 프로젝트 밖 작업까지 섞였음 → 그 폭넓은 조인은 유지하지 않는다.
  //   project_id=이 프로젝트는 정의상 이 프로젝트 작업이라 session_id 가 없어도 표시되어야 한다 — MCP activity_log 로 직접 기록한 작업 포함.)
  const r = await itemsPool.query(
    `SELECT a.id, a.type, a.title, a.summary, a.body, a.author_person, a.author_agent,
            a.commit_sha, a.committed_at, a.created_at, a.should_review, a.is_review,
            a.external_system, a.external_url, rp.name AS repo
       FROM activity a
       LEFT JOIN repo rp ON rp.id = a.repo_id
      WHERE (a.project_id = $1
             OR (a.project_id IS NULL AND EXISTS (
                  SELECT 1 FROM session_project sp
                   WHERE sp.session_id = a.session_id
                     AND sp.project_id = $1
                     AND sp.valid_from <= COALESCE(a.committed_at, a.created_at, now())
                     AND COALESCE(a.committed_at, a.created_at, now()) < COALESCE(
                           (SELECT MIN(sp2.valid_from) FROM session_project sp2
                             WHERE sp2.session_id = sp.session_id AND sp2.valid_from > sp.valid_from),
                           'infinity'::timestamptz))))
      ${personFilter}
      ORDER BY COALESCE(a.committed_at, a.created_at) DESC
      LIMIT ${limP} OFFSET ${offP}`,
    params,
  );
  const rows = r.rows as ProjectActivity[];
  if (!rows.length) return rows;
  // 펼침 연결(산출/참조 지식 + 코드 touch 수)을 곁들인다 — 회사 타임라인(listActivities)과 같은 프로젝션이어야
  // 공용 렌더러(web activityTimelineRow)가 프로젝트 상세에서도 본문·참조를 그린다. tasks 는 이 프로젝트 자신이라 생략.
  const ids = rows.map((row) => row.id);
  const [refRes, touchRes] = await Promise.all([
    itemsPool.query(
      `SELECT ak.activity_id, ak.name, ak.relation, k.title
         FROM activity_knowledge ak LEFT JOIN knowledge k ON k.name = ak.name
        WHERE ak.activity_id = ANY($1) ORDER BY ak.created_at`, [ids]),
    itemsPool.query(
      `SELECT activity_id, COUNT(*)::int AS n FROM activity_touch
        WHERE activity_id = ANY($1) GROUP BY activity_id`, [ids]),
  ]);
  const byId = new Map<number, ProjectActivity>();
  for (const row of rows) { row.refs = []; row.touchCount = 0; byId.set(row.id, row); }
  for (const rf of refRes.rows) byId.get(rf.activity_id)?.refs.push({ name: rf.name, title: rf.title, relation: rf.relation });
  for (const t of touchRes.rows) { const row = byId.get(t.activity_id); if (row) row.touchCount = t.n; }
  return rows;
}

