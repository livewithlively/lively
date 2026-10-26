// #5040 슬랙 개인 연결(유저 토큰)의 공개채널 수집 — 검색(search.messages) 대신 채널 기록(conversations.*)으로.
//
//  사양(셀프호스트 실측 2026-10-26에서): 라이블리 슬랙 앱(새 앱) 유저 토큰은 분할형 search:read.* 만 갖고 legacy
//   search:read 가 없어 검색 스윕이 매번 missing_scope 였다 — 다시 연결해도 같은 권한이 와서 풀리지 않았다.
//   유저 토큰은 conversations.history 로 가입하지 않은 공개 채널도 읽는다(docs.slack.dev conversations.history).
//   A  권한 → 스윕: channels:history+channels:read 면 history · 그게 없고 search:read 면 search(옛 토큰) · 모르면 history.
//   B  권한 부족 안내: search:read(새 앱이 못 받는 권한)엔 «다시 연결하면 받는다» 를 말하지 않는다 · 받을 수 있는 권한엔 말한다.
//   C  대상 채널: 공개 채널만(비공개 표시는 대상에 적혀 있어도 뺀다) · 비면 공개 채널 전부 · 이름·id·# 접두 · 제외가 이긴다.
//   D  가짜 슬랙으로 끝까지: 검색·users.conversations 를 안 부르고 공개 채널 목록(types=public_channel)에서 대상만 읽는다 ·
//      스레드 답글을 받는다(부모는 한 번) · 시스템 메시지는 뺀다 · 파일은 대상 공개 채널 공유분만 · 대상이 없으면 원인을 말한다.
//   E  결정: 권한을 몰랐던 토큰이 채널 목록에서 missing_scope 면 옛 검색으로 · 권한을 알고 고른 history 의 실패는 던진다 ·
//      옛 토큰은 채널 목록을 부르지 않는다.
//  실행: npm run build && node dist/connectors/slack-user-history.test.js  (DB·네트워크 불요 — fetch 를 가짜로 바꾼다)
import assert from "node:assert/strict";
import {
  pickUserTokenSweep, scopeHint, selectPublicChannels, historyBackfill, decideUserSweep, type SlackConversation,
} from "./slack.js";
import type { RawItem } from "./types.js";

let pass = 0;
const t = async (name: string, fn: () => void | Promise<void>): Promise<void> => { await fn(); pass++; console.log(`ok  ${name}`); };

// 새 앱 유저 토큰의 권한 — 라이블리 앱이 요청하는 유저 권한(slack-oauth.ts)과 같은 모양이고 legacy search:read 가 없다.
const NEW_APP_SCOPES = ("channels:history,groups:history,im:history,mpim:history,channels:read,emoji:read,files:read,groups:read," +
  "im:read,mpim:read,reactions:read,users:read,chat:write,search:read.public,search:read.private,search:read.mpim,search:read.im," +
  "search:read.files,search:read.users").split(",");

// ── A 권한 → 스윕 ──
await t("A1 권한을 모르면(헤더 없음) history", () => assert.equal(pickUserTokenSweep(null), "history"));
await t("A2 새 앱 토큰(분할형 search:read.* + channels:*) → history", () => assert.equal(pickUserTokenSweep(NEW_APP_SCOPES), "history"));
await t("A3 옛 클래식 토큰(search:read 만) → search", () => assert.equal(pickUserTokenSweep(["search:read", "users:read"]), "search"));
await t("A4 둘 다 있으면 history — 열거가 잘림 없이 완결하다", () =>
  assert.equal(pickUserTokenSweep(["search:read", "channels:history", "channels:read"]), "history"));
await t("A5 channels:read 없이 history + search:read → search(채널 목록을 못 읽는다)", () =>
  assert.equal(pickUserTokenSweep(["channels:history", "search:read"]), "search"));
await t("A6 둘 다 없으면 history — 다시 연결로 받을 수 있는 권한을 안내하는 쪽", () => assert.equal(pickUserTokenSweep(["users:read"]), "history"));
await t("A7 빈 헤더 → history", () => assert.equal(pickUserTokenSweep([]), "history"));

// ── B 권한 부족 안내 ──
const RECONNECT = "다시 연결하면 권한을 새로 받습니다";
await t("B1 search.messages · needed=search:read — «다시 연결하면 받는다» 를 말하지 않고 쓸 권한을 말한다", () => {
  const h = scopeHint("search.messages", "missing_scope", "search:read");
  assert.ok(!h.includes(RECONNECT), h);
  assert.match(h, /다시 연결해도 풀리지 않습니다/);
  assert.match(h, /channels:history·channels:read/);
});
await t("B2 needed 가 없어도 search.messages 면 같은 말", () => {
  const h = scopeHint("search.messages", "missing_scope");
  assert.ok(!h.includes(RECONNECT), h);
  assert.match(h, /다시 연결해도 풀리지 않습니다/);
});
await t("B3 받을 수 있는 권한(channels:history)은 다시 연결을 권하고 슬랙이 말한 그 권한을 말한다", () => {
  const h = scopeHint("conversations.history", "missing_scope", "channels:history");
  assert.ok(h.includes(RECONNECT), h);
  assert.match(h, /channels:history 권한이 필요합니다/);
});
await t("B4 needed 가 없으면 메서드 표의 권한", () =>
  assert.match(scopeHint("conversations.list", "missing_scope"), /channels:read · groups:read 권한이 필요합니다/));
