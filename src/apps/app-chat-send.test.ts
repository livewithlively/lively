import { strict as assert } from "node:assert";
import test from "node:test";
import { RateWindow, composeAppMessage, localSessionGone, normalizeChatText, sendFromApp, type ChatSendDeps } from "./app-chat-send.js";
import { CHAT_SEND_TOOL, parseAppManifest } from "./manifest.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import type { SessionAppRow } from "./session-apps.js";

// ── 앱 화면 → 붙은 세션으로 글 보내기 (#4594) ─────────────────────────────────────────
//  사양 표 S1 — 행마다 하나씩. 이게 틀리면: 선언 안 한 앱이 사람의 AI 세션에 말을 넣는다 · 동의 없는 앱이 넣는다 · 남의 세션에 넣는다 ·
//  뗀 앱이 계속 넣는다 · 앱 코드가 세션을 메시지로 메운다 · 멈춘 세션에 넣은 말이 조용히 사라진다(409 draft 가 그걸 막는다) ·
//  노드(멤버 PC) 세션이 전부 「멈춤」으로 보여 아무 노드 세션에도 못 보낸다(격리 리뷰 차단 1).

const declared = { permissions: { tools: ["store_query", "store_insert", CHAT_SEND_TOOL] } };
const app = (id: string, over: Partial<OrgApp> = {}): OrgApp => ({
  id, title: "장표 수정", version: "1.0.0", manifest: declared, source: { kind: "builtin" }, content_hash: null,
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null, edit_mode: "all", edit_members: [],
  builtin_version: null, current_version_no: null, ...over,
});
const grant = (tools: string[] = ["store_*", CHAT_SEND_TOOL]): AppGrantRow => ({ app_id: "deck-edit", member_id: "alice", scopes: [], tools, granted_at: "", granted_by: null, revoked_at: null });
const row = (appId: string): SessionAppRow => ({ session_id: "box-a", app_id: appId, member_id: "alice", attached_at: "" });

interface World { app: OrgApp | null; grant: AppGrantRow | null; owner: string | null; attached: string[]; gone: boolean; deliverThrows?: Error; tenant?: string }
function deps(over: Partial<World> = {}): ChatSendDeps & { delivered: Array<{ sid: string; member: string; text: string }> } {
  const w: World = { app: app("deck-edit"), grant: grant(), owner: "alice", attached: ["deck-edit"], gone: false, ...over };
  const delivered: Array<{ sid: string; member: string; text: string }> = [];
  return {
    delivered,
    getApp: async () => w.app,
    getGrant: async () => w.grant,
    sessionOwner: async () => w.owner,
    listAttached: async () => w.attached.map(row),
    isGone: async () => w.gone,
    deliver: async (sid, member, text) => { if (w.deliverThrows) throw w.deliverThrows; delivered.push({ sid, member, text }); return { ok: true, queued: true, outbox_id: 7, seq: 1, transport: "outbox" }; },
    now: () => 1_000_000,
    tenant: () => w.tenant ?? "t1",
  };
}
const q = (over: Partial<{ member: string; text: string; sessionId: string }> = {}) =>
  ({ appId: "deck-edit", sessionId: over.sessionId ?? "box-a", member: over.member ?? "alice", text: over.text ?? "[장표 수정] 판 3 · 의견 2 (묶음 #1)" });
const fail = async (p: Promise<unknown>): Promise<{ status: number; message: string } | "ok"> => {
  try { await p; return "ok"; } catch (e) { const err = e as { status?: number; message?: string }; return { status: err.status ?? -1, message: err.message ?? "" }; }
};
const status = async (p: Promise<unknown>): Promise<number | "ok"> => { const r = await fail(p); return r === "ok" ? "ok" : r.status; };
const fresh = () => new RateWindow();

