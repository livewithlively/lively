#!/usr/bin/env node
// 훅의 자격 우선순위 사양테스트 — **파일이 env 를 이긴다**(#916·#2617 의 훅 판).
//
//  왜: 설치기가 셸 rc 에 `export LIVELY_TOKEN="$(cat ~/.lively/token)"` 를 심는다. 그래서 재로그인(또는
//   게이트웨이 주소 변경) 뒤 **같은 셸의 env 는 언제나 옛 값**이고, 세션은 tmux pane 이라 서버가 처음 뜬
//   시점의 환경을 물려받는다. CLI(lively.mjs token()/gateway())와 MCP 프록시는 이미 파일을 우선하는데
//   훅만 env 를 우선해서, 훅이 혼자 옛 신원·옛 주소로 붙었다. 둘 다 유효한 토큰이면 401 도 안 나므로
//   아무 에러 없이 조용히 파손된다.
//
//  왜 **정적** 검사인가: 이 결함의 형태는 한 줄 안의 `||` 순서 하나다(`env || file` ↔ `file || env`).
//   훅마다 e2e 를 세우면 각 훅의 부수조건(하네스·캐시·네트워크)에 기대게 되고, 정작 순서가 뒤집혀도
//   그 훅의 시나리오가 안 닿으면 통과한다. 여기선 **모든 훅을 한 번에** 훑어 순서 자체를 고정한다 —
//   새 훅이 생겨도 자동으로 걸린다(이 파일에 목록을 다시 적지 않는다).
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HOOKS = dirname(fileURLToPath(import.meta.url));
let pass = 0, fail = 0;
const ok = (n) => { pass++; console.log(`ok  ${n}`); };
const bad = (n, why) => { fail++; console.error(`FAIL ${n} — ${why}`); };

// 자격 env 와, 같은 줄에서 그 값을 고르는 파일 읽기 호출. 훅마다 헬퍼 이름이 달라(readLocal·readCfg·readL)
//  이름을 나열하지 않고 "…(\"token\") / (\"gateway-url\") 형태의 호출" 로 잡는다.
const PAIRS = [
  { env: "LIVELY_TOKEN", file: /\w+\(\s*["']token["']\s*\)/ },
  { env: "LIVELY_GATEWAY_URL", file: /\w+\(\s*["']gateway-url["']\s*\)/ },
];

const files = readdirSync(HOOKS).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"));
const offenders = [];
for (const f of files) {
  const src = readFileSync(join(HOOKS, f), "utf8");
  src.split("\n").forEach((line, i) => {
    if (line.trim().startsWith("//")) return;            // 주석은 설명이라 순서를 뜻하지 않는다
    for (const { env, file } of PAIRS) {
      const e = line.indexOf(`process.env.${env}`);
      const m = file.exec(line);
      if (e < 0 || !m) continue;                          // 한 줄에서 함께 고를 때만 '우선순위'가 존재한다
      if (e < m.index) offenders.push(`${f}:${i + 1} ${env} 가 파일보다 먼저 — ${line.trim().slice(0, 100)}`);
    }
  });
}
offenders.length === 0
  ? ok(`① 훅 ${files.length}개 전부 자격을 파일 우선으로 고른다`)
  : bad("① 훅은 자격을 파일 우선으로 골라야 한다", "\n    " + offenders.join("\n    "));

// ② 무회귀 — '파일 우선' 이 '파일만' 이 되면 안 된다. 플러그인·프로비저닝·CI 는 파일 없이 env 로만 준다.
//  위 ①을 "env 를 지운다" 로 만족시키는 회귀를 막는다.
const usesEnvFallback = files.filter((f) => {
  const src = readFileSync(join(HOOKS, f), "utf8");
  return PAIRS.some(({ env, file }) => src.split("\n").some((l) =>
    !l.trim().startsWith("//") && l.includes(`process.env.${env}`) && file.test(l)));
});
usesEnvFallback.length > 0
  ? ok(`② env 폴백이 살아 있다(파일 없는 경로 무회귀 — ${usesEnvFallback.length}개 훅)`)
  : bad("② env 폴백이 살아 있어야 한다", "자격을 파일에서만 읽는다 — 플러그인·프로비저닝·CI 가 죽는다");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
