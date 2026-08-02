// 채널별 개인 열람/발송 정책(#1226) + **종류별 기본값**(#1262) 단위 체크 — DB·네트워크 불요.
// 실행: npm run build && node dist/org/channels/channel-guard.test.js
//  사양·엣지 표: 프로젝트 1262 spec(D1~D8 · E1~E3 · N1~N6 · G1~G8 · U1~U4 · R1~R10 · MD1~MD6 · M1~M3 · S1~S2 · X1~X2).
//  표의 행 하나가 테스트 하나다 — 빠뜨린 행이 곧 못 잡는 버그다.
import assert from "node:assert/strict";
import {
  channelKey, buildChannelPolicy, extractChannelRefs, extractChannelTargets, extractResponseTargets,
  checkChannelCall, channelToolKind, channelAllows, channelDefaults,
  filterChannelContent, pruneMarkdownItems, EMPTY_POLICY,
} from "./channel-guard.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

// 대화 종류 캐시 — **이것이 기본값을 정한다**(#1262). 캐시에 없는 대화는 종류 미상 → 거부.
const METAS = [
  { channel_id: "C0OPEN0001", channel_name: "general", channel_type: "public" },
  { channel_id: "C0HRPRIV01", channel_name: "hr-private", channel_type: "private" },
  { channel_id: "C0ALERTS01", channel_name: "alerts", channel_type: "public" },
  { channel_id: "C0DIARY001", channel_name: "diary", channel_type: "public" },
  { channel_id: "C0TEAMPRV1", channel_name: "team-secret", channel_type: "private" },
  { channel_id: "D0DM000001", channel_name: "윤상민", channel_type: "dm", peer_id: "U0PEER0001" },
  { channel_id: "G0GROUP001", channel_name: "3인방", channel_type: "group_dm" },
];
// 사람이 **기본값과 다르게** 정한 것만 행으로 남는다(override).
const OVERRIDES = [
  { channel_id: "C0ALERTS01", channel_name: "alerts", allow_read: true, allow_write: false },    // 공개인데 발송만 막음
  { channel_id: "C0DIARY001", channel_name: "diary", allow_read: false, allow_write: true },     // 공개인데 열람만 막음
  { channel_id: "C0TEAMPRV1", channel_name: "team-secret", allow_read: true, allow_write: true },// 비공개인데 열어 둠
];
const POLICY = buildChannelPolicy(OVERRIDES, METAS);
// 종류만 알고 사람은 아무것도 안 건드린 상태 — 슬랙을 막 연결한 직후가 정확히 이것이다.
const FRESH = buildChannelPolicy([], METAS);

const blocks = (text: string) => [{ type: "text", text }];
const textOf = (content: unknown[]) => (content[0] as { text: string }).text;

// ── 배선 단언 — 관측 장치가 살아 있는가. 이게 죽으면 아래 단언들이 통째로 vacuous 해진다. ──
t("배선: 정책이 실제로 구축됐다(종류·override 둘 다 실렸다)", () => {
  assert.equal(POLICY.types.get("C0HRPRIV01"), "private");
  assert.equal(POLICY.types.get("#hr-private"), "private", "이름 축에도 종류가 실려야 한다");
  assert.equal(POLICY.types.get("C0OPEN0001"), "public");
  assert.deepEqual(POLICY.override.get("C0ALERTS01"), { read: true, write: false });
  assert.equal(POLICY.override.has("C0HRPRIV01"), false, "설정 안 한 대화는 override 가 없어야 한다(기본값으로 판정)");
  assert.equal(EMPTY_POLICY.types.size, 0);
  assert.equal(FRESH.override.size, 0, "FRESH 는 사람이 아무것도 안 건드린 상태여야 대조가 성립한다");
});
t("channelKey: id 는 원형, 이름은 '#소문자', 빈 값은 null", () => {
  assert.equal(channelKey("C0HRPRIV01"), "C0HRPRIV01");
  assert.equal(channelKey("#HR-Private"), "#hr-private");
  assert.equal(channelKey("hr-private"), "#hr-private");
  assert.equal(channelKey(""), null);
  assert.equal(channelKey(null), null);
});

