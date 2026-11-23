// 슬랙 다리(#1782) 순수 판정 단위 시험 — 엣지 표 E(envelope) · N(다리 설정) · C(앱 호출) · J(작업 본문) · 연결 보조(spec-1782).
// 실행: npm run build && node --test dist/org/slack-bridge/plan.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { HttpError } from "../../http-error.js";
import {
  BRIDGE_CALL_ARGS_MAX, BRIDGE_FILE_MAX_BYTES, BRIDGE_FILE_RAW_IMAGE_MAX, DEFAULT_BRIDGE_EVENTS, bridgeCallPlan, bridgeFilePlan, bridgeJobBody, envelopeVerdict, formBodyOf,
  isSlackFileUrl, isSlackSocketUrl, normalizeBridgeInput, slackFileChannels,
  parseTokenRef, reconnectDelayMs, shortError, socketAppIdOf, type BotIdentity, type BridgeRow, type SocketEnvelope,
} from "./plan.js";

const BOT: BotIdentity = { user_id: "UBOT", bot_id: "BBOT", team_id: "T1" };
const F = (o: Partial<Pick<BridgeRow, "events" | "channels" | "bot_messages">> = {}) => ({ events: ["message", "app_mention", "block_actions"], channels: ["C1"], bot_messages: false, ...o });
const evEnv = (event: Record<string, unknown>, o: Record<string, unknown> = {}): SocketEnvelope => ({
  envelope_id: "env-1", type: "events_api",
  payload: { token: "verif-tok", team_id: "T1", api_app_id: "A1", type: "event_callback", event_id: "Ev1", event_time: 1700000000, event, ...o },
});
const msg = (o: Record<string, unknown> = {}) => evEnv({ type: "message", channel: "C1", user: "U1", text: "안녕", ts: "100.1", ...o });
const ia = (payload: Record<string, unknown>): SocketEnvelope => ({ envelope_id: "env-i", type: "interactive", payload: { token: "verif-tok", ...payload } });
const btn = (o: Record<string, unknown> = {}) => ia({
  type: "block_actions", trigger_id: "trig-1", user: { id: "U1", team_id: "T1" }, team: { id: "T1" },
  channel: { id: "C1" }, container: { type: "message", channel_id: "C1", message_ts: "200.1" }, message: { ts: "200.1", thread_ts: "199.9" },
  actions: [{ action_id: "ok", value: "yes" }], response_url: "https://hooks.slack.com/actions/x", ...o,
});

test("E1 · E2 사람 글 — 넘김 · 열쇠 · 채널 · ts · 스레드", () => {
  const v = envelopeVerdict(msg(), F(), BOT);
  assert.equal(v.forward, true, String(v.reason));
  assert.equal(v.key, "e:Ev1"); assert.equal(v.kind, "events_api"); assert.equal(v.type, "message");
  assert.equal(v.channel, "C1"); assert.equal(v.ts, "100.1"); assert.equal(v.thread_ts, "100.1"); assert.equal(v.slack_user, "U1");
  assert.equal(v.explicit, false, "채널의 평범한 글은 봇을 부른 것이 아니다"); assert.equal(v.bot_authored, false);
  const r = envelopeVerdict(msg({ thread_ts: "90.0", ts: "100.2" }), F(), BOT);
  assert.equal(r.thread_ts, "90.0", "E2 답글의 스레드는 부모 ts");
});

test("E3 · E4 종류 · 채널 거르기 — channels 가 비면 모든 채널", () => {
  assert.equal(envelopeVerdict(evEnv({ type: "reaction_added", user: "U1", item: { type: "message", channel: "C1", ts: "1.1" } }), F(), BOT).forward, false, "E3 고르지 않은 종류");
  assert.equal(envelopeVerdict(msg({ channel: "C9" }), F(), BOT).forward, false, "E4a 고르지 않은 채널");
  assert.match(String(envelopeVerdict(msg({ channel: "C9" }), F(), BOT).reason), /채널/);
  assert.equal(envelopeVerdict(msg({ channel: "C9" }), F({ channels: [] }), BOT).forward, true, "E4b channels 빈 목록 = 모든 채널");
});

