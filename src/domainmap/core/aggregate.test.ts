// aggregateFileChanges 사양 기반 테스트(#1313 R7) — 분해 선행 안전망. PURE(no DB) — export 표면·행위만 검증.
//  사양 출처: aggregate.ts 헤더 주석(파일 diff → 기존 code_unit 입도 정규화; 디렉터리 이동=파일 rename
//  클러스터 → 모듈 rename 1건; ≥2표 합의 없으면 절대 모듈을 rename 하지 않고 ambiguous 로 표면화).
//  실행: npm run build && node dist/domainmap/core/aggregate.test.js
//
// ── 입력 조합 × 기대 (엣지 표 — 행마다 테스트 ≥1) ─────────────────────────────
// #  | fileChanges                                        | unitPaths            | 기대
// 1  | []                                                 | []                   | unitChanges=[], summary 전부 0/[]
// 2  | 비배열(null/undefined/문자열)                       | 비배열               | 빈 입력과 동일(방어적 정규화)
// 3  | R×2: u/a.ts→v/a.ts, u/b.ts→v/b.ts (score 90,70)    | [u]                  | R{u→v, score=min(70)} 1건, module_renames=1
// 4  | R×3 중 2건은 u→v 합의, 1건은 suffix 불일치          | [u]                  | R{u→v} + 불일치 'to'는 ADD 폴백(신규 dir=A)
// 5  | R×1 만 (1표 < 2 임계)                              | [u]                  | rename 없음, ambiguous_moves 1건(reason=1표), 'to'는 ADD 경로
// 6  | R×2 인데 목적지 v 가 기존 unit                      | [u, v]               | rename 없음, ambiguous(reason=기존 unit), 'to'들은 v 소유라 noop_in_existing
// 7  | R×2 가 서로 다른 목적지로 갈림(v, w 1표씩)          | [u]                  | rename 없음, ambiguous(reason=votes split), 'to' 2건 ADD 폴백
// 8  | A: 기존 unit 내부 신규 파일                         | [u]                  | no-op(noop_in_existing++), unitChanges 없음
// 9  | M: 기존 unit 내부 수정                              | [u]                  | 완전 no-op(어느 카운터도 안 늠)
// 10 | D: 기존 unit 내부 삭제                              | [u]                  | no-op(noop_delete++), 모듈 자동 제거 절대 없음
// 11 | A×2: 신규 dir 아래 두 파일                          | [u]                  | A{path:dir} 1건(dedup), new_dirs=1
// 12 | A: 최상위 파일(부모 dir 없음)                       | []                   | A{path:파일경로 자체}(cand=파일)
// 13 | R: from 이 어느 unit 에도 미소유                    | []                   | rename 아닌 'to' ADD 폴백(refresh 의 from-not-found와 동일 의미)
// 14 | 경계: 'backend/src/campaigns-v2/x.ts' vs unit 'backend/src/campaigns' | [campaigns] | 세그먼트 경계 — 미소유(ADD 경로)
// 15 | R: unit 내부 하위경로 개명(suffix 불일치)           | [u]                  | rename 없음, 'to' ADD → 소유라 noop_in_existing
// 16 | 합의 rename + 그 목적지(Q) 아래 A 파일              | [u]                  | A 는 renamedTargets 스킵(new_dirs 안 늠, noop 도 아님)
// 17 | 같은 rename 클러스터 중복 입력                      | [u]                  | R 1건만(emittedRename dedup)
// 18 | unitPaths 에 비문자열/'' 섞임                       | [u, '', 42]          | 무시(문자열만 필터) — #2와 같은 방어 계열
import assert from "node:assert/strict";
import { aggregateFileChanges } from "./aggregate.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};

const R = (from: string, to: string, score?: number | null) => ({ status: "R", from, to, score });
const A = (path: string) => ({ status: "A", path });
const M = (path: string) => ({ status: "M", path });
const D = (path: string) => ({ status: "D", path });

const emptySummary = { module_renames: 0, new_dirs: 0, noop_in_existing: 0, noop_delete: 0, ambiguous_moves: [] as unknown[] };

// 1. 빈 입력 → 빈 출력(경계).
t("#1 빈 fileChanges + 빈 unitPaths → unitChanges=[] · summary 전부 0", () => {
  const r = aggregateFileChanges([], []);
  assert.deepEqual(r.unitChanges, []);
  assert.deepEqual(r.summary, emptySummary);
});

// 2. 비배열 입력 방어(부재/빈 경우 행).
t("#2 비배열 입력(null/undefined/문자열) → 빈 입력과 동일", () => {
  for (const bad of [null, undefined, "x", 42, {}]) {
    const r = aggregateFileChanges(bad, bad);
    assert.deepEqual(r.unitChanges, []);
    assert.deepEqual(r.summary, emptySummary);
  }
});

