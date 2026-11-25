// 노드 이름이 다른 사람 것과 겹칠 때의 판정 — **순수함수라 어느 플랫폼에서든 돈다.**
//  짝인 `lively-node.test.mjs` ⑪ 이 실제 CLI 로 같은 흐름을 돌지만, 그 파일은 POSIX e2e 라 못 도는 환경이 있다
//  (node-token-reuse.test.mjs 와 같은 관례 — 판정은 표로 고정한다).
//
// 사양: 노드 이름(id)의 기본값은 호스트 이름이고 한 워크스페이스 안에서 하나뿐이다. 회사가 나눠 준 컴퓨터는
//  호스트 이름이 같은 일이 흔하다(실측 2026-11-16: 맥 두 대가 모두 `acmeui-MacBookAir`). 이름을 직접 주지 않았는데
//  그 이름이 **다른 사람의 노드**면 `<호스트 이름>-<구성원 id>` 로 비켜 등록하고, 다음 실행은 그 이름을 잇는다.
// 실행: node kit/cli/node-id-collision.test.mjs
import assert from "node:assert/strict";
import { collisionNodeId, nodeIdTakenByOther, defaultNodeId, nodeOwnedByOther } from "./cmd-node.mjs";
import { normGw } from "./lively.mjs";   // 실사용과 같은 정규화로 본다

let pass = 0;
const t = (name, fn) => { fn(); pass++; console.log(`ok  ${name}`); };
const ID_RE = /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/;   // 서버 규칙: 소문자·숫자·하이픈 2~64자

// ── A. 비킨 이름 ─────────────────────────────────────────────────────────────
t("A1 <호스트 이름>-<구성원 id>", () => {
  assert.equal(collisionNodeId("acmeui-macbookair", "mina"), "acmeui-macbookair-mina");
});
t("A2 구성원 id 에 서버가 못 받는 글자가 있어도 형식에 맞춘다", () => {
  for (const who of ["Mi.Na_Kim", "mina@example.com", "  mina  ", "-mina-"]) {
    const id = collisionNodeId("macbook-air", who);
    assert.match(id, ID_RE, `who=${who} → ${id}`);
    assert.ok(id.startsWith("macbook-air-"), id);
  }
});
t("A3 길어도 64자를 넘지 않고 하이픈으로 끝나지 않는다", () => {
  const id = collisionNodeId("h".repeat(40), "m".repeat(80));
  assert.ok(id.length <= 64, `len=${id.length}`);
  assert.match(id, ID_RE);
  assert.match(collisionNodeId("host", "a".repeat(22) + "-zzz"), ID_RE, "잘린 자리가 하이픈이면 떼어야 한다");
});
t("A4 구성원 id 를 모르면 만들지 않는다(null) — 엉뚱한 이름으로 등록하지 않는다", () => {
  for (const who of [undefined, null, "", "___"]) assert.equal(collisionNodeId("host", who), null, `who=${who}`);
  assert.equal(collisionNodeId("", "mina"), null);
});

// ── B. «남의 노드» 판정 ──────────────────────────────────────────────────────
const err = (status) => Object.assign(new Error("x"), { status });
t("B1 등록 409 + 회전 403 → 같은 이름의 노드가 다른 사람 것", () => {
  assert.equal(nodeIdTakenByOther(err(409), err(403)), true);
});
t("B2 ★ 그 밖의 조합은 아니다 — 접속 열쇠 거절·서버 오류를 이름 겹침으로 읽으면 엉뚱한 노드를 만든다", () => {
  for (const [a, b] of [[401, 401], [403, 403], [409, 404], [409, 500], [500, 403], [409, undefined], [undefined, 403]]) {
    assert.equal(nodeIdTakenByOther(err(a), err(b)), false, `등록=${a} 회전=${b}`);
  }
  assert.equal(nodeIdTakenByOther(new Error("fetch failed"), new Error("fetch failed")), false, "네트워크 오류(status 없음)");
});

