// `tenant_id` 를 **코어의 정식 컬럼**으로 만든다 — 스키마 정의 129개를 손으로 고치지 않고. (#1437 v1)
//
// ── 왜 코어가 이 컬럼을 갖는가 ──────────────────────────────────────────────
// 멀티테넌트 배포에서 자연키 UNIQUE 는 `(tenant_id, …)` 여야 한다(두 워크스페이스가 같은 이름을
//  쓸 수 있어야 하므로). 그런데 그렇게 바꾸면 **`ON CONFLICT (name)` 이 그 인덱스를 추론하지 못한다**:
//     error: there is no unique or exclusion constraint matching the ON CONFLICT specification
//  코어에는 `ON CONFLICT` 가 116곳 있다. 배포 모드마다 다른 SQL 을 쓰면 "빠뜨리면 터지는" 자리가
//  50~60개 생기고, 새 쿼리를 쓸 때마다 다시 걸린다.
//
// 그래서 **SQL 방언을 하나로** 만든다: 컬럼과 복합 UNIQUE 를 **양쪽 배포에 다 둔다.**
//  단일 테넌트에서는 값이 상수라 아무것도 달라지지 않는다(행마다 uuid 16바이트가 늘 뿐이다).
//  멀티테넌트에서는 그 위에 RLS 정책이 얹힌다(정책은 매니지드 배포가 건다 — 코어는 안 건다).
//
// ── 기본값이 한 식으로 두 모드를 덮는다 ────────────────────────────────────
//   COALESCE(current_setting('app.tenant_id', true), '<단일테넌트 UUID>')::uuid
//  · 자가호스팅: GUC 가 없으니 상수로 떨어진다.
//  · 매니지드:   컨텍스트가 있으면 그 값. 없으면 상수로 떨어지지만 **정책이 막는다** —
//    정책은 `current_setting('app.tenant_id')` 를 **missing_ok 없이** 읽으므로 그 자리에서 오류다.
//    즉 조용히 엉뚱한 소속으로 들어가지 않는다. 엄격함은 정책이 갖고, 기본값은 관대해도 된다.
//
// ── 왜 introspection 인가 ───────────────────────────────────────────────────
// 테이블이 129개고 계속 는다. 스키마 정의를 손으로 고치면 새 테이블이 생길 때마다 빠뜨린다.
//  카탈로그에 물어보면 **새 테이블이 자동으로 대상**이 된다.

import { itemsPool } from "./client.js";

/** 단일 테넌트 배포에서 모든 행이 갖는 값. 이 값 자체에 의미는 없다 — 상수라는 것이 전부다. */
export const SINGLE_TENANT_ID = "00000000-0000-0000-0000-000000000000";

/** 두 모드를 한 식으로 덮는 기본값. 엄격함은 정책이 갖는다(위 머리말). */
export const TENANT_DEFAULT_EXPR =
  `COALESCE(current_setting('app.tenant_id', true), '${SINGLE_TENANT_ID}')::uuid`;