test("S1-1 정상 — 서버가 붙인 표식 한 줄 + 원문이 그 세션으로 배달된다", async () => {
  const d = deps();
  const r = await sendFromApp(q(), d, fresh());
  assert.deepEqual(r, { sent: true, session: "box-a", transport: "outbox" });
  assert.equal(d.delivered.length, 1);
  assert.equal(d.delivered[0].sid, "box-a");
  assert.equal(d.delivered[0].member, "alice");
  assert.equal(d.delivered[0].text, "(앱 「장표 수정」에서 보냄)\n[장표 수정] 판 3 · 의견 2 (묶음 #1)");
});

test("S1-2 앱 없음 → 404 · 꺼진 앱 → 409", async () => {
  assert.equal(await status(sendFromApp(q(), deps({ app: null }), fresh())), 404);
  assert.equal(await status(sendFromApp(q(), deps({ app: app("deck-edit", { enabled: false }) }), fresh())), 409);
});

test("S1-3 동의(grant) 없음 → 403 — 동의하지 않은 앱은 세션에 말을 못 넣는다", async () => {
  const d = deps({ grant: null });
  assert.equal(await status(sendFromApp(q(), d, fresh())), 403);
  assert.equal(d.delivered.length, 0);
});

test("S1-3b 선언 없음 — 매니페스트에 chat_send(app_chat_send)가 없으면 403 (동의가 있어도)", async () => {
  const r = await fail(sendFromApp(q(), deps({ app: app("deck-edit", { manifest: { permissions: { tools: ["store_*"] } } }) }), fresh()));
  assert.notEqual(r, "ok");
  assert.equal((r as { status: number }).status, 403);
  assert.match((r as { message: string }).message, /선언하지 않았습니다/);
});

test("S1-3c 선언은 있는데 동의가 예전 범위(grant 에 app_chat_send 없음) → 403 「다시 동의」 문구 — 호스트가 동의 창을 띄우는 신호", async () => {
  const r = await fail(sendFromApp(q(), deps({ grant: grant(["store_*"]) }), fresh()));
  assert.notEqual(r, "ok");
  assert.equal((r as { status: number }).status, 403);
  assert.match((r as { message: string }).message, /사용 동의가 예전 범위라 .*다시 동의\(grant\)/);
});

test("S1-3d 동의 범위에 글롭(app_*)으로 들어 있으면 된다", async () => {
  assert.equal(await status(sendFromApp(q(), deps({ grant: grant(["app_*"]) }), fresh())), "ok");
});

test("S1-4 세션 주인이 아님 → 403 · 모르는 세션 → 404", async () => {
  assert.equal(await status(sendFromApp(q({ member: "mallory" }), deps({ owner: "alice", grant: { ...grant(), member_id: "mallory" } }), fresh())), 403);
  assert.equal(await status(sendFromApp(q(), deps({ owner: null }), fresh())), 404);
});

test("S1-5 그 세션에 안 붙어 있음(뗐다) → 403", async () => {
  assert.equal(await status(sendFromApp(q(), deps({ attached: [] }), fresh())), 403);
  assert.equal(await status(sendFromApp(q(), deps({ attached: ["memo"] }), fresh())), 403);
});

test("S1-6 빈 글 · 공백만 → 400 · 4,001자 → 400 · 4,000자는 통과", async () => {
  assert.equal(await status(sendFromApp(q({ text: "   " }), deps(), fresh())), 400);
  assert.equal(await status(sendFromApp(q({ text: "가".repeat(4001) }), deps(), fresh())), 400);
  assert.equal(await status(sendFromApp(q({ text: "가".repeat(4000) }), deps(), fresh())), "ok");
  assert.throws(() => normalizeChatText(""), (e: { status?: number }) => e.status === 400);
});

test("S1-7 빈도 — (테넌트, 사람, 앱) 분당 20 · 21번째 429 · 60초 지나면 다시 · 다른 테넌트는 따로", async () => {
  let t = 1_000_000;
  const d = { ...deps(), now: () => t };
  const rate = fresh();
  for (let i = 0; i < 20; i++) assert.equal(await status(sendFromApp(q(), d, rate)), "ok", `${i + 1}번째`);
  assert.equal(await status(sendFromApp(q(), d, rate)), 429);
  assert.equal(await status(sendFromApp(q(), { ...deps({ tenant: "t2" }), now: () => t }, rate)), "ok", "다른 테넌트의 같은 사람·앱은 자기 창");
  t += 60_001;
  assert.equal(await status(sendFromApp(q(), d, rate)), "ok");
});