// ══ 기본값 (D1~D8) ══
t("[D1] 공개 채널 + 설정 없음 → 열람·발송 허용", () => {
  assert.equal(channelAllows(FRESH, "C0OPEN0001", "read"), true);
  assert.equal(channelAllows(FRESH, "C0OPEN0001", "write"), true);
});
t("[D2] 비공개 채널 + 설정 없음 → 열람·발송 거부(#1262 의 핵심 전환)", () => {
  assert.equal(channelAllows(FRESH, "C0HRPRIV01", "read"), false);
  assert.equal(channelAllows(FRESH, "C0HRPRIV01", "write"), false);
  assert.equal(channelAllows(FRESH, "#hr-private", "read"), false, "이름으로 불러도 같은 판정");
});
t("[D3] 그룹DM·DM + 설정 없음 → 열람·발송 거부", () => {
  for (const k of ["D0DM000001", "G0GROUP001", "U0PEER0001"]) {
    assert.equal(channelAllows(FRESH, k, "read"), false, `${k} 열람이 열려 있다`);
    assert.equal(channelAllows(FRESH, k, "write"), false, `${k} 발송이 열려 있다`);
  }
});
t("[D4] 종류를 모르는 대화 → 거부(fail-closed)", () => {
  assert.equal(channelAllows(FRESH, "C0NEVERSEEN", "read"), false);
  assert.equal(channelAllows(FRESH, "C0NEVERSEEN", "write"), false);
});
t("[D5] 비공개인데 사람이 켬 → 허용(설정이 기본값을 이긴다)", () => {
  assert.equal(channelAllows(POLICY, "C0TEAMPRV1", "read"), true);
  assert.equal(channelAllows(POLICY, "C0TEAMPRV1", "write"), true);
  assert.equal(channelAllows(FRESH, "C0TEAMPRV1", "read"), false, "같은 대화가 설정 없을 땐 막혀야 대조가 성립한다");
});
t("[D6] 공개인데 사람이 끔 → 거부", () => {
  assert.equal(channelAllows(POLICY, "C0DIARY001", "read"), false);
  assert.equal(channelAllows(POLICY, "C0ALERTS01", "write"), false);
});
t("[D7] 열람·발송은 독립", () => {
  assert.equal(channelAllows(POLICY, "C0ALERTS01", "read"), true);   // 발송만 막은 채널의 열람은 살아 있다
  assert.equal(channelAllows(POLICY, "C0DIARY001", "write"), true);  // 열람만 막은 채널의 발송은 살아 있다
});
t("[D8] 종류별 기본값 표 — 공개만 열려 있다", () => {
  assert.deepEqual(channelDefaults("public"), { read: true, write: true });
  for (const ty of ["private", "group_dm", "dm", "unknown"] as const) {
    assert.deepEqual(channelDefaults(ty), { read: false, write: false }, `${ty} 가 기본 허용이다`);
  }
});

// ══ 새로 도입한 것이 비었거나 부재인 경우 (E1~E3) ══
t("[E1] 종류 캐시가 통째로 비면 공개 채널까지 전부 막힌다(fail-closed) — 알려진 대가", () => {
  const blind = buildChannelPolicy([], []);
  assert.equal(channelAllows(blind, "C0OPEN0001", "read"), false, "종류를 모르면 공개 채널도 막는다");
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0OPEN0001" }, blind, "read").allowed, false);
  // 이 상태에서 전역 검색 결과도 통째로 비어야 한다(허용을 확인할 길이 없으므로)
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0OPEN0001" }, text: "공개" }] });
  assert.equal(textOf(filterChannelContent(blocks(payload), blind, true).content).includes("공개"), false);
});
t("[E2] 사람이 켠 설정은 종류 캐시가 없어도 유효하다(설정이 기본값 판정보다 먼저)", () => {
  const noMeta = buildChannelPolicy([{ channel_id: "C0TEAMPRV1", channel_name: "team-secret", allow_read: true, allow_write: true }], []);
  assert.equal(channelAllows(noMeta, "C0TEAMPRV1", "read"), true);
  assert.equal(channelAllows(noMeta, "#team-secret", "read"), true, "이름 경로도 같아야 한다");
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0TEAMPRV1" }, noMeta, "read").allowed, true);
});
t("[E3] 한 항목이 허용·차단 대화를 둘 다 참조하면 차단이 이긴다", () => {
  const payload = JSON.stringify({ messages: [
    { channel: { id: "C0OPEN0001" }, text: "공개인데 https://x.slack.com/archives/C0HRPRIV01/p1 를 인용함" },
  ] });
  assert.equal(textOf(filterChannelContent(blocks(payload), POLICY, true).content).includes("인용함"), false);
  assert.equal(textOf(filterChannelContent(blocks(payload), POLICY, false).content).includes("인용함"), false);
});

