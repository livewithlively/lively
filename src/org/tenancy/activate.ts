// 셀프호스트 다중 워크스페이스 **활성화 + 정책 보장**(#1750 S1) — lvly-cloud tenantrls 의 코어 이식판.
//
// ── 무엇을 하는가(활성화 1회) ───────────────────────────────────────────────
//  ① 앱 role(lvly_app) 생성 — NOSUPERUSER·NOBYPASSRLS(둘 중 하나만 있어도 RLS 는 장식이 된다. 실측:
//     lvly-cloud 2026-08-14, 테이블을 다 잠갔는데 role 이 rds_superuser 라 B 가 A 의 행을 그대로 봤다).
//  ② 콘텐츠 테이블 전부에 ENABLE+**FORCE** RLS + 정책 2벌:
//       tenant_isolation TO lvly_app — strict `current_setting('app.tenant_id')::uuid`(missing_ok 없음).
//         엄격함은 정책이 갖는다: 바인딩이 빠진 쿼리는 조용히 0행이 아니라 **그 자리에서 오류**다.
//       owner_all TO <소유자 role> — 스키마 초기화·하우스키핑 자식 프로세스는 소유자로 붙는다.
//         FORCE 때문에 소유자도 정책 대상이므로 이 정책이 없으면 그 경로가 전부 죽는다.
//  ③ primary 워크스페이스를 등록부에 시드(id=SINGLE_TENANT_ID·slug='primary') — 기존 행의 tenant_id
//     상수와 정확히 일치하므로 **기존 데이터가 그대로 primary 가 된다**(이관 0건).
//  ④ 앱 DSN 으로 실접속 검증 — role 속성 + "남의 테넌트 컨텍스트에서 org_profile 0행" 실측.
//     검증이 실패하면 상태파일을 **쓰지 않는다**(fail-closed — 잘못 활성화된 격리가 최악이다).
//  ⑤ 상태파일(tenancy/runtime.json) 기록 → 호출자가 프로세스를 끝내면 슈퍼바이저가 재기동하며
//     boot/tenancy-env.ts 가 앱 role 로 재배선한다.
//
// ── 왜 목록이 아니라 introspection 인가(원본과 같은 근거) ───────────────────
// 테이블은 계속 는다. "정책 건 테이블 목록"은 반드시 낡고, 낡은 목록의 구멍 = 전 워크스페이스에
//  보이는 테이블 = 유출이다. 그래서 카탈로그에 물어본다 — 새 테이블은 자동으로 대상이 되고,
//  tenant_id 없는 비면제 테이블이 발견되면 **던진다**. 새 코어 릴리스가 테이블을 추가해도
//  스키마 초기화 자식이 매 부팅 ensureTenantPolicies 를 다시 돌리므로 정책 없이 살아남지 못한다.
//
// ── 면제 2축 ────────────────────────────────────────────────────────────────
//  · TENANT_COLUMN_EXEMPT — tenant_id 자체가 없는 인프라 표(등록부·마이그레이션 기록).
//  · IDENTITY_GLOBAL_TABLES — tenant_id 는 있지만(코어가 일괄로 붙인다) **정책을 걸지 않는** 표.
//    신원은 박스 전역이라는 제품 결정(#1750): 사람·세션·토큰·자격은 워크스페이스를 넘나들고,
//    ground-truth 레지스트리(kind_registry·data_source)와 실행 노드(org_node)도 배포 전체의 사실이다.
//    컬럼은 남지만 정책이 없으면 불활성이다 — 무해한 16바이트.
import crypto from "node:crypto";
import pg from "pg";
import { itemsPool } from "../../db/client.js";
import { TENANT_COLUMN_EXEMPT, SINGLE_TENANT_ID, ensureTenantColumn } from "../../db/tenant-column.js";
import { writeTenancyRuntime, readTenancyRuntimeSync, registryModeActive } from "./state.js";
import { PRIMARY_SLUG, invalidateRegistryCache } from "./registry.js";
import { logger } from "../../log.js";