test("S1-7b 빈도 창은 키마다 따로", () => {
  const rate = new RateWindow(2, 1000);
  assert.equal(rate.take("a:x", 0), true);
  assert.equal(rate.take("a:x", 1), true);
  assert.equal(rate.take("a:x", 2), false);
  assert.equal(rate.take("b:x", 2), true);
  assert.equal(rate.take("a:x", 1002), true);   // 창 밖으로 빠진 뒤
});

test("S1-8 멈춘 세션 → 409 · body 에 draft:true 와 표식 붙은 draft_text — 호스트가 입력칸에 넣어 두라는 신호", async () => {
  const d = deps({ gone: true });
  try { await sendFromApp(q(), d, fresh()); assert.fail("던져야 한다"); }
  catch (e) {
    const err = e as { status?: number; body?: Record<string, unknown> };
    assert.equal(err.status, 409);
    assert.deepEqual(err.body, { draft: true, session: "box-a", draft_text: "(앱 「장표 수정」에서 보냄)\n[장표 수정] 판 3 · 의견 2 (묶음 #1)" });
  }
  assert.equal(d.delivered.length, 0);
});

test("S1-8b 멈춤 판정은 중앙 tmux 세션에만 — 노드(멤버 PC) 세션은 중앙에 없는 것이 정상이라 「멈춤」이 아니다", async () => {
  const calls: string[] = [];
  const gone = async () => { calls.push("gone"); return true; };            // 중앙 tmux 는 «그런 세션 없다»
  assert.equal(await localSessionGone("box-node", { remoteNode: async () => "node-7", gone }), false, "노드 세션 → 멈춤 아님");
  assert.deepEqual(calls, [], "노드 세션이면 sessionGone 을 묻지도 않는다");
  assert.equal(await localSessionGone("box-a", { remoteNode: async () => null, gone }), true, "중앙 세션 + tmux 없음 → 멈춤");
  assert.equal(await localSessionGone("box-b", { remoteNode: async () => "", gone: async () => false }), false, "중앙 세션 + 살아 있음 → 멈춤 아님");
});

test("S1-9 배달이 접근 오류를 던지면 그대로 올라간다(여기서 삼키지 않는다)", async () => {
  const boom = Object.assign(new Error("없거나 접근할 수 없는 세션입니다"), { status: 404 });
  assert.equal(await status(sendFromApp(q(), deps({ deliverThrows: boom }), fresh())), 404);
});

test("S1-10 표식은 서버가 붙인다 — 앱이 제목을 바꿔도 서버가 아는 앱 제목", () => {
  assert.equal(composeAppMessage("메모", "안녕"), "(앱 「메모」에서 보냄)\n안녕");
  assert.ok(/에서 보냄\)/.test(composeAppMessage("x", "y")), "훅이 찾는 꼴 「에서 보냄)」 이 들어 있다");
});

test("S1-11 매니페스트 permissions.chat_send:true 는 app_chat_send 도구를 함의한다(알림 → app_notify 와 같은 규약) · 기본은 false", () => {
  const base = { id: "deck-edit", title: "장표 수정", version: "1.0.0", permissions: { tools: ["store_query"], chat_send: true } };
  const m = parseAppManifest(base);
  assert.ok(m.permissions.tools.includes(CHAT_SEND_TOOL), "도구 allowlist 에 app_chat_send 가 더해진다");
  const m2 = parseAppManifest({ ...base, permissions: { tools: ["store_query"] } });
  assert.equal(m2.permissions.chat_send, false);
  assert.ok(!m2.permissions.tools.includes(CHAT_SEND_TOOL), "선언 안 하면 도구도 없다(fail-closed)");
});
