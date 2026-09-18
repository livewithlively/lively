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
//  ⓘ **이 가드 자신은 test.yml 에 등록하지 않는다** — 확인: `node scripts/run-tests.mjs --scope=scripts`
//     의 수집 목록에 이 파일이 있다. 이름이 `*.test.mjs` 라 러너가 자동으로 집어 가고(실 DB 를 안 쓰므로
//     유닛 체인에 속한다), CI 는 그 러너를 통째로 돌린다. 등록을 강제하는 가드가 정작 자기만 수기
//     등록이면 같은 사고를 자기 자신에게 되풀이하게 되므로, 자동 수집되는 계층에 두는 것이 요점이다.
//
//  실행: node scripts/pg-test-registered.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

const WORKFLOW = src(".github/workflows/test.yml");

/** 러너가 **실제로** 수집하는 목록. 소스 텍스트가 아니라 행동을 본다 — 아래 P1 주석 참조. */
const COLLECTED = execFileSync(process.execPath, ["scripts/run-tests.mjs", "--list"], {
  cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
}).split("\n").map((s) => s.trim()).filter(Boolean);

const onDisk = findPgTests("src").sort();

// 🔴 «등록» 은 **실행되는 명령**이지 파일 어딘가에 그 경로가 적혀 있는 것이 아니다.
//  파일 전체를 훑으면 주석에 적힌 경로("언젠가 이것도 넣자", "원래 … 였다")까지 등록으로 세어,
//  실제로는 아무도 안 돌리는 pg-test 를 통과시킨다 — 이 가드가 막으려는 바로 그 상황에서
//  가드가 조용히 무력해진다(실측으로 확인한 거짓 통과). 그래서 줄마다 주석을 먼저 떼고
//  `node <경로>` 호출만 센다. `run: |` 여러 줄 블록도 줄 단위라 그대로 걸린다.
//  ⚠ 인용부호 안의 `#` 까지 주석으로 떼므로 그런 줄은 «미등록» 으로 읽힐 수 있다 —
//   헛경보 방향이라 안전하다(거짓 통과보다 낫다).
const registered = WORKFLOW.split("\n").flatMap((line) => {
  const code = line.split("#")[0];
  return [...code.matchAll(/\bnode\s+(src\/[\w/.-]+\.pg-test\.mjs)\b/g)].map((m) => m[1]);
});
const registeredSet = new Set(registered);

// 이 가드의 **전제**를 먼저 못박는다 — 러너가 pg-test 를 자동 수집하게 바뀌면 수기 등록은 필요 없어지고
//  이 가드도 test.yml 의 파일별 스텝도 걷어내야 한다. 전제가 사라졌는데 가드만 남으면, 사람은 이게 왜
//  있는지 모른 채 새 파일을 계속 손으로 등록한다.
// 🔴 소스에서 제외 정규식 리터럴을 찾는 방식이 아니라 **러너를 돌려 수집 목록을 본다.** 리터럴 매칭은
//  양방향으로 무르다: 제외를 `endsWith(".pg-test.mjs")` 로 리팩터하면 동작은 그대로인데 헛경보가 나고,
//  반대로 조건부 자동수집을 얹으면서 리터럴만 남기면 전제가 사라졌는데도 통과한다(거짓 통과).
t("[P1] 러너가 수집하는 목록에 pg-test 는 없다 — 그래서 수기 등록이 필요하다", () => {
  const collectedPgTests = COLLECTED.filter((p) => p.endsWith(".pg-test.mjs"));
  assert.deepEqual(collectedPgTests, [],
    "러너가 pg-test 를 수집한다 — 자동 수집으로 바뀐 것이면 이 가드와 test.yml 의 파일별 스텝을 걷어내라: "
    + collectedPgTests.join(" · "));
});

// 등록을 강제하는 가드가 정작 자기만 안 돌면 막으려는 사고를 자기 자신에게 되풀이한다.
//  헤더 주석이 «러너가 자동으로 집어 간다» 고 주장하므로, 그 주장을 여기서 기계로 단언한다.
t("[P1-b] 이 가드 자신은 러너가 수집한다 — 그래서 test.yml 에 수기 등록하지 않는다", () => {
  const self = "scripts/pg-test-registered.test.mjs";
  assert.ok(COLLECTED.includes(self),
    `러너가 이 가드를 수집하지 않는다 — 아무도 안 돌린다. 수집 규칙이 바뀌었는지 확인하라(수집 ${COLLECTED.length}건)`);
});

// 글롭이 깨져 0건이 되면 아래 대조가 **전부 공허하게 통과**한다(빈 집합끼리는 항상 같다).
t(`[P2] pg-test 파일을 디스크에서 찾았다 (${onDisk.length}개)`, () => {
  assert.ok(onDisk.length > 0, "src 아래에 pg-test 가 하나도 없다 — findPgTests 의 글롭이 깨졌는지 확인하라");
});

t("[P3] 🔴 실재하는 pg-test 는 전부 test.yml 에 등록돼 있다", () => {
  const missing = onDisk.filter((p) => !registeredSet.has(p));
  // 이 가드가 보는 것은 «test.yml 어딘가에서 `node <경로>` 로 실행된다» 까지다. 그 스텝이 올바른 잡에
  //  있는지·`ITEMS_DATABASE_URL` 을 받는지·`if:`/`continue-on-error:` 로 사실상 꺼져 있지 않은지는
  //  검사하지 않는다(YAML 구조 파싱을 들이지 않았다 — 실측으로 확인한 남은 맹점이다).
  //  그러니 메시지도 거기까지만 말하고, 나머지는 옆 스텝을 본뜨라고 가리킨다.
  assert.deepEqual(missing, [],
    "test.yml 에서 실행되지 않는 pg-test 가 있다 — CI 가 한 번도 돌리지 않는다(초록이지만 아무도 안 본다). "
    + `옆의 pg-test 스텝을 그대로 본떠 추가하라: ${missing.join(" · ")}`);
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
