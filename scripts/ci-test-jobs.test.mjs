#!/usr/bin/env node
// ★배선 가드 — **CI 가 시험을 한 건도 빠뜨리지 않고, 빨간 조각을 초록으로 통과시키지 않는다** (#5603).
//
//  CI 는 시험 한 벌을 잡 여럿으로 나눠 돈다(.github/workflows/test.yml — unit × N · pg × N · test-windows × N, 그리고 그것을
//  모으는 문 `test`). 나누면 빨라지지만 새로 틀릴 자리가 셋 생긴다. 셋 다 **조용하다** — 빨간불이 안 뜬 채 시험이 안 돈다:
//   ① 조각 번호가 비거나(1,2,4) 조각 수가 어긋나면 그 조각의 시험은 아무도 안 돌린다.
//   ② 문(`test`)이 needs 실패로 skip 되면 GitHub 은 skip 된 필수 체크를 **통과로 센다** — 조각이 빨간데 머지 큐가 열린다.
//   ③ 실 PG 통합 테스트(`*.pg-test.mjs`)는 유닛 수집 밖이다. 러너를 `--pg` 로 부르는 스텝이 사라지면 105개가 통째로 안 돈다.
//      (종전엔 파일마다 스텝을 손으로 적었고, 그때의 무음 실패가 «등록 누락» 이었다 — 16개 중 5개가 한 번도 안 돌았고 그중
//       하나는 실제로 깨져 있었다. 이제 러너가 자동 수집하므로 그 자리는 없어졌고, 대신 «러너를 부르는가» 가 지킬 것이 됐다.)
//
//  판정은 양쪽을 **각자의 SoT 에서 읽어** 대조한다(파일 시스템 · 러너 소스 ↔ test.yml). 목록을 여기 적지 않는다 — 적는 순간
//  이 파일이 세 번째 SoT 가 되어 같이 썩는다.
//
//  ⓘ 조각의 합이 전체와 같다는 것(나눔 자체의 성질)은 scripts/test-runner-schedule.test.mjs S7·S8 이 실제 러너로 잰다.
//     여기는 **워크플로가 그 러너를 옳게 부르는가**만 본다.
//  ⓘ YAML 파서를 들이지 않았다(레포에 의존성이 없다 · 윈도우 잡은 npm ci 도 안 한다). 잡 블록을 들여쓰기로 자르고 주석을 뗀
//     글에서 찾는다 — 주석에 적힌 명령("원래 … 였다")을 실행으로 세면 가드가 지켜야 할 바로 그때 침묵한다.
//
//  실행: node scripts/ci-test-jobs.test.mjs
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel) => readFileSync(join(ROOT, rel), "utf8");

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const RUNNER = src("scripts/run-tests.mjs");
//  주석을 뗀 워크플로 — 줄마다 `#` 뒤를 버린다. ⚠ 인용부호 안의 `#` 까지 떼므로 그런 줄은 «없음» 으로 읽힐 수 있다 —
//   헛경보 방향이라 안전하다(거짓 통과보다 낫다).
const WORKFLOW = src(".github/workflows/test.yml").split("\n").map((l) => l.split("#")[0].trimEnd()).join("\n");

/** jobs: 아래의 잡 블록 — `  이름:` 줄부터 다음 잡 줄 앞까지. */
function jobs(text) {
  const at = text.indexOf("\njobs:");
  assert.notEqual(at, -1, "test.yml 에서 jobs: 를 못 찾았다");
  const out = {};
  let name = null;
  for (const line of text.slice(at + 1).split("\n").slice(1)) {
    const m = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (m) { name = m[1]; out[name] = ""; continue; }
    if (name) out[name] += `${line}\n`;
  }
  return out;
}
const JOBS = jobs(WORKFLOW);

/** 잡의 matrix.shard 목록 — `shard: [1, 2, 3]`. 없으면 null. */
const shardsOf = (job) => {
  const m = /^\s+shard:\s*\[([^\]]*)\]\s*$/m.exec(JOBS[job] ?? "");
  return m ? m[1].split(",").map((x) => Number(x.trim())) : null;
};
/** 잡 안에서 러너를 부르는 줄들(`run: node scripts/run-tests.mjs …`). */
const runnerCalls = (job) => (JOBS[job] ?? "").split("\n").filter((l) => /\bnode\s+scripts\/run-tests\.mjs\b/.test(l));
const SHARD_ARG = "--shard=${{ matrix.shard }}/${{ strategy.job-total }}";