/**
 * 신원·전역 표(#1750) — 컬럼은 두되 **값을 상수로 못박는다**.
 *
 * 계정은 박스에 하나다(사람·세션·토큰·자격은 워크스페이스를 넘나든다). 매니지드 쪽 정책 계층은
 *  이 표들에 RLS 를 걸지 않는다(org/tenancy/activate.ts) — 거기 머리말은 오래도록 "컬럼은 남지만
 *  정책이 없으면 불활성이다 — 무해한 16바이트" 라고 적혀 있었다. **그 전제가 틀렸다.**
 *
 * 정책이 없어도 **기본값은 살아 있다**. TENANT_DEFAULT_EXPR 은 `current_setting('app.tenant_id')` 를
 *  따라가므로, 비-primary 워크스페이스 컨텍스트에서 들어온 INSERT 는 PK (tenant_id, id) 아래
 *  **같은 사람의 행을 하나 더** 만든다. 그러면
 *   · audit() 의 스칼라 서브쿼리가 2행을 받아 `more than one row returned by a subquery` —
 *     감사가 걸린 **모든 org 쓰기가 500**. 오류는 INSERT **뒤에** 나므로 데이터는 들어가고 응답만 실패한다.
 *   · getMember() 류의 tenant 없는 조회가 **아무 행이나** 돌려준다.
 *  실측 2026-08-27 dev.lvly.io(#1879): 개인 워크스페이스에서 온보딩 1막이 이름을 저장한 것이 방아쇠였다.
 *
 * 그래서 이 표들의 기본값만 상수로 되돌린다 — 그러면 위 머리말이 **비로소 참이 된다**.
 * ⚠ 늘리는 것은 "이 표엔 워크스페이스 사유 데이터가 절대 없다"는 판단이다.
 *
 * ★★ 단, **바깥 정책 계층이 tenant_isolation 을 걸어 둔 표는 못박지도 접지도 않는다**(#2198, 2026-08-27 실측).
 *  매니지드 공용 DB(lvly-cloud tenantrls)에서는 '테넌트'가 워크스페이스가 아니라 **고객사**라 토큰·세션·구성원도
 *  테넌트별이고, 그 표들에 FORCE RLS + tenant_isolation 이 걸려 있다. 그 위에서 이 못박기가 돌자 auth_token
 *  290/290 · web_session 325/325 행이 단일테넌트 UUID 로 옮겨졌고 정책이 그 행을 어느 테넌트에도 안 보여 줘
 *  전 테넌트가 invalid_token(app.lvly.io 워크스페이스 열기 500)이 됐다. "정책이 걸린 표"는 그 배포가
 *  테넌트별로 쓰는 표다 — 판정은 identityGlobalPinPlan(순수)에 있다.
 */
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

/** 신원 전역 표의 기본값 — 컨텍스트를 **보지 않는다**. 이게 상수라야 계정이 하나로 남는다. */
export const IDENTITY_GLOBAL_DEFAULT_EXPR = `'${SINGLE_TENANT_ID}'::uuid`;

/** 검사·변경에서 제외 — 테넌트 축이 없는 것이 정상인 테이블. */
export const TENANT_COLUMN_EXEMPT: ReadonlySet<string> = new Set([
  "schema_migrations",
  // #1750 S1 — 셀프호스트 워크스페이스 등록부: "이 배포에 어떤 워크스페이스가 있나"라는 배포 전체의
  //  사실이라 테넌트 축 위에 놓을 수 없다(자기 자신을 못 찾는 부트스트랩 순환). 매니지드의 CP
  //  tenants/workspaces 테이블에 해당하는 코어판. ⚠ lvly-cloud tenantrls.RLS_EXEMPT_TABLES 에도 등재
  //  필수(안 하면 공용 DB 게이트가 프로비저닝을 fail-closed 로 막는다).
  "gw_workspace",
  "gw_workspace_member",
  "gw_session_map", // 세션→워크스페이스 정본(#1750 후속) — 컨텍스트를 열기 **전에** 읽는 표라 테넌트 축 밖
  // #1875 — 구성원 초대. 받는 사람은 **자기 워크스페이스**에서 "나에게 온 초대"를 보는데 그건 초대한
  //  워크스페이스의 컨텍스트가 아니다. 테넌트 축 위에 있으면 그 조회 자체가 성립하지 않는다.
  "gw_workspace_invite",

  // #1291 v3 self-rls 의 스코프 전달 표 — **pg_backend_pid() 키** 프로세스 인프라다(각 백엔드가 제 pid 행만
  //  본다). 테넌트 축을 붙이면 PK(pid,kind,key)가 자연키로 판정돼 (tenant_id,…) 재작성이 일어나는데,
  //  이 표의 격리 축은 테넌트가 아니라 pid 라 재작성이 의미 없고 self-rls 의 정책 조인만 흔든다.
  //  reader 역의 테넌트 격리는 정책 쪽(org/tenancy/activate.ts 의 RESTRICTIVE tenant_restrict_reader)이 담당.
  "lively_vis_scope",
]);

function qi(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)) throw new Error(`안전하지 않은 식별자: ${name}`);
  return `"${name}"`;
}

