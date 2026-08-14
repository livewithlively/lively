// db_query 접근 계층 5테이블 — org_db_source(데이터소스) · org_db_table_policy · org_db_column_mask(#186)
//  · org_db_subject_key(P5 #746) · org_db_unmask_grant(P4 #746). (#1313 R18) 구 org/store.ts 에서 verbatim 분리.
import { itemsPool } from "../../db/client.js";
import { audit } from "./audit.js";

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
     ON CONFLICT (tenant_id, name) DO UPDATE SET
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
     ON CONFLICT (tenant_id, source, table_name) DO UPDATE SET
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
     ON CONFLICT (tenant_id, source, table_name, column_name) DO UPDATE SET
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
     ON CONFLICT (tenant_id, source, table_name, column_name) DO UPDATE SET
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
