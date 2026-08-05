// #735 slack 커넥터 테스트 — toRawItem 이 채널명(container_name)·비공개여부(fields.channel_is_private)를
//   캡처하는지 회귀 잠금. search.messages 응답의 channel.name 은 지식화(distill) 때 "어느 채널 맥락인지"의
//   핵심 정보인데, 예전 toRawItem 은 channel.id(container_ref)만 남기고 name 을 버려 유실됐다(사용자 지적).
//   실행: npm run build && node dist/connectors/slack.test.js  (순수 함수 — DB/네트워크 불요)
import assert from "node:assert/strict";
import { toRawItem, selectBotChannels, threadNeedsReplies, isCollectableMessage } from "./slack.js";

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

// ════════════════════════════════════════════════════════════════════════════
// #1531 봇 모드 — 멤버십 스윕의 판정 3종. 사양·엣지 표는 프로젝트 #1531 spec 참조.
//  검색 모드가 못 보는 비공개 채널을 봇 토큰으로 수집하는 경로라, 여기서 잘못 거르면
//  "설정은 맞는데 조용히 0건"(운영자가 가장 못 찾는 고장)이 된다.
// ════════════════════════════════════════════════════════════════════════════

type Ch = Parameters<typeof selectBotChannels>[0][number];
const ch = (id: string, name?: string, extra: Partial<Ch> = {}): Ch => ({ id, name, ...extra });
const names = (list: Ch[]): string[] => list.map((c) => c.name ?? c.id);

// ── S1. 대상 채널 선별 ──────────────────────────────────────────────────────
const FLEET: Ch[] = [
  ch("C_FRONT", "hai솔루션_front"),
  ch("C_CLOSE", "hai솔루션_closing", { is_private: true }),
  ch("C_OLD", "hai솔루션_2024종료", { is_private: true, is_archived: true }),
  ch("C_NOISE", "alarm_test"),
  ch("D_DM", undefined, { is_im: true }),
  ch("G_MPIM", "mpdm-a--b", { is_mpim: true }),
];

t("S1-1: 대상 미지정이면 봇이 초대된 전체가 대상(DM/그룹DM 제외)", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, [], [])),
    ["hai솔루션_front", "hai솔루션_closing", "hai솔루션_2024종료", "alarm_test"]);
});

t("S1-2: 대상을 이름으로 지정하면 그 채널만", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, ["hai솔루션_front"], [])), ["hai솔루션_front"]);
});

t("S1-3: 대상을 채널 id 로 지정해도 맞는다(이름은 바뀔 수 있다)", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, ["C_CLOSE"], [])), ["hai솔루션_closing"]);
});

t("S1-4: '#' 접두·대소문자 흔들림을 흡수한다", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, ["#HAI솔루션_Front"], [])), ["hai솔루션_front"]);
  assert.deepEqual(names(selectBotChannels(FLEET, ["c_close"], [])), ["hai솔루션_closing"]);
});

t("S1-5: 제외 채널은 빠진다", () => {
  assert.ok(!names(selectBotChannels(FLEET, [], ["alarm_test"])).includes("alarm_test"));
});

t("S1-6: 대상과 제외에 동시에 들면 제외가 이긴다(안전한 쪽)", () => {
  assert.deepEqual(selectBotChannels(FLEET, ["alarm_test"], ["alarm_test"]), []);
});

t("S1-7: DM·그룹DM 은 대상으로 명시해도 빠진다(봇 소유자의 사담 유입 방지)", () => {
  assert.deepEqual(selectBotChannels(FLEET, ["D_DM", "G_MPIM"], []), []);
});

t("S1-8: 보관 채널은 남긴다 — 종료된 프로젝트 기록이 이관 가치가 크다", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, ["hai솔루션_2024종료"], [])), ["hai솔루션_2024종료"]);
});

t("S1-9: 제외만 주면 그것만 뺀 전체", () => {
  assert.deepEqual(names(selectBotChannels(FLEET, [], ["hai솔루션_front", "alarm_test"])),
    ["hai솔루션_closing", "hai솔루션_2024종료"]);
});