export interface TenantColumnPlan {
  /** 컬럼을 새로 붙일 테이블 */
  addColumn: string[];
  /** `(tenant_id, …)` 로 다시 만들 자연키 UNIQUE */
  rewriteUnique: Array<{ table: string; index: string; constraint: string | null; isPk: boolean; columns: string[]; partialDef: string | null }>;
  /** 함께 손봐야 하는 FK */
  rewriteFk: Array<{ name: string; table: string; columns: string[]; refTable: string; refColumns: string[]; onDelete: string; onUpdate: string }>;
}

/**
 * 자연키 판정(순수) — 공용 테이블에서 UNIQUE 가 안전한 조건은 "컬럼 중 하나라도 전역 유일".
 *  ⓐ 대리키(단일컬럼 UNIQUE + **전역 생성기** 기본값/identity) — `id serial PRIMARY KEY` 가 그대로 유효한 이유
 *  ⓑ 그 대리키를 가리키는 FK — `project_member(project_id, member_id)` 가 안전한 이유
 * 둘 다 없으면 자연키다: 두 테넌트가 **같은 값을 쓰고 싶어 한다**.
 *
 * ★★ "기본값이 있으면 대리키" 는 **틀린 규칙**이다(실측으로 밟았다). 싱글턴 테이블의
 *  `id integer PRIMARY KEY DEFAULT 1` 도 기본값이 있지만 그 값은 **모든 테넌트가 똑같이 1** 이다 —
 *  전역 유일이 아니라 전역 **충돌**이다. 실 DB 에서 org_profile·org_runtime_config·
 *  knowledge_view_config 셋이 여기 해당했고, 그래서 두 번째 테넌트를 만들면 프로비저닝이
 *  `23505 duplicate key` 로 죽었다. `project_status_template.is_default DEFAULT false` 도 같은 부류다.
 *  판정 기준은 "기본값의 유무"가 아니라 **그 기본값이 값을 새로 만들어내는가**(SURROGATE_GEN_RE)다.
 */
export function isNaturalKey(table: string, columns: string[], globalColumns: ReadonlySet<string>): boolean {
  return !columns.some((c) => globalColumns.has(`${table}.${c}`));
}

/** 부분 UNIQUE 정의에 tenant_id 를 끼운다(순수). 형태를 못 알아보면 null — **추측하지 않는다**. */
export function rewritePartialUniqueDef(def: string): string | null {
  const m = /^(CREATE UNIQUE INDEX .+? USING [a-z_]+ \()/i.exec(def);
  return m ? `${m[1]}tenant_id, ${def.slice(m[1].length)}` : null;
}

const FK_ACTION: Record<string, string> = { a: "NO ACTION", r: "RESTRICT", c: "CASCADE", n: "SET NULL", d: "SET DEFAULT" };

/**
 * 계획 → DDL(순수). 순서가 중요하다: **FK 를 먼저 떼고 → 키를 재작성하고 → FK 를 다시 만든다.**
 *  ②를 먼저 하면 FK 가 존재하지 않는 키를 가리켜 실패한다.
 */
export function buildTenantColumnDdl(plan: TenantColumnPlan): string[] {
  const ddl: string[] = [];
  for (const t of plan.addColumn) {
    const tbl = qi(t);
    ddl.push(`ALTER TABLE ${tbl} ADD COLUMN tenant_id uuid DEFAULT ${TENANT_DEFAULT_EXPR}`);
    ddl.push(`UPDATE ${tbl} SET tenant_id = ${TENANT_DEFAULT_EXPR} WHERE tenant_id IS NULL`);
    ddl.push(`ALTER TABLE ${tbl} ALTER COLUMN tenant_id SET NOT NULL`);
    ddl.push(`CREATE INDEX IF NOT EXISTS ${qi(`${t}_tenant_idx`)} ON ${tbl} (tenant_id)`);
  }
  for (const f of plan.rewriteFk) ddl.push(`ALTER TABLE ${qi(f.table)} DROP CONSTRAINT ${qi(f.name)}`);
  for (const u of plan.rewriteUnique) {
    const tbl = qi(u.table);
    const cols = ["tenant_id", ...u.columns].map(qi).join(", ");
    if (u.isPk) {
      ddl.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${qi(u.constraint ?? u.index)}`);
      ddl.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${qi(u.constraint ?? u.index)} PRIMARY KEY (${cols})`);
    } else if (u.constraint) {
      ddl.push(`ALTER TABLE ${tbl} DROP CONSTRAINT ${qi(u.constraint)}`);
      ddl.push(`ALTER TABLE ${tbl} ADD CONSTRAINT ${qi(u.constraint)} UNIQUE (${cols})`);
    } else if (u.partialDef) {
      const rewritten = rewritePartialUniqueDef(u.partialDef);
      if (!rewritten) continue;   // 못 알아본 건 건너뛴다(추측하지 않는다)
      ddl.push(`DROP INDEX ${qi(u.index)}`);
      ddl.push(rewritten);
    } else {
      ddl.push(`DROP INDEX ${qi(u.index)}`);
      ddl.push(`CREATE UNIQUE INDEX ${qi(u.index)} ON ${tbl} (${cols})`);
    }
  }
  for (const f of plan.rewriteFk) {
    ddl.push(
      `ALTER TABLE ${qi(f.table)} ADD CONSTRAINT ${qi(f.name)} ` +
      `FOREIGN KEY (${["tenant_id", ...f.columns].map(qi).join(", ")}) ` +
      `REFERENCES ${qi(f.refTable)} (${["tenant_id", ...f.refColumns].map(qi).join(", ")}) ` +
      `ON DELETE ${FK_ACTION[f.onDelete] ?? "NO ACTION"} ON UPDATE ${FK_ACTION[f.onUpdate] ?? "NO ACTION"}`,
    );
  }
  return ddl;
}

