import { strict as assert } from "node:assert";
import test from "node:test";
import {
  IDENTITY_GLOBAL_DEFAULT_EXPR, SINGLE_TENANT_ID, SQL_IDENTITY_GLOBAL, SURROGATE_GEN_RE, TENANT_DEFAULT_EXPR,
  buildIdentityGlobalFoldSql, buildIdentityGlobalPinDdl, buildTenantColumnDdl, identityGlobalPinPlan, isNaturalKey,
  rewritePartialUniqueDef,
} from "./tenant-column.js";

const G = (...pairs: string[]) => new Set(pairs);

// ── OSS 무회귀: 이 컬럼은 자가호스팅에서 상수 하나짜리 컬럼이다 ───────────────

test("★★ 기본값 한 식이 두 모드를 덮는다 — 컨텍스트가 없으면 단일 테넌트로 떨어진다", () => {
  assert.match(TENANT_DEFAULT_EXPR, /current_setting\('app\.tenant_id', true\)/);
  assert.ok(TENANT_DEFAULT_EXPR.includes(SINGLE_TENANT_ID));
  // ★ 기본값은 **관대**해야 한다. 엄격하면(missing_ok 없이 읽으면) 컨텍스트 없이 도는
  //  마이그레이션·시드의 INSERT 가 전부 42704 로 죽는다 — 실측으로 밟았다(initOrgCore).
  //  엄격함은 정책이 갖는다.
  assert.ok(!/current_setting\('app\.tenant_id'\)/.test(TENANT_DEFAULT_EXPR), "기본값이 엄격하면 안 된다");
});

// ── 자연키 판정 ─────────────────────────────────────────────────────────────

test("전역 유일 컬럼이 하나라도 있으면 자연키가 아니다 — 그대로 두는 것이 맞다", () => {
  const g = G("task.id", "task_assignee.task_id");
  assert.equal(isNaturalKey("task", ["id"], g), false);
  assert.equal(isNaturalKey("task_assignee", ["task_id", "member_id"], g), false);
});

test("전역 유일이 없으면 자연키다 — 두 테넌트가 같은 값을 쓰고 싶어 한다", () => {
  assert.equal(isNaturalKey("knowledge", ["name"], G("task.id")), true);
  assert.equal(isNaturalKey("category", ["key"], G()), true);
});

// ★★ 여기가 이 파일의 핵심 명제다. "기본값이 있으면 대리키" 는 틀렸다 —
//  싱글턴의 `DEFAULT 1` 은 값을 만들지 않고 **모든 테넌트가 똑같이 1** 이라 전역 충돌이다.
//  실측: org_profile·org_runtime_config·knowledge_view_config 가 그래서 두 번째 테넌트
//  프로비저닝에서 23505 로 죽었다.
test("★★ 전역 생성기만 대리키로 인정한다 — 상수 기본값은 값을 만들지 않는다", () => {
  const re = new RegExp(SURROGATE_GEN_RE, "i");
  for (const gen of ["nextval('task_id_seq'::regclass)", "gen_random_uuid()", "uuid_generate_v4()"]) {
    assert.ok(re.test(gen), `전역 생성기여야 한다: ${gen}`);
  }
  for (const konst of ["1", "false", "''::text", "now()", "0"]) {
    assert.ok(!re.test(konst), `대리키로 오인하면 안 된다: ${konst}`);
  }
});

// ── 부분·표현식 UNIQUE ──────────────────────────────────────────────────────