// ── S2. 스레드 답글 재수집 판정 ─────────────────────────────────────────────
const SINCE = Date.parse("2026-07-30T00:00:00Z");
const tsAt = (iso: string): string => (Date.parse(iso) / 1000).toFixed(6);

t("S2-1: 답글 없는 메시지는 열어보지 않는다", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 0 }, SINCE), false);
  assert.equal(threadNeedsReplies({ ts: "1" }, SINCE), false); // 필드 자체가 없는 평범한 메시지
});

t("S2-2: 전량 수집(커서 없음)이면 답글 있는 스레드를 모두 연다", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 3, latest_reply: tsAt("2020-01-01T00:00:00Z") }, undefined), true);
});

t("S2-3: 증분 — 마지막 답글이 커서 이전이면 열지 않는다(증분 비용의 핵심)", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 9, latest_reply: tsAt("2026-07-29T23:59:59Z") }, SINCE), false);
});

t("S2-4: 증분 — 마지막 답글이 커서 이후면 연다", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 1, latest_reply: tsAt("2026-07-30T00:00:01Z") }, SINCE), true);
});

t("S2-5: 경계 — 마지막 답글 == 커서 시각이면 연다(놓치느니 다시 읽는다)", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 2, latest_reply: tsAt("2026-07-30T00:00:00Z") }, SINCE), true);
});

t("S2-6: 증분 — 마지막 답글 정보가 없으면 연다(판단 불가 시 안전한 쪽)", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 4 }, SINCE), true);
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 4, latest_reply: "nonsense" }, SINCE), true);
});

t("S2-7: 답글 수 경계 — 정확히 1건이면 연다", () => {
  assert.equal(threadNeedsReplies({ ts: "1", reply_count: 1, latest_reply: tsAt("2026-08-01T00:00:00Z") }, SINCE), true);
});

// ── S3. 자료로 남길 메시지 판정 ─────────────────────────────────────────────
t("S3-1: 사람이 쓴 일반 텍스트는 남긴다", () => {
  assert.equal(isCollectableMessage({ ts: "1", user: "U1", text: "부산은행 배치 일정 공유드립니다" }), true);
});

t("S3-2: 채널 참여·퇴장 등 시스템 부산물은 버린다(증류 오염 방지)", () => {
  assert.equal(isCollectableMessage({ ts: "1", subtype: "channel_join", text: "<@U1> has joined the channel" }), false);
  assert.equal(isCollectableMessage({ ts: "1", subtype: "channel_leave", text: "left" }), false);
  assert.equal(isCollectableMessage({ ts: "1", subtype: "channel_convert_to_private", text: "x" }), false);
});

t("S3-3: 본문·첨부 모두 없으면 버린다", () => {
  assert.equal(isCollectableMessage({ ts: "1", user: "U1" }), false);
});

t("S3-4: 본문이 없어도 파일 첨부가 있으면 남긴다", () => {
  assert.equal(isCollectableMessage({ ts: "1", user: "U1", files: [{ id: "F1" }] }), true);
});

t("S3-5: 본문이 없어도 attachment(봇 카드 등)가 있으면 남긴다", () => {
  assert.equal(isCollectableMessage({ ts: "1", attachments: [{ title: "배포 알림" }] }), true);
});

t("S3-6: 경계 — 본문이 공백문자뿐이면 버린다", () => {
  assert.equal(isCollectableMessage({ ts: "1", user: "U1", text: "   \n\t " }), false);
});

t("S3-7: 봇 알림 메시지도 본문이 있으면 남긴다(업무 기록이다)", () => {
  assert.equal(isCollectableMessage({ ts: "1", bot_id: "B1", subtype: "bot_message", text: "배치 완료" }), true);
});

t("S3-8: 스레드 브로드캐스트도 남긴다(중복은 external_id 유일성이 처리)", () => {
  assert.equal(isCollectableMessage({ ts: "1", subtype: "thread_broadcast", text: "공유합니다" }), true);
});

console.log(`\n${pass} passed`);
