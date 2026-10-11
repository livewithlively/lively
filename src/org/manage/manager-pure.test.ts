// #1419 T5 — 관리기 순수 판정 회귀 잠금(DB 무의존). SQL 불변식은 scripts/manager-finding.itest.mjs 가 본다.
//  실행: npm run build && node dist/org/manage/manager-pure.test.js
//
//  여기서 보는 것: kind 별 실행 경로 분기(LLM 필요 여부)와 자동 조치의 **거부 규칙**.
//  둘 다 틀리면 조용히 나쁘다 — 전자는 LLM 비용을 안 써도 되는 관리기가 매 주기 배치를 접수하고,
//  후자는 비가역 조치가 사람 확인 없이 실행된다.
//  사양 엣지 표: <스크래치패드>/spec-t5.md (M11·M16·M17)
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { needsLlm, MANAGER_KIND_LABEL, type ManagerKind } from "../store/managers.js";
import { applyAction, statusForManagerResults, type ManagerRunResult } from "./run-manager.js";
import { contradictionCandidateSql, CONTRADICTION_NEIGHBORS, CONTRADICTION_PLANNER_OFF } from "./detectors.js";
import { isApplicableAction } from "./action-whitelist.js";

let pass = 0;
const t = (name: string, fn: () => void | Promise<void>): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

// ══ M11 실행 경로 분기 ══
await t("결정적 종류는 LLM 을 안 쓴다 [M11]", () => {
  // 이게 뒤집히면 분류 어긋남·아웃데이티드가 매 주기 헤드리스 배치를 접수한다 —
  // SQL 로 즉시·무료로 낼 수 있는 판정에 토큰을 쓰게 된다.
  assert.equal(needsLlm("mismatch"), false);
  assert.equal(needsLlm("outdated"), false);
});

await t("판단이 필요한 종류는 LLM 을 쓴다 [M11]", () => {
  // 반대로 이게 뒤집히면 모순·코드괴리가 '결정적 경로'로 빠져 아무 발견도 못 낸다(조용히 0건).
  assert.equal(needsLlm("contradiction"), true);
  assert.equal(needsLlm("code_drift"), true);
});

await t("4종 모두 사람 읽는 이름이 있다", () => {
  // 이름이 비면 화면·요약에 raw kind 가 새어 나온다(비개발자 화면 요구).
  for (const k of ["mismatch", "outdated", "contradiction", "code_drift"] as ManagerKind[]) {
    assert.ok(MANAGER_KIND_LABEL[k], `${k} 라벨 없음`);
    assert.notEqual(MANAGER_KIND_LABEL[k], k);
  }
  assert.equal(Object.keys(MANAGER_KIND_LABEL).length, 4, "종류가 늘었는데 라벨 표를 안 고쳤다");
});

// ══ M16·M17 자동 조치 거부 규칙 ══
await t("비가역 조치는 자동 적용하지 않는다 [M16]", async () => {
  // review_knowledge 는 '읽어 보라'는 표식이지 기계가 적용할 조치가 아니다.
  assert.equal(await applyAction({ op: "review_knowledge", name: "k" }, "test"), false);
  // 존재하지 않는 파괴적 op 도 당연히 거부(화이트리스트 방식임을 고정한다).
  assert.equal(await applyAction({ op: "delete_knowledge", name: "k" }, "test"), false);
  assert.equal(await applyAction({ op: "rewrite_body", name: "k", body: "..." }, "test"), false);
});

await t("op 이 없거나 이상하면 거부 [M17·경계]", async () => {
  assert.equal(await applyAction(null, "test"), false);
  assert.equal(await applyAction(undefined, "test"), false);
  assert.equal(await applyAction({}, "test"), false);
  assert.equal(await applyAction({ op: 123 }, "test"), false);
  assert.equal(await applyAction("move_category", "test"), false); // 문자열은 조치가 아니다
});

await t("move_category 도 필수값이 없으면 거부", async () => {
  // 이름이나 대상 분류가 비면 DB 를 건드리기 전에 막는다(잘못된 이동은 되돌리기가 번거롭다).
  assert.equal(await applyAction({ op: "move_category" }, "test"), false);
  assert.equal(await applyAction({ op: "move_category", name: "k" }, "test"), false);
  assert.equal(await applyAction({ op: "move_category", to_category_id: 3 }, "test"), false);
  assert.equal(await applyAction({ op: "move_category", name: "", to_category_id: 3 }, "test"), false);
});

