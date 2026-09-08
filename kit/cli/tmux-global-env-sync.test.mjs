#!/usr/bin/env node
// 로그인 뒤 tmux 서버 전역 env 교정(#3728) — planTmuxGlobalEnvFix 의 안전선을 표로 검증한다.
//  실행: node kit/cli/tmux-global-env-sync.test.mjs   (npm test 체인에 자동 수집)
//  순수 판정만 부른다 — tmux·네트워크·실 HOME 무접촉(부수효과는 syncTmuxGlobalEnv 가 갖고 있다).
//
// ⚠ 이 함수의 값어치는 '무엇을 치느냐'보다 **무엇을 안 치느냐**에 있다. 로그인이 tmux 전역을 고치는 건
//  편의지만, 잘못 고치면 공유 박스에서 **로그인한 사람 토큰이 남의 새 pane 으로 샌다**(sessions.ts 가
//  전역 대신 세션스코프 `-e` 를 쓰는 이유가 그것이다). 그래서 안전선을 회귀로 못박는다.
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = join(fileURLToPath(import.meta.url), "..");
const { planTmuxGlobalEnvFix } = await import(pathToFileURL(join(HERE, "lively.mjs")));

let pass = 0, fail = 0;
const check = (n, cond, why) => cond
  ? (pass++, console.error(`ok  ${n}`))
  : (fail++, console.error(`FAIL ${n} — ${why || "조건 불만족"}`));

const norm = (u) => String(u).replace(/\/+$/, "");
const NEW_GW = "https://new.example", NEW_TOK = "tok-new";
const BOTH_STALE = "LIVELY_GATEWAY_URL=https://old.example\nLIVELY_TOKEN=tok-old\nPATH=/usr/bin";
const plan = (o) => planTmuxGlobalEnvFix({ gw: NEW_GW, tok: NEW_TOK, normalizeGw: norm, ...o });
const names = (r) => r.map(([n]) => n).sort().join(",");

// ── 본래 하려던 일 ──
check("스테일 두 값을 모두 새 값으로",
  JSON.stringify([...plan({ showOutput: BOTH_STALE })].sort()) ===
  JSON.stringify([["LIVELY_GATEWAY_URL", NEW_GW], ["LIVELY_TOKEN", NEW_TOK]].sort()),
  JSON.stringify(plan({ showOutput: BOTH_STALE })));
check("이미 맞으면 아무것도 안 친다(멱등)",
  plan({ showOutput: `LIVELY_GATEWAY_URL=${NEW_GW}\nLIVELY_TOKEN=${NEW_TOK}` }).length === 0, "멱등 위반");
check("한쪽만 스테일이면 그 한쪽만",
  names(plan({ showOutput: `LIVELY_GATEWAY_URL=https://old.example\nLIVELY_TOKEN=${NEW_TOK}` })) === "LIVELY_GATEWAY_URL",
  "안 틀린 값을 덮었다");

// ── 안전선 ③ — 없던 변수는 신규 주입하지 않는다(노출면을 넓히지 않는다) ──
check("전역에 없던 변수는 심지 않는다",
  names(plan({ showOutput: "LIVELY_GATEWAY_URL=https://old.example" })) === "LIVELY_GATEWAY_URL",
  "없던 LIVELY_TOKEN 을 새로 심었다");
check("전역이 비면 아무것도 안 심는다", plan({ showOutput: "" }).length === 0, "빈 전역에 변수를 심었다");
check("`-NAME`(제거 표시) 줄은 '있음'으로 치지 않는다",
  plan({ showOutput: "-LIVELY_TOKEN\n-LIVELY_GATEWAY_URL" }).length === 0, "제거된 변수를 되살렸다");

// ── 안전선 ① — 매니지드 박스 pane 에선 절대 손대지 않는다 ──
check("box-* 세션에선 아무것도 안 한다(공유 tmux 서버 누수 방지)",
  plan({ showOutput: BOTH_STALE, sessionId: "box-jang-1a2b" }).length === 0, "공유 박스에서 전역을 건드렸다");
check("비-box 세션 id 는 정상 진행",
  plan({ showOutput: BOTH_STALE, sessionId: "sess-local-1" }).length === 2, "정상 세션을 막았다");

// ── 자격이 없으면 판정 자체를 안 한다 ──
check("gw·tok 이 비면 무동작",
  plan({ showOutput: BOTH_STALE, gw: "" }).length === 0 && plan({ showOutput: BOTH_STALE, tok: "" }).length === 0,
  "빈 자격으로 전역을 덮었다");

// ── 값에 '=' 가 들어 있어도 잘린 채 비교하지 않는다(첫 '=' 만 구분자) ──
check("값 안의 '=' 를 보존한다",
  planTmuxGlobalEnvFix({ showOutput: "LIVELY_TOKEN=a=b", gw: NEW_GW, tok: "a=b", normalizeGw: norm }).length === 0,
  "값 안의 '=' 를 잘라 같은 값을 다르다고 봤다");

console.error(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