// ══ 구 모델(#1226) 행 재해석 (L1~L4) — ★ 유닛이 아니라 실환경 E2E 가 잡아낸 결함 ══
//  #1226 화면에서 '발송만 끄기' 를 하면 열람 칸은 손대지 않아도 true 로 저장됐다(기본이 전부 허용이었으니까).
//  #1262 가 그 true 를 '명시 허용' 으로 읽자, 재설계를 라이브에 올린 직후 `#lively-비공개` 가 그대로 읽혔다.
const LEGACY = buildChannelPolicy([
  { channel_id: "C0HRPRIV01", channel_name: "hr-private", allow_read: true, allow_write: false, legacy: true },
  { channel_id: "C0ALERTS01", channel_name: "alerts", allow_read: false, allow_write: true, legacy: true },
  { channel_id: "D0DM000001", channel_name: "윤상민", peer_id: "U0PEER0001", allow_read: false, allow_write: true, legacy: true },
], METAS);

t("[L1] 구 행의 true 는 명시 허용이 아니다 — 비공개는 여전히 막힌다(실환경에서 뚫렸던 그것)", () => {
  assert.equal(channelAllows(LEGACY, "C0HRPRIV01", "read"), false);
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0HRPRIV01" }, LEGACY, "read").allowed, false);
});
t("[L2] 구 행의 false 는 사람의 뜻이다 — 공개 채널에 걸어 둔 차단은 보존(행을 지우면 이게 날아간다)", () => {
  assert.equal(channelAllows(LEGACY, "C0ALERTS01", "read"), false);
  assert.equal(channelAllows(LEGACY, "C0ALERTS01", "write"), true, "손대지 않은 쪽은 그 종류의 기본값(공개=허용)");
});
t("[L3] 구 행의 DM — 미지정 발송은 기본값(거부)으로 떨어진다", () => {
  assert.equal(channelAllows(LEGACY, "D0DM000001", "write"), false);
  assert.equal(channelAllows(LEGACY, "U0PEER0001", "read"), false);
});
t("[L4] 새 규칙 화면에서 저장한 행은 true 가 명시 허용으로 산다(시대가 벗겨진다)", () => {
  const saved = buildChannelPolicy([{ channel_id: "C0HRPRIV01", channel_name: "hr-private", allow_read: true, allow_write: true }], METAS);
  assert.equal(channelAllows(saved, "C0HRPRIV01", "read"), true);
  assert.equal(channelAllows(saved, "C0HRPRIV01", "write"), true);
});

// ══ 지목 vs 언급 (N1~N6) — allow 판정의 오탐은 곧 오차단이다 ══
t("[N1] 지목: 힌트 키 아래의 값 · <#C…|name> · permalink", () => {
  assert.ok(extractChannelTargets({ channel: "C0OPEN0001" }).has("C0OPEN0001"));
  assert.ok(extractChannelTargets({ text: "<#C0HRPRIV01|hr-private>" }).has("C0HRPRIV01"));
  assert.ok(extractChannelTargets({ url: "https://x.slack.com/archives/C0HRPRIV01/p1700000000" }).has("C0HRPRIV01"));
});
t("[N2] 본문에 흩어진 맨 id 는 지목이 아니다 — 오차단 방지", () => {
  const args = { channel: "C0OPEN0001", text: "빌드 CI1234567 실패" };
  assert.equal(extractChannelTargets(args).has("CI1234567"), false);
  assert.ok(extractChannelRefs(args).has("CI1234567"), "넓은 축(언급)은 여전히 잡는다 — 차단 판정은 넓게 봐야 하므로");
});
t("[N3] 본문의 '#1262'·해시태그는 지목이 아니다 — 이게 없으면 멀쩡한 발송이 막힌다", () => {
  const args = { channel: "C0OPEN0001", text: "#1262 진행 공유합니다 #긴급" };
  assert.equal(extractChannelTargets(args).has("#1262"), false);
  assert.equal(extractChannelTargets(args).has("#긴급"), false);
  assert.equal(checkChannelCall("slack_send_message", args, POLICY, "write").allowed, true, "공개 채널로 보내는 정상 발송이 통과해야 한다");
});
t("[N4] 힌트 키 아래의 '#이름'·맨이름은 지목이다", () => {
  assert.ok(extractChannelTargets({ channel: "#hr-private" }).has("#hr-private"));
  assert.ok(extractChannelTargets({ channel_name: "hr-private" }).has("#hr-private"));
  assert.ok(extractChannelTargets({ conversation_id: "alerts" }).has("#alerts"));
});
t("[N5] 중첩 경계 — 8겹은 인식, 9겹은 미인식", () => {
  const nest = (d: number, leaf: unknown): unknown => (d <= 0 ? leaf : { k: nest(d - 1, leaf) });
  assert.ok(extractChannelTargets({ filter: { channels: ["C0OPEN0001", "C0HRPRIV01"] } }).has("C0HRPRIV01"));
  assert.ok(extractChannelRefs(nest(8, "C0HRPRIV01")).has("C0HRPRIV01"));
  assert.equal(extractChannelRefs(nest(9, "C0HRPRIV01")).has("C0HRPRIV01"), false);
});
t("[N6] id 길이 경계 — 6자 인식 / 5자 미인식 / 20자 인식", () => {
  assert.ok(extractChannelRefs({ channel: "C123456" }).has("C123456"));
  assert.equal(extractChannelRefs({ text: "C12345 라는 토큰" }).has("C12345"), false);
  const long = "C" + "A1B2C3D4E5F6G7H8I9J0";
  assert.equal(long.length, 21);
  assert.ok(extractChannelRefs({ text: `열려면 ${long} 를 보세요` }).has(long));
});

