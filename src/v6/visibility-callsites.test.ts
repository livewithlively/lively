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
    assert.match(readFileSync(f, "utf8"), /hp\.level='project' AND \(hp\.list_id IS NOT NULL OR hp\.draft OR hp\.invite_only\)/, f);
  }
});

// ★ #5598 — 세션 초대 → 프로젝트 팀원 맞추기는 v6 를 정적으로 끌지 않아 «비공개» 조건을 글자로 옮겨 적는다. 술어와 갈리면 안 된다.
test("★ 세션 초대의 팀원 맞추기는 비공개 술어와 같은 조건을 쓴다", () => {
  const src = readFileSync("src/sessions/session-state.ts", "utf8");
  assert.match(src, /JOIN project p ON p\.id = s\.project_id AND p\.level = 'project' AND \(p\.draft OR p\.invite_only\)/);
  assert.equal(privateProjectSql("p"), "(p.draft OR p.invite_only)");
});
