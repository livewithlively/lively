import { strict as assert } from "node:assert";
import test from "node:test";
import { RateWindow, composeAppMessage, normalizeChatText, sendFromApp, type ChatSendDeps } from "./app-chat-send.js";
import type { OrgApp, AppGrantRow } from "../org/store/apps.js";
import type { SessionAppRow } from "./session-apps.js";

// ── 앱 화면 → 붙은 세션으로 글 보내기 (#4594) ─────────────────────────────────────────
//  사양 표 S1 — 행마다 하나씩. 이게 틀리면: 동의 없는 앱이 세션에 말을 넣는다 · 남의 세션에 넣는다 · 뗀 앱이 계속 넣는다 ·
//  앱 코드가 세션을 메시지로 메운다 · 멈춘 세션에 넣은 말이 조용히 사라진다(409 draft 가 그걸 막는다).

const app = (id: string, over: Partial<OrgApp> = {}): OrgApp => ({
  id, title: "장표 수정", version: "1.0.0", manifest: {}, source: { kind: "builtin" }, content_hash: null,
  status: "active", enabled: true, installed_by: null, installed_at: "", updated_at: "", updated_by: null, edit_mode: "all", edit_members: [], ...over,
});
const grant: AppGrantRow = { app_id: "deck-edit", member_id: "alice", scopes: [], tools: ["store_*"], granted_at: "", granted_by: null, revoked_at: null };
const row = (appId: string): SessionAppRow => ({ session_id: "box-a", app_id: appId, member_id: "alice", attached_at: "" });

interface World { app: OrgApp | null; grant: AppGrantRow | null; owner: string | null; attached: string[]; gone: boolean; deliverThrows?: Error }
function deps(over: Partial<World> = {}): ChatSendDeps & { delivered: Array<{ sid: string; member: string; text: string }> } {
  const w: World = { app: app("deck-edit"), grant, owner: "alice", attached: ["deck-edit"], gone: false, ...over };
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
  };
}
const q = (over: Partial<{ member: string; text: string; sessionId: string }> = {}) =>
  ({ appId: "deck-edit", sessionId: over.sessionId ?? "box-a", member: over.member ?? "alice", text: over.text ?? "[장표 수정] 판 3 · 의견 2 (묶음 #1)" });
const status = async (p: Promise<unknown>): Promise<number | "ok"> => {
  try { await p; return "ok"; } catch (e) { return (e as { status?: number }).status ?? -1; }
};
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

test("S1-4 세션 주인이 아님 → 403 · 모르는 세션 → 404", async () => {
  assert.equal(await status(sendFromApp(q({ member: "mallory" }), deps({ owner: "alice", grant: { ...grant, member_id: "mallory" } }), fresh())), 403);
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

test("S1-7 빈도 — (사람, 앱) 분당 20 · 21번째 429 · 60초 지나면 다시 된다", async () => {
  let t = 1_000_000;
  const d = { ...deps(), now: () => t };
  const rate = fresh();
  for (let i = 0; i < 20; i++) assert.equal(await status(sendFromApp(q(), d, rate)), "ok", `${i + 1}번째`);
  assert.equal(await status(sendFromApp(q(), d, rate)), 429);
  t += 60_001;
  assert.equal(await status(sendFromApp(q(), d, rate)), "ok");
});

test("S1-7b 빈도 창은 키마다 따로 — 다른 사람·다른 앱은 영향 없다", () => {
  const rate = new RateWindow(2, 1000);
  assert.equal(rate.take("a:x", 0), true);
  assert.equal(rate.take("a:x", 1), true);
  assert.equal(rate.take("a:x", 2), false);
  assert.equal(rate.take("b:x", 2), true);
  assert.equal(rate.take("a:x", 1002), true);   // 창 밖으로 빠진 뒤
});

test("S1-8 멈춘 세션 → 409 이고 body 에 draft:true — 호스트가 입력칸에 넣어 두라는 신호", async () => {
  const d = deps({ gone: true });
  try { await sendFromApp(q(), d, fresh()); assert.fail("던져야 한다"); }
  catch (e) {
    const err = e as { status?: number; body?: Record<string, unknown> };
    assert.equal(err.status, 409);
    assert.deepEqual(err.body, { draft: true, session: "box-a" });
  }
  assert.equal(d.delivered.length, 0);
});

test("S1-9 배달이 접근 오류를 던지면 그대로 올라간다(여기서 삼키지 않는다)", async () => {
  const boom = Object.assign(new Error("없거나 접근할 수 없는 세션입니다"), { status: 404 });
  assert.equal(await status(sendFromApp(q(), deps({ deliverThrows: boom }), fresh())), 404);
});

test("S1-10 표식은 서버가 붙인다 — 앱이 제목을 바꿔도 서버가 아는 앱 제목", () => {
  assert.equal(composeAppMessage("메모", "안녕"), "(앱 「메모」에서 보냄)\n안녕");
  assert.ok(/에서 보냄\)/.test(composeAppMessage("x", "y")), "훅이 찾는 꼴 「에서 보냄)」 이 들어 있다");
});