test("부분 UNIQUE 는 WHERE 절을 보존하며 tenant_id 를 앞에 끼운다", () => {
  const def = "CREATE UNIQUE INDEX org_member_email_lc_uniq ON public.org_member " +
    "USING btree (lower(email)) WHERE ((email IS NOT NULL) AND (email <> ''::text))";
  const out = rewritePartialUniqueDef(def)!;
  assert.match(out, /USING btree \(tenant_id, lower\(email\)\)/);
  assert.match(out, /WHERE \(\(email IS NOT NULL\)/, "조건이 사라지면 안 된다");
});

// ★ 못 알아본 정의를 **추측해서 고치지 않는다** — 잘못 고친 UNIQUE 는 조용히 중복을 허용한다.
test("★ 형태를 못 알아보면 null 이다(추측하지 않는다)", () => {
  assert.equal(rewritePartialUniqueDef("CREATE INDEX x ON y (z)"), null);
  assert.equal(rewritePartialUniqueDef("정체불명"), null);
});

// ── DDL 순서 ────────────────────────────────────────────────────────────────

// ★★ FK 를 먼저 떼지 않으면 키 재작성이 실패한다(FK 가 존재하지 않게 될 키를 가리킨다).
test("★★ FK 떼기 → 키 재작성 → FK 다시 걸기 순서다", () => {
  const ddl = buildTenantColumnDdl({
    addColumn: [],
    rewriteUnique: [{ table: "task", index: "task_pkey", constraint: "task_pkey", isPk: true, columns: ["id"], partialDef: null }],
    rewriteFk: [{ name: "fk", table: "task_assignee", columns: ["task_id"], refTable: "task", refColumns: ["id"], onDelete: "c", onUpdate: "a" }],
  });
  const drop = ddl.findIndex((s) => /DROP CONSTRAINT "fk"/.test(s));
  const pk = ddl.findIndex((s) => /PRIMARY KEY \("tenant_id", "id"\)/.test(s));
  const add = ddl.findIndex((s) => /ADD CONSTRAINT "fk" FOREIGN KEY/.test(s));
  assert.ok(drop >= 0 && drop < pk && pk < add, `순서가 틀렸다: drop=${drop} pk=${pk} add=${add}`);
});

// ★ FK 도 복합키가 되어야 한다 — FK 검사는 RLS 를 우회하므로, tenant_id 가 빠지면
//  **남의 테넌트 행을 가리키는 참조**가 만들어진다.
test("★ 다시 거는 FK 는 양쪽 모두 tenant_id 를 포함한다", () => {
  const ddl = buildTenantColumnDdl({
    addColumn: [],
    rewriteUnique: [],
    rewriteFk: [{ name: "fk", table: "a", columns: ["b_id"], refTable: "b", refColumns: ["id"], onDelete: "c", onUpdate: "a" }],
  });
  const s = ddl.find((x) => x.includes("ADD CONSTRAINT"))!;
  assert.match(s, /FOREIGN KEY \("tenant_id", "b_id"\) REFERENCES "b" \("tenant_id", "id"\)/);
  assert.match(s, /ON DELETE CASCADE ON UPDATE NO ACTION/, "동작을 잃으면 안 된다");
});

test("컬럼 추가는 채운 뒤 NOT NULL 을 건다 — 기존 행이 있으면 바로 걸 수 없다", () => {
  const ddl = buildTenantColumnDdl({ addColumn: ["k"], rewriteUnique: [], rewriteFk: [] });
  const i = (re: RegExp) => ddl.findIndex((s) => re.test(s));
  assert.ok(i(/ADD COLUMN tenant_id/) < i(/UPDATE "k" SET tenant_id/));
  assert.ok(i(/UPDATE "k" SET tenant_id/) < i(/SET NOT NULL/));
  assert.ok(i(/CREATE INDEX IF NOT EXISTS "k_tenant_idx"/) >= 0, "정책이 매 행에서 읽는 컬럼이다 — 인덱스가 필요하다");
});

test("★ 안전하지 않은 식별자로는 DDL 을 만들지 않는다", () => {
  assert.throws(() => buildTenantColumnDdl({ addColumn: ['x"; DROP TABLE y; --'], rewriteUnique: [], rewriteFk: [] }), /안전하지 않은/);
});

// ── ★★ 스키마 초기화 시드는 **모양에 무관**해야 한다 ────────────────────────
// `ensureTenantColumn()` 은 initAllSchemas 의 **끝**에서 돈다. 그래서 스키마 모듈의 시드 INSERT 는
//  신규 설치에서 tenant_id 컬럼이 **생기기 전에** 실행된다:
//   · `ON CONFLICT (tenant_id, …)` → 신규 설치가 42703(column does not exist)으로 기동 실패
//   · `ON CONFLICT (kind)`         → 이미 테넌트화된 DB 에서 42P10(no matching constraint)
//  두 모양 모두에 맞는 표기는 둘뿐이다: **중재자 없는 DO NOTHING** 과 **ON CONSTRAINT <이름>**
//  (제약 이름은 재작성해도 보존된다 — buildTenantColumnDdl 이 이름을 유지한다).
test("★★ 스키마 초기화 시드가 tenant_id 를 중재자로 쓰지 않는다(신규 설치가 죽는다)", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const bad: string[] = [];
  for (const dir of ["src/org/schema", "src/v6/schema"]) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = readFileSync(join(dir, f), "utf8");
      if (/ON CONFLICT\s*\(\s*tenant_id/i.test(src)) bad.push(`${dir}/${f}`);
    }
  }
  assert.deepEqual(bad, [], `중재자 없는 DO NOTHING 이나 ON CONSTRAINT <이름> 을 쓸 것: ${bad.join(", ")}`);
});