// ── C. --id 없이 실행했을 때의 이름 ──────────────────────────────────────────
const GW = "https://dev.lvly.io";
const pick = (o) => defaultNodeId({ slug: "macbook-air", gw: GW, prevGw: GW, prevId: null, ...o }, normGw);
t("C1 기록이 없으면 호스트 이름", () => { assert.equal(pick({}), "macbook-air"); });
t("C2 ★ 앞선 실행이 비켜 등록한 이름이면 그 이름을 잇는다 — 안 그러면 실행마다 409 → 회전", () => {
  assert.equal(pick({ prevId: "macbook-air-mina" }), "macbook-air-mina");
  assert.equal(pick({ prevId: "macbook-air-mina", prevGw: GW + "/mcp/" }), "macbook-air-mina", "주소 표기 차이는 같은 게이트웨이다");
});
t("C3 다른 게이트웨이의 기록은 잇지 않는다", () => {
  assert.equal(pick({ prevId: "macbook-air-mina", prevGw: "https://app.lvly.io" }), "macbook-air");
  assert.equal(pick({ prevId: "macbook-air-mina", prevGw: null }), "macbook-air");
});
t("C4 호스트 이름이 바뀌었으면 종전처럼 새 호스트 이름(#2161 의 판정 그대로)", () => {
  assert.equal(pick({ prevId: "old-host" }), "macbook-air");
  assert.equal(pick({ prevId: "old-host-mina" }), "macbook-air");
  assert.equal(pick({ prevId: "macbook-airport" }), "macbook-air", "앞부분만 같은 다른 이름은 비킨 이름이 아니다");
});
t("C5 40자로 자른 호스트 이름이 '-' 로 끝나도 비킨 이름을 잇는다(collisionNodeId 는 끝 '-' 를 떼고 만든다)", () => {
  const slug = "build-host-a1b2c3d4e-pool-17-concurrent-0-abcdef".slice(0, 40);   // 40자째가 '-' 다
  assert.ok(slug.endsWith("-"), slug);
  const alt = collisionNodeId(slug, "mina");
  assert.equal(alt, "build-host-a1b2c3d4e-pool-17-concurrent-mina");
  assert.equal(pick({ slug, prevId: alt }), alt);
  assert.equal(pick({ slug, prevId: "build-host-a1b2c3d4e-pool-17-concurrentx-mina" }), slug, "앞부분만 같은 다른 이름은 비킨 이름이 아니다");
  assert.equal(pick({ slug, prevId: alt, prevGw: "https://app.lvly.io" }), slug, "다른 게이트웨이의 기록은 그대로 잇지 않는다");
});

// ── D. 회전하기 전에 묻는 «남의 개인 컴퓨터인가» ─────────────────────────────
//  서버는 관리자에게 남의 노드 회전도 내준다 — B 의 판정(409 + 403)은 관리자에게 성립하지 않는다(403 이 안 난다).
//  그래서 이름을 직접 주지 않은 실행은 회전 전에 목록에서 그 이름의 주인을 본다.
t("D1 ★ 주인이 다른 구성원인 개인 컴퓨터 → 남의 것(회전하지 않는다)", () => {
  assert.equal(nodeOwnedByOther({ owner_member: "mina", kind: "member" }, "jisoo"), true);
  assert.equal(nodeOwnedByOther({ owner_member: "mina" }, "jisoo"), true, "kind 칸이 없다고 worker 로 보지 않는다");
  assert.equal(nodeOwnedByOther({ owner_member: "mina", kind: "member", shared: true }, "jisoo"), true, "공유로 열어 둔 컴퓨터도 주인은 그 사람이다");
});
t("D2 주인이 나 → 내 것(종전처럼 회전으로 잇는다)", () => {
  assert.equal(nodeOwnedByOther({ owner_member: "jisoo", kind: "member" }, "jisoo"), false);
  assert.equal(nodeOwnedByOther({ owner_member: " jisoo " }, "jisoo"), false, "앞뒤 공백은 같은 사람이다");
});
t("D3 worker 노드는 가르지 않는다 — 관리자들이 함께 다시 앉히는 컴퓨터", () => {
  assert.equal(nodeOwnedByOther({ owner_member: "mina", kind: "worker" }, "jisoo"), false);
});
t("D4 ★ 모르면 false — 목록에 없다 · 주인 칸이 비었다 · 내 id 를 모른다(종전 길로 간다)", () => {
  for (const node of [undefined, null, {}, { owner_member: "" }, { owner_member: null }, { owner_member: "   " }]) {
    assert.equal(nodeOwnedByOther(node, "jisoo"), false, `node=${JSON.stringify(node)}`);
  }
  for (const me of [undefined, null, "", "   "]) {
    assert.equal(nodeOwnedByOther({ owner_member: "mina", kind: "member" }, me), false, `me=${JSON.stringify(me)}`);
  }
});

console.log(`\n${pass} passed`);
