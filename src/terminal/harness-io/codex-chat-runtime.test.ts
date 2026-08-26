// codex 대화 런타임 계약 (#2055 P2) — 전송을 가짜로 갈아 끼워 **수명·경계·폴백**만 본다(프로세스 없음).
//  여기서 잡는 것: 세션당 1개 · 겹친 ensure 가 서버를 두 개 안 띄운다 · 멤버 경계 argv · 실패는 값으로(폴백 신호) ·
//  resume 실패를 새 스레드로 덮지 않는다 · release 는 프로세스를 내린다(락 반납).
import assert from "node:assert/strict";
import {
  CodexChatUnavailable, codexChatStatus, dropAllCodexChats, dropSession,
  ensureCodexChat, interruptCodexChat, releaseCodexChat, sendCodexChat,
} from "./codex-chat-runtime.js";
import type { AppServerTransport } from "./codex-app-server.js";

let pass = 0;
const t = async (name: string, fn: () => Promise<void> | void): Promise<void> => {
  dropAllCodexChats();
  await fn(); pass++; console.log(`ok  ${name}`);
};

/** 서버 흉내 — initialize·thread/*·turn/* 에 즉답한다. 특정 메서드를 실패시킬 수 있다.
 *  turn/start 뒤에는 실제 서버처럼 **turn/started 알림**을 흘린다(런타임이 '도는 중'을 그걸로 안다). */
function fakeServer(o: { failOn?: string; closeOnSend?: boolean; noTurnNotify?: boolean } = {}) {
  const argvSeen: string[][] = [];
  const sentMethods: string[] = [];
  let closed = 0;
  const factory = (argv: string[]): AppServerTransport => {
    argvSeen.push(argv);
    let onLine: ((l: string) => void) | null = null;
    let onClose: ((r: string) => void) | null = null;
    return {
      send: (line) => {
        const m = JSON.parse(line);
        if (!m.method) return;
        sentMethods.push(m.method);
        if (m.id === undefined) return;                       // 알림엔 답이 없다
        if (o.failOn && m.method === o.failOn) {
          setImmediate(() => onLine?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32600, message: `${m.method} 거부` } })));
          return;
        }
        if (o.closeOnSend && m.method === "turn/start") { setImmediate(() => onClose?.("서버가 죽었다")); return; }
        const result =
          m.method === "thread/start" || m.method === "thread/resume" ? { thread: { id: m.params?.threadId ?? "T-new" } } :
          m.method === "turn/start" ? { turn: { id: "TU1" } } : {};
        setImmediate(() => {
          onLine?.(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
          if (m.method === "turn/start" && !o.noTurnNotify) onLine?.(JSON.stringify({ jsonrpc: "2.0", method: "turn/started", params: { threadId: "T-new", startedAtMs: 1 } }));
        });
      },
      onLine: (cb) => { onLine = cb; },
      onClose: (cb) => { onClose = cb; },
      close: () => { closed++; onClose?.("closed"); },
    };
  };
  return { factory, argvSeen, sentMethods, closedCount: () => closed };
}

const base = (extra: Record<string, unknown> = {}) => ({ sessionId: "s1", cwd: "/work", osUser: null, ...extra }) as any;

await t("L1 ensure 는 세션당 서버 1개 — 두 번째는 재사용이다", async () => {
  const f = fakeServer();
  const a = await ensureCodexChat(base({ transportFactory: f.factory }));
  const b = await ensureCodexChat(base({ transportFactory: f.factory }));
  assert.equal(a.reused, false);
  assert.equal(b.reused, true);
  assert.equal(f.argvSeen.length, 1, "전송(=프로세스)은 한 번만 만들어져야 한다");
  assert.equal(a.threadId, b.threadId);
});

await t("★ L2 겹친 ensure 도 서버를 두 개 띄우지 않는다(둘째가 첫째의 writer 락에 걸린다)", async () => {
  const f = fakeServer();
  const [a, b] = await Promise.all([
    ensureCodexChat(base({ transportFactory: f.factory })),
    ensureCodexChat(base({ transportFactory: f.factory })),
  ]);
  assert.equal(f.argvSeen.length, 1);
  assert.equal(a.threadId, b.threadId);
});

await t("M1 전송 seam — 주입한 전송으로 붙고, 세션당 한 번만 만든다", async () => {
  const f = fakeServer();
  await ensureCodexChat(base({ osUser: "box_yoon", transportFactory: f.factory }));
  await ensureCodexChat(base({ osUser: "box_yoon", transportFactory: f.factory }));
  assert.equal(f.argvSeen.length, 1);
});

await t("N1 핸드셰이크·스레드 순서 — initialize → initialized → thread/start", async () => {
  const f = fakeServer();
  await ensureCodexChat(base({ transportFactory: f.factory }));
  assert.deepEqual(f.sentMethods.slice(0, 3), ["initialize", "initialized", "thread/start"]);
});

await t("N2 threadId 를 주면 resume 으로 이어 연다", async () => {
  const f = fakeServer();
  const r = await ensureCodexChat(base({ threadId: "T-old", transportFactory: f.factory }));
  assert.ok(f.sentMethods.includes("thread/resume"));
  assert.ok(!f.sentMethods.includes("thread/start"));
  assert.equal(r.threadId, "T-old");
});