// ── ★★ 재작성 **제외** 테이블에는 tenant_id 를 중재자로 쓰지 않는다 ──────────
// isNaturalKey 머리말 ⓑ 가 그 예로 `project_member(project_id, member_id)` 를 든다: project_id 가
//  project.id(대리키)를 가리키는 FK 라 이미 전역 유일이고, 그래서 이 PK 는 **재작성되지 않는다**.
//  PK 가 (project_id, member_id) 로 남으므로 `ON CONFLICT (tenant_id, project_id, member_id)` 는
//  42P10 "no unique or exclusion constraint matching" 으로 죽는다 — **컬럼은 있는데 제약이 없다**
//  (그래서 42703 이 아니라 42P10 이고, 컬럼 존재만 확인해서는 못 잡는다).
// 실측(2026-08-20, #1821): #126 일괄치환이 project_member 5곳에만 tenant_id 를 넣어, members 를 준
//  프로젝트 생성(MCP project_create_v6)이 전부 500 이었다. 같은 배열의 자매 task_assignee·
//  task_comment_reaction 은 안 바꿔서 멀쩡했다 — 규칙이 아니라 누락이었다.
test("★★ 재작성 제외 테이블(project_member 등)에 tenant_id 중재자를 쓰지 않는다", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".ts") && !e.name.endsWith(".test.ts")) files.push(p);
    }
  };
  walk("src");
  // ⚠ 정규식을 쓰지 않는다 — 이스케이프가 한 번 어긋나면 이런 스캔 테스트는 **조용히 통과**한다
  //  (이 테스트 자체가 처음에 그렇게 깨졌다). 앵커부터 400자 창을 떠서 문자열 포함만 본다.
  const TABLES = ["project_member", "task_assignee", "task_comment_reaction"];
  const ARBITERS = ["ON CONFLICT (tenant_id", 'conflict: "tenant_id'];
  const bad: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    for (const t of TABLES) {
      for (const anchor of [`INSERT INTO ${t}`, `table: "${t}"`]) {
        for (let i = src.indexOf(anchor); i >= 0; i = src.indexOf(anchor, i + 1)) {
          const window = src.slice(i, i + 400);
          if (ARBITERS.some((a) => window.includes(a))) bad.push(`${f} (${t})`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(bad)], [], `이 표들의 PK 는 (tenant_id, …) 로 재작성되지 않는다 — tenant_id 를 빼라: ${bad.join(", ")}`);
});

// ── ★★ 신원 전역 표(#1879) — 컬럼은 두되 값은 **상수로 못박는다** ──────────────
// activate.ts 의 IDENTITY_GLOBAL_TABLES 머리말은 "컬럼은 남지만 정책이 없으면 불활성이다 — 무해한
//  16바이트" 라고 적혀 있었다. **그 전제가 틀렸다.** 정책이 없어도 컬럼 기본값은 살아 있어서
//  `current_setting('app.tenant_id')` 를 따라간다. PK 가 (tenant_id, id) 이므로 비-primary
//  워크스페이스에서 들어온 INSERT 는 **같은 사람의 계정행을 하나 더 만든다**.
// 실측(2026-08-27, dev.lvly.io): 개인 워크스페이스에서 온보딩 1막이 이름을 저장하자 org_member 에
//  yoon 행이 둘이 됐고, 그때부터 audit() 의 스칼라 서브쿼리가 2행을 받아
//  `more than one row returned by a subquery used as an expression` 로 **감사가 걸린 모든 org 쓰기가
//  500** 이 됐다(쓰기는 이미 커밋된 뒤라 데이터는 들어가고 응답만 실패 — 가장 나쁜 조합).
//  getMember() 도 tenant 조건이 없어 **아무 행이나** 돌려줬다.

test("★★ 신원 전역 표의 tenant_id 기본값은 상수다 — 컨텍스트를 따라가면 계정이 갈라진다", () => {
  assert.equal(IDENTITY_GLOBAL_DEFAULT_EXPR, `'${SINGLE_TENANT_ID}'::uuid`);
  // 여기에 current_setting 이 들어가는 순간 이 표들은 다시 워크스페이스마다 갈라진다.
  assert.ok(!/current_setting/.test(IDENTITY_GLOBAL_DEFAULT_EXPR), "신원 전역 표는 컨텍스트를 보면 안 된다");
});

