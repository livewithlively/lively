// «선언된 세션 호스트» 축 — #2592 겹침 판정의 **유일한** 면제 근거 (#2600 T2).
//
//  ── 무엇을 지키나 ──
//  #2592 는 셀프 노드(게이트웨이 박스에서 켠 노드 데몬)를 **tmux 겹침**으로 잡는다. 그 판정은 오탐이 0이라
//   값어치가 있고, 그래서 손대지 않는다. 문제는 T2 의 매니지드 세션 호스트가 **설계상 같은 tmux 를 본다**는
//   것이다 — 같은 브로커 소켓으로 닿기 때문이고, 그게 존재 이유다. 관측만으로는 사고와 구별되지 않는다
//   (겹침은 양쪽에서 똑같이 참). 그래서 **선언**으로 가른다.
//
//  ★ 여기서 못박는 두 가지:
//   ① 술어는 **fail-closed** — 모르면 면제하지 않는다. 구 행·조회 실패가 «선언» 으로 읽히면 방어가 조용히 꺼진다.
//   ② 선언은 **관리자만** — 아무나 켜면 그건 방어를 스스로 끄는 문이다. 그리고 면제는 그 게이트 **뒤**여야 한다.
import assert from "node:assert/strict";
import test from "node:test";
import { declaredSessionHost, shouldMarkSelfNode } from "./self-node.js";

// ── 술어: 모르면 면제하지 않는다 ──────────────────────────────────────────────
test("D1/D2 선언한 노드만 참이다", () => {
  assert.equal(declaredSessionHost({ session_host: true }), true);
  assert.equal(declaredSessionHost({ session_host: false }), false);
});

test("D3 ★ 필드가 없는 구 행은 **면제하지 않는다**(fail-closed)", () => {
  //  컬럼이 없던 시절에 만들어진 행이 «선언» 으로 읽히면, 그 노드들이 통째로 셀프 노드 방어 밖으로 나간다.
  assert.equal(declaredSessionHost({}), false);
});

test("D4 ★ 조회 실패(null·undefined)도 면제하지 않는다", () => {
  assert.equal(declaredSessionHost(null), false);
  assert.equal(declaredSessionHost(undefined), false);
});

test("D5 ★ 비-불리언 참값은 면제하지 않는다 — 엄격 비교", () => {
  //  DB 드라이버·직렬화가 't'/'true'/1 로 실어 오는 판이 흔하다. 느슨하게 읽으면 «모름» 이 «선언» 이 된다.
  for (const v of ["true", "t", 1, {}, []] as unknown[]) {
    assert.equal(declaredSessionHost({ session_host: v as boolean }), false, `${JSON.stringify(v)} 는 선언이 아니다`);
  }
});

// ── 집행: 판정 한 칸이 실제로 면제하나 ─────────────────────────────────────
//  ⚠ 이 행들이 없으면 «면제» 는 시험이 안 문다 — 실측으로 확인했다: 면제를 통째로 지워도 그 전까지의
//   시험 29개가 전부 초록이었다(결정이 루프 안에 갇혀 있었다).
const OVERLAP = { gatewaySessionIds: new Set(["box-a-1111"]), nodeSessionIds: ["box-a-1111"] };
const NO_OVERLAP = { gatewaySessionIds: new Set(["box-a-1111"]), nodeSessionIds: ["box-b-2222"] };

test("J3 겹치면 셀프 노드로 판정한다 — #2592 의 본래 동작(무회귀)", () => {
  assert.equal(shouldMarkSelfNode({ alreadyJudged: false, declaredSessionHost: false, ...OVERLAP }), true);
});

test("J2 ★ **선언된 세션 호스트는 겹쳐도 판정하지 않는다** — 이 면제가 T2 의 관문이다", () => {
  assert.equal(shouldMarkSelfNode({ alreadyJudged: false, declaredSessionHost: true, ...OVERLAP }), false);
});

test("J4 안 겹치면 판정하지 않는다", () => {
  assert.equal(shouldMarkSelfNode({ alreadyJudged: false, declaredSessionHost: false, ...NO_OVERLAP }), false);
});

test("J5 ★ 행을 못 읽은 값이 판정까지 흘러도 **면제되지 않는다** — 술어와 판정을 이어서 본다", () => {
  //  ⚠ J3 과 인자가 같아 보이지만 다른 것을 본다: 여기서는 `declaredSessionHost(null)` 의 **결과**를 그대로
  //   흘려 «조회 실패 → 면제 안 함» 이 두 함수를 지나도 유지되는지를 잇는다. 술어만·판정만 보면 그 이음매가 빈다.
  assert.equal(shouldMarkSelfNode({ alreadyJudged: false, declaredSessionHost: declaredSessionHost(null), ...OVERLAP }), true);
});