test("E5 이 봇 자신의 글은 늘 거른다 — bot_messages 를 켜도(답이 다시 이벤트로 돌아오는 고리)", () => {
  assert.equal(envelopeVerdict(msg({ user: undefined, bot_id: "BBOT", subtype: "bot_message" }), F({ bot_messages: true }), BOT).forward, false, "E5a bot_id");
  assert.equal(envelopeVerdict(msg({ user: "UBOT", bot_id: "BBOT" }), F({ bot_messages: true }), BOT).forward, false, "E5a 앱이 chat.postMessage 로 단 글(user=봇)");
  assert.equal(envelopeVerdict(msg({ user: "UBOT" }), F({ bot_messages: true }), BOT).forward, false, "E5b 봇 user");
  assert.equal(envelopeVerdict(evEnv({ type: "app_mention", channel: "C1", user: "UBOT", ts: "1.1" }), F({ bot_messages: true }), BOT).forward, false, "E5b 봇이 저를 태그");
  //  E5c 봇 신원을 모를 때 — 다른 봇 글은 bot_messages 꺼짐이면 거른다(봇 글 판정은 신원과 무관)
  assert.equal(envelopeVerdict(msg({ user: undefined, bot_id: "BX", subtype: "bot_message" }), F(), { user_id: null, bot_id: null, team_id: null }).forward, false);
});

test("E6 다른 봇 · 워크플로 글 — bot_messages 꺼짐이면 거름 · 켜면 넘김(사람 없음)", () => {
  const wf = msg({ user: undefined, bot_id: "BWF", subtype: "bot_message", bot_profile: { name: "업무 요청" } });
  assert.equal(envelopeVerdict(wf, F(), BOT).forward, false, "E6a");
  const v = envelopeVerdict(wf, F({ bot_messages: true }), BOT);
  assert.equal(v.forward, true, String(v.reason)); assert.equal(v.bot_authored, true); assert.equal(v.slack_user, null, "E6b 글쓴이는 사람이 아니다");
  //  새 워크플로는 subtype 없이 bot_id 만 싣기도 한다
  const wf2 = msg({ user: "UWF", bot_id: "BWF" });
  assert.equal(envelopeVerdict(wf2, F(), BOT).forward, false, "E6a bot_id 만 있는 글도 봇 글");
  assert.equal(envelopeVerdict(wf2, F({ bot_messages: true }), BOT).bot_authored, true);
});

test("E7 글이 아닌 메시지 이벤트(고침 · 지움 · 들어옴)는 거르고, 스레드 방송 · 파일 공유는 넘긴다", () => {
  for (const st of ["message_changed", "message_deleted", "channel_join", "channel_topic"]) {
    assert.equal(envelopeVerdict(msg({ subtype: st }), F(), BOT).forward, false, st);
  }
  for (const st of ["thread_broadcast", "file_share"]) assert.equal(envelopeVerdict(msg({ subtype: st }), F(), BOT).forward, true, st);
});

test("E8 다른 워크스페이스 — payload 팀 · 글쓴이 팀이 봇 팀과 다르면 거름 · 봇 팀을 모르면 거르지 않는다", () => {
  assert.equal(envelopeVerdict(msg({}, ), F(), { ...BOT, team_id: "T2" }).forward, false, "E8a");
  assert.equal(envelopeVerdict(msg({ user_team: "T9" }), F(), BOT).forward, false, "E8b Slack Connect");
  assert.equal(envelopeVerdict(msg({ user_team: "T9" }), F(), { ...BOT, team_id: null }).forward, true, "E8c 봇 팀 모름");
});

test("E9 봇을 직접 부른 것 — 태그 · DM 은 explicit", () => {
  assert.equal(envelopeVerdict(evEnv({ type: "app_mention", channel: "C1", user: "U1", ts: "1.1" }), F(), BOT).explicit, true, "E9a");
  const dm = envelopeVerdict(msg({ channel: "D1", channel_type: "im" }), F({ channels: [] }), BOT);
  assert.equal(dm.forward, true); assert.equal(dm.explicit, true, "E9b");
});

test("E10 · E11 열쇠 — event_id 없으면 envelope_id · 둘 다 없으면 거름 · event_callback 아니면 거름", () => {
  const p = msg();
  delete (p.payload as Record<string, unknown>).event_id;
  assert.equal(envelopeVerdict(p, F(), BOT).key, "v:env-1", "E10a");
  delete (p as Record<string, unknown>).envelope_id;
  assert.equal(envelopeVerdict(p, F(), BOT).forward, false, "E10b");
  assert.equal(envelopeVerdict(evEnv({ type: "message", channel: "C1", user: "U1", ts: "1.1" }, { type: "app_rate_limited" }), F(), BOT).forward, false, "E11");
});