// ══ 인자 게이트 (G1~G8) ══
t("[G1] 비공개 채널 열람 + 설정 없음 → 거부, 이름은 알려준다(호출자가 이미 지목했으므로)", () => {
  const v = checkChannelCall("slack_read_channel", { channel_id: "C0HRPRIV01" }, FRESH, "read");
  assert.equal(v.allowed, false);
  assert.deepEqual(v.blocked, ["#hr-private"]);
  assert.ok((v.reason ?? "").includes("#hr-private"));
});
t("[G2] 비공개 채널이라도 사람이 켰으면 통과", () => {
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0TEAMPRV1" }, POLICY, "read").allowed, true);
  assert.equal(checkChannelCall("slack_send_message", { channel_id: "C0TEAMPRV1", text: "hi" }, POLICY, "write").allowed, true);
});
t("[G3] 공개 채널은 설정 없이도 통과", () => {
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0OPEN0001" }, FRESH, "read").allowed, true);
  assert.equal(checkChannelCall("slack_send_message", { channel_id: "C0OPEN0001", text: "hi" }, FRESH, "write").allowed, true);
});
t("[G4] 공개인데 사람이 끈 쪽만 막힌다", () => {
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0ALERTS01" }, POLICY, "read").allowed, true);
  assert.equal(checkChannelCall("slack_send_message", { channel: "#alerts", text: "hi" }, POLICY, "write").allowed, false);
  assert.equal(checkChannelCall("slack_send_message", { channel_id: "C0DIARY001", text: "hi" }, POLICY, "write").allowed, true);
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0DIARY001" }, POLICY, "read").allowed, false);
});
t("[G5] 종류를 모르는 대화를 지목하면 거부(fail-closed)", () => {
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "C0NEVERSEEN" }, POLICY, "read").allowed, false);
});
t("[G6] 발송 + 지목 0개 → 거부(설정이 하나도 없어도)", () => {
  const v = checkChannelCall("slack_send_message", { text: "어디로 가는지 모를 발송" }, POLICY, "write");
  assert.equal(v.allowed, false);
  assert.equal(v.blocked, undefined, "이름을 말할 대상 자체가 없다");
  assert.equal(checkChannelCall("slack_send_message", { text: "x" }, EMPTY_POLICY, "write").allowed, false);
});
t("[G7] 열람 + 지목 0개 → 통과(전역 검색을 죽이지 않는다 — ②가 받는다)", () => {
  assert.equal(checkChannelCall("slack_search_public_and_private", { query: "배포 일정" }, POLICY, "read").allowed, true);
  assert.equal(checkChannelCall("slack_search_public_and_private", { query: "x" }, FRESH, "read").allowed, true);
});
t("[G9] 차단 사유를 구분해 안내한다 — 사람이 끈 것에 '비공개는 기본 거부' 라고 하지 않는다", () => {
  // 실환경: 공개 채널(#lively-공개, 사람이 끔)이 막혔는데 안내가 "비공개 채널·DM 은 기본이 거부라" 여서
  //  원인을 완전히 오인시켰다. 읽는 쪽(AI·사람)이 무엇을 고쳐야 할지 잘못 판단한다.
  const v1 = checkChannelCall("read", { channel_id: "C0DIARY001" }, POLICY, "read");   // 공개인데 열람을 끔
  assert.equal(v1.allowed, false);
  assert.ok((v1.reason ?? "").includes("다시 켜면"), "사람이 끈 것엔 '다시 켜면' 안내");
  assert.equal((v1.reason ?? "").includes("기본이"), false, "사람이 끈 것에 기본값 설명을 붙이면 원인을 오인시킨다");
  const v2 = checkChannelCall("read", { channel_id: "C0HRPRIV01" }, FRESH, "read");    // 비공개 기본 거부
  assert.ok((v2.reason ?? "").includes("기본이"), "기본값 때문이면 그렇게 설명해야 한다");
});
t("[G8] 지목이 여럿이면 전부 허용이어야 통과 + 걸린 것만 이름에", () => {
  assert.equal(checkChannelCall("read", { channels: ["C0OPEN0001", "C0ALERTS01"] }, POLICY, "read").allowed, true);
  const no = checkChannelCall("read", { channels: ["C0OPEN0001", "C0HRPRIV01"] }, POLICY, "read");
  assert.equal(no.allowed, false);
  assert.deepEqual(no.blocked, ["#hr-private"]);
});