// ══ 화이트리스트 단일 출처 — 화면·저장·적용이 같은 판정을 써야 한다 [#1419 T9] ══
await t("isApplicableAction 과 applyAction 의 판정이 일치한다", async () => {
  // 이 둘이 어긋나면 '적용' 버튼이 있는데 눌러도 아무 일이 없다(사용자는 실패를 인지하지 못한다).
  //  applyAction 은 DB 를 건드리므로 **거부 케이스만** 대조한다 — 거부는 DB 접근 전에 끝난다.
  const rejected: unknown[] = [
    null, undefined, {}, { op: 123 }, "move_category",
    { op: "review_knowledge", name: "k" },
    { op: "delete_knowledge", name: "k" },
    { op: "move_category" },                              // 필수값 없음
    { op: "move_category", name: "k" },                   // 대상 분류 없음
    { op: "move_category", to_category_id: 3 },           // 지식 이름 없음
    { op: "move_category", name: "   ", to_category_id: 3 }, // 공백뿐인 이름
    { op: "move_category", name: "k", to_category_id: 0 }, // 0 은 유효 id 가 아니다
  ];
  for (const a of rejected) {
    assert.equal(isApplicableAction(a), false, `whitelist 가 통과시켰다: ${JSON.stringify(a)}`);
    assert.equal(await applyAction(a, "test"), false, `applyAction 이 통과시켰다: ${JSON.stringify(a)}`);
  }
  // 반대로 온전한 조치안은 화이트리스트를 통과해야 한다(대조군 — 전부 false 를 반환하는 구현을 잡는다).
  assert.equal(isApplicableAction({ op: "move_category", name: "k", to_category_id: 3 }), true);
});

// ══ M18 코드괴리 관리기는 «지식» 도 본다 (#3579) ══════════════════════════════════
//  실측 사고(2026-09-07): 2026-08-28 지식이 «defaultWorkspaceId() 로 고쳤다» 고 적어 뒀는데 그 심볼은
//  전 브랜치 어느 커밋에도 없었다. 지식만 «고쳤다» 고 말하고 코드엔 없는 상태가 열흘 갔고, 그 사이
//  같은 버그를 다른 프로젝트가 처음부터 다시 진단했다(#3564).
//
//  ★ 그런데 그걸 잡으라고 만든 관리기(code_drift)는 **도메인 정의만** 후보로 냈다. 종류 이름은
//   «지식 ↔ 코드 비교» 이고 관리기 설정은 지식 필터(match_types)를 들고 있었는데, 후보 SQL 은 category
//   만 봤다 — 즉 이 관리기 자신이 «문서가 말하는 걸 코드가 안 하는» 사례였다. 켜 두기만 했어도
//   지식은 한 건도 안 봤을 것이다.
//
//  아래는 그 배선을 잠근다. 순수 판정이 아니라 **배선**이라 소스를 읽어 단언한다(DB·LLM 없이 잴 수 있는
//   유일한 층이다 — 이 경로의 실제 판정은 헤드리스 AI 가 한다).
function repoRoot(): string {
  let d = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (existsSync(path.join(d, "package.json")) && existsSync(path.join(d, "web"))) return d;
    d = path.dirname(d);
  }
  throw new Error("레포 뿌리를 찾지 못했다");
}
const readSrc = (rel: string): string => readFileSync(path.join(repoRoot(), rel), "utf8");

