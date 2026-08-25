// 채널 정책 집행 배선(#1881) — A(MCP 프록시)·B(http_proxy) 가 공유하는 사전 게이트/사후 필터. 사양 = scratch spec.md §B.
//  게이트는 주입한다(DB·슬랙 불요). 판정 규칙 자체는 channel-guard.test 가 맡고, 여기선 **순서·모드·우회 없음**을 본다.
//  실행: npm run build && node dist/org/channels/channel-enforce.test.js
import assert from "node:assert/strict";
import { channelSystemOf, channelPreCheck, channelPostFilter, type ChannelEnforcement } from "./channel-enforce.js";
import { buildChannelPolicy, type ChannelPolicy } from "./channel-guard.js";
import type { ChannelGate } from "./channel-resolver.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// 고정 정책: C0PUBLIC(공개, 허용) · C0PRIV(비공개, 사람이 열람 거부) · C0OPEN(비공개, 사람이 열람 허용)
const POLICY: ChannelPolicy = buildChannelPolicy(
  [
    { channel_id: "C0PRIVXX01", channel_name: "lively-비공개", allow_read: false, allow_write: false },
    { channel_id: "C0OPENXX01", channel_name: "lively-열림", allow_read: true, allow_write: true },
  ],
  [
    { channel_id: "C0PUBLIC01", channel_name: "lively-공개", channel_type: "public" },
    { channel_id: "C0PRIVXX01", channel_name: "lively-비공개", channel_type: "private" },
    { channel_id: "C0OPENXX01", channel_name: "lively-열림", channel_type: "private" },
  ],
);
const stubGate = (policy = POLICY): { gate: ChannelGate; resolved: string[][] } => {
  const resolved: string[][] = [];
  const gate: ChannelGate = { policy, resolve: async (keys) => { resolved.push([...keys]); return policy; } };
  return { gate, resolved };
};
const okGate = async (): Promise<ChannelGate> => stubGate().gate;

await t("B10 channelSystemOf — auth_kind / 호스트 / 둘 다 아님", () => {
  assert.equal(channelSystemOf({ auth_kind: "slack_oauth" }), "slack");
  assert.equal(channelSystemOf({ auth_kind: null, url: "https://slack.com/api/search.messages" }), "slack");
  assert.equal(channelSystemOf({ auth_kind: "google_drive_oauth", url: "https://www.googleapis.com/drive/v3/files" }), null);
  assert.equal(channelSystemOf({ url: "not a url" }), null);
});

await t("B1 대화 시스템이 아니면 통과하고 게이트가 없다(응답 필터도 무변경)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: null, toolName: "google_drive_search", level: "L0", args: { q: "x" }, openGate: async () => { throw new Error("불리면 안 된다"); } });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.enf.gate, null);
  const content = [{ type: "text", text: '{"messages":[{"channel":"C0PRIVXX01"}]}' }];
  assert.deepEqual(await channelPostFilter(r.enf, "google_drive_search", content), content);
});

await t("B2 신원이 없으면 통과(게이트 없음) — 정책은 사람 단위라 대조할 상대가 없다", async () => {
  const r = await channelPreCheck({ callerId: null, system: "slack", toolName: "slack_read_channel", level: "L0", args: { channel: "C0PRIVXX01" }, openGate: async () => { throw new Error("불리면 안 된다"); } });
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.enf.gate, null);
});

await t("B3 meta 도구(채널 목록)는 정책 밖 — 게이트를 열지도 않는다", async () => {
  let opened = 0;
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_search_channels", level: "L0", args: {}, openGate: async () => { opened++; return stubGate().gate; } });
  assert.equal(r.ok, true);
  assert.equal(opened, 0);
  if (r.ok) { assert.equal(r.enf.gate, null); assert.equal(r.enf.toolKind, "meta"); }
});

await t("B4 read 도구가 차단된 채널을 지목하면 거부(사유에 열람 안내)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_read_channel", level: "L0", args: { channel: "C0PRIVXX01" }, openGate: okGate });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /열람/);
});

await t("B5 write 도구(L2)가 대상을 지목하지 않으면 거부(fail-closed)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_send_message", level: "L2", args: { text: "hi" }, openGate: okGate });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.reason, /발송/);
});