test("★★ 못박기 DDL 은 기본값을 상수로 되돌린다(멱등)", () => {
  const ddl = buildIdentityGlobalPinDdl(["org_member", "auth_token"]);
  assert.equal(ddl.length, 2);
  assert.match(ddl[0], /^ALTER TABLE "org_member" ALTER COLUMN tenant_id SET DEFAULT '00000000-0000-0000-0000-000000000000'::uuid$/);
  assert.match(ddl[1], /^ALTER TABLE "auth_token" ALTER COLUMN tenant_id SET DEFAULT/);
  for (const s of ddl) assert.ok(!/current_setting/.test(s), s);
});

test("★ 못박기도 안전하지 않은 식별자를 거부한다", () => {
  assert.throws(() => buildIdentityGlobalPinDdl(['x"; DROP TABLE y; --']), /안전하지 않은/);
});

// ★★ 이미 갈라진 행은 **짝이 없을 때만** 옮긴다. 짝이 있으면(같은 사람이 두 워크스페이스에서 다른
//  값을 쌓았을 수 있다) 자동 병합은 어느 쪽을 버릴지 정할 수 없다 — 옮기지 않고 보고만 한다.
//  이 규칙 덕분에 이 마이그레이션은 **행을 지우지도 덮어쓰지도 않는다**.
test("★★ 갈라진 행 접기 — 짝이 없는 것만 옮기고, 짝이 있으면 손대지 않는다", () => {
  const sql = buildIdentityGlobalFoldSql("org_member", ["id"]);
  assert.match(sql, /UPDATE "org_member"/);
  assert.match(sql, /SET tenant_id = '00000000-0000-0000-0000-000000000000'::uuid/);
  assert.match(sql, /WHERE x\.tenant_id <> '00000000-0000-0000-0000-000000000000'::uuid/);
  // 짝(primary 에 같은 키가 이미 있는 행)은 제외 — 여기가 이 문장의 안전장치다.
  assert.match(sql, /NOT EXISTS/);
  assert.match(sql, /p\."id" = x\."id"/);
  assert.ok(!/DELETE/i.test(sql), "접기는 절대 지우지 않는다");
});

test("★ 복합키도 전부 짝 조건에 들어간다 — 한 컬럼만 보면 남의 행을 덮는다", () => {
  const sql = buildIdentityGlobalFoldSql("member_credential", ["member_id", "kind"]);
  assert.match(sql, /p\."member_id" = x\."member_id"/);
  assert.match(sql, /p\."kind" = x\."kind"/);
});

test("★ 키 컬럼이 없으면 접기 문장을 만들지 않는다 — 추측하지 않는다", () => {
  assert.throws(() => buildIdentityGlobalFoldSql("org_member", []), /키 컬럼/);
});

// ── ★★ PK 가 tenant_id 하나뿐인 표(=자연키가 전부 tenant_id 에 얹힌 표) ──────────────
//  실측 사고(2026-08-27 c60 롤): member_credential 의 PK 는 `member_id` 인데, tenant 화가 그 PK 를
//   (tenant_id, member_id) 로 바꿔 놓았다. 그러면 PK 조회(SQL_IDENTITY_GLOBAL)가 tenant_id 를 빼고
//   `member_id` 를 돌려주므로 짝 판정은 맞다 — 여기까지는 정상이다.
//  그런데 **PK 에서 tenant_id 를 뺀 나머지가 비는 표**가 있으면 얘기가 다르다: 짝 조건이 `AND` 없이
//   비어 `NOT EXISTS (SELECT 1 FROM t p WHERE p.tenant_id = <기본>)` 가 되어, primary 에 행이
//   **하나라도** 있으면 전부 건너뛰거나(무해) 하나도 없으면 **전부 옮겨** PK 충돌을 낸다.
//  그래서 그런 표는 문장을 만들지 않고 던진다 — 위 '키 컬럼 없음' 가드가 정확히 그 자리다.
//  이 테스트는 그 가드가 **빈 배열뿐 아니라 tenant_id 만 남은 경우에도** 걸리는지 못박는다.
test("★★ 짝 조건이 비면 접지 않는다 — tenant_id 만 남은 키로는 '같은 행'을 못 가른다", () => {
  // tenant_id 는 SQL_IDENTITY_GLOBAL 이 애초에 빼고 주므로, 여기 남는 건 빈 배열이다.
  assert.throws(() => buildIdentityGlobalFoldSql("member_credential", []), /키 컬럼/);
  // 공백만 든 배열도 같은 취급이어야 한다 — 호출부가 filter(Boolean) 을 빠뜨려도 여기서 막힌다.
  assert.throws(() => buildIdentityGlobalFoldSql("member_credential", ["", ""]), /키 컬럼/);
});

