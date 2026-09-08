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
import { applyAction } from "./run-manager.js";
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

console.log(`\n${pass} passed`);