// 3. 디렉터리 이동 = rename 클러스터 → 모듈 rename 1건, score 는 최소값.
t("#3 R×2 합의(u→v) → 유닛 R 1건 + score=min + module_renames=1", () => {
  const u = "backend/src/campaigns";
  const r = aggregateFileChanges(
    [R(`${u}/a.ts`, "backend/src/camps/a.ts", 90), R(`${u}/svc/b.ts`, "backend/src/camps/svc/b.ts", 70)],
    [u],
  );
  assert.deepEqual(r.unitChanges, [{ status: "R", from: u, to: "backend/src/camps", score: 70 }]);
  assert.equal(r.summary.module_renames, 1);
  assert.deepEqual(r.summary.ambiguous_moves, []);
});

// 4. 합의 rename + suffix 불일치 파일(이동+개명) → 그 'to'만 ADD 폴백.
t("#4 합의 rename 에 안 낀 suffix-불일치 rename 은 'to' ADD 폴백(신규 dir)", () => {
  const u = "backend/src/campaigns";
  const r = aggregateFileChanges(
    [
      R(`${u}/a.ts`, "backend/src/camps/a.ts", 95),
      R(`${u}/b.ts`, "backend/src/camps/b.ts", 95),
      R(`${u}/c.ts`, "elsewhere/renamed-c.ts", 60), // suffix 다름 → 클러스터 불가
    ],
    [u],
  );
  assert.deepEqual(r.unitChanges, [
    { status: "R", from: u, to: "backend/src/camps", score: 95 },
    { status: "A", path: "elsewhere" },
  ]);
  assert.equal(r.summary.module_renames, 1);
  assert.equal(r.summary.new_dirs, 1);
});

// 5. 1표는 임계(≥2) 미달 → 모듈 rename 금지 + ambiguous 표면화, 'to'는 ADD 경로.
t("#5 R×1(1표) → rename 없음 · ambiguous(votes=1) · 'to'는 신규 dir A", () => {
  const u = "backend/src/campaigns";
  const r = aggregateFileChanges([R(`${u}/a.ts`, "backend/src/camps/a.ts", 90)], [u]);
  assert.deepEqual(r.unitChanges, [{ status: "A", path: "backend/src/camps" }]);
  assert.equal(r.summary.module_renames, 0);
  assert.equal(r.summary.ambiguous_moves.length, 1);
  assert.equal(r.summary.ambiguous_moves[0].from, u);
  assert.equal(r.summary.ambiguous_moves[0].to, "backend/src/camps");
  assert.equal(r.summary.ambiguous_moves[0].votes, 1);
});

// 6. 목적지가 이미 존재하는 unit → rename 금지(ambiguous), 'to'들은 그 unit 소유 = no-op.
t("#6 목적지=기존 unit → rename 없음 · ambiguous · 'to'는 noop_in_existing", () => {
  const u = "src/old", v = "src/new";
  const r = aggregateFileChanges(
    [R(`${u}/a.ts`, `${v}/a.ts`, 90), R(`${u}/b.ts`, `${v}/b.ts`, 90)],
    [u, v],
  );
  assert.deepEqual(r.unitChanges, []);
  assert.equal(r.summary.module_renames, 0);
  assert.equal(r.summary.ambiguous_moves.length, 1);
  assert.equal(r.summary.ambiguous_moves[0].votes, 2);
  assert.equal(r.summary.noop_in_existing, 2); // 두 'to' 모두 기존 unit v 소유
});

// 7. 표가 목적지별로 갈림 → rename 금지(ambiguous), 'to' 전부 ADD 폴백.
t("#7 표 분산(v 1표·w 1표) → rename 없음 · ambiguous · 'to' 2건 신규 dir", () => {
  const u = "src/old";
  const r = aggregateFileChanges(
    [R(`${u}/a.ts`, "src/v/a.ts", 90), R(`${u}/b.ts`, "src/w/b.ts", 90)],
    [u],
  );
  assert.equal(r.summary.module_renames, 0);
  assert.equal(r.summary.ambiguous_moves.length, 1);
  assert.equal(r.summary.ambiguous_moves[0].votes, 2);
  const adds = r.unitChanges.filter((c: any) => c.status === "A").map((c: any) => c.path).sort();
  assert.deepEqual(adds, ["src/v", "src/w"]);
  assert.equal(r.summary.new_dirs, 2);
});

// 8~10. 기존 모듈 내부 add/modify/delete = 전부 유닛 레벨 no-op.
t("#8 기존 unit 내부 A → noop_in_existing, 유닛 변경 없음", () => {
  const r = aggregateFileChanges([A("src/mod/new-file.ts")], ["src/mod"]);
  assert.deepEqual(r.unitChanges, []);
  assert.equal(r.summary.noop_in_existing, 1);
});
t("#9 M(수정) → 완전 no-op(어느 카운터도 변화 없음)", () => {
  const r = aggregateFileChanges([M("src/mod/a.ts")], ["src/mod"]);
  assert.deepEqual(r.unitChanges, []);
  assert.deepEqual(r.summary, emptySummary);
});
t("#10 D(삭제) → noop_delete(모듈 자동 제거 절대 없음)", () => {
  const r = aggregateFileChanges([D("src/mod/a.ts"), D("src/mod/b.ts")], ["src/mod"]);
  assert.deepEqual(r.unitChanges, []);
  assert.equal(r.summary.noop_delete, 2);
  assert.equal(r.unitChanges.filter((c: any) => c.status === "D").length, 0);
});