test("E12 상호작용(버튼) — 넘김 · 열쇠 trigger · 채널 · 메시지 ts · explicit / 모달(채널 없음) · 누른 사람 없음 · 고르지 않은 종류는 거름", () => {
  const v = envelopeVerdict(btn(), F(), BOT);
  assert.equal(v.forward, true, String(v.reason)); assert.equal(v.kind, "interactive"); assert.equal(v.key, "i:trig-1");
  assert.equal(v.channel, "C1"); assert.equal(v.ts, "200.1"); assert.equal(v.thread_ts, "199.9"); assert.equal(v.slack_user, "U1"); assert.equal(v.explicit, true);
  const modal = ia({ type: "view_submission", trigger_id: "t2", user: { id: "U1", team_id: "T1" }, view: { id: "V1" } });
  assert.equal(envelopeVerdict(modal, F({ events: ["view_submission"] }), BOT).forward, false, "E12b 채널을 골랐는데 채널 없는 모달");
  assert.equal(envelopeVerdict(modal, F({ events: ["view_submission"], channels: [] }), BOT).forward, true, "E12b' 채널을 안 골랐으면 모달도 넘김");
  assert.equal(envelopeVerdict(btn({ user: undefined }), F(), BOT).forward, false, "E12c");
  assert.equal(envelopeVerdict(btn(), F({ events: ["message"] }), BOT).forward, false, "E12d");
  const noTrig = btn({ trigger_id: undefined });
  assert.equal(envelopeVerdict(noTrig, F(), BOT).key, "v:env-i", "trigger 없으면 envelope_id");
});

test("E13 · E14 · E15 · E16 — 다른 envelope · 숨은 이벤트 · 글쓴이 없음 · 반응 이벤트의 대상", () => {
  assert.equal(envelopeVerdict({ envelope_id: "e", type: "slash_commands", payload: { command: "/x", user_id: "U1", channel_id: "C1" } }, F(), BOT).forward, false, "E13");
  assert.equal(envelopeVerdict({ envelope_id: "e", type: "hello" }, F(), BOT).forward, false);
  assert.equal(envelopeVerdict(msg({ hidden: true }), F(), BOT).forward, false, "E14");
  assert.equal(envelopeVerdict(msg({ user: undefined }), F(), BOT).forward, false, "E15");
  const r = envelopeVerdict(evEnv({ type: "reaction_added", user: "U1", reaction: "+1", item: { type: "message", channel: "C1", ts: "5.5" } }), F({ events: ["reaction_added"] }), BOT);
  assert.equal(r.forward, true, String(r.reason)); assert.equal(r.channel, "C1"); assert.equal(r.ts, "5.5", "E16");
});

test("J1 · J2 작업 본문 — 이벤트 · 열쇠 · 다리 · 사람이 실리고, 슬랙 검증 토큰은 어디에도 없다", () => {
  const at = new Date("2026-11-20T01:02:03.000Z");
  const e = msg();
  const v = envelopeVerdict(e, F(), BOT);
  const b = bridgeJobBody(e, v, "ops", { slack_user: "U1", member: "alice", via: "email" }, at);
  assert.equal(b.kind, "events_api"); assert.equal(b.bridge, "ops"); assert.equal(b.event_id, "Ev1"); assert.equal(b.team_id, "T1");
  assert.equal(b.received_at, "2026-11-20T01:02:03.000Z");
  assert.deepEqual(b.actor, { slack_user: "U1", member: "alice", via: "email" });
  assert.equal((b.event as { text?: string }).text, "안녕");
  assert.ok(!JSON.stringify(b).includes("verif-tok"), "J1 검증 토큰이 없다");
  const i = btn();
  const bi = bridgeJobBody(i, envelopeVerdict(i, F(), BOT), "ops", { slack_user: "U1", member: "alice", via: "identity" }, at);
  assert.equal(bi.kind, "interactive");
  assert.equal((bi.payload as { type?: string }).type, "block_actions");
  assert.deepEqual((bi.payload as { actions?: unknown }).actions, [{ action_id: "ok", value: "yes" }], "J2 나머지는 그대로");
  assert.ok(!JSON.stringify(bi).includes("verif-tok"), "J2 검증 토큰을 뺐다");
});

// ── N 다리 설정 ──
const statusOf = (e: unknown): number => (e instanceof HttpError ? e.status : -1);
const throws400 = (fn: () => unknown, re?: RegExp): void => {
  let err: unknown = null;
  try { fn(); } catch (e) { err = e; }
  assert.equal(statusOf(err), 400, `400 을 기대 — ${String(err)}`);
  if (re) assert.match((err as Error).message, re);
};
const base = { id: "ops", app_id: "policy", route: "/api/slack/event", app_token: "slack_bridge_app:ops", bot_token: "slack_bridge_bot:ops" };

test("N1 최소 새 다리 — 기본값", () => {
  const b = normalizeBridgeInput(base, null, "boss");
  assert.deepEqual(b.events, DEFAULT_BRIDGE_EVENTS); assert.deepEqual(b.channels, []); assert.equal(b.enabled, true); assert.equal(b.bot_messages, false);
  assert.equal(b.run_as, null); assert.equal(b.react, null);
  assert.deepEqual(b.app_token_ref, { owner: "gateway", kind: "slack_bridge_app", scope_key: "ops" });
});