// ══ DM 경로 (U1~U4) ══
t("[U1] DM 은 D… · U… 어느 쪽으로 불러도 막힌다(기본 거부)", () => {
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "D0DM000001" }, FRESH, "read").allowed, false);
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "U0PEER0001" }, FRESH, "read").allowed, false);
  assert.equal(checkChannelCall("slack_send_message", { channel_id: "U0PEER0001", message: "hi" }, FRESH, "write").allowed, false);
});
t("[U2] DM 을 켜면 두 경로 모두 열린다", () => {
  const opened = buildChannelPolicy(
    [{ channel_id: "D0DM000001", channel_name: "윤상민", peer_id: "U0PEER0001", allow_read: true, allow_write: true }], METAS,
  );
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "D0DM000001" }, opened, "read").allowed, true);
  assert.equal(checkChannelCall("slack_read_channel", { channel_id: "U0PEER0001" }, opened, "read").allowed, true);
});
t("[U3] 응답 본문의 작성자 user_id 는 대화로 보지 않는다 — 오탐 방지", () => {
  // 본문 스캔으로 U 를 잡으면 "그 사람과의 DM 을 껐다"는 이유로 그 사람의 모든 메시지가 사라진다.
  assert.equal(extractChannelRefs({ text: "<@U0PEER0001> 님이 말했습니다" }).has("U0PEER0001"), false);
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0OPEN0001" }, author: "U0PEER0001", text: "공개채널 발언" }] });
  const r = filterChannelContent(blocks(payload), FRESH, true);
  assert.equal(r.removed, 0);
  assert.ok(textOf(r.content).includes("공개채널 발언"));
});
t("[U4] DM 표시명엔 '#' 을 붙이지 않는다 — 사람 이름이지 채널이 아니다", () => {
  assert.deepEqual(checkChannelCall("slack_read_channel", { channel_id: "D0DM000001" }, FRESH, "read").blocked, ["윤상민"]);
  assert.deepEqual(checkChannelCall("read", { channel: "C0HRPRIV01" }, FRESH, "read").blocked, ["#hr-private"]);
});

