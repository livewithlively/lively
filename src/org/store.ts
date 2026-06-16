// org-content 읽기/쓰기 — 전달 서브시스템의 진실원천 접근 계층.
// 모든 쓰기는 org_content_audit 에 before/after 를 남기고 version 을 올린다(낙관적 잠금 토대).
// 멤버 쓰기는 person/person_identity 로도 동기화 → 비개발자의 UI 편집이 즉시 게이트웨이 신원 매칭에 반영.
import crypto from "node:crypto";
import { itemsPool } from "../items/store.js";

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
  body_md: string;
  in_index: boolean;
  sort: number;
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
): Promise<void> {
  await itemsPool.query(
    `INSERT INTO org_content_audit(entity, entity_key, op, before, after, actor, source)
     VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7)`,
    [entity, key, op, before == null ? null : JSON.stringify(before),
     after == null ? null : JSON.stringify(after), actor ?? null, source ?? null],
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

// ── org_content (섹션 markdown) ──
export async function getSection(section: string): Promise<OrgSection | null> {
  const r = await itemsPool.query(
    `SELECT section, body_md, version, updated_at, updated_by FROM org_content WHERE section=$1`,
    [section],
  );
  return (r.rows[0] as OrgSection) ?? null;
}

export async function listSections(): Promise<OrgSection[]> {
  const r = await itemsPool.query(
    `SELECT section, body_md, version, updated_at, updated_by FROM org_content ORDER BY section`,
  );
  return r.rows as OrgSection[];
}

export async function updateSection(
  section: string,
  body_md: string,
  actor?: string,
  source?: string,
): Promise<OrgSection> {
  const before = await getSection(section);
  await itemsPool.query(
    `INSERT INTO org_content(section, body_md, version, updated_at, updated_by)
       VALUES($1,$2,1,now(),$3)
     ON CONFLICT (section) DO UPDATE SET
       body_md = EXCLUDED.body_md, version = org_content.version + 1,
       updated_at = now(), updated_by = EXCLUDED.updated_by`,
    [section, body_md, actor ?? null],
  );
  const after = await getSection(section);
  await audit("org_content", section, before ? "update" : "insert", before, after, actor, source);
  return after as OrgSection;
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
  const scopes = m.scopes ?? before?.scopes ?? ["items", "context"];
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
  // 권한 변경 시 그 구성원의 활성 토큰에도 즉시 반영(발급 후 권한 회수/확대가 바로 먹게).
  if (m.scopes) await updateMemberTokenScopes(m.id, scopes);
  return after as OrgMember;
}

// 구성원의 활성 토큰 scope 를 일괄 갱신(권한편집 즉시 적용).
export async function updateMemberTokenScopes(memberId: string, scopes: string[]): Promise<void> {
  await itemsPool.query(
    `UPDATE auth_token SET scopes=$2::jsonb WHERE member_id=$1 AND revoked_at IS NULL`,
    [memberId, JSON.stringify(scopes)],
  );
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

// ── org_memory ──
export async function listMemory(): Promise<OrgMemory[]> {
  const r = await itemsPool.query(
    `SELECT name, title, body_md, in_index, sort, version, updated_at, updated_by
       FROM org_memory ORDER BY sort, name`,
  );
  return r.rows as OrgMemory[];
}

export async function getMemory(name: string): Promise<OrgMemory | null> {
  const r = await itemsPool.query(
    `SELECT name, title, body_md, in_index, sort, version, updated_at, updated_by FROM org_memory WHERE name=$1`,
    [name],
  );
  return (r.rows[0] as OrgMemory) ?? null;
}

export interface MemoryInput {
  name: string;
  title?: string | null;
  body_md?: string;
  in_index?: boolean;
  sort?: number;
}

export async function upsertMemory(mem: MemoryInput, actor?: string, source?: string): Promise<OrgMemory> {
  const before = await getMemory(mem.name);
  await itemsPool.query(
    `INSERT INTO org_memory(name, title, body_md, in_index, sort, version, updated_at, updated_by)
       VALUES($1,$2,$3,$4,$5,1,now(),$6)
     ON CONFLICT (name) DO UPDATE SET
       title=EXCLUDED.title, body_md=EXCLUDED.body_md, in_index=EXCLUDED.in_index, sort=EXCLUDED.sort,
       version=org_memory.version + 1, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [mem.name, mem.title ?? before?.title ?? null, mem.body_md ?? before?.body_md ?? "",
     mem.in_index ?? before?.in_index ?? true, mem.sort ?? before?.sort ?? 0, actor ?? null],
  );
  const after = await getMemory(mem.name);
  await audit("org_memory", mem.name, before ? "update" : "insert", before, after, actor, source);
  return after as OrgMemory;
}

export async function removeMemory(name: string, actor?: string, source?: string): Promise<void> {
  const before = await getMemory(name);
  if (!before) return;
  await itemsPool.query(`DELETE FROM org_memory WHERE name=$1`, [name]);
  await audit("org_memory", name, "delete", before, null, actor, source);
}

// ── auth_token (DB 기반 bearer) ──
export interface DbToken {
  user_id: string;
  email: string | null;
  scopes: string[];
  projects: string[];
  label: string | null;
  member_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

// 발급 — 평문 토큰을 1회 반환(저장은 해시만). prefix 'lvk_' 로 verifyDbToken 의 빠른 게이팅 가능.
export async function mintToken(input: {
  userId: string;
  email?: string | null;
  scopes: string[];
  projects?: string[];
  label?: string | null;
  memberId?: string | null;
}, actor?: string, source?: string): Promise<{ token: string; tokenHash: string }> {
  const token = "lvk_" + crypto.randomBytes(24).toString("base64url");
  const tokenHash = sha256(token);
  await itemsPool.query(
    `INSERT INTO auth_token(token_hash, user_id, email, scopes, projects, label, member_id, created_by)
       VALUES($1,$2,$3,$4::jsonb,$5::jsonb,$6,$7,$8)`,
    [tokenHash, input.userId, input.email ?? null, JSON.stringify(input.scopes),
     JSON.stringify(input.projects ?? ["*"]), input.label ?? null, input.memberId ?? null, actor ?? null],
  );
  await audit("auth_token", input.userId, "mint",
    null, { userId: input.userId, scopes: input.scopes, label: input.label, memberId: input.memberId }, actor, source);
  return { token, tokenHash };
}

export interface TokenMeta {
  token_hash: string;
  user_id: string;
  email: string | null;
  scopes: string[];
  label: string | null;
  member_id: string | null;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

export async function listTokens(): Promise<TokenMeta[]> {
  const r = await itemsPool.query(
    `SELECT token_hash, user_id, email, scopes, label, member_id, created_at, last_used_at, revoked_at
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

// 인증 경로(bearer.ts) — 평문 토큰 → 해시 조회. revoked 아니면 LivelyUser shape 반환, 아니면 null.
// ITEMS_DATABASE_URL 미설정/오류 시 null(fail-closed: 무효 토큰 취급).
export async function verifyDbToken(token: string): Promise<{ userId: string; email: string; scopes: string[]; projects: string[] } | null> {
  if (!process.env.ITEMS_DATABASE_URL) return null;
  try {
    const r = await itemsPool.query(
      `SELECT user_id, email, scopes, projects FROM auth_token
         WHERE token_hash=$1 AND revoked_at IS NULL`,
      [sha256(token)],
    );
    const row = r.rows[0] as { user_id: string; email: string | null; scopes: unknown; projects: unknown } | undefined;
    if (!row) return null;
    // JSONB scopes/projects 는 런타임에 무엇이든 될 수 있다(마이그레이션 버그·손상) → 보안 경계에서
    //  .includes() 가 깨지지 않게 '문자열 배열'로 강제 정규화(비배열/비문자 원소는 버린다).
    const strArr = (v: unknown, fb: string[]): string[] =>
      Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : fb;
    // last_used 갱신은 베스트에포트(인증 핫패스 — 실패 무시).
    itemsPool.query(`UPDATE auth_token SET last_used_at=now() WHERE token_hash=$1`, [sha256(token)]).catch(() => {});
    return { userId: row.user_id, email: row.email ?? "", scopes: strArr(row.scopes, []), projects: strArr(row.projects, ["*"]) };
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
