// v6 스키마 조각 — category-team: 분류축과 팀. category(구 domain 일반화)·category_edge(should/is 관계)·
//  category_repo(#1153 명시 매핑) + team·team_member·team_category(오너십 경첩 — 소유≠권한).
// #1313 R19c: 구 단일 initV6Schema(v6/schema.ts, ~1,270줄)에서 **verbatim 이동**한 조각 — DDL·시드 SQL 무변경.
//  실행(await) 순서는 v6/schema.ts 오케스트레이터가 소유한다(분할 전 시퀀스 그대로 — SCHEMA_SQL_LOG
//  스냅샷 diff 0 이 계약, scripts/schema-init.itest.mjs 헤더 참조). 블록을 옮기려면 그 증명을 다시 떠라.
import type { Pool } from "pg";
import { ensureCheck, softUniqueIndex } from "../../org/schema/ddl-util.js";

export async function initV6CategoryTeam(pool: Pool): Promise<void> {
  // ── 1) category — 구 domain 일반화. repo_id 없음(도메인=멀티레포). key 유니크(merged 제외 — team_key_uq 와 동형). ──
  //  should=정의·범위·규칙. 코드 앵커(mapping/debt/엣지)는 **있으면 붙는 것**이지 별도 부류가 아니다.
  //  ⚠ 2026-09-02(#1631) space 폐기 — 분류축 위에 business/product/system 이라는 **고정 서랍장**이 하나 더 있었다.
  //   그건 소프트웨어 회사의 분류지 쓰는 사람의 분류가 아니다(학생·양조장 대표에게 「제품/시스템」은 고를 이유가 없는 칸이다).
  //   실측: 온보딩이 만든 「팀 운영」이 이름만 보고 system 으로 갔다. 고르게 두면 틀리는 게 아니라, 고를 게 아니었다.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category(
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT,
      description TEXT,
      should TEXT,
      cross_cutting BOOLEAN DEFAULT false,
      origin TEXT,
      status TEXT NOT NULL DEFAULT 'confirmed',
      state TEXT NOT NULL DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    ${ensureCheck("category", {
      category_state_chk: "state IN ('active','merged','deprecated')",
    })}
    ALTER TABLE category ADD COLUMN IF NOT EXISTS layout_x REAL;
    ALTER TABLE category ADD COLUMN IF NOT EXISTS layout_y REAL;
  `);

  // ── 1-a) space 걷어내기(#1631) — **컬럼을 지우기 전에** key 충돌을 먼저 가른다. ──
  //  (space,key) 유니크였으므로 옛 DB 엔 같은 key 가 space 만 다르게 둘 이상 있을 수 있다. 그대로 컬럼만 지우면
  //  유일 인덱스가 안 걸리고(softUniqueIndex 가 보류) 두 축이 같은 이름으로 공존한다 — getCategoryByKey 가 아무거나 준다.
  //  가르는 규칙: id 가 작은 쪽이 원래 key 를 지키고 뒤엣것은 `<key>-<옛 space>`, 그마저 쓰였으면 `<key>-<id>`.
  //  ⚠ **id 는 안 바꾼다** — knowledge_category·team_category·mapping·debt_finding 이 전부 id 로 매달려 있다(매핑 무손실).
  //  컬럼이 이미 없으면(신규 DB) DO 블록이 통째로 건너뛴다 — 멱등.
  //  ⚠ 이 UPDATE 는 DDL 경로라 RLS 를 안 탄다 — **테넌트 안에서만** 비교해야 한다(두 워크스페이스가 같은 key 를
  //   갖는 건 정상이다). tenant_id 는 이 조각이 아니라 뒤따르는 tenant-column 단계가 붙이므로 있을 수도 없을 수도
  //   있다 → 컬럼 존재를 보고 술어를 만들어 EXECUTE 한다(없는 컬럼을 참조하면 plpgsql 이 그 자리에서 죽는다).
  await pool.query(`
    DO $$
    DECLARE scope text := '';
    BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='category' AND column_name='space') THEN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                    WHERE table_name='category' AND column_name='tenant_id') THEN
          scope := ' AND o.tenant_id = c.tenant_id';
        END IF;
        EXECUTE
          'UPDATE category c SET key = CASE' ||
          '   WHEN NOT EXISTS (SELECT 1 FROM category o WHERE o.state<>''merged''' ||
          '                      AND o.key = c.key || ''-'' || c.space' || scope || ')' ||
          '     THEN c.key || ''-'' || c.space' ||
          '   ELSE c.key || ''-'' || c.id::text END,' ||
          ' updated_at = now()' ||
          ' WHERE c.state <> ''merged''' ||
          '   AND EXISTS (SELECT 1 FROM category o WHERE o.state<>''merged''' ||
          '                 AND o.key = c.key AND o.id < c.id' || scope || ')';
      END IF;
    END $$;
    DROP INDEX IF EXISTS category_space_key_uq;
    DROP INDEX IF EXISTS category_space_idx;
    ALTER TABLE category DROP CONSTRAINT IF EXISTS category_space_chk;
    ALTER TABLE category DROP COLUMN IF EXISTS space;
  `);
  //  유일 인덱스는 보류형 — 위 가르기가 못 푼 중복(merged 경계 등)이 남아도 부팅을 죽이지 않는다.
  await softUniqueIndex(pool,
    `CREATE UNIQUE INDEX IF NOT EXISTS category_key_uq ON category(key) WHERE state <> 'merged'`,
    "category_key_uq 보류(분류축 key 중복)");

  // ── 2) category_edge — 도메인間 관계. axis='should'(의도, 수동 저작) | 'is'(코드 import 의존, 스캔 도출). ──
  //  should↔is 갭 = 아키텍처 부채 신호(후속). 한 (from,to,axis) 당 1엣지: is 는 스캔 upsert, should 는 수동.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category_edge(
      id SERIAL PRIMARY KEY,
      from_category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      to_category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      axis TEXT NOT NULL,
      relation TEXT NOT NULL DEFAULT 'depends_on',
      origin TEXT,
      weight INT,
      run_id INT,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    ${ensureCheck("category_edge", {
      category_edge_axis_chk: "axis IN ('should','is')",
      category_edge_noself_chk: "from_category_id <> to_category_id",
    })}
    CREATE UNIQUE INDEX IF NOT EXISTS category_edge_uq ON category_edge(from_category_id, to_category_id, axis);
    CREATE INDEX IF NOT EXISTS category_edge_from_idx ON category_edge(from_category_id, axis);
    CREATE INDEX IF NOT EXISTS category_edge_to_idx ON category_edge(to_category_id, axis);
  `);

  // ── 2-a) category_repo — 카테고리↔레포 **명시** 매핑(#1153). project_repo 와 동형(repo 는 이름 TEXT, FK 없음). ──
  //  왜 신설: 지금까지 도메인↔레포는 mapping→code_unit→repo 로 **역산하는 파생값**이었다(v6/domainmap-store.ts).
  //   그래서 (a) is 스캔이 표류하면 같이 흔들리고 (b) 부트스트랩 전에는 아예 비어 있다. "이 분류는 이 레포에 산다"는
  //   사람이 직접 선언할 수 있어야 한다 — 그게 이 테이블. 파생값은 그대로 두고(스캔 사실), 명시 매핑이 있으면 그게 우선.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS category_repo(
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      repo TEXT NOT NULL,
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (category_id, repo));
    CREATE INDEX IF NOT EXISTS category_repo_repo_idx ON category_repo(repo);
  `);

  // ── 2-b) team — 조직 내 팀(스쿼드/사일로). 카테고리 오너십의 주체. category 뒤(team_category 가 category FK 의존). ──
  //  ★원칙: 오너십 ≠ 접근권한. 권한은 scopes[]/auth_token.projects[] 가 따로 강제 — 팀 소유는 표면화·주입의 '소프트 렌즈'다
  //   (우리 팀 맥락을 먼저 보여줄 뿐, 다른 팀 맥락도 전원 열람·검색 가능). '분절 없는 집중'.
  //  body_md = 팀 charter(주입될 '팀 층' — org_profile 섹션·org_member.body_md 와 같은 층, WIKI 와 직교).
  //  lead_member_id = org_member.id(FK 없음 — project_member 관례, 미러/외부신원 허용). key 유니크(archived 제외, category idiom).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team(
      id SERIAL PRIMARY KEY,
      key TEXT NOT NULL,
      name TEXT,
      description TEXT,
      body_md TEXT,
      lead_member_id TEXT,
      state TEXT NOT NULL DEFAULT 'active',
      sort INT NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT now(),
      updated_at TIMESTAMPTZ DEFAULT now());
    ${ensureCheck("team", { team_state_chk: "state IN ('active','archived')" })}
    CREATE UNIQUE INDEX IF NOT EXISTS team_key_uq ON team(key) WHERE state <> 'archived';
  `);

  // ── 2-c) team_member — 팀원(n:n). 사람은 여러 팀 가능(겸직). member_id=org_member.id(FK 없음, project_member 관례). ──
  //  role = lead|pm|dev|design|member (표시 메타 — '누구한테 물어봐'. 표면화/주입은 소속 여부만 보고 role 은 안 본다).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_member(
      team_id INT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      sort INT NOT NULL DEFAULT 0,
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (team_id, member_id));
    CREATE INDEX IF NOT EXISTS team_member_member_idx ON team_member(member_id);
  `);

  // ── 2-d) team_category — ★핵심 경첩: 팀↔카테고리 오너십(n:n). relation=owner|stakeholder. ──
  //  지식(knowledge_category)·프로젝트(project_category)·도메인맵이 이미 category 에 매달려 있어, 여기 한 줄(팀↔카테고리)이
  //   팀의 맥락 귀속 전체를 끌어온다(새 축 X, 기존 축에 오너 부착). 카테고리당 owner 팀은 최대 1(부분 유니크) = '우리 팀' 기준.
  //   stakeholder 는 여럿 허용(공유/크로스커팅 카테고리 — brand·gtm 등 여러 팀이 이해관계자).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_category(
      team_id INT NOT NULL REFERENCES team(id) ON DELETE CASCADE,
      category_id INT NOT NULL REFERENCES category(id) ON DELETE CASCADE,
      relation TEXT NOT NULL DEFAULT 'owner',
      added_at TIMESTAMPTZ DEFAULT now(),
      PRIMARY KEY (team_id, category_id));
    ${ensureCheck("team_category", { team_category_relation_chk: "relation IN ('owner','stakeholder')" })}
    CREATE UNIQUE INDEX IF NOT EXISTS team_category_owner_uq ON team_category(category_id) WHERE relation='owner';
    CREATE INDEX IF NOT EXISTS team_category_team_idx ON team_category(team_id);
    CREATE INDEX IF NOT EXISTS team_category_cat_idx ON team_category(category_id);
  `);
}