// ══ 툴 성격 (M1~M3) ══
t("[M1] 채널·사용자 목록/검색은 meta — 정책 대상 밖", () => {
  assert.equal(channelToolKind("slack_search_channels", "L0"), "meta");
  assert.equal(channelToolKind("list_channels", "L0"), "meta");
  assert.equal(channelToolKind("users_list", "L0"), "meta");
  assert.equal(channelToolKind("slack_list_conversations", null), "meta");
});
t("[M2] 뒤에 내용이 붙는 이름은 meta 가 아니다 — 끝 앵커(오인하면 곧 누출)", () => {
  assert.equal(channelToolKind("get_channel_history", "L0"), "read");
  assert.equal(channelToolKind("search_channels_messages", "L0"), "read");
  assert.equal(channelToolKind("list_channel_members", "L0"), "read");
  assert.equal(channelToolKind("slack_search_messages", "L0"), "read");
});
t("[M3] 쓰기로 분류될 것은 meta 로 새지 않는다 — 판정 순서 write→meta", () => {
  assert.equal(channelToolKind("slack_search_channels", "L2"), "write");
  assert.equal(channelToolKind("invite_users", "L0"), "write");
  assert.equal(channelToolKind("draft_message", "L0"), "write");
  assert.equal(channelToolKind("reply_in_thread", "L0"), "write");
});

// ══ 응답 필터 (R1~R10) ══
t("[R1] 대화를 지목한 호출(allowOnly=false) — 차단된 대화가 섞였을 때만 제거", () => {
  const payload = JSON.stringify({ messages: [
    { channel: { id: "C0OPEN0001", name: "general" }, text: "공개 메시지" },
    { channel: { id: "C0HRPRIV01", name: "hr-private" }, text: "비밀 메시지" },
  ] });
  const r = filterChannelContent(blocks(payload), POLICY, false);
  assert.equal(r.removed, 1);
  assert.equal(r.blocked, 0);
  const out = textOf(r.content);
  assert.ok(out.includes("공개 메시지"));
  assert.equal(out.includes("비밀 메시지"), false);
  assert.equal(out.includes("C0HRPRIV01"), false);
});
t("[R1b] 지목한 호출의 응답 본문은 귀속 표시가 없어도 보존된다(★ 깨지면 허용한 채널을 못 읽는다)", () => {
  // slack_read_channel(C0OPEN0001) 의 응답 — 메시지마다 채널을 다시 적지 않는다.
  const payload = JSON.stringify({ messages: [{ user: "U0PEER0001", text: "안녕하세요" }, { user: "U0X", text: "네" }] });
  const r = filterChannelContent(blocks(payload), POLICY, false);
  assert.equal(r.removed, 0);
  assert.equal(r.blocked, 0);
  assert.ok(textOf(r.content).includes("안녕하세요"));
});
t("[R2] 전역 검색(allowOnly=true) — 허용 확인된 항목만 남는다", () => {
  const payload = JSON.stringify({ messages: [
    { channel: { id: "C0OPEN0001" }, text: "공개 메시지" },
    { channel: { id: "C0HRPRIV01" }, text: "비밀 메시지" },
    { channel: { id: "C0TEAMPRV1" }, text: "켜둔 비공개 메시지" },
  ] });
  const out = textOf(filterChannelContent(blocks(payload), POLICY, true).content);
  assert.ok(out.includes("공개 메시지"));
  assert.ok(out.includes("켜둔 비공개 메시지"), "사람이 켠 비공개는 남아야 한다");
  assert.equal(out.includes("비밀 메시지"), false);
});
t("[R3] 전역 검색 + 귀속 불명 항목 → 제거(#1226 L1 한계를 닫는다)", () => {
  const payload = JSON.stringify({ messages: [
    { channel: { id: "C0OPEN0001" }, text: "공개 메시지" },
    { text: "어느 대화인지 안 적힌 메시지" },
  ] });
  const out = textOf(filterChannelContent(blocks(payload), POLICY, true).content);
  assert.ok(out.includes("공개 메시지"));
  assert.equal(out.includes("어느 대화인지"), false, "귀속을 못 읽는 항목은 안전측으로 빼야 한다");
});
t("[R4] 설정이 하나도 없어도 응답 필터는 돈다(#1226 은 여기서 그냥 빠져나갔다)", () => {
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0HRPRIV01" }, text: "비밀" }] });
  assert.equal(textOf(filterChannelContent(blocks(payload), FRESH, true).content).includes("비밀"), false,
    "기본 거부인 비공개 내용이 그대로 나왔다");
});
t("[R5] 최상위 자체가 차단된 대화(도려낼 단위 없음) → 블록 차단", () => {
  const payload = JSON.stringify({ channel: "C0HRPRIV01", messages: [{ text: "본문" }] });
  const r = filterChannelContent(blocks(payload), POLICY, false);
  assert.equal(r.blocked, 1);
  assert.equal(textOf(r.content).includes("본문"), false);
});
t("[R6] 평문에 차단된 대화 흔적 → 블록 차단", () => {
  const r = filterChannelContent(blocks("#hr-private 에서 나온 이야기입니다"), POLICY, false);
  assert.equal(r.blocked, 1);
  assert.equal(textOf(r.content).includes("나온 이야기"), false);
});
t("[R7] 흔적 없는 응답은 손대지 않는다(지목한 호출)", () => {
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0OPEN0001" }, text: "공개" }] });
  const r = filterChannelContent(blocks(payload), POLICY, false);
  assert.equal(r.removed, 0);
  assert.equal(r.blocked, 0);
  assert.equal(textOf(r.content), payload);
});
t("[R8] 발송만 막은 채널은 열람 응답에서 안 지운다", () => {
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0ALERTS01" }, text: "알림" }] });
  const r = filterChannelContent(blocks(payload), POLICY, true);
  assert.equal(r.removed, 0);
  assert.ok(textOf(r.content).includes("알림"));
});
t("[R9] 텍스트가 아닌 블록에 차단된 흔적 → 차단", () => {
  const r = filterChannelContent([{ type: "resource", resource: { uri: "slack://C0HRPRIV01/x" } }], POLICY, true);
  assert.equal(r.blocked, 1);
  assert.equal((r.content[0] as { type: string }).type, "text");
});
t("[R10] 채널 참조가 아예 없는 블록은 건드리지 않는다(알려진 한계 — 지울 근거도 남길 근거도 없다)", () => {
  const r = filterChannelContent(blocks("작업을 완료했습니다."), POLICY, true);
  assert.equal(r.blocked, 0);
  assert.equal(textOf(r.content), "작업을 완료했습니다.");
});
t("[R11] 항목 구조 없는 평문 + 허용 채널 언급 → 통과(allowOnly 여도 통째 차단하지 않는다)", () => {
  // 골라낼 항목이 없는 평문을 allowOnly 로 막으면, 허용된 공개 채널 이름이 스치기만 해도 응답이 통째로
  //  사라진다 — #1226 이 실사용에서 겪은 그 실패다.
  const r = filterChannelContent(blocks("#general 채널에 공지를 올렸습니다."), POLICY, true);
  assert.equal(r.blocked, 0);
  assert.ok(textOf(r.content).includes("공지를 올렸습니다"));
  // 반대로 차단된 대화가 섞이면 평문이라도 여전히 막는다(R6 와 같은 규칙)
  assert.equal(filterChannelContent(blocks("#hr-private 관련 잡담"), POLICY, true).blocked, 1);
});

