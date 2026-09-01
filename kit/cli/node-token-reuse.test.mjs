// 노드 토큰 재사용 판정(#2161) — **순수함수라 어느 플랫폼에서든 돈다.**
//
// ⚠ 이 파일이 존재하는 이유: 짝인 `lively-node.test.mjs` 는 launchd/systemd 스텁을 쓰는 POSIX e2e 라
//  샌드박스·플랫폼에 따라 통째로 못 도는 환경이 있다(실측: 이 판정을 만든 자리에서 baseline 이 0/14 였다).
//  그런데 여기서 검증하는 것은 **매니지드 노드가 붙느냐 마느냐를 가르는 판정**이다 — 실행 커버리지가
//  환경에 좌우되면 안 된다. 그래서 판정을 순수함수로 빼고 여기서 표로 고정한다(#1541 node-win-contract 와 같은 관례).
//
// 정책(사양): 노드 토큰은 **그 게이트웨이(테넌트)에 매인다.** 게이트웨이는 제시된 토큰을 자기 org_node
//  기록과 직접 대조해서만 통과시키므로, 다른 게이트웨이에서 받은 토큰은 **어디서도** 통과할 수 없다.
//  실측 사고(2026-08-27): A 로그아웃 → B 로그인 뒤 윈도우 노드가 /node/ws 에서 502 무한 재시도.
//
// ⚖ 비대칭이 판정의 기준이다 — 잘못 재사용하면 사람이 손대기 전에는 낫지 않는 무한 거부가 되고,
//  불필요하게 재등록하면 최악이 왕복 한 번이다. **그래서 모르면 재등록한다.**
//  단 그 반대 방향 사고도 실재한다: 표기 차이를 '바뀐 것'으로 읽으면 **매 실행 재등록**(= 매번 토큰 회전)이다.
// 실행: node kit/cli/node-token-reuse.test.mjs
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { nodeTokenReuse } from "./cmd-node.mjs";
import { normGw } from "./lively.mjs";   // ★ 실사용과 **같은** 정규화로 검증한다(복제하면 여기만 맞고 라이브는 틀린다)

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };

const GW_A = "https://dev.lvly.io";
const GW_B = "https://app.lvly.io";
const TOK = "lvk_node_token_abc";
/** 표의 한 행을 그대로 부른다 — 인자 순서를 매번 다시 쓰지 않게. */
const verdict = (o) => nodeTokenReuse({ token: TOK, prevGw: GW_A, prevId: "n1", gw: GW_A, nodeId: "n1", ...o }, normGw);

// ── 표 A: 재사용 판정 ────────────────────────────────────────────────────────

t("A1 같은 게이트웨이·같은 노드이름 → 재사용", () => {
  assert.deepEqual(verdict({}), { reuse: true });
});

t("A2 주소 표기 차이(끝슬래시·/mcp)는 '바뀐 것'이 아니다 — 매 실행 재등록(=매번 토큰 회전)을 막는다", () => {
  for (const prevGw of ["https://dev.lvly.io/", "https://dev.lvly.io/mcp", "https://dev.lvly.io/mcp/"]) {
    assert.deepEqual(verdict({ prevGw }), { reuse: true }, `prevGw=${prevGw}`);
  }
});

t("A3 노드이름 기록이 없는 옛 파일은 그것만으로 버리지 않는다(게이트웨이가 같으면 토큰은 유효하다)", () => {
  for (const prevId of [null, undefined, ""]) {
    assert.deepEqual(verdict({ prevId }), { reuse: true }, `prevId=${JSON.stringify(prevId)}`);
  }
});

t("A4 ★ 게이트웨이가 바뀌면 재등록 — 옛 테넌트 토큰은 새 게이트웨이에서 절대 안 통한다", () => {
  const v = verdict({ gw: GW_B });
  assert.equal(v.reuse, false);
  // 사유는 **사람이 로그만 보고 '어디에서 어디로'를 알 수 있어야** 한다 — 없으면 또 패킷캡처를 하게 된다.
  //  (문구 자체가 아니라 '필요한 사실이 실려 있는가'를 본다.)
  assert.ok(v.why.includes("dev.lvly.io") && v.why.includes("app.lvly.io"), `어느 주소에서 어디로인지가 없다: ${v.why}`);
});

t("A5 게이트웨이 기록이 없으면 모르는 것이므로 재등록한다(잘못 재사용하면 스스로 안 낫는다)", () => {
  for (const prevGw of [null, undefined, ""]) {
    const v = verdict({ prevGw });
    assert.equal(v.reuse, false, `prevGw=${JSON.stringify(prevGw)}`);
    assert.ok(v.why.includes(GW_A), `지금 게이트웨이가 사유에 없다: ${v.why}`);
  }
});

t("A6 노드이름이 바뀌면 재등록 — 그 토큰은 다른 노드의 것이다", () => {
  const v = verdict({ prevId: "old-box", nodeId: "new-box" });
  assert.equal(v.reuse, false);
  assert.ok(v.why.includes("old-box") && v.why.includes("new-box"), `어느 이름에서 어디로인지가 없다: ${v.why}`);
});

t("A7 토큰이 없으면 재사용 대상이 아니다(등록 경로로 간다)", () => {
  for (const token of [null, undefined, ""]) {
    assert.equal(verdict({ token }).reuse, false, `token=${JSON.stringify(token)}`);
  }
});

// ── 표 A-배선: **판정이 맞는 것과 그 판정이 불리는 것은 별개의 결함 축이다.** ──
//  이 프로젝트(#2119)가 같은 종류를 이미 세 번 만났다. 순수함수만 초록이고 호출부가 안 부르면 라이브는 그대로 502 다.
const SRC = readFileSync(new URL("./cmd-node.mjs", import.meta.url), "utf8");

t("A8 배선: 등록 경로가 이 판정을 normGw 와 함께 부르고, 거짓이면 저장된 토큰을 버린다", () => {
  assert.match(SRC, /nodeTokenReuse\(\{[\s\S]{0,400}\},\s*normGw\)/,
    "호출부가 normGw 를 안 넘긴다 — 정규화 단일 출처가 깨져 표기 차이로 매번 재등록한다(A2 의 반대 사고)");
  assert.match(SRC, /if \(nodeTok && !verdict\.reuse\)[\s\S]{0,240}nodeTok = ""/,
    "판정이 거짓인데 토큰을 안 버린다 = 등록을 건너뛴다(사고 당시와 같은 상태)");
});

t("A9 배선: 등록 응답에 토큰이 없으면 멈춘다(undefined 가 0600 파일에 굳지 않게)", () => {
  assert.match(SRC, /startsWith\("lvk_"\)\)\s*die\(/,
    "등록 응답 토큰을 검증하지 않는다 — `LIVELY_NODE_TOKEN=undefined` 가 굳으면 그 뒤 모든 재실행이 '토큰 있음'으로 판단한다");
});

console.log(`\n${pass} passed`);
