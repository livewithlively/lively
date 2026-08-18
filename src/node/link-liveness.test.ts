// 순수 단위 체크(node:assert) — 노드 WS 링크의 클라이언트 쪽 생존 판정(#1541). 근거·엣지 표는 link-liveness.ts 머리말.
// 실행: npm run build && node dist/node/link-liveness.test.js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { linkIsStale, LINK_STALE_MS, LINK_CHECK_MS, GW_HEARTBEAT_MS } from "./link-liveness.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const T = 1_700_000_000_000;

t("L1 방금 받았으면 살아 있다", () => { assert.equal(linkIsStale(T, T + 1000), false); });
t("L2 경계 — 정확히 stale 이면 아직 살아 있고, 1ms 넘으면 죽었다(> 이지 >= 가 아니다)", () => {
  assert.equal(linkIsStale(T, T + LINK_STALE_MS), false);
  assert.equal(linkIsStale(T, T + LINK_STALE_MS + 1), true);
});
t("L3 ★ 절전에서 깨어난 뒤 — 몇 시간 침묵이면 죽었다(실측: 나흘·2시간 40분 좀비)", () => {
  assert.equal(linkIsStale(T, T + 2 * 60 * 60 * 1000), true);
});
t("L4 시각을 모르면(NaN·undefined) 끊지 않는다 — 끊기는 파괴적이라 안전측", () => {
  assert.equal(linkIsStale(NaN, T), false);
  assert.equal(linkIsStale(T, NaN), false);
  assert.equal(linkIsStale(undefined as unknown as number, T), false);
});
t("L5 상수 관계 — stale 은 게이트웨이 heartbeat 의 여러 주기여야 하고(잠깐 지연에 끊지 않게), 감시 주기는 heartbeat 이하", () => {
  assert.ok(LINK_STALE_MS >= 3 * GW_HEARTBEAT_MS, `stale 이 heartbeat 3주기보다 짧다: ${LINK_STALE_MS}`);
  assert.ok(LINK_STALE_MS <= 120_000, `stale 이 2분을 넘으면 절전 복귀가 느리다: ${LINK_STALE_MS}`);
  assert.ok(LINK_CHECK_MS <= GW_HEARTBEAT_MS);
  // 게이트웨이 상수와 실제로 같은가 — 갈리면 위 배수 계산이 거짓이 된다
  const reg = readFileSync(fileURLToPath(new URL("../../src/node/registry.ts", import.meta.url)), "utf8");
  const m = /const HEARTBEAT_MS = (\d[\d_]*);/.exec(reg);
  assert.ok(m, "registry.ts 의 HEARTBEAT_MS 를 못 찾았다");
  assert.equal(GW_HEARTBEAT_MS, Number(m![1].replace(/_/g, "")), "GW_HEARTBEAT_MS 가 registry.ts 와 다르다");
});
t("L6 배선 — 에이전트가 ping·message 로 lastBeat 를 갱신하고, stale 이면 terminate 해 재연결 경로(close)를 탄다", () => {
  const src = readFileSync(fileURLToPath(new URL("../../src/node/agent.ts", import.meta.url)), "utf8");
  const code = src.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert.match(code, /ws\.on\("ping"/, "ping 을 안 듣는다 — 게이트웨이 heartbeat 를 생존 신호로 못 쓴다");
  assert.match(code, /linkIsStale\(/, "판정을 순수함수로 하지 않는다");
  assert.match(code, /LINK_CHECK_MS/, "감시 인터벌이 없다");
  // stale 이면 close 를 기다리지 말고 terminate — close 가 안 오는 게 바로 이 결함이다
  const seg = code.slice(code.indexOf("linkIsStale("), code.indexOf("linkIsStale(") + 400);
  assert.match(seg, /terminate\(\)/, "stale 판정 뒤 terminate 하지 않는다(close 만 기다리면 영영 안 온다)");
  // 감시 타이머는 teardown 에서 정리한다(안 그러면 죽은 ws 마다 타이머가 쌓인다)
  const td = code.slice(code.indexOf("const teardown"), code.indexOf("ws.once(\"close\", teardown)"));
  assert.match(td, /clearInterval\(watch/, "teardown 이 감시 타이머를 정리하지 않는다");
  // 소켓 keepalive 도 켠다(belt and braces — 절전이 아니라 NAT 만료 같은 조용한 단절)
  assert.match(code, /setKeepAlive[?.]*\(true/, "TCP keepalive 를 켜지 않는다");
});

console.log(`\n${pass} passed`);