// ── 신원 전역 표 못박기(#1879) ──────────────────────────────────────────────

/**
 * 기본값을 상수로 되돌린다(멱등). `ensureTenantColumn` 은 컬럼이 **없는** 표에만 손대므로
 *  이미 붙어 있는 컬럼의 기본값은 여기서 따로 고친다(선례: org_runtime_config.ui_mode SET DEFAULT).
 */
export function buildIdentityGlobalPinDdl(tables: readonly string[]): string[] {
  return tables.map((t) => `ALTER TABLE ${qi(t)} ALTER COLUMN tenant_id SET DEFAULT ${IDENTITY_GLOBAL_DEFAULT_EXPR}`);
}

/**
 * 이미 갈라진 행을 primary 로 접는다 — **짝이 없는 것만**.
 *
 * 짝이 있으면(primary 에 같은 키가 이미 있으면) 두 행 중 어느 쪽이 맞는지는 사람만 안다:
 *  워크스페이스에서 쌓은 값이 진짜일 수도, primary 가 진짜일 수도 있다. 자동으로 고르면 데이터를
 *  잃는다. 그래서 **옮기지 않고 남겨 두고 보고만 한다** — 이 문장은 행을 지우지도 덮어쓰지도 않는다.
 *  남은 행이 다시 500 을 내지 않도록 읽는 쪽(audit)이 테넌트로 못박혀 있다.
 */
export function buildIdentityGlobalFoldSql(table: string, keyColumns: readonly string[]): string {
  const keys = keyColumns.map((c) => String(c || "").trim()).filter(Boolean);
  // 빈 키(그리고 공백만 든 배열)로는 '같은 행'을 가를 수 없다 — 조건 없는 UPDATE 는 전량 이동이다.
  if (!keys.length) throw new Error(`${table}: 키 컬럼을 모르면 접기 문장을 만들 수 없다`);
  const tbl = qi(table);
  const match = keys.map((c) => `p.${qi(c)} = x.${qi(c)}`).join(" AND ");
  // ⚠ NOT EXISTS 만으로는 **옮기는 행끼리의 충돌**을 못 막는다(실측 사고 2026-08-27, c60 롤에서
  //  `duplicate key value violates unique constraint "member_credential_pkey"` 로 스키마 초기화가 죽었다).
  //  secondary 두 워크스페이스에 같은 키의 행이 하나씩 있으면 **둘 다** primary 에 짝이 없으므로 둘 다
  //  통과하고, 같은 키 두 행이 primary 로 들어가 PK 를 깬다. 그래서 키마다 **한 행만**(ctid 최소) 옮긴다.
  //  나머지는 그 자리에 남고 아래 conflicts 집계가 사람에게 보고한다 — 자동으로 고르지 않는다는 원칙 그대로다.
  return `UPDATE ${tbl} x SET tenant_id = ${IDENTITY_GLOBAL_DEFAULT_EXPR}
     WHERE x.tenant_id <> ${IDENTITY_GLOBAL_DEFAULT_EXPR}
       AND NOT EXISTS (SELECT 1 FROM ${tbl} p WHERE p.tenant_id = ${IDENTITY_GLOBAL_DEFAULT_EXPR} AND ${match})
       AND x.ctid = (SELECT min(d.ctid) FROM ${tbl} d
                      WHERE d.tenant_id <> ${IDENTITY_GLOBAL_DEFAULT_EXPR}
                        AND ${keys.map((c) => `d.${qi(c)} = x.${qi(c)}`).join(" AND ")})`;
}