test("N1b run_as_human — 기본 꺼짐 · 켜려면 bot_ids 가 있어야 한다 · 앞 값을 이어 쓴다 · \"true\" 글도 받는다", () => {
  assert.equal(normalizeBridgeInput(base, null, "boss").run_as_human, false);
  throws400(() => normalizeBridgeInput({ ...base, run_as: "runner", bot_messages: true, run_as_human: true }, null, "boss"), /bot_ids/);
  const on = normalizeBridgeInput({ ...base, run_as: "runner", bot_messages: true, bot_ids: ["BWF"], run_as_human: true }, null, "boss");
  assert.equal(on.run_as_human, true);
  assert.equal(normalizeBridgeInput({ ...base, bot_ids: ["BWF"], run_as_human: "true" }, null, "boss").run_as_human, true);
  //  고칠 때 생략하면 앞 값 그대로 — 앞 값이 켜져 있는데 bot_ids 를 비우면 거절(켠 채로 모든 봇 글을 사람의 질문으로 보지 않게)
  const prev = { ...on, status: {}, created_at: null, updated_at: null, updated_by: null };
  assert.equal(normalizeBridgeInput({ id: "ops" }, prev, "boss").run_as_human, true);
  throws400(() => normalizeBridgeInput({ id: "ops", bot_ids: [] }, prev, "boss"), /bot_ids/);
  assert.equal(normalizeBridgeInput({ id: "ops", bot_ids: [], run_as_human: false }, prev, "boss").run_as_human, false);
});

test("N2 id 경계(40/41) · 앱 · 라우트(메서드 앞머리 · /_lively)", () => {
  assert.equal(normalizeBridgeInput({ ...base, id: "a".repeat(40) }, null, "boss").id, "a".repeat(40));
  throws400(() => normalizeBridgeInput({ ...base, id: "a".repeat(41) }, null, "boss"));
  throws400(() => normalizeBridgeInput({ ...base, id: "Ops!" }, null, "boss"));
  throws400(() => normalizeBridgeInput({ ...base, app_id: undefined }, null, "boss"), /app_id/);
  throws400(() => normalizeBridgeInput({ ...base, route: undefined }, null, "boss"), /route/);
  assert.equal(normalizeBridgeInput({ ...base, route: "POST /api/slack/event" }, null, "boss").route, "/api/slack/event");
  throws400(() => normalizeBridgeInput({ ...base, route: "GET /api/x" }, null, "boss"), /POST/);
  throws400(() => normalizeBridgeInput({ ...base, route: "/_lively/x" }, null, "boss"));
  throws400(() => normalizeBridgeInput({ ...base, route: "api/x" }, null, "boss"));
});

test("N3 금고 참조 — 글 · 객체 · 남의 개인 칸 거절 · 본인 칸 허용 · 같은 칸 거절 · 토큰 값을 붙여도 오류 글에 값이 없다", () => {
  const o = normalizeBridgeInput({ ...base, app_token: { kind: "slack_bridge_app", scope_key: "x" } }, null, "boss");
  assert.deepEqual(o.app_token_ref, { owner: "gateway", kind: "slack_bridge_app", scope_key: "x" });
  throws400(() => normalizeBridgeInput({ ...base, app_token: { owner: "member:alice", kind: "k" } }, null, "boss"), /본인/);
  assert.equal(normalizeBridgeInput({ ...base, app_token: { owner: "member:boss", kind: "k" } }, null, "boss").app_token_ref.owner, "member:boss");
  throws400(() => normalizeBridgeInput({ ...base, bot_token: "slack_bridge_app:ops" }, null, "boss"), /같은 금고 칸/);
  const tok = ["xoxb", "1111", "2222", "AbCdEfGhIjKl"].join("-");   // 조각으로 — 토큰 꼴 리터럴을 남기지 않는다(secret-scan)
  let err: unknown = null;
  try { parseTokenRef(tok, "bot_token", "boss"); } catch (e) { err = e; }
  assert.equal(statusOf(err), 400);
  assert.ok(!String((err as Error).message).includes("AbCdEfGhIjKl"), "N3d 오류 글에 토큰 값이 없다");
  throws400(() => parseTokenRef(42, "x", "boss"));
});