// ── ★★ 접기는 **한 행이 여러 후보와 겹칠 때**도 안전해야 한다 ────────────────────────
//  NOT EXISTS 는 '짝이 이미 있으면 건너뛴다' 를 보장하지만, **옮기는 행끼리** 서로 같은 키를 가지면
//   막지 못한다(둘 다 primary 에 짝이 없으므로 둘 다 통과 → 같은 키 두 행이 primary 로 들어가 PK 충돌).
//   실측 사고가 정확히 이 모양이었다: secondary 두 워크스페이스에 같은 member_id 자격이 하나씩.
//  그래서 문장은 **행 단위 dedup** 을 함께 가져야 한다.
test("★★ 옮기는 행끼리 같은 키면 하나만 옮긴다 — 둘 다 통과하면 PK 충돌이다", () => {
  const sql = buildIdentityGlobalFoldSql("member_credential", ["member_id"]);
  assert.match(sql, /ctid/, "행 단위 dedup 이 없다 — 같은 키를 가진 secondary 행 둘이 함께 옮겨진다");
});

// ── ★★ 감사 서브쿼리는 신원 전역 표를 **못박아** 읽는다 ─────────────────────
// 이 한 줄이 없으면 갈라진 행 하나가 감사가 걸린 **모든 org 쓰기**를 500 으로 만든다.
//  스칼라 서브쿼리는 2행을 받으면 그 자리에서 오류이고, 그 오류는 INSERT 뒤에 나서 되돌릴 수도 없다.
test("★★ audit() 의 org_member 서브쿼리가 tenant 로 못박혀 있다", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/org/store/audit.ts", "utf8");
  const m = /FROM org_member m WHERE[^)]*/.exec(src);
  assert.ok(m, "audit.ts 에서 org_member 서브쿼리를 못 찾았다 — 이 가드를 따라 옮길 것");
  assert.match(m[0], /m\.tenant_id\s*=/, `스칼라 서브쿼리가 테넌트로 좁혀지지 않았다: ${m[0]}`);
});

// ── 못박기 계획 — 바깥 정책 계층이 격리한 표는 건드리지 않는다(#2198) ─────────
//
// ★★ 2026-08-27 실측. 매니지드 공용 DB(lvly-cloud) 에서는 '테넌트'가 워크스페이스가 아니라 **고객사**라
//  토큰·세션·구성원도 테넌트별이고, 그래서 그 표들에 tenant_isolation(FORCE RLS)이 걸려 있다. 그 위에서
//  #1879 의 못박기·접기가 돌아 auth_token 290/290 · web_session 325/325 행이 단일테넌트 UUID 로 옮겨졌고,
//  정책이 그 행을 어느 테넌트에도 안 보여 줘 **전 테넌트가 invalid_token** 이 됐다(app.lvly.io 워크스페이스
//  열기 500). "정책이 걸린 표"는 그 배포가 테넌트별로 쓰는 표다 — 거기서 전역화는 곧 장애다.

const igRow = (t: string, over: Partial<{ pk: string[] | null; rls_forced: boolean; tenant_policy: boolean }> = {}) =>
  ({ t, pk: ["id"], rls_forced: false, tenant_policy: false, ...over });

test("★★ tenant_isolation 정책이 걸린 신원 표는 못박지도 접지도 않는다 — 매니지드 공용 DB 전 테넌트 로그인이 죽는다(#2198)", () => {
  const plan = identityGlobalPinPlan([
    igRow("org_member"),
    igRow("auth_token", { tenant_policy: true }),
    igRow("web_session", { rls_forced: true }),
  ]);
  assert.deepEqual(plan.pin.map((r) => r.t), ["org_member"]);
  assert.deepEqual(plan.skipped, ["auth_token", "web_session"]);
});

