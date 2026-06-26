// org-content 읽기/쓰기 — 전달 서브시스템의 진실원천 접근 계층.
// 모든 쓰기는 org_content_audit 에 before/after 를 남기고 version 을 올린다(낙관적 잠금 토대).
// 멤버 쓰기는 person/person_identity 로도 동기화 → 비개발자의 UI 편집이 즉시 게이트웨이 신원 매칭에 반영.
import crypto from "node:crypto";
import { itemsPool } from "../items/store.js";
import { isScope } from "../capabilities/scopes.js";
import { redactDeep } from "./redact.js";
// WIKI 인덱스(팀 메모리)·섹션 모두 v6 knowledge 사용(knowledge_unit 컷오버 완료 2026-06-24).
import {
  getKnowledge as getK6, listKnowledge as listK6,
  upsertKnowledge as upsertK6, deleteKnowledge as deleteK6,
  type KnowledgeRow,
} from "../v6/knowledge-store.js";
// 임베딩(벡터검색 #172) config seam — embedding_config 정규화/병합(env 시드 + DB 우선). 무순환(provider 모듈은 store 미import).
import { type EmbeddingConfig, resolveEmbeddingConfig, normalizeEmbeddingConfig } from "../v6/embedding-provider.js";

// 쓰기 호출 맥락 — 감사 보강(누가/어느 토큰/어디서). delivery 핸들러가 web.ts 의 ctx 에서 구성해 전달.
export interface WriteCtx { actor?: string; source?: string; tokenHashPrefix?: string | null; ip?: string | null }

export interface OrgProfile {
  name: string | null;
  display_name: string | null;
  gateway_url: string | null;
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
  email: string | null;
  identities: MemberIdentity[];
  body_md: string;
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
  updated_at: string | null;
  updated_by: string | null;
}

const sha256 = (s: string): string => crypto.createHash("sha256").update(s).digest("hex");

// ── 감사 (append-only) ──
async function audit(
  entity: string,
  key: string | null,
  op: string,
  before: unknown,
  after: unknown,
  actor: string | undefined,
  source: string | undefined,
  meta?: { tokenHashPrefix?: string | null; ip?: string | null },
): Promise<void> {
  // B20: before/after 를 굳히기 전 시크릿 redaction — 감사 로그가 평문 토큰/키의 사본이 되지 않게.
  const b = before == null ? null : JSON.stringify(redactDeep(before));
  const a = after == null ? null : JSON.stringify(redactDeep(after));
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source, token_hash_prefix, req_ip)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8,$9)`,
    [entity, key, op, b, a, actor ?? null, source ?? null,
     meta?.tokenHashPrefix ?? null, meta?.ip ?? null],
  );
}

// ── org_profile ──
export async function getOrgProfile(): Promise<OrgProfile> {
  const r = await itemsPool.query(
    `SELECT name, display_name, gateway_url, version, updated_at, updated_by FROM org_profile WHERE id=1`,
  );
  return (r.rows[0] as OrgProfile) ?? {
    name: null, display_name: null, gateway_url: null, version: 1, updated_at: null, updated_by: null,
  };
}

export async function updateOrgProfile(
  patch: Partial<Pick<OrgProfile, "name" | "display_name" | "gateway_url">>,
  actor?: string,
  source?: string,
): Promise<OrgProfile> {
  const before = await getOrgProfile();
  await itemsPool.query(
    `UPDATE org_profile SET
       name = COALESCE($1, name),
       display_name = COALESCE($2, display_name),
       gateway_url = COALESCE($3, gateway_url),
       version = version + 1,
       updated_at = now(),
       updated_by = $4
     WHERE id=1`,
    [patch.name ?? null, patch.display_name ?? null, patch.gateway_url ?? null, actor ?? null],
  );
  const after = await getOrgProfile();
  await audit("org_profile", "1", "update", before, after, actor, source);
  return after;
}

// ── org 섹션(규칙·페르소나 markdown) — v6 knowledge 테이블 injection='always' 위 얇은 래퍼(캐노니컬 단일진실). ──
//  매핑: section ↔ name(=section), injection='always'. 섹션은 분류대상이 아니라 category 없이 존재(주입 설정 — managed-policy/org-defaults/가이드).
//  v6 컷오버(2026-06-24): 구 knowledge_unit kind='R' → knowledge injection='always'. 반환 shape(OrgSection) 불변(소비자 무수정).
//  v6 upsertKnowledge 는 신규에 category 필수라 섹션엔 부적합 → 직접 SQL(injection='always', 분류 없음).
const SECTION_COLS = "name, body_md, version, updated_at, updated_by";
function rowToSection(r: Record<string, unknown>): OrgSection {
  return {
    section: r.name as string, body_md: (r.body_md as string) ?? "",
    version: (r.version as number) ?? 1, updated_at: (r.updated_at as string) ?? null, updated_by: (r.updated_by as string) ?? null,
  };
}

export async function getSection(section: string): Promise<OrgSection | null> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE name=$1 AND injection='always' AND lifecycle='active'`, [section]);
  return r.rows[0] ? rowToSection(r.rows[0]) : null;
}

