// #735 slack 커넥터 테스트 — toRawItem 이 채널명(container_name)·비공개여부(fields.channel_is_private)를
//   캡처하는지 회귀 잠금. search.messages 응답의 channel.name 은 지식화(distill) 때 "어느 채널 맥락인지"의
//   핵심 정보인데, 예전 toRawItem 은 channel.id(container_ref)만 남기고 name 을 버려 유실됐다(사용자 지적).
//   실행: npm run build && node dist/connectors/slack.test.js  (순수 함수 — DB/네트워크 불요)
import assert from "node:assert/strict";
import { toRawItem } from "./slack.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// ── 채널 맥락 보존 — id(container_ref)에 더해 표시명(container_name)·비공개여부를 담는다. ──
t("toRawItem: channel.name/is_private 를 container_name·fields 로 보존(#735)", () => {
  const it = toRawItem(
    { type: "message", ts: "1783945464.777099", user: "U0B2D0A8KV3", username: "Alice", text: "hello world" },
    {
      channel: "C03017U5KLJ",
      channelName: "f_deal_prepayment",
      channelPrivate: false,
      instance: "T02UTQ38VRR",
      explicitUrl: "https://x.slack.com/archives/C03017U5KLJ/p1783945464777099",
    },
  );
  assert.equal(it.container_ref, "C03017U5KLJ");        // 채널 id (기존 계약 유지)
  assert.equal(it.container_name, "f_deal_prepayment"); // 채널 표시명 (신규 — 지식화 핵심 맥락)
  assert.equal((it.fields as Record<string, unknown>).channel_is_private, false);
  assert.equal(it.body, "hello world");
  assert.equal(it.provenance.external_url, "https://x.slack.com/archives/C03017U5KLJ/p1783945464777099");
});

// ── 비공개 채널 라벨 전달 ──
t("toRawItem: 비공개 채널이면 channel_is_private=true", () => {
  const it = toRawItem(
    { type: "message", ts: "1783945400.000100", text: "secret" },
    { channel: "C_PRIV", channelName: "임원_비공개", channelPrivate: true, instance: "T1" },
  );
  assert.equal(it.container_name, "임원_비공개");
  assert.equal((it.fields as Record<string, unknown>).channel_is_private, true);
});

// ── graceful: 채널명 미제공(id만 아는 경로/타 커넥터)이면 container_name 은 undefined(깨지지 않음). ──
t("toRawItem: channelName 미제공이면 container_name=undefined(graceful)", () => {
  const it = toRawItem(
    { type: "message", ts: "1783945400.000200", text: "x" },
    { channel: "C999", instance: "T1" },
  );
  assert.equal(it.container_ref, "C999");
  assert.equal(it.container_name, undefined);
});

console.log(`\n${pass} passed`);