test("J6 ★★ **연결이 없어도** 선언은 살아 있어야 한다 — 부팅 직후가 그 순간이다", () => {
  //  ⚠ 이 행이 이 변경에서 제일 중요하다. 판정은 `states`(디스크에서 복구된 스냅샷)를 도는데,
  //   `hydrateNodeStates` 가 복구 **직후 곧바로** 판정한다(#2172) — 그때 연결은 **하나도 없다**.
  //   선언을 «살아 있는 연결» 에서 읽으면 그 순간 안 보이고, 겹치면 sticky 하게 확정돼(되돌리는 경로가
  //   없다 — R2) 선언된 세션 호스트가 **게이트웨이가 뜰 때마다** 영구히 거부된다.
  //   그래서 선언은 **상태와 함께** 다녀야 하고, 이 함수는 그 값을 불리언으로 받는다.
  //  ⚠ J2 와 인자가 같다 — 일부러다. J2 는 «면제가 있나», 여기는 «그 면제가 **무엇에 걸려 있나**» 를 적는다.
  //   실제 회귀를 잡는 것은 짝인 배선 시험(W)이고, 이 행은 그 시험이 무엇을 지키는지 설명하는 자리다.
  assert.equal(shouldMarkSelfNode({ alreadyJudged: false, declaredSessionHost: true, ...OVERLAP }), false,
    "연결 유무와 무관하게 선언만 보고 면제한다");
});

test("J1 이미 판정된 노드는 다시 판정하지 않는다(sticky)", () => {
  assert.equal(shouldMarkSelfNode({ alreadyJudged: true, declaredSessionHost: false, ...OVERLAP }), false);
});

// ── 등록 게이트: 선언은 관리자만, 그리고 면제는 그 게이트 뒤 ──────────────────
//  라우트 본문을 소스로 읽어 **순서**를 못박는다. 여기서 지키는 것은 «그렇게 적혀 있다» 가 아니라
//  «아무나 방어를 끌 수 없다» 이고, 그 성질은 두 줄의 **순서**에만 걸려 있다(런타임으로 재려면 DB·세션이 필요하다).
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROUTES = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "node", "routes.ts"), "utf8");

const REGISTRY = readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "node", "registry.ts"), "utf8");

test("W ★★ 판정에 넘기는 선언은 **상태**에서 읽는다(연결이 아니라)", () => {
  //  순수 함수가 옳아도 호출부가 «연결» 에서 읽으면 부팅 직후 면제가 죽는다(J6 의 그 시나리오).
  //  그 결함은 값으로는 안 잡힌다 — 함수는 멀쩡하다. 그래서 배선을 여기서 못박는다.
  assert.match(REGISTRY, /declaredSessionHost:\s*st\.sessionHost/,
    "상태 스냅샷의 값을 넘겨야 한다");
  assert.doesNotMatch(REGISTRY, /declaredSessionHost:\s*conns\.get/,
    "연결에서 읽으면 안 된다 — 부팅 직후엔 연결이 없다");
});

test("R1 ★ 세션 호스트 선언은 **admin 권한**을 요구한다", () => {
  assert.match(ROUTES, /sessionHost && !isAdmin\(u\)[\s\S]{0,120}403/,
    "선언에 admin 게이트가 있어야 한다 — 없으면 아무나 셀프 노드 방어를 끌 수 있다");
});

test("R4 ★ 선언된 경우 등록 프리플라이트(겹침 409)를 건너뛴다", () => {
  assert.match(ROUTES, /!sessionHost && await looksLikeGatewayBox/,
    "선언이 없을 때만 프리플라이트를 본다 — 아니면 세션 호스트는 등록조차 못 한다");
});

test("★ 순서 — 면제가 admin 게이트보다 **뒤**에 있다(앞이면 아무나 끌 수 있다)", () => {
  const gate = ROUTES.indexOf("sessionHost && !isAdmin(u)");
  const exempt = ROUTES.indexOf("!sessionHost && await looksLikeGatewayBox");
  assert.ok(gate > 0 && exempt > 0, "두 줄이 실제로 있다(관측 장치 생존 확인)");
  assert.ok(gate < exempt, `admin 게이트(${gate})가 면제(${exempt})보다 앞이어야 한다`);
});

test("R3 ★ 선언을 안 하면 종전 그대로 — 기본값은 «세션 호스트 아님»", () => {
  assert.match(ROUTES, /const sessionHost = !!b\.sessionHost;/,
    "요청에 없으면 false 로 접힌다(구 클라이언트 무회귀)");
});