// ══ 마크다운 항목 필터 (MD1~MD6) — 슬랙 실측 응답 형태(배열이 아니라 results 안의 한 덩어리) ══
const SLACK_MD = JSON.stringify({
  results: "# Search Results for: lively\n\n## Messages (3 results)\n"
    + "### Result 1 of 3\nChannel: #general (ID: C0OPEN0001)\nPermalink: [link](https://x.slack.com/archives/C0OPEN0001/p1700000001)\nText: \n공개 이야기\n\n---\n\n"
    + "### Result 2 of 3\nChannel: #hr-private (ID: C0HRPRIV01)\nPermalink: [link](https://x.slack.com/archives/C0HRPRIV01/p1700000002)\nText: \n비밀 이야기\n\n---\n\n"
    + "### Result 3 of 3\nChannel: #team-secret (ID: C0TEAMPRV1)\nPermalink: [link](https://x.slack.com/archives/C0TEAMPRV1/p1700000003)\nText: \n켜둔 비공개 이야기\n\n---\n\n",
  pagination_info: "End of results",
});

t("[MD1] 마크다운 덩어리에서 허용된 항목만 남긴다(배열이 없어도)", () => {
  const r = filterChannelContent(blocks(SLACK_MD), POLICY, true);
  assert.equal(r.blocked, 0, "통째 차단이 아니라 항목 제거여야 한다");
  assert.equal(r.removed, 1);
  const out = textOf(r.content);
  assert.ok(out.includes("공개 이야기"), "공개 채널 결과는 남아야 한다");
  assert.ok(out.includes("켜둔 비공개 이야기"), "사람이 켠 비공개 결과도 남아야 한다");
  assert.equal(out.includes("비밀 이야기"), false);
  assert.equal(out.includes("C0HRPRIV01"), false);
  assert.ok(out.includes("Search Results for"), "머리말은 보존");
});
t("[MD2] 설정 없는 초기 상태 — 공개만 남는다", () => {
  const out = textOf(filterChannelContent(blocks(SLACK_MD), FRESH, true).content);
  assert.ok(out.includes("공개 이야기"));
  assert.equal(out.includes("비밀 이야기"), false);
  assert.equal(out.includes("켜둔 비공개 이야기"), false, "안 켠 비공개는 막혀야 한다");
});
t("[MD3] 항목 헤딩이 없으면 null(처리 불가를 삼키지 않는다)", () => {
  assert.equal(pruneMarkdownItems("그냥 평문", POLICY, true), null);
});
t("[MD4] 도려냈으면 '제외됨' 안내를 한 번 남긴다 — 개수·번호 불일치로 생기는 오해 방지", () => {
  const out = textOf(filterChannelContent(blocks(SLACK_MD), POLICY, true).content);
  assert.ok(out.includes("개인 설정"), "제외 사실을 알려야 한다");
  assert.ok(out.includes("제외 전 기준"), "남은 개수·번호가 원본 기준임을 밝혀야 한다");
  assert.equal(out.includes("_omitted_by_policy"), false, "마크다운 경로에선 안내가 한 번만");
});
t("[MD5] 배열 경로에서도 같은 안내(최상위 1회)", () => {
  const payload = JSON.stringify({ messages: [
    { channel: { id: "C0OPEN0001" }, text: "공개" },
    { channel: { id: "C0HRPRIV01" }, text: "비밀" },
  ] });
  const out = textOf(filterChannelContent(blocks(payload), POLICY, true).content);
  const parsed = JSON.parse(out) as Record<string, unknown>;
  assert.ok(String(parsed._omitted_by_policy ?? "").includes("개인 설정"));
  assert.equal(out.includes("비밀"), false);
  assert.equal((out.match(/_omitted_by_policy/g) ?? []).length, 1, "중첩마다 붙으면 안 된다");
});
t("[MD6] 도려낸 게 없으면 안내도 없다(무변)", () => {
  const payload = JSON.stringify({ messages: [{ channel: { id: "C0OPEN0001" }, text: "공개" }] });
  const out = textOf(filterChannelContent(blocks(payload), POLICY, true).content);
  assert.equal(out, payload);
  assert.equal(out.includes("_omitted_by_policy"), false);
});