// ── 카탈로그 ────────────────────────────────────────────────────────────────
// ⚠ `pg_constraint.conindid` 는 **FK 도 가리킨다** — contype 을 p·u 로 좁히지 않으면 PK 이름 자리에
//  FK 이름이 들어가 `ADD CONSTRAINT <fk이름> PRIMARY KEY` 라는 헛소리가 생성된다(실측으로 밟았다).

const SQL_TABLES = `SELECT c.relname::text t FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND NOT c.relispartition
    AND NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)`;

/**
 * 전역 유일을 **만들어내는** 기본값만 인정한다. 상수(`1`, `false`)는 값을 만들지 않으므로 제외 —
 *  그게 싱글턴 테이블을 대리키로 오인하던 구멍이었다(isNaturalKey 머리말).
 */
export const SURROGATE_GEN_RE = "(nextval|gen_random_uuid|uuid_generate)";

const SQL_SURROGATE = `SELECT c.relname::text t, a.attname::text col FROM pg_class c
  JOIN pg_namespace n ON n.oid=c.relnamespace
  JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
  LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum
  WHERE n.nspname='public' AND c.relkind='r' AND a.attname<>'tenant_id'
    AND (a.attidentity<>'' OR pg_get_expr(d.adbin,d.adrelid) ~* '${SURROGATE_GEN_RE}')
    AND EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid=c.oid AND i.indisunique
                  AND array_length(i.indkey::int2[],1)=1 AND a.attnum=ANY(i.indkey::int2[]))`;

const SQL_FK = `SELECT ct.conname::text name, c.relname::text tbl, fc.relname::text ref_table,
    ct.confdeltype::text on_delete, ct.confupdtype::text on_update,
    (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(ct.conkey) WITH ORDINALITY x(k,ord)
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.k) cols,
    (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(ct.confkey) WITH ORDINALITY x(k,ord)
       JOIN pg_attribute a ON a.attrelid=fc.oid AND a.attnum=x.k) ref_cols
  FROM pg_constraint ct JOIN pg_class c ON c.oid=ct.conrelid JOIN pg_class fc ON fc.oid=ct.confrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ct.contype='f' AND n.nspname='public'`;

const SQL_UNIQUE = `SELECT c.relname::text tbl, ic.relname::text idx, i.indisprimary is_pk,
    i.indpred IS NOT NULL is_partial, pg_get_indexdef(i.indexrelid) def,
    (SELECT ct.conname::text FROM pg_constraint ct WHERE ct.conindid=i.indexrelid AND ct.contype IN ('p','u') LIMIT 1) cname,
    (SELECT array_agg(a.attname::text ORDER BY x.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY x(k,ord)
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.k) cols
  FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid JOIN pg_class ic ON ic.oid=i.indexrelid
  JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND i.indisunique AND NOT c.relispartition`;

/**
 * `tenant_id` 와 복합 UNIQUE 를 보장한다(멱등). 스키마 초기화 **직후**에 부른다.
 *
 * ⚠ 전 과정을 **한 트랜잭션**에서 돌린다 — 중간에 끊기면 UNIQUE 없는 구간이 생기고, 그때 들어온
 *  중복 행은 나중에 되돌릴 수 없다(제약을 다시 걸 수 없게 된다).
 */