test("정책이 없는 표는 종전대로 전부 못박는다(셀프호스트 registry 모드 무회귀)", () => {
  const plan = identityGlobalPinPlan([igRow("org_member"), igRow("auth_token"), igRow("web_session")]);
  assert.equal(plan.pin.length, 3);
  assert.deepEqual(plan.skipped, []);
});

test("★ 카탈로그 조회가 정책 이름과 FORCE 를 실제로 읽는다 — 판정 재료가 없으면 건너뛸 수 없다", () => {
  assert.match(SQL_IDENTITY_GLOBAL, /pg_policy/);
  assert.match(SQL_IDENTITY_GLOBAL, /'tenant_isolation'/);
  assert.match(SQL_IDENTITY_GLOBAL, /relforcerowsecurity/);
});

// ── ★★ 신원을 **판정하는** 읽기는 지금 맥락으로 못박는다 (#1879 후속) ──────────
// 접기(pinIdentityGlobalTenant)는 짝이 있는 행을 **일부러 남기고**, 정책이 걸린 배포에서는 아예
//  손대지 않는다. 그래서 "갈라진 행이 0" 은 보장이 아니고, 남은 짝 위에서도 읽기가 옳아야 한다.
//
// 실 Postgres 로 재현(2026-08-27):
//   primary : __probe  state=inactive   ← 비활성화한 계정
//   짝      : __probe  state=active
//   SELECT id FROM org_member WHERE lower(email)=$1 AND state='active' LIMIT 1  →  1행
//  즉 **비활성화된 계정이 로그인된다.** ORDER BY 도 없어 어느 행이 뽑힐지 비결정적이다.
//
// ★★ 다만 **상수(primary)로 못박으면 안 된다.** 매니지드는 이 표에 RLS 를 걸고 요청마다
//  app.tenant_id 를 그 테넌트로 세우므로, primary 를 요구하면 정책이 걸러 **0행**이 된다(실측:
//  매니지드 맥락에서 상수 못박기 0행 / 맥락식 1행). 그러면 로그인·getMember 가 통째로 죽는다 —
//  이 파일이 이미 한 번 밟은 사고와 **같은 모양**이다(코어 전제를 배포 사실로 착각).
//  TENANT_DEFAULT_EXPR 은 두 배포를 한 식으로 덮는다: GUC 가 없으면 primary, 있으면 그 테넌트.
const IDENTITY_READS: Array<[string, RegExp]> = [
  ["src/auth/local-accounts.ts", /FROM org_member[^`]*/],
  ["src/ee/auth/oidc-login.ts", /FROM org_member[^`]*/],
  ["src/org/store/members.ts", /FROM org_member WHERE id=\$1[^`]*/],
  ["src/org/store/audit.ts", /FROM org_member m WHERE[^)]*/],
];

test("★★ 신원 판정 조회가 테넌트로 좁혀져 있다 — 남은 짝으로 로그인되지 않게", async () => {
  const { readFileSync } = await import("node:fs");
  const bad: string[] = [];
  for (const [f, re] of IDENTITY_READS) {
    const m = re.exec(readFileSync(f, "utf8"));
    if (!m) { bad.push(`${f}: 쿼리를 못 찾았다 — 이 가드를 따라 옮길 것`); continue; }
    if (!/tenant_id\s*=/.test(m[0])) bad.push(`${f}: ${m[0].replace(/\s+/g, " ").slice(0, 70)}`);
  }
  assert.deepEqual(bad, [], `테넌트로 좁혀지지 않은 신원 판정 조회:\n  ${bad.join("\n  ")}`);
});

test("★★ 그 못박기는 **상수가 아니라 맥락식**이다 — 상수면 매니지드에서 0행이 된다", async () => {
  const { readFileSync } = await import("node:fs");
  const bad: string[] = [];
  for (const [f, re] of IDENTITY_READS) {
    const m = re.exec(readFileSync(f, "utf8"));
    if (!m) continue;
    if (m[0].includes(SINGLE_TENANT_ID) || /SINGLE_TENANT_ID/.test(m[0])) {
      bad.push(`${f}: 상수로 못박혀 있다 — 매니지드(RLS)에서 정책이 걸러 0행이 된다`);
    }
    if (!/TENANT_DEFAULT_EXPR/.test(m[0])) {
      bad.push(`${f}: TENANT_DEFAULT_EXPR 이 아니다 — 두 배포를 한 식으로 덮어야 한다`);
    }
  }
  assert.deepEqual(bad, [], bad.join("\n  "));
});
