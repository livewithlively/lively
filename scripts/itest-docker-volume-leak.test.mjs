// itest 컨테이너 정리의 익명 볼륨 회수 계약 — 디스크 누수 회귀 가드.
//
// 왜 이 테스트가 있나: `postgres`·`pgvector` 이미지는 `VOLUME /var/lib/postgresql` 을 선언한다.
// `-v` 없이 `docker run` 하면 익명 볼륨이 자동 생성되고, 그 컨테이너를 `docker rm`(-v 없이) 으로 지우면
// **볼륨만 고아로 남는다**. 컨테이너는 깨끗이 사라져 `docker ps -a` 에 흔적이 없고 테스트도 초록이라,
// **성공한 실행마다** 40~78MB 씩 조용히 쌓인다 — 실패로는 절대 드러나지 않는 종류의 결함이다.
//
// 실제로 그랬다(2026-08-14): itest 9개가 전부 `docker rm -f ${CNAME}` 로 정리하고 있었고, 3주 만에
// 익명 볼륨 139개 / 6.26GB 가 쌓여 dev 맥미니가 94% 까지 찼다. 한 달 전(2026-07-14)에도 같은 증상을
// 손으로 걷어냈지만 원인을 안 막아 그대로 재발했다 — 그래서 규율이 아니라 테스트로 박는다.
//
// 왜 텍스트 검사인가: 진짜 검증(볼륨 수 증감)은 도커가 필요한 ②계층이라 기본 CI 에서 안 돈다.
// 이 계약은 **호출 한 줄의 플래그**로 완전히 결정되므로 ①계층(의존성 0)에서 정적으로 잠글 수 있다.
//
// ⚠ 대상은 글롭으로 **자동 발견**한다 — 목록을 하드코딩하면 "새로 짠 사람"이 정확히 이 가드를 빠져나간다.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPTS = path.dirname(fileURLToPath(import.meta.url));

// ── 판정 헬퍼 (순수 — 아래 A 표로 직접 잠근다) ────────────────────────────────

/** 소스에서 `docker rm …` 호출만 뽑는다. `docker volume rm` 은 다른 명령이라 걸리지 않는다. */
const dockerRmCalls = (src) =>
  src.split("\n")
    .map((line, i) => ({ line, no: i + 1 }))
    .filter(({ line }) => /\bdocker\s+rm\b/.test(line));