/** 디스크의 pg-test. 경로는 `/` 로 만든다 — 윈도우 러너에서도 같은 글로 대조된다. */
function findPgTests(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    if (["node_modules", ".git", "dist", "build", "public"].includes(e.name)) continue;
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...findPgTests(rel));
    else if (e.name.endsWith(".pg-test.mjs")) out.push(rel);
  }
  return out;
}

// ── 조각 — 번호가 1..N 으로 이어지고, 러너가 그 번호와 «잡 수» 를 그대로 받는다 ──
for (const [job, mode] of [["unit", "--budget="], ["pg", "--pg"], ["test-windows", "--scope=kit,desktop"]]) {
  t(`[J1] ${job} — 조각 번호가 1..N 으로 빈틈없이 이어진다`, () => {
    const shards = shardsOf(job);
    assert.ok(shards && shards.length >= 1, `${job} 잡에 matrix.shard 가 없다 — 조각으로 나뉘지 않았거나 잡 이름이 바뀌었다`);
    assert.deepEqual(shards, shards.map((_, i) => i + 1),
      `${job} 의 조각 번호가 1..${shards.length} 이 아니다(${shards.join(",")}) — 빈 번호의 시험은 아무도 안 돌린다`);
  });
  t(`[J2] ${job} — 러너를 한 번, 조각 번호와 잡 수(strategy.job-total)로 부른다`, () => {
    const calls = runnerCalls(job);
    assert.equal(calls.length, 1, `${job} 잡이 러너를 ${calls.length}번 부른다(한 번이어야 한다):\n${calls.join("\n")}`);
    assert.ok(calls[0].includes(SHARD_ARG),
      `${job} 의 러너 호출에 «${SHARD_ARG}» 가 없다 — 조각 수를 손으로 적으면 matrix 와 어긋나는 순간 시험이 빠진다:\n${calls[0]}`);
    assert.ok(calls[0].includes(mode), `${job} 의 러너 호출에 «${mode}» 가 없다:\n${calls[0]}`);
  });
  t(`[J3] ${job} — 조각 하나가 깨져도 나머지는 끝까지 돈다 · 실패를 삼키지 않는다`, () => {
    assert.match(JOBS[job], /^\s+fail-fast:\s*false\s*$/m, `${job} 의 fail-fast 가 false 가 아니다 — 한 조각의 실패가 다른 조각의 실패를 가린다`);
    assert.doesNotMatch(JOBS[job], /continue-on-error:\s*true/, `${job} 잡이 실패를 삼킨다(continue-on-error)`);
  });
}

// ── 문 — 필수 체크 `test` 가 조각 전부를 직접 판정한다 ──
t("[G1] 🔴 문(test)은 always() 로 반드시 돈다 — skip 된 필수 체크는 통과로 세어진다", () => {
  assert.ok(JOBS.test, "test.yml 에 `test` 잡이 없다 — 브랜치 보호의 필수 체크 이름이다(없으면 머지 큐가 영영 기다린다)");
  assert.match(JOBS.test, /^\s+if:\s*\$\{\{\s*always\(\)\s*\}\}\s*$/m,
    "문에 `if: ${{ always() }}` 가 없다 — 조각이 깨지면 문이 skip 되고, GitHub 은 그것을 통과로 센다");
});
t("[G2] 문은 유닛 · PG 조각을 둘 다 기다리고, 둘의 결과가 success 인지 직접 본다", () => {
  const needs = /^\s+needs:\s*\[([^\]]*)\]\s*$/m.exec(JOBS.test);
  assert.ok(needs, "문에 needs 가 없다");
  const list = needs[1].split(",").map((x) => x.trim());
  for (const job of ["unit", "pg"]) {
    assert.ok(list.includes(job), `문이 ${job} 을 기다리지 않는다 — ${job} 이 빨개도 머지된다`);
    assert.ok(JOBS.test.includes(`needs.${job}.result`), `문이 needs.${job}.result 를 읽지 않는다`);
  }
  //  env 로 받은 결과를 `= "success"` 로 견준다 — 하나라도 다르면(failure · cancelled · skipped) 스텝이 죽는다.
  const checks = [...JOBS.test.matchAll(/\[ "\$(\w+)" = "success" \]/g)].map((m) => m[1]);
  const envs = [...JOBS.test.matchAll(/^\s+(\w+):\s*\$\{\{\s*needs\.(\w+)\.result\s*\}\}\s*$/gm)].map((m) => m[1]);
  assert.deepEqual([...checks].sort(), [...envs].sort(), `문이 받은 결과(${envs.join(",")})와 success 로 견주는 것(${checks.join(",")})이 다르다`);
  assert.equal(envs.length, list.length, "needs 에 건 잡의 수와 결과를 읽는 수가 다르다 — 기다리기만 하고 판정하지 않는 잡이 있다");
});