/**
 * 앱 role 이름 — **DB 마다 다르다**(`lvly_app_<db>`), 상수가 아니다.
 *
 * ★ role 은 Postgres 에서 **클러스터 전역**이다. 상수명('lvly_app')이면 같은 클러스터에 사는 두 배포가
 *  각자 활성화하며 **서로의 비밀번호를 회전**시킨다 — 먼저 활성화한 쪽의 runtime.json 이 낡은 비밀번호를
 *  들고 있어 다음 부팅부터 DB 인증이 전부 죽는다(자동 활성화가 켜지면 개발 박스에서 실제로 나는 조합이다:
 *  한 로컬 pg 에 게이트웨이 여러 개). LOGIN+비밀번호 역만의 문제다 — lively_reader(NOLOGIN)는 공유해도 무해.
 */
export function appRoleName(dbName: string): string {
  const s = String(dbName || "").trim().toLowerCase().replace(/[^a-z0-9_]/g, "_");
  if (!s) throw new Error("DB 이름이 비어 있습니다 — 앱 role 이름을 만들 수 없습니다");
  return `lvly_app_${s}`.slice(0, 63); // Postgres 식별자 상한
}

async function currentAppRole(db: Q): Promise<string> {
  return appRoleName(String((await db.query("SELECT current_database() AS d")).rows[0]?.d ?? ""));
}

/** 신원·전역 표 — 정책을 걸지 않는다(박스 전역). ⚠ 늘리는 것은 "이 표엔 워크스페이스 사유 데이터가
 *  절대 없다"는 판단이다 — 면제는 검사를 끄는 일이고, 꺼진 검사가 유출 경로가 된다. */
export const IDENTITY_GLOBAL_TABLES: ReadonlySet<string> = new Set([
  // 사람과 그 자격 — 계정은 박스에 하나, 워크스페이스는 접근 명부(gw_workspace_member)로 가른다.
  "org_member", "web_session", "auth_token", "member_credential", "member_secret", "git_credential",
  // 인증 진행중 상태 — 로그인 플로우는 워크스페이스 이전에 일어난다.
  "pending_device_auth", "pending_oidc_auth", "pending_oidc_link", "pending_session_mint",
  // OAuth AS(이 게이트웨이가 인가서버) — 클라이언트 등록·코드·리프레시는 배포 전체의 사실.
  "oauth_client", "oauth_auth_code", "oauth_auth_request", "oauth_refresh",
  // 실행 노드 — 기계는 박스에 붙는다(어느 워크스페이스의 세션이든 같은 노드에서 뜰 수 있다).
  "org_node",
  // ground-truth 레지스트리 — 스키마 초기화(소유자)가 시드하는 정의 표. 테넌트로 가르면
  //  secondary 가 빈 레지스트리를 본다(시드는 primary 에만 떨어지므로).
  "kind_registry", "data_source",
]);

const qi = (name: string): string => {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`안전하지 않은 식별자: ${name}`);
  return `"${name}"`;
};

const STRICT_EXPR = "current_setting('app.tenant_id')::uuid";

interface TableStatus {
  table: string;
  has_tenant_id: boolean;
  rls_enabled: boolean;
  rls_forced: boolean;
  policies: string[];
}

/** public 스키마 일반 테이블 전수 상태(파티션 자식 제외 — 정책은 부모에서 상속된다). */
const TABLE_STATUS_SQL = `
SELECT
  c.relname::text AS table,
  EXISTS (SELECT 1 FROM pg_attribute a
           WHERE a.attrelid = c.oid AND a.attname = 'tenant_id' AND a.attnum > 0 AND NOT a.attisdropped) AS has_tenant_id,
  c.relrowsecurity AS rls_enabled,
  c.relforcerowsecurity AS rls_forced,
  COALESCE((SELECT array_agg(p.polname::text) FROM pg_policy p WHERE p.polrelid = c.oid), '{}') AS policies
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind = 'r' AND NOT c.relispartition
ORDER BY c.relname`;

// itemsPool(프록시 Pool)·자식의 단독 Client 둘 다 받는 최소 표면 — pg 오버로드에 구조적으로 안 걸리게 최소로 좁힌다.
interface Q { query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>>; rowCount: number | null }> }

/**
 * 콘텐츠 테이블 전부에 정책을 보장한다(멱등). **소유자 접속에서 불러야 한다** — 활성화 시점(아직
 *  registry 모드 전 = 소유자)과 스키마 초기화 자식(LIVELY_OWNER_DATABASE_URL) 두 곳이 그렇다.
 * 반환: 새로 손댄 테이블 수. tenant_id 없는 비면제 테이블 발견 시 **던진다**(fail-closed).
 */