test("N4 events · channels — 모르는 종류 · 빈 목록 · 채널 id 꼴 · 100/101", () => {
  throws400(() => normalizeBridgeInput({ ...base, events: ["message", "typo"] }, null, "boss"), /typo/);
  throws400(() => normalizeBridgeInput({ ...base, events: [] }, null, "boss"));
  throws400(() => normalizeBridgeInput({ ...base, channels: ["#general"] }, null, "boss"), /id/);
  const ch = (n: number) => Array.from({ length: n }, (_, i) => `C${String(i).padStart(4, "0")}`);
  assert.equal(normalizeBridgeInput({ ...base, channels: ch(100) }, null, "boss").channels.length, 100);
  throws400(() => normalizeBridgeInput({ ...base, channels: ch(101) }, null, "boss"));
  assert.deepEqual(normalizeBridgeInput({ ...base, channels: "C0TESTCH01, G0AAA1111 C0TESTCH01" }, null, "boss").channels, ["C0TESTCH01", "G0AAA1111"], "쉼표 · 빈칸 글 · 중복 제거");
});

test("N5 고치기 — 생략한 칸은 그대로 · null 은 지움 · 이모지 콜론", () => {
  const prev = { ...normalizeBridgeInput({ ...base, channels: ["C0TESTCH01"], run_as: "bot-runner", react: "eyes", bot_messages: true }, null, "boss"),
    status: {}, created_at: null, updated_at: null, updated_by: null } as BridgeRow;
  const b = normalizeBridgeInput({ id: "ops" }, prev, "boss");
  assert.deepEqual(b.channels, ["C0TESTCH01"]); assert.equal(b.run_as, "bot-runner"); assert.equal(b.react, "eyes"); assert.equal(b.bot_messages, true); assert.equal(b.route, "/api/slack/event");
  const c = normalizeBridgeInput({ id: "ops", run_as: null, react: ":white_check_mark:" }, prev, "boss");
  assert.equal(c.run_as, null); assert.equal(c.react, "white_check_mark");
});

// ── C 앱 호출 ──
test("C1 · C2 메서드 허용 목록 · args 모양 · token 칸", () => {
  throws400(() => bridgeCallPlan("chat.delete.all", {}, { channels: [] }));
  throws400(() => bridgeCallPlan("admin.users.remove", { user: "U1" }, { channels: [] }), /chat\.postMessage/);
  throws400(() => bridgeCallPlan("chat.postMessage", "hi", { channels: [] }));
  throws400(() => bridgeCallPlan("chat.postMessage", { channel: "C1", token: "x" }, { channels: [] }), /token/);
  assert.deepEqual(bridgeCallPlan("users.info", undefined, { channels: [] }).args, {});
});

test("C3 args 크기 경계 — 정확히 상한은 통과 · 1바이트 넘으면 400", () => {
  const head = JSON.stringify({ channel: "C1", text: "" }).length;
  const exact = { channel: "C1", text: "a".repeat(BRIDGE_CALL_ARGS_MAX - head) };
  assert.equal(Buffer.byteLength(JSON.stringify(exact)), BRIDGE_CALL_ARGS_MAX);
  assert.equal(bridgeCallPlan("chat.postMessage", exact, { channels: [] }).method, "chat.postMessage");
  throws400(() => bridgeCallPlan("chat.postMessage", { ...exact, text: exact.text + "a" }, { channels: [] }), /너무 큽니다/);
});

test("C4 채널 — 다리에 고른 채널 밖은 403 · DM 은 된다 · 고르지 않았으면 아무 채널", () => {
  let err: unknown = null;
  try { bridgeCallPlan("chat.postMessage", { channel: "C9", text: "x" }, { channels: ["C1"] }); } catch (e) { err = e; }
  assert.equal(statusOf(err), 403, "C4a");
  assert.equal(bridgeCallPlan("chat.postMessage", { channel: "D7", text: "x" }, { channels: ["C1"] }).channel, "D7", "C4b");
  assert.equal(bridgeCallPlan("chat.postMessage", { channel: "C9", text: "x" }, { channels: [] }).channel, "C9", "C4c");
  assert.equal(bridgeCallPlan("chat.postMessage", { channel: "C1", text: "x" }, { channels: ["C1"] }).channel, "C1");
});

test("C5 본문 꼴 · ts — 쓰기는 JSON, 읽기는 form · ts · thread_ts · timestamp 를 기록용으로 뽑는다", () => {
  assert.equal(bridgeCallPlan("chat.postMessage", { channel: "C1", text: "x", thread_ts: "1.1" }, { channels: [] }).json, true);
  assert.equal(bridgeCallPlan("chat.postMessage", { channel: "C1", text: "x", thread_ts: "1.1" }, { channels: [] }).ts, "1.1");
  assert.equal(bridgeCallPlan("chat.update", { channel: "C1", ts: "2.2", text: "y" }, { channels: [] }).ts, "2.2");
  assert.equal(bridgeCallPlan("reactions.add", { channel: "C1", timestamp: "3.3", name: "eyes" }, { channels: [] }).ts, "3.3");
  const ui = bridgeCallPlan("users.info", { user: "U1" }, { channels: [] });
  assert.equal(ui.json, false); assert.equal(ui.channel, null);
  assert.equal(bridgeCallPlan("conversations.replies", { channel: "C1", ts: "1.1" }, { channels: [] }).json, false);
  assert.equal(formBodyOf({ channel: "C1", blocks: [{ type: "section" }], limit: 5, skip: null }), "channel=C1&blocks=%5B%7B%22type%22%3A%22section%22%7D%5D&limit=5");
});