// ── PG — 러너가 자동 수집하고, pg 잡이 그것을 실 DB 로 돌린다 ──
t("[P1] 러너의 --pg 가 pg-test 를 모은다 · 유닛 수집은 그것을 뺀다(실 DB 없이 돌면 105개가 저마다 죽는다)", () => {
  const body = (name) => {
    const from = RUNNER.indexOf(`function ${name}(`);
    assert.notEqual(from, -1, `run-tests.mjs 에서 ${name}() 를 못 찾았다 — 가드가 무엇을 볼지 모른다`);
    return RUNNER.slice(from, RUNNER.indexOf("\n}", from));
  };
  assert.match(body("collect"), /pg-test/, "러너의 유닛 수집(collect)이 pg-test 를 더는 빼지 않는다 — 실 DB 없는 유닛 조각에서 돈다");
  assert.match(body("collectPg"), /pg-test/, "러너의 collectPg() 가 pg-test 를 모으지 않는다");
  assert.match(RUNNER, /if \(opts\.pg\) \{[\s\S]{0,600}?collectPg\("src"\)/, "--pg 갈래가 collectPg(\"src\") 를 부르지 않는다");
});
const onDisk = findPgTests(".").map((p) => p.replace(/^\.\//, "")).sort();
t(`[P2] pg-test 는 전부 src/ 아래에 있다 — 러너가 모으는 자리다 (${onDisk.length}개)`, () => {
  assert.ok(onDisk.length > 0, "pg-test 를 하나도 못 찾았다 — findPgTests 가 깨졌는지 확인하라(0건이면 아래가 전부 공허하게 통과한다)");
  const outside = onDisk.filter((p) => !p.startsWith("src/"));
  assert.deepEqual(outside, [], `src/ 밖의 pg-test 는 아무도 안 돌린다(--pg 는 src 만 모은다): ${outside.join(" · ")}`);
});
t("[P3] 🔴 pg 잡이 실 DB 주소를 주고 러너를 --pg 로 부른다 · 스키마를 먼저 세운다", () => {
  const job = JOBS.pg ?? "";
  assert.match(job, /^\s+image:\s*pgvector\/pgvector:/m, "pg 잡의 Postgres 가 pgvector 이미지가 아니다(#172 — plain postgres 금지)");
  const at = job.indexOf(runnerCalls("pg")[0]);
  const stepStart = job.lastIndexOf("\n      - ", at);
  const step = job.slice(stepStart, at);
  assert.match(step, /ITEMS_DATABASE_URL:\s*postgres:\/\//, "러너를 부르는 스텝에 ITEMS_DATABASE_URL 이 없다 — 러너가 exit 2 로 죽는다");
  const schema = job.indexOf("initAllSchemas");
  assert.ok(schema !== -1 && schema < at, "스키마 마이그레이션(initAllSchemas)이 러너보다 앞에 없다 — 빈 DB 에서 pg-test 가 돈다");
});
t("[P4] 손으로 적은 pg-test 스텝이 남아 있지 않다 — 남으면 그 파일은 두 번 돈다(같은 DB 에서)", () => {
  const manual = [...WORKFLOW.matchAll(/\bnode\s+(src\/[\w/.-]+\.pg-test\.mjs)\b/g)].map((m) => m[1]);
  assert.deepEqual(manual, [], `test.yml 이 pg-test 를 직접 실행한다(러너가 이미 모은다): ${manual.join(" · ")}`);
});

console.log(`\n${pass} passed (pg-test ${onDisk.length}개 · 조각 unit ${shardsOf("unit")?.length} · pg ${shardsOf("pg")?.length} · windows ${shardsOf("test-windows")?.length})`);
