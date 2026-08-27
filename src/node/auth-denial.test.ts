// 노드 채널 인증 거부 사유(#2161) — 순수함수 표 고정.
//
// 정책(사양): 거부 자체는 조용해도 되지만(연결을 끊는다) **기록까지 조용하면 안 된다.**
//  사유는 **사람이 할 다음 행동이 다른 것끼리** 갈라야 한다. 특히 아래 둘을 뭉치면 안 된다:
//   · 조회 자체가 실패한 것(DB·권한)  ↔  토큰이 안 맞는 것
//  종전 store 의 `catch { return null }` 이 정확히 이 둘을 한 값으로 뭉갰고, 그래서 인프라 오류가
//  '토큰 불일치'로 둔갑해 매니지드에서 노드가 502 를 도는 동안 게이트웨이에 로그 한 줄이 없었다.
import assert from "node:assert/strict";
import { denialMessage, shouldLogDenial, denialKey, DENIAL_LOG_COOLDOWN_MS, type NodeAuthDenial } from "./auth-denial.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 표 B: 거부 사유별 메시지 ────────────────────────────────────────────────
// 메시지는 **운영자가 그 줄만 보고 움직일 수 있어야** 한다. 문구를 고정하지는 않고(다듬으면 거짓 실패한다),
//  '그 사유를 가르는 사실이 실려 있는가'를 본다.

t("B1 형식 아님 — 메시지가 나온다", () => {
  assert.ok(denialMessage({ reason: "malformed" }).length > 0);
});

t("B2 DB 없음 — 메시지가 나온다", () => {
  assert.ok(denialMessage({ reason: "no-db" }).length > 0);
});

t("B3 ★ 조회 실패는 '토큰 문제'와 갈라진다 — 원인 문구를 싣고, 토큰 탓이 아님을 말한다", () => {
  const m = denialMessage({ reason: "db-error", detail: "permission denied for table org_node" });
  assert.ok(m.includes("permission denied for table org_node"), `원인 문구가 유실됐다: ${m}`);
  // 이 갈래의 존재 이유 자체 — 이 문장이 없으면 읽는 사람이 또 토큰을 의심한다.
  assert.ok(m.includes("토큰 문제가 아닙니다"), `토큰 탓이 아님을 말하지 않는다: ${m}`);
  // 그리고 '모르는 토큰'과 **다른 말**이어야 한다(뭉개짐 방지의 최소 조건).
  assert.notEqual(m, denialMessage({ reason: "unknown-token" }));
});

t("B4 모르는 토큰 — 재등록으로 풀린다는 경로를 준다", () => {
  const m = denialMessage({ reason: "unknown-token" });
  assert.ok(m.includes("lively node"), `사람이 할 행동이 없다: ${m}`);
});

t("B5 노드 토큰이 아님 — 그 토큰의 용도(라벨)를 드러낸다", () => {
  const m = denialMessage({ reason: "not-a-node-token", label: "central-box:sangmin-yoon", member: "sangmin-yoon" });
  assert.ok(m.includes("central-box:sangmin-yoon"), `라벨이 없다 — 어느 표면의 토큰인지 못 짚는다: ${m}`);
  // 라벨이 없을 수도 있다(옛 토큰) — 그때도 메시지는 나와야 한다.
  assert.ok(denialMessage({ reason: "not-a-node-token", label: null, member: null }).length > 0);
});

t("B6 회수됨 — 라벨을 드러낸다", () => {
  const m = denialMessage({ reason: "revoked", label: "node:hammurabi" });
  assert.ok(m.includes("node:hammurabi"), `라벨이 없다: ${m}`);
  assert.ok(denialMessage({ reason: "revoked", label: null }).length > 0);
});

t("B7 노드 비활성 — 어느 노드인지 말한다", () => {
  const m = denialMessage({ reason: "node-disabled", node: "hammurabi" });
  assert.ok(m.includes("hammurabi"), `노드 이름이 없다: ${m}`);
});

t("B8 소유자 비활성 — 어느 노드·누구인지 말한다", () => {
  const m = denialMessage({ reason: "owner-inactive", node: "hammurabi", owner: "sangmin-yoon", state: "disabled" });
  assert.ok(m.includes("hammurabi") && m.includes("sangmin-yoon"), `노드/소유자가 없다: ${m}`);
  // state 가 null(모름)이어도 메시지는 나온다.
  assert.ok(denialMessage({ reason: "owner-inactive", node: "n", owner: "o", state: null }).length > 0);
});

t("B9 모든 사유가 메시지를 낸다 — 사유가 늘어도 빈 문자열·undefined 가 새지 않는다", () => {
  const all: NodeAuthDenial[] = [
    { reason: "malformed" },
    { reason: "no-db" },
    { reason: "db-error", detail: "x" },
    { reason: "unknown-token" },
    { reason: "not-a-node-token", label: null, member: null },
    { reason: "revoked", label: null },
    { reason: "node-disabled", node: "n" },
    { reason: "owner-inactive", node: "n", owner: "o", state: null },
  ];
  const seen = new Set<string>();
  for (const d of all) {
    const m = denialMessage(d);
    assert.equal(typeof m, "string", `${d.reason} 가 문자열을 안 냈다`);
    assert.ok(m.trim().length > 0, `${d.reason} 가 빈 메시지다`);
    seen.add(d.reason);
  }
  // 사유가 새로 생기면 이 줄이 먼저 깨져 '표를 갱신하라'고 알린다(런타임 망라 보증).
  const declared = new Set(all.map((d) => d.reason));
  assert.equal(seen.size, declared.size);
  assert.equal(seen.size, 8, "사유 개수가 바뀌었다 — 표 B 를 갱신할 것");
});

// ── 표 C: 로그 쿨다운 — 거부돼도 노드는 백오프로 재접속을 반복한다 ─────────────

t("C1 첫 건은 반드시 남긴다(기록 없음)", () => {
  assert.equal(shouldLogDenial(undefined, 1_000_000), true);
});

t("C2 쿨다운 직전이면 접는다", () => {
  const now = 1_000_000;
  assert.equal(shouldLogDenial(now - (DENIAL_LOG_COOLDOWN_MS - 1), now), false);
});

t("C3 ★ 경계 — 쿨다운이 정확히 찼으면 남긴다(> 와 >= 오프바이원)", () => {
  const now = 1_000_000;
  assert.equal(shouldLogDenial(now - DENIAL_LOG_COOLDOWN_MS, now), true);
});

t("C4 쿨다운을 지났으면 남긴다", () => {
  const now = 1_000_000;
  assert.equal(shouldLogDenial(now - (DENIAL_LOG_COOLDOWN_MS + 1), now), true);
});

t("C5 같은 토큰이라도 사유가 다르면 별개로 남긴다(사유 변화는 새로운 사실이다)", () => {
  assert.notEqual(denialKey("abc123", "unknown-token"), denialKey("abc123", "revoked"));
  // 반대로 같은 토큰·같은 사유는 한 건으로 접힌다.
  assert.equal(denialKey("abc123", "unknown-token"), denialKey("abc123", "unknown-token"));
  // 토큰이 다르면 별개다 — 한 노드의 실패가 다른 노드의 첫 기록을 삼키면 안 된다.
  assert.notEqual(denialKey("abc123", "unknown-token"), denialKey("def456", "unknown-token"));
});

console.log(`\n${pass} passed`);