test("연결 보조 — 기다림 경계 · 슬랙 소켓 주소만 · app_id · 오류 글의 토큰 가림", () => {
  for (const r of [0, 0.999]) {
    const d0 = reconnectDelayMs(0, () => r);
    assert.ok(d0 >= 1000 && d0 < 1500, `첫 기다림 1초대 — ${d0}`);
  }
  assert.equal(reconnectDelayMs(1, () => 0), 2000);
  assert.equal(reconnectDelayMs(6, () => 0), 60_000, "6번째에 상한");
  assert.equal(reconnectDelayMs(100, () => 0), 60_000, "더 가도 상한");
  assert.equal(reconnectDelayMs(-3, () => 0), 1000);
  assert.ok(isSlackSocketUrl("wss://wss-primary.slack.com/link/?ticket=t&app_id=A1"));
  assert.ok(!isSlackSocketUrl("ws://wss-primary.slack.com/link"), "wss 만");
  assert.ok(!isSlackSocketUrl("wss://evil.example/slack.com"));
  assert.ok(!isSlackSocketUrl("wss://slack.com.evil.example/link"));
  assert.ok(!isSlackSocketUrl("not a url"));
  assert.equal(socketAppIdOf("wss://wss-primary.slack.com/link/?ticket=t&app_id=A123"), "A123");
  assert.equal(socketAppIdOf("::"), null);
  const j = (...p: string[]): string => p.join("-");   // 조각으로 — 토큰 꼴 리터럴을 남기지 않는다(secret-scan)
  const toks = [j("xapp", "1", "A123", "456", "abcdef"), j("xoxb", "1", "2", "ccc"), `xoxe.${j("xoxb", "1", "2")}`, j("xoxp", "9", "9")];
  const s = shortError(new Error(`실패 ${toks.join(" 와 ")}`));
  for (const t of toks) assert.ok(!s.includes(t), `${t} 가 가려져야 한다 — ${s}`);
  assert.equal((s.match(/\[토큰\]/g) ?? []).length, 4, "넷 다 가렸다(관측 장치)");
});

// ── 격리 리뷰 뒤 더한 행(spec-1782 «격리 리뷰 뒤») ──
test("E17 사람이 봇을 태그한 글 — app_mention 을 고르면 message 쪽은 거른다 · 안 고르면 넘긴다 · 봇 신원 모르면 거르지 않는다", () => {
  const tagged = msg({ text: "<@UBOT> 한도 알려 줘" });
  const v = envelopeVerdict(tagged, F(), BOT);
  assert.equal(v.forward, false, "E17");
  assert.match(String(v.reason), /app_mention/);
  assert.equal(envelopeVerdict(tagged, F({ events: ["message"] }), BOT).forward, true, "E17b app_mention 을 안 고름");
  assert.equal(envelopeVerdict(tagged, F(), { ...BOT, user_id: null }).forward, true, "E17c 봇 신원 모름");
  assert.equal(envelopeVerdict(msg({ text: "<@UOTHER> 봐 줘" }), F(), BOT).forward, true, "다른 사람 태그는 그대로");
  assert.equal(envelopeVerdict(msg({ text: "<@UBOT> 봐 줘", channel_type: "channel" }), F(), BOT).forward, false, "공개 채널(channel_type)");
  assert.equal(envelopeVerdict(msg({ text: "<@UBOT> 봐 줘", channel_type: "group", channel: "G0AAA1111" }), F({ channels: [] }), BOT).forward, false, "비공개 채널");
  //  E17d — 슬랙은 DM · 그룹 DM 의 글을 app_mention 으로 보내지 않는다. 거르면 그 글이 사라진다.
  const dm = envelopeVerdict(msg({ text: "<@UBOT> DM 질문", channel: "D0AAA1111", channel_type: "im" }), F({ channels: [] }), BOT);
  assert.equal(dm.forward, true, "E17d DM 의 태그 글은 넘긴다"); assert.equal(dm.explicit, true);
  assert.equal(envelopeVerdict(msg({ text: "<@UBOT> 그룹 DM", channel: "G0MPIM111", channel_type: "mpim" }), F({ channels: [] }), BOT).forward, true, "E17d 그룹 DM");
  assert.equal(envelopeVerdict(msg({ text: "<@UBOT> DM(channel_type 없음)", channel: "D0AAA1111" }), F({ channels: [] }), BOT).forward, true, "E17d channel_type 이 없어도 D… 면 DM");
});