await t("B5' write 도구가 허용 채널을 지목하면 통과하고, 사후 필터는 발송 결과를 건드리지 않는다(B9)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_send_message", level: "L2", args: { channel: "C0PUBLIC01", text: "hi" }, openGate: okGate });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.enf.toolKind, "write");
  const content = [{ type: "text", text: '{"ok":true,"channel":"C0PUBLIC01","ts":"1.2","message":{"text":"C0PRIVXX01 언급"}}' }];
  assert.deepEqual(await channelPostFilter(r.enf, "slack_send_message", content), content);
});

await t("B6 전역 검색(지목 없음)은 통과 → 사후 필터가 '허용 확인된 항목만' 남긴다(allowOnly)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_search_messages", level: "L0", args: { query: "배포" }, openGate: okGate });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.enf.argTargets.size, 0);
  // 슬랙 search.messages 실제 모양 — matches 배열 각 항목에 channel.id + permalink
  const body = JSON.stringify({
    ok: true,
    messages: { total: 3, matches: [
      { text: "공개 배포", channel: { id: "C0PUBLIC01", name: "lively-공개" }, permalink: "https://x.slack.com/archives/C0PUBLIC01/p1" },
      { text: "비공개 배포", channel: { id: "C0PRIVXX01", name: "lively-비공개" }, permalink: "https://x.slack.com/archives/C0PRIVXX01/p2" },
      { text: "모르는 채널", channel: { id: "C0UNKNOWN1", name: "unknown" }, permalink: "https://x.slack.com/archives/C0UNKNOWN1/p3" },
    ] },
  });
  const out = await channelPostFilter(r.enf, "slack_search_messages", [{ type: "text", text: body }]);
  const parsed = JSON.parse((out[0] as { text: string }).text) as { messages: { matches: Array<{ text: string }> }; _omitted_by_policy?: string };
  assert.deepEqual(parsed.messages.matches.map((m) => m.text), ["공개 배포"], "차단(비공개)과 모르는 채널은 빠지고 공개만 남는다");
  assert.ok(parsed._omitted_by_policy, "도려냈다는 안내가 남는다");
});

await t("B7 채널을 지목한 읽기(허용)는 통과 → 사후 필터는 차단된 것만 제거(allowOnly 아님)", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_read_channel", level: "L0", args: { channel: "C0OPENXX01" }, openGate: okGate });
  assert.equal(r.ok, true);
  if (!r.ok) return;
  assert.equal(r.enf.argTargets.size, 1);
  // conversations.history 모양 — 메시지에 채널 귀속 표시가 없다. allowOnly 였다면 통째로 사라졌을 응답.
  const body = JSON.stringify({ ok: true, messages: [{ type: "message", text: "본문 1", ts: "1.1" }, { type: "message", text: "본문 2", ts: "1.2" }] });
  const out = await channelPostFilter(r.enf, "slack_read_channel", [{ type: "text", text: body }]);
  assert.equal((out[0] as { text: string }).text, body, "귀속 없는 정상 응답은 한 글자도 안 바뀐다");
});

await t("B8 게이트를 못 열면(정책 조회 실패) 거부하고 사유가 '채널 허용 설정을 확인하지 못해' 로 시작한다", async () => {
  const r = await channelPreCheck({ callerId: "yoon", system: "slack", toolName: "slack_read_channel", level: "L0", args: { channel: "C0PUBLIC01" }, openGate: async () => { throw new Error("db down"); } });
  assert.equal(r.ok, false);
  if (!r.ok) assert.ok(r.reason.startsWith("채널 허용 설정을 확인하지 못해"), r.reason);
});

await t("B11 배선: 사후 필터가 응답이 지목한 대화들로 gate.resolve 를 부른다(종류 해소 없이는 판정 불가)", async () => {
  const { gate, resolved } = stubGate();
  const enf: ChannelEnforcement = { gate, toolKind: "read", argTargets: new Set() };
  const body = JSON.stringify({ ok: true, messages: { matches: [{ text: "x", channel: { id: "C0PUBLIC01" } }] } });
  await channelPostFilter(enf, "slack_search_messages", [{ type: "text", text: body }]);
  assert.ok(resolved.some((keys) => keys.includes("C0PUBLIC01")), `resolve 호출 키: ${JSON.stringify(resolved)}`);
});

console.log(`\nchannel-enforce tests: ${pass} passed`);