// 11. 신규 dir 아래 여러 파일 → A{dir} 1건으로 dedup.
t("#11 신규 dir 아래 A×2 → A{path:dir} 1건 · new_dirs=1(dedup)", () => {
  const r = aggregateFileChanges([A("src/fresh/a.ts"), A("src/fresh/b.ts")], ["src/other"]);
  assert.deepEqual(r.unitChanges, [{ status: "A", path: "src/fresh" }]);
  assert.equal(r.summary.new_dirs, 1);
});

// 12. 최상위 파일 → 후보 = 파일 경로 자체(경계: parentDir=null).
t("#12 최상위 파일 A → 후보 dir 없음 → A{path:파일}", () => {
  const r = aggregateFileChanges([A("README.md")], []);
  assert.deepEqual(r.unitChanges, [{ status: "A", path: "README.md" }]);
  assert.equal(r.summary.new_dirs, 1);
});

// 13. from 미소유 rename → 'to' ADD 폴백(unit 입도의 from-not-found).
t("#13 from 이 어느 unit 에도 미소유 → 'to' ADD 폴백", () => {
  const r = aggregateFileChanges([R("unowned/a.ts", "fresh/a.ts", 80)], []);
  assert.deepEqual(r.unitChanges, [{ status: "A", path: "fresh" }]);
  assert.equal(r.summary.module_renames, 0);
});

// 14. 소유 판정은 세그먼트 경계 안전('campaigns' 가 'campaigns-v2' 를 소유하면 안 됨).
t("#14 'backend/src/campaigns-v2/x.ts' 는 unit 'backend/src/campaigns' 미소유", () => {
  const r = aggregateFileChanges([A("backend/src/campaigns-v2/x.ts")], ["backend/src/campaigns"]);
  // 소유였다면 noop_in_existing — 미소유이므로 신규 dir 후보.
  assert.equal(r.summary.noop_in_existing, 0);
  assert.deepEqual(r.unitChanges, [{ status: "A", path: "backend/src/campaigns-v2" }]);
});

// 15. 같은 unit 안 하위경로 개명(suffix 불일치) → rename 아님, 'to'는 소유라 no-op.
t("#15 unit 내부 하위경로 개명 → rename 없음 · 'to'는 noop_in_existing", () => {
  const u = "src/mod";
  const r = aggregateFileChanges([R(`${u}/sub/a.ts`, `${u}/sub2/a.ts`, 90)], [u]);
  // suffix 'sub/a.ts' 는 to 와 불일치 → ADD 폴백 → 소유 → no-op. (어느 경로든 rename 0 이 계약)
  assert.deepEqual(r.unitChanges, []);
  assert.equal(r.summary.module_renames, 0);
  assert.equal(r.summary.noop_in_existing, 1);
});

// 16. 합의 rename 목적지(Q) 아래로 떨어진 별도 A 는 신규 dir 로 세지 않음(rename 이 이미 행을 만든다).
t("#16 rename 목적지 Q 아래 A → renamedTargets 스킵(new_dirs 불변)", () => {
  const u = "src/old";
  const r = aggregateFileChanges(
    [R(`${u}/a.ts`, "src/new/a.ts", 90), R(`${u}/b.ts`, "src/new/b.ts", 90), A("src/new/c.ts")],
    [u],
  );
  assert.deepEqual(r.unitChanges, [{ status: "R", from: u, to: "src/new", score: 90 }]);
  assert.equal(r.summary.new_dirs, 0);
  assert.equal(r.summary.noop_in_existing, 0);
});

// 17. 동일 클러스터 중복 표 → R 1건만(dedup) — module_renames 도 1.
t("#17 같은 (from,to) 클러스터 중복 → R 1건 · module_renames=1", () => {
  const u = "src/old";
  const r = aggregateFileChanges(
    [R(`${u}/a.ts`, "src/new/a.ts", 90), R(`${u}/b.ts`, "src/new/b.ts", 80), R(`${u}/c.ts`, "src/new/c.ts", 85)],
    [u],
  );
  assert.equal(r.unitChanges.filter((c: any) => c.status === "R").length, 1);
  assert.equal(r.summary.module_renames, 1);
  assert.equal(r.unitChanges[0].score, 80); // minScore
});

// 18. unitPaths 의 비문자열/'' 은 무시(방어) — 파이프라인은 문자열 unit 만 본다.
t("#18 unitPaths 에 ''/숫자 섞임 → 문자열 unit 만 유효", () => {
  const r = aggregateFileChanges([A("src/mod/x.ts")], ["src/mod", "", 42 as unknown as string]);
  assert.equal(r.summary.noop_in_existing, 1);
  assert.deepEqual(r.unitChanges, []);
});

console.log(`\n${pass} passed`);