// ══ 안내 비노출 (S1~S2) ══
t("[S1] 응답 차단 안내에 대화 이름·id 가 새지 않는다", () => {
  const note = textOf(filterChannelContent(blocks("#hr-private 에서 나온 이야기"), POLICY, false).content);
  for (const leak of ["hr-private", "C0HRPRIV01", "alerts", "C0ALERTS01", "team-secret", "C0TEAMPRV1"]) {
    assert.equal(note.includes(leak), false, `차단 안내에 '${leak}' 가 노출됨`);
  }
  const note2 = textOf(filterChannelContent(blocks(JSON.stringify({ channel: "C0HRPRIV01", messages: [{ text: "x" }] })), POLICY, false).content);
  assert.equal(note2.includes("hr-private"), false);
  assert.equal(note2.includes("C0HRPRIV01"), false);
});
t("[S2] 전역 검색 제외 안내에도 이름이 없다", () => {
  const out = textOf(filterChannelContent(blocks(SLACK_MD), POLICY, true).content);
  assert.equal(out.includes("hr-private"), false, "제외 안내가 가리려던 대화를 알려주면 자기모순");
});

// ══ 응답 지목 추출 — 집행 배선용 (X1~X2) ══
t("[X1] extractResponseTargets: JSON 블록은 파싱해서 힌트 키까지 읽는다", () => {
  const got = extractResponseTargets(blocks(JSON.stringify({ messages: [{ channel: "C0HRPRIV01" }] })));
  assert.ok(got.has("C0HRPRIV01"), "파싱 안 하면 힌트 키가 안 보여 지목을 놓친다");
});
t("[X2] extractResponseTargets: 마크다운 덩어리의 permalink 도 읽는다", () => {
  const got = extractResponseTargets(blocks(SLACK_MD));
  for (const id of ["C0OPEN0001", "C0HRPRIV01", "C0TEAMPRV1"]) assert.ok(got.has(id), `${id} 를 못 읽었다`);
});

console.log(`\n${pass} passed`);
