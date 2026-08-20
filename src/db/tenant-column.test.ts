import { strict as assert } from "node:assert";
import test from "node:test";
import {
  SINGLE_TENANT_ID, SURROGATE_GEN_RE, TENANT_DEFAULT_EXPR,
  buildTenantColumnDdl, isNaturalKey, rewritePartialUniqueDef,
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
  assert.equal(isNaturalKey("category", ["key", "space"], G()), true);
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
