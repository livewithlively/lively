// #735 discord 커넥터 테스트 — toRawItem 이 채널/스레드명(container_name)을 보존하고(slack 동형),
//   스레드/리플라이 관계(parent_external_id)를 방출하는지 회귀 잠금. 이 parent_external_id 는 미러가
//   source.parent_external_id 컬럼으로 저장해 "스레드 답글" 탐색(자료 간 관계)의 근거가 된다.
//   실행: npm run build && node dist/connectors/discord.test.js  (순수 함수)
import assert from "node:assert/strict";
import { toRawItem } from "./discord.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 리플라이 메시지 — 채널명 보존 + 참조 메시지가 부모. ──
t("discord toRawItem: channelName→container_name + 리플라이 parent_external_id(#735)", () => {
  const it = toRawItem(
    {
      id: "999", content: "hi there", author: { id: "u1", username: "bob" },
      timestamp: "2026-07-13T00:00:00.000Z", message_reference: { message_id: "500", channel_id: "C1" },
    } as never,
    { guildId: "G1", channelId: "C1", channelName: "general" },
  );
  assert.equal(it.container_ref, "C1");
  assert.equal(it.container_name, "general");     // 채널명 보존(신규 — 예전엔 id만)
  assert.equal(it.parent_external_id, "C1:500");  // 리플라이 → 부모 메시지 링크(자료 간 관계)
});

// ── 스레드 메시지 — 스레드명 보존 + 스레드 시작 메시지가 부모. ──
t("discord toRawItem: 스레드명 container_name + 스레드 부모 링크", () => {
  const it = toRawItem(
    { id: "M2", content: "질문 있어요", author: { id: "u2" }, timestamp: "2026-07-13T00:00:00.000Z" } as never,
    { guildId: "G1", channelId: "T1", channelName: "질문-스레드", threadParentChannelId: "Cparent" },
  );
  assert.equal(it.container_name, "질문-스레드");
  assert.equal(it.parent_external_id, "Cparent:T1"); // 스레드 시작 메시지(id==스레드id)가 부모
});

// ── graceful: channelName 미제공이면 container_name=undefined. ──
t("discord toRawItem: channelName 미제공이면 container_name=undefined", () => {
  const it = toRawItem(
    { id: "M3", content: "x", author: { id: "u3" }, timestamp: "2026-07-13T00:00:00.000Z" } as never,
    { guildId: "G1", channelId: "C9" },
  );
  assert.equal(it.container_ref, "C9");
  assert.equal(it.container_name, undefined);
});

console.log(`\n${pass} passed`);