export async function ensureTenantPolicies(db: Q = itemsPool): Promise<{ tables: number; touched: number }> {
  const owner = String((await db.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  if (!owner) throw new Error("current_user 를 조회할 수 없습니다");
  // ★ 컬럼부터 다시 보장한다(멱등 introspection). 스키마 체인 밖에서 **지연 생성**되는 표가 실제로 있다 —
  //  connector_run(런트래커 첫 사용 시 DDL)이 E2E 에서 정확히 이 자리로 걸어 들어왔다. 그런 표는 체인 말미의
  //  ensureTenantColumn 이 못 봤으므로 여기서 한 번 더 돌려 붙인다. 그래도 없으면 아래에서 던진다(fail-closed).
  await ensureTenantColumn();
  // self-rls(#1291 v3)의 reader 역 — SET LOCAL ROLE 로 내려가는 SELECT 경로. 이 역에는 tenant_isolation
  //  (TO lvly_app)이 **적용되지 않으므로**, 방치하면 self 소스 SQL 창이 전 워크스페이스 행을 본다(유출).
  //  RESTRICTIVE 로 건다: permissive(lively_vis)와 OR 가 아니라 **AND** 로 겹쳐, 가시성 정책은 그대로 두고
  //  테넌트 밖 행만 추가로 걸러낸다. 역이 없으면(self-rls 미준비) 건너뛴다 — 역이 생기는 건 ensureSelfRls 뒤고,
  //  그 직후 이 함수가 다시 돈다(스키마 자식의 실행 순서).
  const readerExists = (await db.query("SELECT 1 FROM pg_roles WHERE rolname='lively_reader'")).rows.length > 0;
  const appRole = await currentAppRole(db);
  const rows = (await db.query(TABLE_STATUS_SQL)).rows as unknown as TableStatus[];
  let touched = 0, content = 0;
  for (const t of rows) {
    if (TENANT_COLUMN_EXEMPT.has(t.table) || IDENTITY_GLOBAL_TABLES.has(t.table)) continue;
    if (!t.has_tenant_id) {
      // 컬럼이 없으면 정책 재료가 없다 = 그 표는 전 워크스페이스에 보인다. 조용히 넘기지 않는다.
      throw new Error(`테이블 ${t.table} 에 tenant_id 가 없습니다 — 격리 불가(ensureTenantColumn 재실행으로도 안 붙었다)`);
    }
    content++;
    const tbl = qi(t.table);
    const stmts: string[] = [];
    if (!t.rls_enabled) stmts.push(`ALTER TABLE ${tbl} ENABLE ROW LEVEL SECURITY`);
    if (!t.rls_forced) stmts.push(`ALTER TABLE ${tbl} FORCE ROW LEVEL SECURITY`);
    if (!t.policies.includes("tenant_isolation")) {
      // USING = 보이는 행 · WITH CHECK = 쓸 수 있는 행. 같은 식이라 "남의 소속으로 바꿔치기"도 막힌다.
      stmts.push(`CREATE POLICY ${qi("tenant_isolation")} ON ${tbl} FOR ALL TO ${qi(appRole)} ` +
        `USING (tenant_id = ${STRICT_EXPR}) WITH CHECK (tenant_id = ${STRICT_EXPR})`);
    }
    if (!t.policies.includes("owner_all")) {
      stmts.push(`CREATE POLICY ${qi("owner_all")} ON ${tbl} FOR ALL TO ${qi(owner)} USING (true) WITH CHECK (true)`);
    }
    if (readerExists && !t.policies.includes("tenant_restrict_reader")) {
      stmts.push(`CREATE POLICY ${qi("tenant_restrict_reader")} ON ${tbl} AS RESTRICTIVE FOR SELECT ` +
        `TO ${qi("lively_reader")} USING (tenant_id = ${STRICT_EXPR})`);
    }
    if (!stmts.length) continue;
    for (const s of stmts) await db.query(s);
    touched++;
  }
  return { tables: content, touched };
}

/** 앱 role 에 데이터 권한을 준다(멱등). DDL 권한은 주지 않는다 — 스키마는 소유자의 일이다.
 *  ⚠ TRUNCATE 는 주지 않는다: TRUNCATE 는 RLS 를 안 본다(정책 무시 전체 삭제) — 앱이 가지면 안 되는 권한. */
async function grantAppRole(db: Q, owner: string, appRole: string): Promise<void> {
  await db.query(`GRANT USAGE ON SCHEMA public TO ${qi(appRole)}`);
  await db.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${qi(appRole)}`);
  await db.query(`GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA public TO ${qi(appRole)}`);
  // 앞으로 소유자가 만들 테이블(새 코어 릴리스)도 자동으로 — 안 하면 릴리스마다 GRANT 를 사람이 기억해야 한다.
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${qi(appRole)}`);
  await db.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${qi(owner)} IN SCHEMA public GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO ${qi(appRole)}`);
}

/** 소유자 DSN → 앱 DSN(사용자·비밀번호만 교체). 못 알아보는 형태면 던진다 — 추측한 DSN 으로
 *  활성화하면 재기동 후 게이트웨이가 영영 못 뜬다(app_dsn 파라미터로 직접 지정하는 길을 안내). */
export function buildAppDsn(ownerDsn: string, appRole: string, password: string): string {
  let u: URL;
  try { u = new URL(ownerDsn); } catch { throw new Error("ITEMS_DATABASE_URL 을 URL 로 해석할 수 없습니다 — app_dsn 파라미터로 앱 DSN 을 직접 지정하세요"); }
  if (!/^postgres(ql)?:$/.test(u.protocol) || !u.hostname) {
    throw new Error("소켓 경로형 DSN 은 자동 변환하지 않습니다 — app_dsn 파라미터로 앱 DSN 을 직접 지정하세요");
  }
  u.username = appRole;
  u.password = password;
  return u.toString();
}

/**
 * 앱 DSN 실접속 검증 — 통과 못 하면 던진다(호출자는 상태파일을 쓰지 않는다).
 *  ① role 속성: 슈퍼유저·BYPASSRLS 면 격리 0(테이블 검사로는 절대 안 잡힌다 — 실측 항목).
 *  ② 남의 테넌트 컨텍스트에서 org_profile 0행 — 정책이 실제로 거른다는 실측.
 *  ③ 컨텍스트 없는 조회는 **오류** — strict 식이 살아 있다는 실측(조용한 0행이 아니라).
 */
export async function verifyAppIsolation(appDsn: string): Promise<void> {
  const client = new pg.Client({ connectionString: appDsn });
  await client.connect();
  try {
    const role = (await client.query(
      "SELECT rolsuper AS s, rolbypassrls AS b FROM pg_roles WHERE rolname = current_user")).rows[0] as { s: boolean; b: boolean };
    if (role?.s) throw new Error("앱 role 이 슈퍼유저입니다 — RLS 를 항상 우회하므로 활성화를 중단합니다");
    if (role?.b) throw new Error("앱 role 에 BYPASSRLS 가 있습니다 — RLS 를 항상 우회하므로 활성화를 중단합니다");
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [crypto.randomUUID()]);
    const n = Number((await client.query("SELECT count(*)::int AS n FROM org_profile")).rows[0]?.n);
    await client.query("ROLLBACK");
    if (n !== 0) throw new Error(`격리 검증 실패 — 남의 테넌트 컨텍스트에서 org_profile ${n}행이 보입니다`);
    let strictOk = false;
    try { await client.query("SELECT count(*) FROM org_profile"); }
    catch { strictOk = true; } // 컨텍스트 없음 → strict 식이 던져야 정상
    if (!strictOk) throw new Error("격리 검증 실패 — 컨텍스트 없는 조회가 오류 없이 통과했습니다(정책이 관대합니다)");
  } finally {
    await client.end().catch(() => {});
  }
}

export interface ActivationResult {
  tables: number;
  touched: number;
  app_dsn_host: string;
  primary_seeded: boolean;
}

/**
 * 활성화 본체 — **아직 registry 모드가 아닌**(= 소유자로 붙어 있는) 프로세스에서 부른다.
 * 성공 시 상태파일까지 기록한다. 호출자(capability)가 응답 후 프로세스를 끝내면 재기동으로 완성된다.
 */
export async function activateWorkspaceRegistry(opts: {
  /** 활성화한 관리자의 member id — primary 워크스페이스의 owner 로 시드된다. */
  ownerMember: string;
  /** 앱 DSN 직접 지정(소켓 DSN 등 자동 변환 불가 시). 미지정이면 소유자 DSN 에서 만든다. */
  appDsn?: string;
}): Promise<ActivationResult> {
  const ownerDsn = process.env.LIVELY_OWNER_DATABASE_URL || process.env.ITEMS_DATABASE_URL || "";
  if (!ownerDsn) throw new Error("ITEMS_DATABASE_URL 이 없습니다");

  const owner = String((await itemsPool.query("SELECT current_user AS u")).rows[0]?.u ?? "");
  const appRole = await currentAppRole(itemsPool);

  // ① 앱 role(DB별 파생명 — appRoleName 머리말) — 기존 상태파일이 **이 role 이름으로** 있으면 비밀번호를
  //  재사용한다(재활성화 = 정책 재보장, 자격 회전 아님). 이름이 다르면(구 상수명 등) 새로 만든다.
  const prior = readTenancyRuntimeSync();
  const priorUser = (() => { try { return prior ? new URL(prior.app_dsn).username : ""; } catch { return ""; } })();
  const roleExists = (await itemsPool.query("SELECT 1 FROM pg_roles WHERE rolname=$1", [appRole])).rows.length > 0;
  let password: string;
  if (prior && roleExists && priorUser === appRole && !opts.appDsn) {
    try { password = new URL(prior.app_dsn).password; } catch { password = ""; }
    if (!password) { password = crypto.randomBytes(24).toString("base64url"); await itemsPool.query(`ALTER ROLE ${qi(appRole)} PASSWORD '${password}'`); }
  } else {
    password = crypto.randomBytes(24).toString("base64url");
    // 비밀번호는 식별자가 아니라 리터럴 — base64url 은 따옴표·백슬래시가 없어 안전하다(생성 직후라 주입면 없음).
    await itemsPool.query(roleExists
      ? `ALTER ROLE ${qi(appRole)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD '${password}'`
      : `CREATE ROLE ${qi(appRole)} NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE LOGIN PASSWORD '${password}'`);
  }
  await grantAppRole(itemsPool, owner, appRole);

  // ② 정책 전수 보장(멱등) — 콘텐츠 테이블 전부.
  const pol = await ensureTenantPolicies(itemsPool);

  // ③ primary 등록부 시드 — 기존 박스 워크스페이스가 그대로 primary 가 된다.
  const orgName = String((await itemsPool.query("SELECT name FROM org_profile WHERE id=1")).rows[0]?.name ?? "") || "우리 워크스페이스";
  const seeded = (await itemsPool.query(
    `INSERT INTO gw_workspace(id, slug, name, kind, owner_member)
     VALUES($1, $2, $3, 'team', $4) ON CONFLICT (id) DO NOTHING`,
    [SINGLE_TENANT_ID, PRIMARY_SLUG, orgName, opts.ownerMember])).rowCount === 1;
  await itemsPool.query(
    `INSERT INTO gw_workspace_member(workspace_id, member_id, role) VALUES($1,$2,'owner') ON CONFLICT DO NOTHING`,
    [SINGLE_TENANT_ID, opts.ownerMember]);
  invalidateRegistryCache();

  // ④ 실접속 검증 — 실패하면 여기서 던지고 상태파일은 쓰지 않는다.
  const appDsn = opts.appDsn?.trim() || buildAppDsn(ownerDsn, appRole, password);
  await verifyAppIsolation(appDsn);

  // ⑤ 상태파일 — 다음 부팅부터 registry 모드.
  await writeTenancyRuntime({ mode: "registry", app_dsn: appDsn });
  logger.info({ tables: pol.tables, touched: pol.touched }, "워크스페이스 등록부 활성화 — 재기동 후 registry 모드로 뜹니다");
  let host = "";
  try { host = new URL(appDsn).host; } catch { /* 표시용일 뿐 */ }
  return { tables: pol.tables, touched: pol.touched, app_dsn_host: host, primary_seeded: seeded };
}

// ── 부팅 자동 활성화(#1750 후속) — 사람 손 0 이 목표다 ─────────────────────────
//
// 처음 구현은 활성화를 admin capability 1회 호출로 남겼다. 그 결과가 나쁜 플로우였다: 신규 설치도
//  단일 모드로 뜨고, 스위처엔 만들기 UI 가 안 보이고(registry 모드에서만 노출), 관리자가 숨은 API 를
//  알아야 했다 — "셀프서브"가 아니었다. 그래서 **부팅이 스스로 활성화한다**: 단일 모드로 뜬 부팅
//  하우스키핑이 여기를 지나며 활성화하고 1회 재기동한다. 신규 설치는 첫 부팅에, 기존 박스는 다음
//  업데이트 재기동에 자동으로 넘어온다 — 설치·업데이트 스크립트는 한 줄도 몰라도 된다.
//
// 실패 방향: **fail-closed 로 단일 모드 유지**(활성화의 검증 게이트가 상태파일을 안 쓴다) + 경고 로그
//  + 상태 API 노출. 격리가 덜 된 채 다중으로 뜨는 것보다 종전 단일로 남는 것이 항상 낫다.

/** 자동 활성화 대상인가(순수) — 아닌 이유가 곧 로그 문구다. */
export function autoActivationEligible(env: NodeJS.ProcessEnv = process.env): { ok: boolean; reason: string } {
  // 명시 opt-out — 매니지드 테넌트 컨테이너(CP 가 워크스페이스 축의 권위 — 테넌트 안 다중 ws 는 CP 캡 우회가
  //  된다)와, 운영자가 원치 않는 박스의 탈출구. lvly-cloud 프로비저너가 테넌트 env 에 심는다.
  if ((env.LIVELY_WORKSPACE_REGISTRY || "").trim().toLowerCase() === "off") return { ok: false, reason: "LIVELY_WORKSPACE_REGISTRY=off" };
  if (registryModeActive(env)) return { ok: false, reason: "이미 registry 모드" };
  if ((env.LIVELY_TENANT_HEADER_SECRET || "").trim()) return { ok: false, reason: "매니지드 공유 게이트웨이(CP 헤더 모드)" };
  // fixed/request(매니지드 공용 DB) — 그 배포의 테넌시는 CP 소유다. registry 를 겹치면 권위가 둘이 된다.
  if ((env.LIVELY_TENANT_BINDING || "").trim()) return { ok: false, reason: "외부 관리 바인딩(fixed/request)" };
  if (!env.ITEMS_DATABASE_URL) return { ok: false, reason: "DB 미설정" };
  return { ok: true, reason: "" };
}

// 마지막 자동 활성화 실패 사유 — 상태 API(workspace_registry_status)가 admin 에게 보여준다.
//  로그는 흘러가지만 이 값은 남는다: "왜 아직 single 인가"를 화면에서 답할 수 있어야 수동 복구(app_dsn)로 이어진다.
let lastAutoActivationError: string | null = null;
export function lastActivationError(): string | null { return lastAutoActivationError; }

export type AutoActivateStatus = "activated" | "skipped" | "failed";

/**
 * 부팅 하우스키핑용 — 대상이면 활성화까지 한다. "activated" 를 받으면 **호출자가 프로세스를 재기동**해야
 *  한다(앱 role 재배선은 첫 import 시점이라 살아 있는 프로세스에선 불가능하다).
 */
export async function autoActivateWorkspaceRegistry(): Promise<{ status: AutoActivateStatus; reason?: string }> {
  const e = autoActivationEligible();
  if (!e.ok) return { status: "skipped", reason: e.reason };
  try {
    // primary 의 owner 표시용 — 첫 admin 멤버, 아직 없으면(신규 설치 첫 부팅) 'system'.
    //  primary 는 명부를 안 보는 워크스페이스라 이 값은 표시 이상의 권한이 아니다.
    const admin = await itemsPool.query(
      `SELECT id FROM org_member WHERE state='active' AND scopes @> '["admin"]'::jsonb ORDER BY created_at LIMIT 1`,
    ).then((r) => String(r.rows[0]?.id ?? "")).catch(() => "");
    await activateWorkspaceRegistry({ ownerMember: admin || "system" });
    lastAutoActivationError = null;
    return { status: "activated" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastAutoActivationError = msg;
    logger.warn({ err }, "다중 워크스페이스 자동 활성화 실패 — 단일 모드로 계속(수동: workspace_activate, 소켓 DSN 이면 app_dsn 지정)");
    return { status: "failed", reason: msg };
  }
}
