#!/usr/bin/env node
// ★배선 가드 — **실 PG 통합 테스트(`*.pg-test.mjs`)는 전부 CI 에 등록돼 있다**.
//
//  왜 이 테스트가 필요한가. 이 계층은 러너의 자동 발견 **밖**이다(scripts/run-tests.mjs 가
//  `*.pg-test.mjs` 를 수집에서 제외한다 — 실 Postgres 를 요구하므로 유닛 체인에 섞일 수 없다).
//  그래서 도는 유일한 자리가 `.github/workflows/test.yml` 의 **파일별 스텝**이고, 그 등록은 손으로 한다.
//
//  🔴 등록을 빠뜨리는 사고는 조용하다. 테스트 파일은 레포에 있고, 열어 보면 멀쩡하고, CI 는 초록이다 —
//     그저 **한 번도 실행되지 않을** 뿐이다. 빨간불이 안 뜨니 아무도 못 본다.
//     실측(이 가드를 넣던 시점): `src/**/*.pg-test.mjs` 16개 중 **5개가 미등록**이었고, 그중 하나는
//     실제로 깨져 있었다 — 등록이 안 돼 있어서 깨진 줄도 몰랐다.
//
//  왜 목록을 여기 적지 않나 — 그 순간 이 파일이 세 번째 SoT 가 되어 같이 썩는다. 양쪽을 **각자의
//     SoT 에서 읽어**(파일 시스템 ↔ test.yml) 대조하므로, 파일을 늘리거나 지워도 이 파일은 그대로다.
//
//  실행: node scripts/pg-test-registered.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

/** src/ 아래 실재하는 pg-test. 경로는 `/` 로 만든다 — 윈도우 러너에서도 test.yml 문자열과 대조된다. */
function findPgTests(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...findPgTests(rel));
    else if (e.name.endsWith(".pg-test.mjs")) out.push(rel);
  }
  return out;
}

const RUNNER = src("scripts/run-tests.mjs");
const WORKFLOW = src(".github/workflows/test.yml");

const onDisk = findPgTests("src").sort();
const registered = [...WORKFLOW.matchAll(/src\/[\w/.-]+\.pg-test\.mjs/g)].map((m) => m[0]);
const registeredSet = new Set(registered);

// 이 가드의 **전제**를 먼저 못박는다 — 러너가 pg-test 를 자동 수집하게 바뀌면 수기 등록은 필요 없어지고
//  이 가드도 test.yml 의 파일별 스텝도 걷어내야 한다. 전제가 사라졌는데 가드만 남으면, 사람은 이게 왜
//  있는지 모른 채 새 파일을 계속 손으로 등록한다.
t("[P1] 러너는 pg-test 를 자동 수집하지 않는다 — 그래서 수기 등록이 필요하다", () => {
  assert.match(RUNNER, /\\\.pg-test\\\.mjs\$/,
    "run-tests.mjs 가 pg-test 를 제외하지 않는다 — 자동 수집으로 바뀐 것이면 이 가드와 test.yml 의 파일별 스텝을 걷어내라");
});

// 글롭이 깨져 0건이 되면 아래 대조가 **전부 공허하게 통과**한다(빈 집합끼리는 항상 같다).
t(`[P2] pg-test 파일을 디스크에서 찾았다 (${onDisk.length}개)`, () => {
  assert.ok(onDisk.length > 0, "src 아래에 pg-test 가 하나도 없다 — findPgTests 의 글롭이 깨졌는지 확인하라");
});

t("[P3] 🔴 실재하는 pg-test 는 전부 test.yml 에 등록돼 있다", () => {
  const missing = onDisk.filter((p) => !registeredSet.has(p));
  assert.deepEqual(missing, [],
    "CI 에서 한 번도 실행되지 않는 pg-test 가 있다(초록이지만 아무도 안 본다). "
    + `.github/workflows/test.yml 의 test 잡에 ITEMS_DATABASE_URL 을 준 스텝으로 추가하라: ${missing.join(" · ")}`);
});

t("[P4] test.yml 이 등록한 pg-test 는 전부 실재한다 — 개명·삭제 뒤 남은 죽은 스텝을 잡는다", () => {
  const ghost = [...registeredSet].filter((p) => !onDisk.includes(p));
  assert.deepEqual(ghost, [],
    `test.yml 이 없는 파일을 실행하려 한다(그 스텝은 CI 에서 죽는다): ${ghost.join(" · ")}`);
});

t("[P5] 등록은 파일당 한 번뿐이다 — 복붙으로 같은 파일을 두 번 돌리지 않게", () => {
  const dup = [...new Set(registered.filter((p, i) => registered.indexOf(p) !== i))];
  assert.deepEqual(dup, [], `test.yml 에 중복 등록: ${dup.join(" · ")}`);
});

console.log(`\n${pass} passed (pg-test ${onDisk.length}개 전부 등록됨)`);