/** 신원 전역 표의 현재 모습 — tenant_id 컬럼이 있나, PK 는 무엇인가, **바깥 정책 계층이 테넌트로 격리해 뒀나**(#2198). */
export const SQL_IDENTITY_GLOBAL = `SELECT c.relname::text t,
    (SELECT array_agg(a.attname::text ORDER BY x.ord)
       FROM pg_index i, unnest(i.indkey::int2[]) WITH ORDINALITY x(k,ord)
       JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=x.k
      WHERE i.indrelid=c.oid AND i.indisprimary AND a.attname<>'tenant_id') pk,
    (c.relrowsecurity AND c.relforcerowsecurity) AS rls_forced,
    EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = c.oid AND p.polname = 'tenant_isolation') AS tenant_policy
  FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relkind='r' AND c.relname = ANY($1::text[])
    AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='tenant_id' AND a.attnum>0 AND NOT a.attisdropped)`;

export interface IdentityGlobalTableState {
  t: string;
  pk: string[] | null;
  /** RLS 가 켜지고 **강제**돼 있나 — 소유자도 정책 대상인 표(테넌트 격리 계층이 건 것). */
  rls_forced: boolean;
  /** `tenant_isolation` 정책이 있나 — 코어 activate.ts 와 lvly-cloud tenantrls 가 같은 이름을 쓴다. */
  tenant_policy: boolean;
}

/**
 * 못박기 계획(순수) — 어느 표를 못박고(전역화) 어느 표를 건너뛰나.
 *
 * ★★ tenant_isolation 정책이나 FORCE RLS 가 걸린 표는 **그 배포가 테넌트별로 쓰는 표**다. 코어의
 *  ensureTenantPolicies 는 신원 전역 표에 정책을 걸지 않으므로, 정책이 있다면 바깥 계층(매니지드 공용 DB 의
 *  lvly-cloud tenantrls — 거기서 테넌트 = 고객사)이 건 것이다. 그 표를 못박고 접으면 행이 단일테넌트 UUID 로
 *  가는데 정책은 그 행을 어느 테넌트에도 안 보여 준다 — 전 테넌트 로그인 장애(#2198). 그래서 건너뛴다.
 *  셀프호스트 registry 모드의 신원 표엔 정책이 없으므로 종전대로 전부 못박는다(무회귀).
 */
export function identityGlobalPinPlan(rows: IdentityGlobalTableState[]): { pin: IdentityGlobalTableState[]; skipped: string[] } {
  const pin: IdentityGlobalTableState[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    if (r.tenant_policy || r.rls_forced) skipped.push(r.t);
    else pin.push(r);
  }
  return { pin, skipped };
}

/**
 * 신원 전역 표의 tenant_id 를 primary 로 못박고, 이미 갈라진 행을 접는다(#1879).
 *
 * `ensureTenantColumn()` **뒤에** 돈다 — 컬럼이 붙은 다음이라야 기본값을 고칠 수 있다.
 *  멱등이고, 접기는 짝이 없는 행만 옮긴다(지우지도 덮어쓰지도 않는다).
 *  짝이 남은 표는 **경고로 알린다** — 사람이 어느 쪽을 남길지 정해야 하는 자리다.
 */
export async function pinIdentityGlobalTenant(): Promise<{ pinned: number; folded: number; conflicts: string[]; skipped: string[] }> {
  const names = [...IDENTITY_GLOBAL_TABLES];
  const all = (await itemsPool.query(SQL_IDENTITY_GLOBAL, [names])).rows as unknown as IdentityGlobalTableState[];
  // ★ 바깥 정책 계층이 테넌트로 격리한 표는 건드리지 않는다(#2198) — 판정은 순수 함수에.
  const { pin: rows, skipped } = identityGlobalPinPlan(all);
  if (!rows.length) return { pinned: 0, folded: 0, conflicts: [], skipped };

  for (const sql of buildIdentityGlobalPinDdl(rows.map((r) => r.t))) await itemsPool.query(sql);

  let folded = 0;
  const conflicts: string[] = [];
  for (const r of rows) {
    const pk = (r.pk ?? []).filter(Boolean);
    // PK 를 못 읽었으면 접지 않는다 — 어떤 행이 '같은 행'인지 모르는 채로 옮기면 남의 행을 덮는다.
    if (!pk.length) { conflicts.push(`${r.t}(PK 불명 — 접기 건너뜀)`); continue; }
    folded += (await itemsPool.query(buildIdentityGlobalFoldSql(r.t, pk))).rowCount ?? 0;
    const left = (await itemsPool.query(
      `SELECT count(*)::int n FROM ${qi(r.t)} WHERE tenant_id <> ${IDENTITY_GLOBAL_DEFAULT_EXPR}`)).rows[0]?.n ?? 0;
    if (left > 0) conflicts.push(`${r.t}(${left}행 — primary 에 같은 키가 이미 있다)`);
  }
  return { pinned: rows.length, folded, conflicts, skipped };
}