await t("코드괴리 후보에 지식이 들어간다 — 도메인만 보면 «고쳤다는 지식» 을 아무도 안 본다 [M18]", () => {
  const det = readSrc("src/org/manage/detectors.ts");
  assert.match(det, /export async function findCodeDriftKnowledgeCandidates/,
    "지식 후보 경로가 없다 — code_drift 가 category 만 본다(이 관리기 이름은 «지식 ↔ 코드» 다)");
  const fn = det.slice(det.indexOf("export async function findCodeDriftKnowledgeCandidates"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /FROM knowledge k/, "지식 표를 안 읽는다");
  //  ★ 관리기 스코프(match_types·provenance·exclude_names…)를 **실제로** 적용해야 한다. 설정은 지식
  //   필터를 들고 있는데 SQL 이 그걸 무시하던 것이 이 사고의 구조적 뿌리다.
  assert.match(body, /scopeConds\(m, params, "k"\)/,
    "관리기 스코프를 안 쓴다 — 설정(match_types 등)이 약속하는 범위와 실제로 보는 범위가 갈린다");
  assert.match(body, /category_repo/, "레포가 연결된 것만 봐야 한다(코드를 못 찾으면 AI 가 추측한다)");
});

await t("코드괴리 실행 경로가 지식 후보를 실제로 부르고 배치에 싣는다 [M18]", () => {
  const run = readSrc("src/org/manage/run-manager.ts");
  assert.match(run, /findCodeDriftKnowledgeCandidates\(m, m\.batch_size\)/,
    "실행 경로가 지식 후보를 안 부른다 — 함수만 있고 아무도 안 쓰면 없는 것과 같다");
  assert.match(run, /buildCodeDriftPrompt\(m, group\.cats, group\.docs\)/,
    "프롬프트에 지식 후보를 안 넘긴다");
});

await t("배치 지시문이 지식 축과 «과거 서술 제외» 를 함께 담는다 [M18]", () => {
  const run = readSrc("src/org/manage/run-manager.ts");
  const fn = run.slice(run.indexOf("function buildCodeDriftPrompt"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /target_kind='knowledge'/, "지식 발견을 어떤 종류로 보고할지 안 알려 준다");
  //  오탐 하나가 큐를 죽인다 — 이 레포는 «종전엔 이랬다» 를 본문에 남기는 관례가 있어, 그 문장을
  //  드리프트로 읽으면 발견이 전부 잡음이 된다(관리기 note 가 켜기 전 조건으로 적어 둔 바로 그 항목).
  assert.match(body, /과거를 서술하는 문장은 괴리가 아니다/,
    "«종전엔 이랬다» 관례를 안 알려 주면 오탐이 큐를 덮는다");
});

// ══ 모순 후보 SQL — HNSW 이웃 탐색 모양 + 술어 보존 ══
//  전쌍 자기조인으로 되돌아가면 인덱스를 못 타 운영 데이터(임베딩 5천여 건)에서 statement timeout 이 난다.
//  술어가 하나라도 빠지면 폴더·비활성·스코프 밖 지식이 LLM 배치에 섞여 조용히 비용과 오탐이 는다.
const CSQL = contradictionCandidateSql(["k.lifecycle='active'", "SCOPE_SENTINEL"], "$7", "$8");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const lateralOpen = CSQL.indexOf("CROSS JOIN LATERAL (");
const lateralClose = CSQL.indexOf(") o\n");
const INNER = flat(CSQL.slice(lateralOpen, lateralClose));
const OUTER = flat(CSQL.slice(0, lateralOpen) + CSQL.slice(lateralClose));

await t("모순 후보는 행마다 LATERAL 최근접 이웃(인덱스 열 <=> 바깥 벡터 ORDER BY … LIMIT)으로 뽑는다", () => {
  assert.ok(lateralOpen > 0 && lateralClose > lateralOpen, "LATERAL 서브쿼리가 없다");
  assert.match(INNER, /FROM knowledge o .*ORDER BY o\.embedding_vector <=> k\.embedding_vector LIMIT (\d+)/,
    "HNSW 가 타는 «인덱스 열 <=> 식» 정렬 + LIMIT 이 아니다");
  assert.equal(Number(/LIMIT (\d+)/.exec(INNER)?.[1]), CONTRADICTION_NEIGHBORS);
  assert.doesNotMatch(flat(CSQL), /JOIN knowledge o ON/, "전쌍 자기조인이 돌아왔다");
  assert.doesNotMatch(INNER, /<=\s*\$/, "거리 임계를 이웃 탐색 안에 넣으면 HNSW 가 아니라 필터 스캔이 된다");
});

await t("모순 후보 SQL 이 기존 술어를 전부 보존한다", () => {
  // o 쪽 — 이웃 탐색 안에서 거른다
  for (const p of ["o.lifecycle='active'", "o.embedding_vector IS NOT NULL", "COALESCE(o.is_folder,false) = false"]) {
    assert.ok(INNER.includes(p), `이웃 탐색에 o 술어 누락: ${p}`);
  }
  // k 쪽 스코프 + 쌍 술어 — 바깥에서 거른다
  for (const p of ["k.lifecycle='active' AND SCOPE_SENTINEL", "k.embedding_vector IS NOT NULL",
    "COALESCE(k.is_folder,false) = false", "o.name > k.name", "o.dist <= $7"]) {
    assert.ok(OUTER.includes(p), `바깥 술어 누락: ${p}`);
  }
  assert.match(OUTER, /ORDER BY similarity DESC LIMIT \$8\s*$/, "기존 정렬·LIMIT 이 아니다");
  assert.match(OUTER, /\(1 - o\.dist\) AS similarity/, "유사도 = 1 - 코사인 거리");
  const det = readSrc("src/org/manage/detectors.ts");
  const fn = det.slice(det.indexOf("export async function findContradictionCandidates"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /scopeConds\(m, params, "k"\)/, "관리기 스코프를 안 쓴다");
  assert.match(body, /contradictionCandidateSql\(conds, distP, limP\)/, "조립 함수를 안 거친다 — 위 단언이 실제 SQL 을 안 본다");
});

// ══ 관리기 결과 → 크론 status ══
//  runManager 는 실패를 throw 하지 않고 결과의 error 로 돌려준다. 액션이 그걸 ok 로 덮으면 모순 후보 SQL 이
//  timeout 으로 죽어도 크론 last_status 에 ok 가 찍힌다(2026-10-11 실제로 그랬다).
await t("관리기 결과 → 크론 status 표", () => {
  const E = { error: "canceling statement due to statement timeout" };
  const P = { partial_error: "레포 1/3 접수 실패: r2: 헤드리스 접수 실패" };
  const rows: [Pick<ManagerRunResult, "error" | "partial_error">[], string, string][] = [
    [[{}], "ok", "성공 하나"],
    [[{}, {}], "ok", "전부 성공"],
    [[E], "error", "하나뿐인 관리기가 실패"],
    [[E, E], "error", "전부 실패"],
    [[E, {}], "warn", "일부 실패"],
    [[{}, E, {}], "warn", "가운데 하나 실패"],
    [[{ error: "" }], "ok", "빈 error 문자열은 실패가 아니다"],
    [[P], "warn", "하나뿐인 관리기가 레포 일부만 접수 실패 — 나머지 레포는 돌았다"],
    [[P, E], "warn", "한 관리기는 레포 일부라도 돌았으면 전멸이 아니다"],
    [[P, {}], "warn", "partial_error 만 있어도 경고"],
  ];
  for (const [input, want, why] of rows) assert.equal(statusForManagerResults(input), want, why);
  // skipped(볼 것 없음)는 성공이다 — 실패로 세면 후보 0건인 주마다 브레이커가 돈다
  assert.equal(statusForManagerResults([{ skipped: "닮은 지식 쌍 없음" } as Pick<ManagerRunResult, "error">, E]), "warn");
});

await t("크론 액션이 관리기 결과로 status 를 정한다", () => {
  const act = readSrc("src/scheduler/actions/manage.ts");
  assert.match(act, /status: statusForManagerResults\(out\), summary: \{ managers: out \}/,
    "관리기 실패가 크론 상태에 안 드러난다");
});

console.log(`\n${pass} passed`);

// ── 배선 — HNSW 탐색 폭과 접수 실패 노출 (리뷰 반영) ──
{
  const { readFileSync } = await import("node:fs");
  const src = (p: string) => readFileSync(new URL(p, import.meta.url).pathname.replace("/dist/", "/src/"), "utf8");
  const DET = src("./detectors.ts");
  const RUN = src("./run-manager.ts");
  assert.match(DET, /SET LOCAL hnsw\.ef_search = \$\{CONTRADICTION_EF_SEARCH\}/, "탐색 폭을 안 넓혀 이웃 40개가 후보 목록 꼬리로 채워진다");
  //  대체 경로를 안 끄면 플래너가 HNSW 대신 행마다 순차 스캔을 골라 prod 에서 statement timeout 이 난다(2026-10-11).
  assert.match(DET, /for \(const g of CONTRADICTION_PLANNER_OFF\) await client\.query\(`SET LOCAL \$\{g\} = off`\)/, "플래너 대체 경로를 끄지 않는다");
  assert.deepEqual([...CONTRADICTION_PLANNER_OFF].sort(), ["enable_bitmapscan", "enable_seqscan", "enable_sort"],
    "seqscan·bitmapscan·sort 셋 다 꺼야 HNSW 를 고른다(seqscan 만 끄면 lifecycle 비트맵 스캔으로 간다)");
  assert.ok(!/client\.query\(`SET hnsw/.test(DET), "세션 SET 은 풀 커넥션에 새어 다른 쿼리의 실행계획을 바꾼다");
  assert.match(RUN, /if \(r\.status === "error"\) return \{ \.\.\.base, candidates: cands\.length, error: errorOf\(r\.summary\) \};/,
    "모순 관리기 접수 실패가 결과에 error 로 안 실려 크론 상태·감시가 ok 로 읽는다");
  assert.match(RUN, /\.\.\.\(failMsg \? \(taskIds\.length \? \{ partial_error: failMsg \} : \{ error: failMsg \}\) : \{\}\)/,
    "코드 비교 관리기의 레포 접수 실패가 결과에 안 실리면 상태·감시가 ok 로 읽는다(전멸=error, 일부=partial_error)");
  assert.ok(!/failed_repos/.test(RUN), "아무도 읽지 않는 칸에 실패를 실어 다시 묻는다");
  console.log("ok  배선 — ef_search·접수 실패 노출");
}
