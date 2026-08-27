#!/usr/bin/env node
// ★구조 불변식 — **노드 에이전트 번들 경계는 조용히 자라지 않는다** (#2165).
//
//  이 테스트가 없어서 실제로 났던 일(2026-08-27 실측):
//   🔴 가드가 `console.warn` 이라 빌드가 통과했고, 아무도 안 보는 사이 목록 밖 모듈이 **70개**까지 쌓였다.
//      그 안에 `org/credentials/{github-app,oauth-broker,member-secret-store,google-oauth,notion-oauth,
//      slack-oauth,…}` 가 있었다 = **GitHub App 서명·설치토큰 발급·멤버 시크릿 금고가 멤버 PC 로 배포되는
//      번들에 실려 나갔다.** 근원은 `project-provision` 이 순수 URL 파서 하나(`githubRepoFullName`)를
//      무거운 자격 모듈에서 가져온 것이었다 — 간선 하나가 11개를 끌었다.
//
//  ⚠ 실측으로 못박아 둘 것 — **`await import()` 로는 번들에서 빠지지 않는다.** esbuild 는 outfile 하나(코드
//   분할 없음)면 동적 import 를 그대로 인라인한다. '나중에 부르니 괜찮다'는 통하지 않는다. 유일한 길은
//   **모듈을 가르는 것**이고, 그래서 T6·T7 이 갈라낸 잎의 순수함을 지킨다(잎이 다시 무거워지면 원위치다).
//
//  실행: node scripts/node-agent-bundle-boundary.test.mjs   (dist/ 가 먼저 있어야 한다 — npm test 가 빌드한다)
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const ALLOW = join(HERE, "node-agent-allowed-modules.json");
const DEBT = join(HERE, "node-agent-known-debt.json");
const GUARD = join(HERE, "build-node-agent.mjs");

//  래칫 상한 — 부채는 **줄어들기만 해야 한다**. 줄었으면 이 수를 낮춰라(그게 진척의 기록이다).
//  올리려면 왜 못 고치는지가 커밋 메시지에 있어야 한다.
const DEBT_CEILING = 49;

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const list = (p) => JSON.parse(readFileSync(p, "utf8"));
const runGuard = () => spawnSync(process.execPath, [GUARD], { cwd: ROOT, encoding: "utf8", timeout: 120_000 });

// ── 목록 자체의 불변식 ────────────────────────────────────────────────────────
t("[T3] 승인과 부채는 겹치지 않는다 — 겹치면 '승인'인지 '부채'인지 말할 수 없다", () => {
  const both = list(ALLOW).filter((p) => new Set(list(DEBT)).has(p));
  assert.deepEqual(both, [], `양쪽에 있는 항목: ${both.join(", ")}`);
});

t("[T4] 두 목록의 항목은 전부 dist/ 경로다", () => {
  for (const p of [...list(ALLOW), ...list(DEBT)]) assert.match(p, /^dist\/.+\.js$/, `형식이 아니다: ${p}`);
});

t(`[T5] 래칫 — 부채는 ${DEBT_CEILING}개 이하다(줄었으면 상한을 낮춰라)`, () => {
  const n = list(DEBT).length;
  assert.ok(n <= DEBT_CEILING,
    `부채가 ${n}개로 늘었다(상한 ${DEBT_CEILING}). 노드 번들에 실리는 모듈이 또 늘었다는 뜻이다 — ` +
    "`node scripts/node-agent-bundle-map.mjs` 로 어느 간선이 끌고 왔는지 보고 끊어라.");
});

// ── 갈라낸 잎이 다시 무거워지지 않는다(P5) ────────────────────────────────────
//  런타임 import 만 센다 — `import type` 은 tsc 가 지우므로 번들 간선이 아니다.
const runtimeImports = (rel) =>
  readFileSync(join(ROOT, rel), "utf8").split("\n")
    .filter((l) => /^import\s/.test(l) && !/^import\s+type\s/.test(l))
    .map((l) => (l.match(/from\s+"([^"]+)"/) ?? [])[1])
    .filter((m) => m && !m.startsWith("node:"));

t("[T6] 잎 github-repo-url.ts — node: 외 런타임 import 0", () => {
  assert.deepEqual(runtimeImports("src/org/credentials/github-repo-url.ts"), [],
    "이 파일이 무언가를 import 하는 순간, 그것을 쓰는 노드-도달 모듈이 그 무게를 다시 끌어온다(#2165 의 원인).");
});

t("[T7] 잎 git-auth-prepare.ts — node: 외 런타임 import 0 (import type 은 허용)", () => {
  assert.deepEqual(runtimeImports("src/org/credentials/git-auth-prepare.ts"), [],
    "DB(itemsPool)·GitHub App 자격이 여기로 되돌아오면 노드 번들이 다시 그걸 싣는다.");
});

// ── 가드가 실제로 막는가(T1·T2) — 부채 목록을 한 항목 빼고 돌려 본다 ──────────
//  ⚠ 목록 파일을 잠시 바꾸므로 반드시 finally 로 되돌린다(git 추적 파일이라 최악에도 checkout 으로 복구).
{
  const before = readFileSync(DEBT, "utf8");
  try {
    t("[T1] 번들이 승인∪부채와 일치하면 가드는 통과한다", () => {
      const r = runGuard();
      assert.equal(r.status, 0, `가드가 통과해야 하는데 실패했다:\n${(r.stderr || "").slice(0, 1200)}`);
      assert.match(r.stdout || "", /번들 경계 가드/);
    });

    t("[T2] 🔴 회귀락 — 어느 목록에도 없는 모듈이 하나라도 있으면 **빌드가 실패한다**(경고 아님)", () => {
      const debt = list(DEBT);
      assert.ok(debt.length > 0, "부채가 비어 있으면 이 시나리오를 만들 수 없다(그땐 승인목록에서 빼서 시험하라)");
      const victim = debt[0];
      writeFileSync(DEBT, JSON.stringify(debt.slice(1), null, 1) + "\n");
      const r = runGuard();
      assert.notEqual(r.status, 0, "미분류 모듈이 있는데 빌드가 통과했다 — 가드가 경고로 되돌아갔다");
      const out = (r.stderr || "") + (r.stdout || "");
      assert.match(out, /새 모듈/, "무엇이 문제인지 말하지 않는다");
      assert.ok(out.includes(victim), `빠진 모듈 이름(${victim})을 알려주지 않으면 고칠 수 없다`);
    });
  } finally {
    writeFileSync(DEBT, before);
  }
}

console.log(`\n${pass} passed — 노드 번들 경계 불변식(#2165)`);