export async function ensureTenantColumn(): Promise<{ tables: number; ddl: number }> {
  const client = await itemsPool.connect();
  try {
    const missing = (await client.query(SQL_TABLES)).rows
      .map((r) => String(r.t)).filter((t) => !TENANT_COLUMN_EXEMPT.has(t));
    const sur = (await client.query(SQL_SURROGATE)).rows;
    const fks = (await client.query(SQL_FK)).rows;
    const uq = (await client.query(SQL_UNIQUE)).rows;

    const globalColumns = new Set(sur.map((r) => `${r.t}.${r.col}`));
    for (const f of fks) {
      const p = (f.ref_cols ?? [])[0], c = (f.cols ?? [])[0];
      if (p && c && globalColumns.has(`${f.ref_table}.${p}`)) globalColumns.add(`${f.tbl}.${c}`);
    }

    const rewriteUnique = uq
      // ⚠ 표현식 인덱스(`lower(name)` 등)는 indkey 에 0 이 들어와 cols 가 불완전하다. 그걸 이유로
      //  건너뛰면 **그 자연키가 테넌트 간 전역 유일로 남는다**(실측: task_tag 의 태그 이름이 그랬다 —
      //  A 가 'urgent' 를 쓰면 B 는 못 쓴다). 정의(pg_get_indexdef)로 재작성한다.
      .filter((x) => !(x.cols ?? []).includes("tenant_id"))
      .filter((x) => !TENANT_COLUMN_EXEMPT.has(String(x.tbl)))
      // 컬럼을 다 못 읽은 인덱스(표현식)는 **자연키로 본다** — 표현식 유니크는 거의 언제나
      //  이름·경로 같은 자연키이고, 판단이 애매할 때 넓게 잡으면 최악이 "덜 필요한 컬럼 하나 추가"다.
      .filter((x) => {
        const cols = (x.cols ?? []) as string[];
        return !cols.length || isNaturalKey(String(x.tbl), cols, globalColumns);
      })
      .map((x) => ({
        table: String(x.tbl), index: String(x.idx), constraint: x.cname ?? null,
        isPk: !!x.is_pk, columns: (x.cols ?? []) as string[],
        // 부분(WHERE) 또는 표현식 — 둘 다 원본 정의를 보존하며 재작성해야 한다.
        partialDef: (x.is_partial || !(x.cols ?? []).length) ? String(x.def) : null,
      }));

    const targetKey = new Set(rewriteUnique.map((u) => `${u.table}|${u.columns.join(",")}`));
    const rewriteFk = fks
      .filter((f) => targetKey.has(`${f.ref_table}|${(f.ref_cols ?? []).join(",")}`))
      .map((f) => ({
        name: String(f.name), table: String(f.tbl), columns: f.cols as string[],
        refTable: String(f.ref_table), refColumns: f.ref_cols as string[],
        onDelete: String(f.on_delete), onUpdate: String(f.on_update),
      }));

    const ddl = buildTenantColumnDdl({ addColumn: missing, rewriteUnique, rewriteFk });
    if (!ddl.length) return { tables: 0, ddl: 0 };

    await client.query("BEGIN");
    try {
      for (const sql of ddl) await client.query(sql);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK").catch(() => { /* 이미 죽은 커넥션 */ });
      throw e;
    }
    return { tables: missing.length, ddl: ddl.length };
  } finally {
    client.release();
  }
}