await t("★ N3 resume 이 거부되면(=TUI 가 쥐고 있다) 새 스레드로 덮지 않고 실패시킨다", async () => {
  const f = fakeServer({ failOn: "thread/resume" });
  await assert.rejects(
    ensureCodexChat(base({ threadId: "T-old", transportFactory: f.factory })),
    (e: unknown) => e instanceof CodexChatUnavailable && /thread\/resume 거부/.test((e as Error).message),
  );
  assert.ok(!f.sentMethods.includes("thread/start"), "새 대화를 몰래 파면 사람이 보던 대화와 달라진다");
  assert.equal(f.closedCount(), 1, "실패한 서버는 내린다(고아 프로세스 금지)");
  assert.equal(codexChatStatus("s1"), null);
});

await t("O1 send 는 준비를 겸한다 — ensure 를 따로 안 불러도 된다", async () => {
  const f = fakeServer();
  const r = await sendCodexChat(base({ text: "안녕", transportFactory: f.factory }));
  assert.equal(r.threadId, "T-new");
  assert.ok(f.sentMethods.includes("turn/start"));
});

await t("O2 빈 메시지는 보내지 않는다", async () => {
  const f = fakeServer();
  await assert.rejects(sendCodexChat(base({ text: "   ", transportFactory: f.factory })), CodexChatUnavailable);
  assert.equal(f.argvSeen.length, 0, "빈 메시지로 프로세스를 띄우지 않는다");
});

await t("★ P1 보내는 중 서버가 죽으면 폴백 신호를 던지고 런타임을 버린다(다음 호출이 새로 띄운다)", async () => {
  const f = fakeServer({ closeOnSend: true });
  await assert.rejects(
    sendCodexChat(base({ text: "안녕", transportFactory: f.factory })),
    (e: unknown) => e instanceof CodexChatUnavailable && /서버가 죽었다/.test((e as Error).message),
  );
  assert.equal(codexChatStatus("s1"), null, "죽은 런타임은 남지 않는다");
  const f2 = fakeServer();
  await sendCodexChat(base({ text: "다시", transportFactory: f2.factory }));
  assert.equal(f2.argvSeen.length, 1, "다음 호출은 새로 띄운다");
});

await t("★ O3 도는 중에 온 말은 새 턴이 아니라 **얹는다**(turn/steer) — 두 턴이 겹치지 않게", async () => {
  const f = fakeServer();
  await sendCodexChat(base({ text: "먼저 이걸", transportFactory: f.factory }));
  await new Promise((r) => setImmediate(r));                 // turn/started 알림이 도착할 틈
  const r = await sendCodexChat(base({ text: "아, 그거 말고 이거요", transportFactory: f.factory }));
  assert.equal(r.steered, true, "화면이 '하던 작업에 얹었어요'로 말할 수 있어야 한다");
  assert.equal(f.sentMethods.filter((m) => m === "turn/start").length, 1, "새 턴을 또 열지 않는다");
  assert.ok(f.sentMethods.includes("turn/steer"));
});

await t("O4 턴이 끝난 뒤에 온 말은 새 턴이다(얹을 턴이 없다)", async () => {
  const f = fakeServer({ noTurnNotify: true });              // turn/started 가 안 오면 '도는 중'이 아니다
  await sendCodexChat(base({ text: "하나", transportFactory: f.factory }));
  const r = await sendCodexChat(base({ text: "둘", transportFactory: f.factory }));
  assert.equal(r.steered, undefined);
  assert.equal(f.sentMethods.filter((m) => m === "turn/start").length, 2);
  assert.ok(!f.sentMethods.includes("turn/steer"));
});

await t("★ O5 steer 를 못 쓰는 판이면 실패를 삼키지 않고 새 턴으로 보낸다(말이 사라지지 않는다)", async () => {
  const f = fakeServer({ failOn: "turn/steer" });
  await sendCodexChat(base({ text: "먼저", transportFactory: f.factory }));
  await new Promise((r) => setImmediate(r));
  const r = await sendCodexChat(base({ text: "덧붙임", transportFactory: f.factory }));
  assert.equal(r.steered, undefined);
  assert.equal(f.sentMethods.filter((m) => m === "turn/start").length, 2, "얹지 못했으면 새 턴으로라도 전한다");
});

await t("★ Q1 release 는 프로세스를 내려 스레드를 TUI 에 넘긴다 — 그 id 를 돌려준다", async () => {
  const f = fakeServer();
  await ensureCodexChat(base({ transportFactory: f.factory }));
  const r = releaseCodexChat("s1");
  assert.equal(r?.threadId, "T-new");
  assert.equal(f.closedCount(), 1, "unsubscribe 로는 락이 안 풀린다 — 프로세스를 내려야 한다");
  assert.equal(codexChatStatus("s1"), null);
  assert.equal(releaseCodexChat("s1"), null, "두 번 놓아도 안 터진다");
});

await t("Q2 interrupt 는 런타임이 없으면 조용히 false(호출자가 종전 Esc 경로로 간다)", async () => {
  assert.equal(await interruptCodexChat("없는세션"), false);
  const f = fakeServer();
  await ensureCodexChat(base({ transportFactory: f.factory }));
  assert.equal(await interruptCodexChat("s1"), true);
  assert.ok(f.sentMethods.includes("turn/interrupt"));
});

await t("Q3 세션이 끝나면 런타임도 내려간다(고아 프로세스 방지)", async () => {
  const f = fakeServer();
  await ensureCodexChat(base({ transportFactory: f.factory }));
  dropSession("s1");
  assert.equal(f.closedCount(), 1);
  assert.equal(codexChatStatus("s1"), null);
});

dropAllCodexChats();
console.log(`\n${pass} passed`);
