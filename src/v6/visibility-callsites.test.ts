import { strict as assert } from "node:assert";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { privateProjectSql, privateVisibleSql, projectVisPredicate, PROJECT_VIS_ALL } from "./visibility.js";

// ★ 프로젝트 행을 거르는 자리는 projectVisPredicate 하나만 쓴다(#5522).
//  listIdPredicate 는 «리스트 공개범위» 만 본다. 프로젝트 행을 거르는 자리가 그걸 직접 부르면 **초안이 그 자리에서만
//  전원에게 보인다** — 초안은 리스트가 없어 «미분류 = 전원» 으로 통과하기 때문이다. 이 조직은 «술어는 맞는데 그 술어를
//  안 쓰고 스스로 판단하는 곳» 으로 여러 번 사고를 냈다(#1291: 지식 1홉 · projBase · ClickUp 반출 · OS ACL · 증류기 인박스).
//  그래서 listIdPredicate 를 부를 수 있는 파일을 못 박는다 — 전부 **리스트 · 폴더 · 보기 표**를 거르는 자리다.
//  새 자리가 프로젝트 행을 거른다면 projectVisPredicate(listCol, rootIdCol, vis)를 쓰고, 정말 리스트 표를 거르는
//  자리라면 아래 목록에 까닭과 함께 더한다.
const LIST_ONLY_CALLERS = new Set([
  "src/v6/visibility.ts",        // 정의 + projectVisPredicate 안에서 한 번
  "src/v6/folder-store.ts",      // 폴더별 리스트 수(project_list)
  "src/v6/list-store.ts",        // 리스트 목록(project_list)
  "src/v6/view-store.ts",        // 저장된 보기(project_view.list_id)
  "src/db/self/self-rls.ts",     // 숨길 리스트 · 폴더 id(project_list · project_folder) — 프로젝트 행은 projectVisPredicate
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

test("★ listIdPredicate 를 부르는 파일은 리스트 · 폴더 · 보기 표를 거르는 자리뿐이다", () => {
  const callers = walk("src").filter((p) => /\blistIdPredicate\(/.test(readFileSync(p, "utf8"))).map((p) => p.replace(/\\/g, "/")).sort();
  assert.deepEqual(callers, [...LIST_ONLY_CALLERS].sort(),
    "프로젝트 행을 거르는 자리는 projectVisPredicate 를 써야 비공개 프로젝트(#5522 초안 · #5598 초대제)가 함께 걸러진다");
});

test("★ self-rls 의 listIdPredicate 는 리스트 · 폴더 표의 id 에만 걸린다(프로젝트 행은 projectVisPredicate)", () => {
  const src = readFileSync("src/db/self/self-rls.ts", "utf8");
  const calls = [...src.matchAll(/listIdPredicate\(("[^"]*")/g)].map((m) => m[1]);
  assert.deepEqual(calls, ['"id"', '"id"']);
  assert.match(src, /FROM project hp[\s\S]{0,200}projectVisPredicate\("hp\.list_id", "hp\.id", pv\)/, "프로젝트 행은 별칭을 붙여 projectVisPredicate 로 거른다");
});

// ★ 뿌리 id 식에는 별칭이 있어야 한다 — 맨 `id` 는 하위 질의 안에서 dft.id 로 풀려 `dft.id = dft.id` 가 된다
//  («안 보이는 초안이 하나라도 있으면 모든 행이 안 보인다». 2026-11-16 실 PG 시험이 잡았다).
test("★ privateVisibleSql 은 별칭 없는 뿌리 id 를 거절한다", () => {
  assert.throws(() => privateVisibleSql("id", "u1"), /별칭이 없다/);
  assert.doesNotThrow(() => privateVisibleSql("p.id", "u1"));
  assert.doesNotThrow(() => privateVisibleSql("COALESCE(root.id, p.id)", "u1"));
});

test("소스 어디에도 projectVisPredicate 에 맨 컬럼 이름을 넘기는 자리가 없다", () => {
  const bad = walk("src").filter((p) => /projectVisPredicate\(\s*"[a-z_]+"\s*,|projectVisPredicate\([^,]+,\s*"[a-z_]+"\s*,/.test(readFileSync(p, "utf8")));
  assert.deepEqual(bad, []);
});

test("초안 술어 — 뷰어를 글자로 넣되 따옴표 · 역슬래시를 겹친다", () => {
  const sql = privateVisibleSql("p.id", "o'brien\\x");
  assert.ok(sql.includes("E'o''brien\\\\x'"), sql);
  assert.ok(!/'o'brien/.test(sql), "따옴표가 그대로 들어가면 글자가 끊긴다");
});

test("초안을 거르지 않는 뷰어(특권 · 축 꺼짐)는 리스트 술어만 나온다", () => {
  assert.equal(projectVisPredicate("p.list_id", "p.id", PROJECT_VIS_ALL), "TRUE");
  assert.equal(projectVisPredicate("p.list_id", "p.id", { lists: new Set([3]), privateViewer: null }), "(p.list_id IS NULL OR p.list_id IN (3))");
  const both = projectVisPredicate("p.list_id", "p.id", { lists: new Set([3]), privateViewer: "u1" });
  assert.match(both, /^\(\(p\.list_id IS NULL OR p\.list_id IN \(3\)\) AND NOT EXISTS \(SELECT 1 FROM project dft WHERE dft\.id = p\.id /);
  assert.match(both, /dft\.created_by IS DISTINCT FROM 'u1'/);
  assert.match(both, /dpm\.member_id = 'u1'/);
});

// ★ #5598 — «비공개» 는 초안과 초대제 둘 다다. 한쪽만 보면 초대제 프로젝트가 초안이 풀리는 순간 전원에게 열린다.
test("★ 비공개 술어는 초안과 초대제를 함께 본다", () => {
  assert.equal(privateProjectSql("dft"), "(dft.draft OR dft.invite_only)");
  assert.throws(() => privateProjectSql("p.id"), /별칭이 아니다/);
  assert.match(privateVisibleSql("p.id", "u1"), /dft\.level = 'project' AND \(dft\.draft OR dft\.invite_only\)/);
});

// ★ #5598 — «숨은 프로젝트» 후보를 고르는 자리(세션 판정 · self 조회)가 초대제를 빼먹으면, 리스트 없는 초대제 프로젝트의
//  세션 · 파일 · self 행이 남에게 그대로 보인다(술어는 맞는데 후보에서 빠진다).
test("★ 숨은 프로젝트 후보는 리스트 · 초안 · 초대제 셋을 다 훑는다", () => {
  for (const f of ["src/v6/visibility.ts", "src/db/self/self-rls.ts"]) {
    //  초대제 칸은 inviteOnlySql 로 적는다(#5598 롤 창 — 칸이 아직 없는 DB 에서는 false 가 들어간다 · project-invite-column.ts).
    assert.match(readFileSync(f, "utf8"), /hp\.level='project' AND \(hp\.list_id IS NOT NULL OR hp\.draft OR \$\{inviteOnlySql\("hp"\)\}\)/, f);
  }
});

// ★ #5598 — 세션 초대 → 프로젝트 팀원 맞추기는 v6 를 정적으로 끌지 않아 «비공개» 조건을 글자로 옮겨 적는다. 술어와 갈리면 안 된다.
test("★ 세션 초대의 팀원 맞추기는 비공개 술어와 같은 조건을 쓴다", () => {
  const src = readFileSync("src/sessions/session-state.ts", "utf8");
  //  조건은 인자로 들어간다 — 평소 «초안 또는 초대제», 칸이 아직 없는 DB(롤 창 · 42703)에서는 «초안» 으로 한 번 더.
  assert.match(src, /JOIN project p ON p\.id = s\.project_id AND p\.level = 'project' AND \$\{privateCond\}/);
  assert.match(src, /r = await run\("\(p\.draft OR p\.invite_only\)"\);/);
  assert.match(src, /code !== "42703"\) throw e;\s*r = await run\("p\.draft"\);/, "롤 창 폴백 — 칸이 없으면 초안만 보고 다시");
  assert.equal(privateProjectSql("p"), "(p.draft OR p.invite_only)");
});

// ★ #5598 롤 창 — 매니지드 롤은 새 코드가 서빙을 시작한 뒤에야 공용 DB 에 새 칸을 만든다. project.invite_only 를 SQL 에 **글자로**
//  적은 자리가 가드(project-invite-column.ts) 밖에 있으면, 그 몇 분 동안 그 조회가 «없는 칸» 으로 실패한다.
//  글자로 적어도 되는 자리는 셋뿐이다: 칸을 만드는 스키마 · 가드 자신 · 가드가 «있다» 를 확인한 뒤에만 도는 쓰기/읽기.
//  ⚠ 아래 두 시험은 겹으로 선다. 줄 단위 검사(둘째)는 여러 줄 SQL 의 이어진 줄(`  OR p.invite_only)`)을 놓친다(격리 리뷰).
//   그래서 첫째가 **파일 단위**로 막는다: `invite_only` 라는 글자가 나올 수 있는 파일을 못 박는다. 새 파일이 이 칸을 읽으려면
//   여기에 까닭과 함께 더해야 하고, 그때 «가드를 지났나» 를 사람이 본다.
const INVITE_ONLY_FILES = new Set([
  "src/v6/schema/project.ts",            // 칸을 만든다
  "src/v6/project-invite-column.ts",     // 가드 자신
  "src/v6/project-store.ts",             // 행 읽기 묶음(projectCols) · 생성 · 공개 범위 바꾸기 — 전부 가드를 잰 뒤
  "src/v6/visibility.ts",                // inviteOnlyProjectIds — ensure 가 참일 때만
  "src/v6/trash-store.ts",               // 삭제 스냅샷(JSON)의 열쇠 · 줄 재료 — 칸 참조는 inviteOnlySql
  "src/v6/project-invite.ts",            // 행 객체의 속성(SQL 아님)
  "src/v6/project-access.ts",            // 주석(칸 이름을 설명)
  "src/v6/project-draft.ts",             // 주석
  "src/capabilities/trash.ts",           // 스냅샷 객체의 속성
  "src/capabilities/projects-v6.ts",     // 도구 설명 · createProject 인자 이름
  "src/sessions/session-state.ts",       // 42703 을 잡아 초안만 보는 조건으로 다시 돌린다
  "src/index.ts",                        // 주석(부팅 때 가드를 한 번 잰다)
]);
test("★ invite_only 라는 글자가 나오는 파일은 못 박은 목록뿐이다(주석 포함)", () => {
  const found = walk("src").filter((p) => /\binvite_only\b/.test(readFileSync(p, "utf8"))).map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !p.endsWith(".pg-test.mjs")).sort();
  const extra = found.filter((p) => !INVITE_ONLY_FILES.has(p));
  assert.deepEqual(extra, [], "새 파일이 project.invite_only 를 읽으면 롤 창(칸이 아직 없는 DB)에서 실패할 수 있다 — inviteOnlySql · ensureInviteOnlyColumn 을 쓰고 목록에 더한다");
});

test("★ invite_only 를 SQL 에 글자로 적는 자리는 가드를 지난 곳뿐이다", () => {
  const allowed: Record<string, RegExp[]> = {
    "src/v6/schema/project.ts": [/ADD COLUMN IF NOT EXISTS invite_only/],
    "src/v6/project-invite-column.ts": [/.*/],
    //  칸이 있을 때만 그 이름을 넣는 조립 · ensureInviteOnlyColumn 이 참일 때만 도는 UPDATE.
    "src/v6/project-store.ts": [/inviteOnlyColumnExists\(\) \? /, /hasInviteCol \? ", invite_only" : ""/, /UPDATE project SET invite_only = \$2/],
    //  ensureInviteOnlyColumn 이 거짓이면 그 앞에서 빈 집합으로 돌아간다.
    "src/v6/visibility.ts": [/SELECT id FROM project WHERE level='project' AND invite_only`/],
    //  세션 상태는 노드 에이전트 번들에 실려 가드 모듈을 못 쓴다 — 42703 을 잡아 초안만 보는 조건으로 다시 돌린다(같은 함수 안).
    "src/sessions/session-state.ts": [/r = await run\("\(p\.draft OR p\.invite_only\)"\);/],
  };
  const bad: string[] = [];
  for (const f of walk("src")) {
    const rel = f.replace(/\\/g, "/");
    readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*--.*$/, "");   // 주석(JS · SQL)은 본다지 않는다
      //  SQL 의 칸 참조 꼴만 — `<별칭>.invite_only` 또는 SQL 낱말 옆의 맨 invite_only. 객체 속성(`row.invite_only ===` · `invite_only:`)은 뺀다.
      const sqlRef = /\b[a-z_]+\.invite_only\b(?!\s*(===|!==|\?|:|,|\)|;|$))/.test(code) && /`|'|"/.test(code) && /\b(SELECT|WHERE|AND|OR|JOIN|SET|FROM)\b/.test(code)
        || /\b(AND|OR|SET|,)\s+invite_only\b/.test(code) && /`/.test(code);
      if (!sqlRef) return;
      if ((allowed[rel] || []).some((re) => re.test(line))) return;
      bad.push(`${rel}:${i + 1}: ${line.trim().slice(0, 120)}`);
    });
  }
  assert.deepEqual(bad, [], "inviteOnlySql(별칭)으로 적거나, 가드를 지난 자리라면 위 목록에 까닭과 함께 더한다");
});