test("E18 같은 글 열쇠 — message · app_mention 은 m:<채널>:<ts> · 버튼 · 반응은 없음", () => {
  assert.equal(envelopeVerdict(msg(), F(), BOT).alt_key, `m:C1:${(msg().payload as { event: { ts: string } }).event.ts}`);
  const m = envelopeVerdict(evEnv({ type: "app_mention", channel: "C1", user: "U1", ts: "7.7" }), F(), BOT);
  assert.equal(m.alt_key, "m:C1:7.7");
  assert.equal(envelopeVerdict(btn(), F(), BOT).alt_key, null, "버튼");
  assert.equal(envelopeVerdict(evEnv({ type: "reaction_added", user: "U1", item: { type: "message", channel: "C1", ts: "5.5" } }), F({ events: ["reaction_added"] }), BOT).alt_key, null, "반응");
});

test("E19 bot_ids — 고른 봇 글만 · 다른 봇 · bot_id 없는 봇 글은 거름 · 비었으면 모든 봇 글", () => {
  const wf = (botId?: string) => msg({ user: undefined, subtype: "bot_message", ...(botId ? { bot_id: botId } : {}) });
  const on = (ids: string[]) => F({ bot_messages: true, bot_ids: ids } as Partial<BridgeRow>);
  assert.equal(envelopeVerdict(wf("B0TESTWF01"), on(["B0TESTWF01"]), BOT).forward, true, "E19a");
  assert.equal(envelopeVerdict(wf("BOTHER"), on(["B0TESTWF01"]), BOT).forward, false, "E19b 다른 봇");
  assert.equal(envelopeVerdict(wf(), on(["B0TESTWF01"]), BOT).forward, false, "E19b bot_id 없음");
  assert.equal(envelopeVerdict(wf("BOTHER"), on([]), BOT).forward, true, "E19c 비었으면 모든 봇");
  assert.equal(envelopeVerdict(wf("BBOT"), on(["BBOT"]), BOT).forward, false, "이 봇 자신은 목록에 있어도 거른다");
});

test("N8 bot_ids — 꼴 · 20/21 · 생략하면 유지", () => {
  assert.deepEqual(normalizeBridgeInput({ ...base, bot_ids: ["B0TESTWF01"] }, null, "boss").bot_ids, ["B0TESTWF01"]);
  assert.deepEqual(normalizeBridgeInput(base, null, "boss").bot_ids, [], "기본은 빈 목록");
  throws400(() => normalizeBridgeInput({ ...base, bot_ids: ["워크플로"] }, null, "boss"), /bot_id/);
  throws400(() => normalizeBridgeInput({ ...base, bot_ids: ["U1234"] }, null, "boss"));
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `B${String(i).padStart(5, "0")}`);
  assert.equal(normalizeBridgeInput({ ...base, bot_ids: ids(20) }, null, "boss").bot_ids.length, 20);
  throws400(() => normalizeBridgeInput({ ...base, bot_ids: ids(21) }, null, "boss"));
  const prev = { ...normalizeBridgeInput({ ...base, bot_ids: ["B0TESTWF01"] }, null, "boss"), status: {}, created_at: null, updated_at: null, updated_by: null } as BridgeRow;
  assert.deepEqual(normalizeBridgeInput({ id: "ops" }, prev, "boss").bot_ids, ["B0TESTWF01"], "생략 = 유지");
  assert.deepEqual(normalizeBridgeInput({ id: "ops", bot_ids: [] }, prev, "boss").bot_ids, [], "빈 목록 = 지움");
});

// ── 앱이 읽는 슬랙 파일(slack_bridge_file) ──
const URL_OK = "https://files.slack.com/files-pri/T1-F0ABC12345/download/a.png";
const fileOf = (o: Record<string, unknown> = {}) => ({ id: "F0ABC12345", name: "a.png", mimetype: "image/png", filetype: "png", size: 1000, mode: "hosted", channels: ["C1"], url_private: URL_OK, ...o });

test("F-u 파일 주소 — https 의 슬랙 파일 서버만(봇 토큰을 실어 보내는 자리)", () => {
  assert.ok(isSlackFileUrl(URL_OK));
  assert.ok(!isSlackFileUrl("http://files.slack.com/files-pri/T1-F0ABC12345/a.png"), "https 만");
  assert.ok(!isSlackFileUrl("https://files.slack.com.evil.example/files-pri/T1-F0ABC12345/a.png"), "슬랙 아래가 아닌 곳");
  assert.ok(!isSlackFileUrl("https://evil.example/files.slack.com/a.png"));
  assert.ok(!isSlackFileUrl("https://gowid.slack.com/files/U1/F0ABC12345/a.png"), "파일 서버가 아닌 슬랙 주소");
  assert.ok(!isSlackFileUrl("https://user:pw@files.slack.com/a.png"), "주소에 신원을 싣지 않는다");
  assert.ok(!isSlackFileUrl("files.slack.com/a.png")); assert.ok(!isSlackFileUrl(null)); assert.ok(!isSlackFileUrl(""));
});