export async function listSections(): Promise<OrgSection[]> {
  const r = await itemsPool.query(
    `SELECT ${SECTION_COLS} FROM knowledge WHERE injection='always' AND lifecycle='active' ORDER BY name`);
  return r.rows.map(rowToSection);
}

export async function updateSection(
  section: string,
  body_md: string,
  actor?: string,
  source?: string,
): Promise<OrgSection> {
  const before = await getSection(section);
  // 섹션 upsert — injection='always' 고정, 분류 없음. version 증가·감사(org_content_audit, channel 미설정).
  await itemsPool.query(
    `INSERT INTO knowledge(name, body_md, injection, provenance, lifecycle, confidence, source, version, updated_at, updated_by)
     VALUES($1,$2,'always','authored','active',$3,$4,1,now(),$5)
     ON CONFLICT (name) DO UPDATE SET
       body_md=EXCLUDED.body_md, injection='always', lifecycle='active',
       version=knowledge.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [section, body_md, source === "mcp" ? "ai" : "human", source ?? "web", actor ?? null]);
  const after = await getSection(section);
  await audit("org_section", section, before ? "update" : "insert", before, after, actor, source);
  return after!;
}

// ── org_member ──
function mapMember(row: Record<string, unknown>): OrgMember {
  return {
    id: row.id as string,
    kind: row.kind as OrgMember["kind"],
    display_name: (row.display_name as string) ?? null,
    email: (row.email as string) ?? null,
    identities: (row.identities as MemberIdentity[]) ?? [],
    body_md: (row.body_md as string) ?? "",
    state: row.state as OrgMember["state"],
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const MEMBER_COLS = "id, kind, display_name, email, identities, body_md, state, scopes, sort, version, updated_at, updated_by";

export async function listMembers(): Promise<OrgMember[]> {
  const r = await itemsPool.query(`SELECT ${MEMBER_COLS} FROM org_member ORDER BY sort, id`);
  return r.rows.map(mapMember);
}

export async function getMember(id: string): Promise<OrgMember | null> {
  const r = await itemsPool.query(`SELECT ${MEMBER_COLS} FROM org_member WHERE id=$1`, [id]);
  return r.rows[0] ? mapMember(r.rows[0]) : null;
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
  email?: string | null;
  identities?: MemberIdentity[];
  body_md?: string;
  state?: "active" | "inactive";
  scopes?: string[];
  sort?: number;
}

export async function upsertMember(m: MemberInput, actor?: string, source?: string): Promise<OrgMember> {
  const before = await getMember(m.id);
  const kind = m.kind ?? before?.kind ?? "human";
  const identities = m.identities ?? before?.identities ?? [];
  const scopes = m.scopes ?? before?.scopes ?? ["items", "context", "memory"];
  await itemsPool.query(
    `INSERT INTO org_member(id, kind, display_name, email, identities, body_md, state, scopes, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8::jsonb,$9,1,now(),$10)
     ON CONFLICT (id) DO UPDATE SET
       kind=EXCLUDED.kind, display_name=EXCLUDED.display_name, email=EXCLUDED.email,
       identities=EXCLUDED.identities, body_md=EXCLUDED.body_md, state=EXCLUDED.state, scopes=EXCLUDED.scopes, sort=EXCLUDED.sort,
       version=org_member.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.id, kind, m.display_name ?? before?.display_name ?? null, m.email ?? before?.email ?? null,
     JSON.stringify(identities), m.body_md ?? before?.body_md ?? "",
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

export async function removeMemory(name: string, actor?: string, source?: string): Promise<void> {
  const k = await getK6(name);
  if (!k || k.injection === "always") return; // 규칙(R)은 메모리로 삭제 안 함
  await deleteK6(name, { actor: actor ?? null, source });
}

// ── auth_token (DB 기반 bearer) ──
// 발급 — 평문 토큰을 1회 반환(저장은 해시만). prefix 'lvk_' 로 verifyDbToken 의 빠른 게이팅 가능.
// email 은 토큰에 저장하지 않는다 — 귀속/표시용 email 은 member_id → org_member 에서 파생(중복·stale 제거).
export async function mintToken(input: {
  userId: string;
  scopes: string[];
  projects?: string[];
  label?: string | null;
  memberId?: string | null;
}, actor?: string, source?: string): Promise<{ token: string; tokenHash: string }> {
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  await itemsPool.query(
    `INSERT INTO auth_token(token_hash, user_id, scopes, projects, label, member_id, created_by)
       VALUES($1,$2,$3::jsonb,$4::jsonb,$5,$6,$7)`,
    [tokenHash, input.userId, JSON.stringify(input.scopes),
     JSON.stringify(input.projects ?? ["*"]), input.label ?? null, input.memberId ?? null, actor ?? null],
  );
  await audit("auth_token", input.userId, "mint",
    null, { userId: input.userId, scopes: input.scopes, label: input.label, memberId: input.memberId }, actor, source);
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
  hooks: { session_preload: boolean; work_flag: boolean; stop_writeback_gate: boolean };
  writeback_notice: string | null;
  work_roots: string[];
  allowed_auth_envs: string[]; // http_proxy 툴이 참조 가능한 환경변수 '이름' 화이트리스트(B15)
  url_allowlist: string[];     // http_proxy 호출 허용 호스트(소문자, deny-all 기본)
  allowed_db_secret_refs: string[]; // db 소스가 참조 가능한 시크릿 env '이름' 화이트리스트(deny-all 기본)
  allowed_db_hosts: string[]; // db 소스가 접속 가능한 host 화이트리스트(소문자, deny-all 기본) — 사설/localhost SSRF 면제 대상
  write_tools: string[]; // work-flag 가 '기록함(writeback)'으로 인정할 lively MCP 툴 목록(비면 훅 내장 v6 기본)
  embedding_config: EmbeddingConfig; // 벡터검색(#172) 추론 seam 설정 — 기본 off(현행 grep/ILIKE). DB 우선, 비면 env(EMBEDDINGS_*) 시드
  version: number;
  updated_at: string | null;
  updated_by: string | null;
}

const strArrSafe = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export async function getRuntimeConfig(): Promise<OrgRuntimeConfig> {
  const r = await itemsPool.query(
    `SELECT hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, write_tools, embedding_config, version, updated_at, updated_by
       FROM org_runtime_config WHERE id=1`,
  );
  const row = r.rows[0] as Record<string, unknown> | undefined;
  const hooksRaw = (row?.hooks ?? {}) as Record<string, unknown>;
  return {
    hooks: {
      session_preload: hooksRaw.session_preload !== false,
      work_flag: hooksRaw.work_flag !== false,
      stop_writeback_gate: hooksRaw.stop_writeback_gate !== false,
    },
    writeback_notice: (row?.writeback_notice as string) ?? null,
    work_roots: strArrSafe(row?.work_roots),
    allowed_auth_envs: strArrSafe(row?.allowed_auth_envs),
    url_allowlist: strArrSafe(row?.url_allowlist).map((s) => s.toLowerCase()),
    allowed_db_secret_refs: strArrSafe(row?.allowed_db_secret_refs),
    allowed_db_hosts: strArrSafe(row?.allowed_db_hosts).map((s) => s.toLowerCase()),
    write_tools: strArrSafe(row?.write_tools),
    embedding_config: resolveEmbeddingConfig(row?.embedding_config), // DB 우선, off/미설정이면 env(EMBEDDINGS_*) 시드
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
    write_tools?: string[];
    embedding_config?: EmbeddingConfig;
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
  const writeTools = patch.write_tools !== undefined ? patch.write_tools : before.write_tools;
  // 임베딩 설정 — 저장 시 정규화(잡값/알 수 없는 provider → off). 시크릿 미저장(auth_env_ref=env 이름만).
  const embeddingConfig = patch.embedding_config !== undefined ? normalizeEmbeddingConfig(patch.embedding_config) : before.embedding_config;
  await itemsPool.query(
    `INSERT INTO org_runtime_config(id, hooks, writeback_notice, work_roots, allowed_auth_envs, url_allowlist, allowed_db_secret_refs, allowed_db_hosts, write_tools, embedding_config, version, updated_at, updated_by)
       VALUES(1,$1::jsonb,$2,$3::jsonb,$4::jsonb,$5::jsonb,$6::jsonb,$7::jsonb,$8::jsonb,$9::jsonb,1,now(),$10)
     ON CONFLICT (id) DO UPDATE SET hooks=EXCLUDED.hooks, writeback_notice=EXCLUDED.writeback_notice,
       work_roots=EXCLUDED.work_roots, allowed_auth_envs=EXCLUDED.allowed_auth_envs, url_allowlist=EXCLUDED.url_allowlist,
       allowed_db_secret_refs=EXCLUDED.allowed_db_secret_refs, allowed_db_hosts=EXCLUDED.allowed_db_hosts,
       write_tools=EXCLUDED.write_tools, embedding_config=EXCLUDED.embedding_config,
       version=org_runtime_config.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [JSON.stringify(hooks), writebackNotice, JSON.stringify(workRoots),
     JSON.stringify(allowedAuthEnvs), JSON.stringify(urlAllowlist), JSON.stringify(allowedDbSecretRefs), JSON.stringify(allowedDbHosts), JSON.stringify(writeTools), JSON.stringify(embeddingConfig), actor ?? null],
  );
  const after = await getRuntimeConfig();
  await audit("org_runtime_config", "1", "update", before, after, actor, source, meta);
  return after;
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
  };
}

const MCP_COLS = "name, transport, url, command, auth_env, note, enabled, sort, version, updated_at, updated_by";

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
}

export async function upsertMcpServer(m: McpServerInput, actor?: string, source?: string): Promise<McpServer> {
  const before = await getMcpServer(m.name);
  const transport = m.transport ?? before?.transport ?? "http";
  // transport 와 맞지 않는 필드는 비운다(http↔stdio 전환 시 옛 url/command 잔류로 인한 잘못된 상태 방지).
  const url = transport === "http" ? (m.url ?? before?.url ?? null) : null;
  const command = transport === "stdio" ? (m.command ?? before?.command ?? null) : null;
  await itemsPool.query(
    `INSERT INTO org_mcp_server(name, transport, url, command, auth_env, note, enabled, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,1,now(),$9)
     ON CONFLICT (name) DO UPDATE SET
       transport=EXCLUDED.transport, url=EXCLUDED.url, command=EXCLUDED.command, auth_env=EXCLUDED.auth_env,
       note=EXCLUDED.note, enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       version=org_mcp_server.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [m.name, transport, url, command,
     m.auth_env ?? before?.auth_env ?? null, m.note ?? before?.note ?? null,
     m.enabled ?? before?.enabled ?? true, m.sort ?? before?.sort ?? 0, actor ?? null],
  );
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
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const DBSRC_COLS = "name, driver, url, auth_mode, auth_ref, rls, max_rows, timeout_ms, note, enabled, sort, version, updated_at, updated_by";

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
  const sort = s.sort ?? before?.sort ?? 0;
  await itemsPool.query(
    `INSERT INTO org_db_source(name, driver, url, auth_mode, auth_ref, rls, max_rows, timeout_ms, note, enabled, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,1,now(),$12)
     ON CONFLICT (name) DO UPDATE SET
       driver=EXCLUDED.driver, url=EXCLUDED.url, auth_mode=EXCLUDED.auth_mode, auth_ref=EXCLUDED.auth_ref,
       rls=EXCLUDED.rls, max_rows=EXCLUDED.max_rows, timeout_ms=EXCLUDED.timeout_ms, note=EXCLUDED.note,
       enabled=EXCLUDED.enabled, sort=EXCLUDED.sort,
       version=org_db_source.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [s.name, driver, keep(s.url, before?.url), authMode, keep(s.auth_ref, before?.auth_ref),
     keep(s.rls, before?.rls), keep(s.max_rows, before?.max_rows), keep(s.timeout_ms, before?.timeout_ms),
     keep(s.note, before?.note), enabled, sort, actor ?? null],
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
  enabled: boolean;
  sort: number;
  version: number;
  content_hash: string | null;
  created_by: string | null;
  updated_at: string | null;
  updated_by: string | null;
}

function mapHook(row: Record<string, unknown>): OrgHook {
  return {
    id: row.id as string,
    label: (row.label as string) ?? null,
    harness: row.harness as HookHarness,
    event: row.event as string,
    matcher: (row.matcher as string) ?? null,
    source_code: (row.source_code as string) ?? "",
    timeout_sec: (row.timeout_sec as number) ?? 10,
    note: (row.note as string) ?? null,
    enabled: row.enabled !== false,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    content_hash: (row.content_hash as string) ?? null,
    created_by: (row.created_by as string) ?? null,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const HOOK_COLS = "id, label, harness, event, matcher, source_code, timeout_sec, note, enabled, sort, version, content_hash, created_by, updated_at, updated_by";

export async function listOrgHooks(): Promise<OrgHook[]> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook ORDER BY sort, id`);
  return r.rows.map(mapHook);
}

// 런너 fetch 용 — enabled 훅만. harness 지정 시 그 하네스 또는 'all' 만.
export async function listEnabledHooks(harness?: string): Promise<OrgHook[]> {
  const r = harness
    ? await itemsPool.query(
        `SELECT ${HOOK_COLS} FROM org_hook WHERE enabled=true AND (harness=$1 OR harness='all') ORDER BY sort, id`, [harness])
    : await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook WHERE enabled=true ORDER BY sort, id`);
  return r.rows.map(mapHook);
}

export async function getOrgHook(id: string): Promise<OrgHook | null> {
  const r = await itemsPool.query(`SELECT ${HOOK_COLS} FROM org_hook WHERE id=$1`, [id]);
  return r.rows[0] ? mapHook(r.rows[0]) : null;
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
  await itemsPool.query(
    `INSERT INTO org_hook(id,label,harness,event,matcher,source_code,timeout_sec,note,enabled,sort,version,content_hash,created_by,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1,$11,$12,now(),$13)
     ON CONFLICT (id) DO UPDATE SET
       label=EXCLUDED.label, harness=EXCLUDED.harness, event=EXCLUDED.event, matcher=EXCLUDED.matcher,
       source_code=EXCLUDED.source_code, timeout_sec=EXCLUDED.timeout_sec, note=EXCLUDED.note,
       enabled=EXCLUDED.enabled, sort=EXCLUDED.sort, content_hash=EXCLUDED.content_hash,
       version=org_hook.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [h.id, h.label ?? before?.label ?? null, harness, event, h.matcher ?? before?.matcher ?? null,
     sourceCode, h.timeout_sec ?? before?.timeout_sec ?? 10, h.note ?? before?.note ?? null,
     h.enabled ?? before?.enabled ?? true, h.sort ?? before?.sort ?? 0, contentHash,
     before?.created_by ?? ctx.actor ?? null, ctx.actor ?? null],
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
    note: (row.note as string) ?? null,
    sort: (row.sort as number) ?? 0,
    version: (row.version as number) ?? 1,
    updated_at: (row.updated_at as string) ?? null,
    updated_by: (row.updated_by as string) ?? null,
  };
}

const TOOL_COLS = "name, kind, enabled, title, description, scope, input_schema, method, url, auth_env, auto_approve, note, sort, version, updated_at, updated_by";

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

// 설치 번들용 — auto_approve 가 켜진(그리고 enabled) 툴 이름. 멤버 settings 의 무확인 실행 허용목록에 들어간다.
export async function listAutoApproveTools(): Promise<{ name: string; kind: ToolKind }[]> {
  const r = await itemsPool.query(
    `SELECT name, kind FROM org_tool WHERE auto_approve=true AND enabled=true ORDER BY name`);
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
  const authEnv = isProxy ? (t.auth_env ?? before?.auth_env ?? null) : null;
  const scope = isProxy ? (t.scope ?? before?.scope ?? null) : null;
  const inputSchema = isProxy ? (t.input_schema ?? before?.input_schema ?? DEFAULT_INPUT_SCHEMA) : DEFAULT_INPUT_SCHEMA;
  await itemsPool.query(
    `INSERT INTO org_tool(name,kind,enabled,title,description,scope,input_schema,method,url,auth_env,auto_approve,note,sort,version,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12,$13,1,now(),$14)
     ON CONFLICT (name) DO UPDATE SET
       kind=EXCLUDED.kind, enabled=EXCLUDED.enabled, title=EXCLUDED.title, description=EXCLUDED.description,
       scope=EXCLUDED.scope, input_schema=EXCLUDED.input_schema, method=EXCLUDED.method, url=EXCLUDED.url,
       auth_env=EXCLUDED.auth_env, auto_approve=EXCLUDED.auto_approve, note=EXCLUDED.note, sort=EXCLUDED.sort,
       version=org_tool.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [t.name, kind, t.enabled ?? before?.enabled ?? true, t.title ?? before?.title ?? null,
     t.description ?? before?.description ?? "", scope, JSON.stringify(inputSchema), method, url, authEnv,
     t.auto_approve ?? before?.auto_approve ?? false, t.note ?? before?.note ?? null, t.sort ?? before?.sort ?? 0,
     ctx.actor ?? null],
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



// ── 프로젝트 타임라인 — 이 프로젝트 팀원들이 한 작업(activity). authorPerson 지정 시 그 사람만. ──
//  activity 는 itemsPool 동일 DB(지식참조=activity_knowledge→knowledge FK). project_member.member_id ↔ activity.author_person 조인.
export interface ProjectActivity {
  id: number; type: string; title: string | null; summary: string | null;
  author_person: string | null; author_agent: string | null;
  commit_sha: string | null; committed_at: string | null; created_at: string | null;
  external_system: string | null; external_url: string | null;
}
export async function listProjectActivities(
  projectId: number, authorPerson?: string, limit = 100,
): Promise<ProjectActivity[]> {
  const params: unknown[] = [projectId];
  let personFilter = "";
  if (authorPerson) { params.push(authorPerson); personFilter = ` AND a.author_person = $${params.length}`; }
  params.push(Math.min(Math.max(Number(limit) || 100, 1), 200));
  // 이 프로젝트에 연결된 작업 — 둘 중 하나면 포함:
  //  ① activity.project_id 가 이 프로젝트(명시적 링크 — activity_log 가 직접 박는 가장 권위 있는 신호), 또는
  //  ② activity.session_id 가 session_project(이 프로젝트의 터미널 세션)에 매핑된 것(세션 추론).
  //  (예전엔 author_person 조인으로 팀원이 한 모든 작업을 보여줘서 프로젝트 밖 작업까지 섞였음 → 그 폭넓은 조인은 유지하지 않는다.
  //   project_id=이 프로젝트는 정의상 이 프로젝트 작업이라 session_id 가 없어도 표시되어야 한다 — MCP activity_log 로 직접 기록한 작업 포함.)
  const r = await itemsPool.query(
    `SELECT a.id, a.type, a.title, a.summary, a.author_person, a.author_agent,
            a.commit_sha, a.committed_at, a.created_at, a.external_system, a.external_url
       FROM activity a
      WHERE (a.project_id = $1
             OR a.session_id IN (SELECT session_id FROM session_project WHERE project_id = $1))
      ${personFilter}
      ORDER BY COALESCE(a.committed_at, a.created_at) DESC
      LIMIT $${params.length}`,
    params,
  );
  return r.rows as ProjectActivity[];
}