/** 그 호출이 익명 볼륨까지 회수하나. `-v` · `-fv` 묶음 · `--volumes` 를 모두 인정한다. */
const removesVolumes = (line) => {
  // 인자 구간만 본다 — 따옴표/백틱에서 끊어 뒤따르는 다른 셸 토막을 섞지 않는다.
  const args = /\bdocker\s+rm\b([^`"']*)/.exec(line)?.[1] ?? "";
  // 반드시 **플래그 토큰**이어야 한다 — 컨테이너 이름 안의 v(co-v-itest)를 플래그로 오인하면 거짓 통과.
  return /(^|\s)-[a-zA-Z]*v[a-zA-Z]*(\s|$)/.test(args) || /(^|\s)--volumes(\s|$)/.test(args);
};

/** 이 파일이 컨테이너를 띄우나(= 정리 의무가 있나). */
const createsContainer = (src) =>
  /\bdocker\s+run\b/.test(src) || /"docker"\s*,\s*\[\s*"run"/.test(src);

// ── A. 플래그 판정 (사양 A1~A7) ───────────────────────────────────────────────
// 헬퍼를 실제 파일에만 걸어보면 정규식이 깨져도 모른다(전부 통과해버린다). 표로 직접 잠근다.
const FLAG_CASES = [
  ["A1 정상형(-f -v)",        "  try { sh(`docker rm -f -v ${CNAME}`); } catch {}",        true],
  ["A2 회귀형(-v 없음)",      "  try { sh(`docker rm -f ${CNAME}`); } catch {}",           false],
  ["A3 묶인 단축(-fv)",       "  try { sh(`docker rm -fv ${CNAME}`); } catch {}",          true],
  ["A4 롱옵션(--volumes)",    "  try { sh(`docker rm --volumes -f ${CNAME}`); } catch {}", true],
  ["A5 플래그 전무",          "  try { sh(`docker rm ${CNAME}`); } catch {}",              false],
  ["A6 이름 속 v (경계)",     "  try { sh(`docker rm -f co-v-itest`); } catch {}",         false],
];
for (const [label, line, expected] of FLAG_CASES) {
  assert.equal(dockerRmCalls(line).length, 1, `${label}: 호출 추출에 실패했다 — 정규식이 깨졌다`);
  assert.equal(removesVolumes(line), expected,
    `${label}: 볼륨 회수 판정이 ${expected} 여야 하는데 ${!expected} 로 나왔다 — 「${line.trim()}」`);
}
// A7 — `docker volume rm` 은 컨테이너 정리가 아니다(추출 대상 아님).
assert.equal(dockerRmCalls("docker volume ls -qf dangling=true | xargs docker volume rm").length, 0,
  `A7: \`docker volume rm\` 이 컨테이너 정리로 오인됐다 — 무관한 줄에 거짓 실패가 난다`);

// ── B·C. 실제 itest 파일에 적용 ───────────────────────────────────────────────
const targets = readdirSync(SCRIPTS, { recursive: true })
  .filter((p) => /\.itest\.mjs$|itest-harness\.mjs$/.test(p))
  .sort();

// C1 — 글롭이 헛돌면 아래 단언이 전부 공허해진다(0건이 거짓 green 이 되지 않게).
assert.ok(targets.length > 0,
  `C1: scripts/ 에서 *.itest.mjs 를 한 건도 못 찾았다 — 글롭이 깨졌다(가드가 아무것도 안 보고 있다)`);

let checkedCalls = 0;
const missingV = [];
const noCleanup = [];

for (const rel of targets) {
  const src = readFileSync(path.join(SCRIPTS, rel), "utf8");
  const calls = dockerRmCalls(src);

  // B2 — 컨테이너를 띄우면 반드시 정리 호출이 있어야 한다.
  if (createsContainer(src) && calls.length === 0) noCleanup.push(rel);

  // B1 — 모든 `docker rm` 은 익명 볼륨까지 회수해야 한다.
  for (const { line, no } of calls) {
    checkedCalls++;
    if (!removesVolumes(line)) missingV.push(`${rel}:${no}  ${line.trim()}`);
  }
}

// C2 — 추출이 0건이면 B1 루프가 한 번도 안 돈 것이다.
assert.ok(checkedCalls > 0,
  `C2: 대상 ${targets.length}개 파일에서 \`docker rm\` 호출을 한 건도 못 찾았다 — 추출이 깨졌다`);

assert.deepEqual(noCleanup, [],
  `B2: 컨테이너를 띄우면서 \`docker rm\` 정리가 없는 itest:\n  ${noCleanup.join("\n  ")}\n` +
  `  → finally 에서 정리해라(안 하면 이름 충돌 + 볼륨 누수).`);

assert.deepEqual(missingV, [],
  `B1: \`docker rm\` 에 -v 가 없다 — 익명 볼륨이 고아로 남아 실행할 때마다 디스크가 샌다:\n  ${
    missingV.join("\n  ")}\n` +
  `  → \`docker rm -f \${CNAME}\` → \`docker rm -f -v \${CNAME}\`\n` +
  `  (컨테이너는 사라지고 테스트도 통과하므로 증상이 안 보인다 — 볼륨만 40~78MB 씩 쌓인다.)`);

console.log(`ok  플래그 판정 ${FLAG_CASES.length + 1}건 · itest ${targets.length}개 / docker rm ${
  checkedCalls}건 전부 익명 볼륨 회수(-v)`);