await t("B5 권한 오류가 아니면 아무 말도 안 붙인다", () => assert.equal(scopeHint("conversations.history", "channel_not_found"), ""));

// ── C 대상 채널 ──
const ch = (id: string, name: string, extra: Partial<SlackConversation> = {}): SlackConversation => ({ id, name, ...extra });
const ALL: SlackConversation[] = [
  ch("C1", "1_공지"), ch("C2", "8_개발"), ch("C3", "9_대나무숲", { is_archived: true }),
  ch("G1", "임원방", { is_private: true }), ch("D1", "dm", { is_im: true }),
];
const ids = (l: SlackConversation[]): string[] => l.map((c) => c.id);
await t("C1 비공개 표시는 대상에 적혀 있어도 뺀다", () => assert.deepEqual(ids(selectPublicChannels(ALL, ["임원방", "1_공지"], [])), ["C1"]));
await t("C2 대상이 비면 공개 채널 전부(보관 포함 · DM 제외)", () => assert.deepEqual(ids(selectPublicChannels(ALL, [], [])), ["C1", "C2", "C3"]));
await t("C3 이름·id·# 접두 모두 맞는다 · 제외가 이긴다", () => {
  assert.deepEqual(ids(selectPublicChannels(ALL, ["#8_개발", "C1"], [])), ["C1", "C2"]);
  assert.deepEqual(ids(selectPublicChannels(ALL, [], ["9_대나무숲"])), ["C1", "C2"]);
});

// ── D·E 가짜 슬랙 ──
interface Call { method: string; params: URLSearchParams }
function fakeSlack(opts: { scopes?: string | null; listError?: string; channels?: SlackConversation[] }): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const json = (body: unknown, headers: Record<string, string> = {}): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });
  const fetchImpl = (async (input: string | URL | Request): Promise<Response> => {
    const u = new URL(input instanceof Request ? input.url : String(input));
    const method = u.pathname.replace(/^\/api\//, "");
    calls.push({ method, params: u.searchParams });
    switch (method) {
      case "auth.test":
        return json({ ok: true, team_id: "T1", url: "https://acme.slack.com/" },
          typeof opts.scopes === "string" ? { "x-oauth-scopes": opts.scopes } : {});
      case "users.list":
        return json({ ok: true, members: [{ id: "U1", name: "alice", profile: { display_name: "앨리스" } }] });
      case "conversations.list":
        if (opts.listError) return json({ ok: false, error: opts.listError, needed: "channels:read" });
        return json({ ok: true, channels: opts.channels ?? [] });
      case "conversations.history": {
        const c = u.searchParams.get("channel");
        if (c === "C2") {
          return json({ ok: true, messages: [{ type: "message", ts: "1790000100.000100", user: "U1", text: "배포 원인 정리",
            reply_count: 2, latest_reply: "1790000300.000100", thread_ts: "1790000100.000100" }] });
        }
        return json({ ok: true, messages: [
          { type: "message", ts: "1790000000.000100", user: "U1", text: `${c} 공지` },
          { type: "message", subtype: "channel_join", ts: "1790000001.000100", user: "U1", text: "<@U1> has joined the channel" },
        ] });
      }
      case "conversations.replies":
        return json({ ok: true, messages: [
          { type: "message", ts: "1790000100.000100", user: "U1", text: "배포 원인 정리", thread_ts: "1790000100.000100" },
          { type: "message", ts: "1790000200.000100", user: "U1", text: "답글 하나", thread_ts: "1790000100.000100" },
          { type: "message", ts: "1790000300.000100", user: "U1", text: "답글 둘", thread_ts: "1790000100.000100" },
        ] });
      case "files.list":
        return json({ ok: true, paging: { pages: 1 }, files: [
          { id: "F_PUB", name: "a.png", filetype: "png", channels: ["C1"], created: 1790000000 },
          { id: "F_PRIV", name: "b.png", filetype: "png", groups: ["G1"], created: 1790000000 },
          { id: "F_DM", name: "c.png", filetype: "png", ims: ["D1"], created: 1790000000 },
          { id: "F_OTHER", name: "d.png", filetype: "png", channels: ["C9"], created: 1790000000 },
        ] });
      default:
        return json({ ok: true });
    }
  }) as typeof fetch;
  return { calls, fetchImpl };
}
async function collect(it: AsyncIterable<RawItem>): Promise<RawItem[]> {
  const out: RawItem[] = [];
  for await (const x of it) out.push(x);
  return out;
}
async function withFetch<T>(f: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = f;
  try { return await fn(); } finally { globalThis.fetch = real; }
}
const WORKSPACE: SlackConversation[] = [ch("C1", "1_공지"), ch("C2", "8_개발"), ch("G1", "임원방", { is_private: true }), ch("C9", "random")];