test("F-c 파일이 공유된 채널 — channels · groups · ims 와 shares 의 열쇠", () => {
  assert.deepEqual(slackFileChannels({ channels: ["C1"], groups: ["G1"], ims: ["D1"], shares: { public: { C2: [{}] }, private: { G2: [{}] } } }).sort(), ["C1", "C2", "D1", "G1", "G2"]);
  assert.deepEqual(slackFileChannels({ channels: ["C1", "C1", 3, ""], shares: "x" }), ["C1"]);
  assert.deepEqual(slackFileChannels({}), []);
});

test("F-p 판정 — 그림은 줄일 형식 · 글 · 읽지 못하는 것은 까닭", () => {
  const B = { channels: ["C1"] };
  const png = bridgeFilePlan(fileOf(), B);
  assert.deepEqual([png.kind, png.convert, png.url, png.channel, png.reason], ["image", "png", URL_OK, "C1", null]);
  assert.equal(bridgeFilePlan(fileOf({ mimetype: "image/jpeg" }), B).convert, "jpeg");
  assert.equal(bridgeFilePlan(fileOf({ mimetype: "IMAGE/HEIC" }), B).convert, "heic");
  const gif = bridgeFilePlan(fileOf({ mimetype: "image/gif" }), B);
  assert.deepEqual([gif.kind, gif.convert], ["image", null], "GIF 는 그대로");
  assert.equal(bridgeFilePlan(fileOf({ mimetype: "image/webp", size: BRIDGE_FILE_RAW_IMAGE_MAX + 1 }), B).kind, "unsupported", "줄일 수 없는데 크면 주지 않는다");
  assert.equal(bridgeFilePlan(fileOf({ mimetype: "text/csv; charset=utf-8" }), B).kind, "text");
  assert.equal(bridgeFilePlan(fileOf({ mimetype: "application/json" }), B).kind, "text");
  const pdf = bridgeFilePlan(fileOf({ mimetype: "application/pdf" }), B);
  assert.equal(pdf.kind, "unsupported"); assert.equal(pdf.url, null); assert.match(String(pdf.reason), /형식/);
  assert.equal(bridgeFilePlan(fileOf({ size: BRIDGE_FILE_MAX_BYTES + 1 }), B).kind, "unsupported", "너무 큰 파일");
  assert.equal(bridgeFilePlan(fileOf({ mode: "external" }), B).kind, "unsupported", "슬랙 밖 저장소의 파일");
  assert.equal(bridgeFilePlan(fileOf({ url_private: "https://evil.example/a.png" }), B).kind, "unsupported", "슬랙 파일 서버가 아닌 주소로는 받지 않는다");
  assert.equal(bridgeFilePlan(fileOf({ url_private: "https://evil.example/a.png", url_private_download: URL_OK }), B).url, URL_OK);
  assert.equal(bridgeFilePlan(fileOf({ name: "a\nb.png" }), B).name, "a b.png", "이름의 제어 문자는 빈칸으로");
});

test("F-g 채널 — 다리가 고른 채널에 공유된 파일만 · 고르지 않았으면 모두", () => {
  const out = (() => { try { bridgeFilePlan(fileOf({ channels: ["C9"] }), { channels: ["C1"] }); return null; } catch (e) { return e; } })();
  assert.ok(out instanceof HttpError && out.status === 403, "다리 채널 밖");
  assert.equal(bridgeFilePlan(fileOf({ channels: [], shares: { private: { C1: [{}] } } }), { channels: ["C1", "C2"] }).channel, "C1", "shares 로 공유된 채널도 본다");
  assert.equal(bridgeFilePlan(fileOf({ channels: ["C9"] }), { channels: [] }).channel, "C9", "채널을 고르지 않은 다리");
  const none = (() => { try { bridgeFilePlan(fileOf({ channels: [] }), { channels: ["C1"] }); return null; } catch (e) { return e; } })();
  assert.ok(none instanceof HttpError && none.status === 403, "어디에도 공유되지 않은 파일");
  const bad = (() => { try { bridgeFilePlan({ id: "x" }, { channels: [] }); return null; } catch (e) { return e; } })();
  assert.ok(bad instanceof HttpError && bad.status === 502, "파일 정보가 아닌 응답");
});