await t("D1 공개채널 모드 — 검색·가입 채널 목록을 안 부르고, 공개 채널 목록에서 대상만 기록·답글·파일까지 읽는다", async () => {
  const f = fakeSlack({ scopes: NEW_APP_SCOPES.join(","), channels: WORKSPACE });
  const items = await withFetch(f.fetchImpl, async () => {
    const d = await decideUserSweep("xoxp-test");
    assert.equal(d.sweep, "history");
    if (d.sweep !== "history") return [];
    return collect(historyBackfill("xoxp-test", { channels: "1_공지 8_개발 임원방" }, undefined, "user", d));
  });
  const methods = f.calls.map((c) => c.method);
  //  배선 — 가짜 슬랙이 실제로 불렸다(안 불렸으면 아래 «부르지 않았다» 단언이 공짜로 통과한다).
  assert.ok(methods.includes("auth.test") && methods.includes("conversations.list") && methods.includes("files.list"), `배선: ${methods.join(" ")}`);
  assert.ok(!methods.includes("search.messages"), "검색을 불렀다 — 이 토큰엔 search:read 가 없다");
  assert.ok(!methods.includes("users.conversations"), "가입 채널 목록을 불렀다 — 미가입 공개 채널을 놓친다");
  assert.equal(f.calls.find((c) => c.method === "conversations.list")?.params.get("types"), "public_channel");
  assert.deepEqual(f.calls.filter((c) => c.method === "conversations.history").map((c) => c.params.get("channel")), ["C1", "C2"],
    "비공개(G1)·대상 밖(C9)을 읽었거나 대상을 빠뜨렸다");
  const ext = items.map((i) => i.provenance.external_id);
  assert.ok(ext.includes("C1:1790000000.000100") && ext.includes("C2:1790000100.000100"), `채널 메시지: ${ext.join(" ")}`);
  assert.ok(ext.includes("C2:1790000200.000100") && ext.includes("C2:1790000300.000100"), "스레드 답글이 빠졌다");
  assert.equal(ext.filter((e) => e === "C2:1790000100.000100").length, 1, "스레드 부모가 두 번 들어왔다");
  assert.ok(!ext.includes("C1:1790000001.000100"), "채널 참여 시스템 메시지가 들어왔다");
  assert.ok(ext.includes("file:F_PUB"), "대상 공개 채널 파일이 빠졌다");
  for (const bad of ["file:F_PRIV", "file:F_DM", "file:F_OTHER"]) assert.ok(!ext.includes(bad), `${bad} 가 들어왔다 — 토큰 주인의 비공개·DM 또는 대상 밖 파일`);
});

await t("D2 대상이 공개 채널에 하나도 없으면(비공개만 적음) 원인을 말하고 실패한다", async () => {
  const f = fakeSlack({ scopes: NEW_APP_SCOPES.join(","), channels: WORKSPACE });
  await withFetch(f.fetchImpl, async () => {
    const d = await decideUserSweep("xoxp-test");
    if (d.sweep !== "history") throw new Error("history 여야 한다");
    await assert.rejects(collect(historyBackfill("xoxp-test", { channels: "임원방" }, undefined, "user", d)), /공개 채널에서 찾지 못했습니다/);
  });
  assert.ok(!f.calls.some((c) => c.method === "conversations.history"), "대상이 없는데 기록을 읽었다");
});

await t("E1 권한을 모른 채(헤더 없음) 채널 목록이 missing_scope → 옛 검색 스윕", async () => {
  const f = fakeSlack({ scopes: null, listError: "missing_scope" });
  const d = await withFetch(f.fetchImpl, () => decideUserSweep("xoxp-test"));
  assert.equal(d.sweep, "search");
  assert.ok(f.calls.some((c) => c.method === "conversations.list"), "배선: 채널 목록을 먼저 시도했다");
});
await t("E2 권한을 알고 고른 history 의 목록 실패는 삼키지 않는다", async () => {
  const f = fakeSlack({ scopes: "channels:history,channels:read", listError: "missing_scope" });
  await withFetch(f.fetchImpl, () => assert.rejects(decideUserSweep("xoxp-test"), /missing_scope/));
});
await t("E3 옛 토큰(search:read 만)은 채널 목록을 부르지 않고 search", async () => {
  const f = fakeSlack({ scopes: "search:read,users:read" });
  const d = await withFetch(f.fetchImpl, () => decideUserSweep("xoxp-test"));
  assert.equal(d.sweep, "search");
  assert.ok(f.calls.some((c) => c.method === "auth.test"), "배선: 권한을 읽었다");
  assert.ok(!f.calls.some((c) => c.method === "conversations.list"));
});

console.log(`\n${pass} passed`);
