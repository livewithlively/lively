// 전송 추상 계약 (#2439) — **줄만 나른다.** 그 줄의 뜻은 번역기가 안다.
//
//  이 경계가 있어야 새 프로토콜이 와도 «전송 하나 + 번역기 하나» 로 끝나고 런타임·버스·화면이 안 바뀐다.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { lineSplitter, perTurnTransport, sseTransport, stdioTransport } from "./chat-transport.js";

let pass = 0;
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve(fn()).then(() => { pass++; console.log(`ok  ${name}`); });

await t("[1] ★ 줄 자르기 — 청크가 줄 가운데서 끊겨도 안 잃는다(전송마다 다시 짜지 않게 한 곳에)", () => {
  const got: string[] = [];
  const feed = lineSplitter((l) => got.push(l));
  feed('{"a":1}\n{"b":');            // 두 번째 줄이 가운데서 끊긴다
  feed('2}\n');
  assert.deepEqual(got, ['{"a":1}', '{"b":2}']);
  //  빈 줄은 흘리지 않는다(SSE 프레임 구분자가 그대로 올라오면 번역기가 매번 걸러야 한다).
  const got2: string[] = [];
  const f2 = lineSplitter((l) => got2.push(l));
  f2("a\n\n\nb\n");
  assert.deepEqual(got2, ["a", "b"]);
});

await t("[2] stdio — 줄을 흘리고 줄을 쓴다 · 죽으면 alive=false", async () => {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  const written: string[] = [];
  child.stdin = { write: (s: string) => { written.push(s); return true; }, end: () => {}, destroyed: false };
  child.kill = () => {};
  const conn = stdioTransport(["x"], "/tmp", { spawnFn: () => child });
  const got: string[] = [];
  conn.onLine((l) => got.push(l));
  child.stdout.write('{"hi":1}\n');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got, ['{"hi":1}']);
  assert.equal(conn.send('{"say":"x"}'), true);
  assert.ok(written[0].endsWith("\n"), "개행을 붙여 보낸다(JSONL)");
  assert.equal(conn.alive(), true);
  child.emit("exit", 0, null);
  assert.equal(conn.alive(), false);
  assert.equal(conn.send("늦은 말"), false, "죽은 뒤 쓰기는 false — 던지지 않는다(호출자가 폴백을 정한다)");
});

await t("[3] stdio — close 는 멱등", () => {
  const child = new EventEmitter() as any;
  child.stdout = new PassThrough(); child.stderr = new PassThrough();
  let ends = 0, kills = 0;
  child.stdin = { write: () => true, end: () => { ends++; }, destroyed: false };
  child.kill = () => { kills++; };
  const conn = stdioTransport(["x"], "/tmp", { spawnFn: () => child });
  conn.onLine(() => {});
  conn.close(); conn.close();
  assert.equal(ends, 1); assert.equal(kills, 1);
  assert.equal(conn.alive(), false);
});

await t("[4] ★ SSE — `data:` 껍질을 벗겨 줄만 올린다(번역기는 SSE 를 모른다)", async () => {
  const frames = ['data: {"type":"permission.asked"}\n\n', ': beat\n\n', 'data: {"type":"session.idle"}\n\n'];
  let i = 0;
  const fetchFn = (async () => ({
    ok: true,
    body: { getReader: () => ({ read: async () => i < frames.length
      ? { done: false, value: new TextEncoder().encode(frames[i++]) }
      : new Promise(() => {}) }) },
  })) as unknown as typeof fetch;
  const got: string[] = [];
  const conn = sseTransport({ eventUrl: "http://x/event", postLine: async () => true, fetchFn });
  conn.onLine((l) => got.push(l));
  await new Promise((r) => setTimeout(r, 30));
  //  하트비트 주석(`: beat`)은 이벤트가 아니다 — 올리면 번역기가 매번 걸러야 한다.
  assert.deepEqual(got, ['{"type":"permission.asked"}', '{"type":"session.idle"}']);
  conn.close();
});

await t("[5] ★ SSE 쓰기는 **기다리지 않는다** — 기다리면 호출자가 턴 길이만큼 매달린다", async () => {
  let posted = "";
  let resolvePost: (v: boolean) => void = () => {};
  const conn = sseTransport({
    eventUrl: "http://x/event",
    postLine: (l) => { posted = l; return new Promise<boolean>((r) => { resolvePost = r; }); },
    fetchFn: (async () => ({ ok: false })) as unknown as typeof fetch,
  });
  conn.onLine(() => {});
  const t0 = Date.now();
  assert.equal(conn.send("hello"), true, "POST 가 아직 안 끝나도 즉시 true");
  assert.ok(Date.now() - t0 < 50, "매달리지 않는다");
  assert.equal(posted, "hello");
  resolvePost(true);
  conn.close();
});

await t("[6] SSE — close 뒤에는 쓰지 않는다", () => {
  let calls = 0;
  const conn = sseTransport({
    eventUrl: "http://x/event",
    postLine: async () => { calls++; return true; },
    fetchFn: (async () => ({ ok: false })) as unknown as typeof fetch,
  });
  conn.onLine(() => {});
  conn.close();
  assert.equal(conn.send("x"), false);
  assert.equal(calls, 0);
  assert.equal(conn.alive(), false);
});

await t("[7] ★ 턴마다 프로세스 — 대화 id 를 잡아 다음 턴에 잇는다(잃으면 새 대화가 열린다)", async () => {
  const argvSeen: string[][] = [];
  let child: any;
  const conn = perTurnTransport({
    cwd: "/tmp",
    argvFor: (text, convId) => {
      const a = ["agy", `--print=${text}`, "--output-format=stream-json"];
      if (convId) a.push(`--conversation=${convId}`);
      argvSeen.push(a);
      return a;
    },
    spawnFn: () => {
      child = new EventEmitter() as any;
      child.stdout = new PassThrough(); child.stderr = new PassThrough();
      return child;
    },
  });
  const got: string[] = [];
  conn.onLine((l) => got.push(l));

  conn.send("say A");
  child.stdout.write(JSON.stringify({ event: "init", conversation_id: "c-77", init: {} }) + "\n");
  await new Promise((r) => setImmediate(r));
  //  첫 턴엔 --conversation 이 없다(대화가 아직 없다).
  assert.ok(!argvSeen[0].some((x) => x.startsWith("--conversation")));

  conn.send("say B");
  //  ★ 둘째 턴은 잡아 둔 id 로 잇는다.
  assert.ok(argvSeen[1].includes("--conversation=c-77"), "대화를 이어 붙인다");
  assert.equal(got.length, 1, "줄은 그대로 흐른다");
});

await t("[8] ★ 턴 사이에 프로세스가 없어도 alive=true — 아니면 매 턴 뒤 «죽었다» 로 승인이 마감된다", () => {
  const conn = perTurnTransport({ cwd: "/tmp", argvFor: () => ["x"], spawnFn: () => {
    const c = new EventEmitter() as any; c.stdout = new PassThrough(); c.stderr = new PassThrough(); return c;
  } });
  conn.onLine(() => {});
  assert.equal(conn.alive(), true, "아직 아무 턴도 안 돌았는데 살아 있다");
  conn.send("한 턴");
  assert.equal(conn.alive(), true, "턴이 끝나도 살아 있다(프로세스 없음이 정상 상태)");
  conn.close();
  assert.equal(conn.alive(), false);
  assert.equal(conn.send("닫힌 뒤"), false);
});

console.log(`\n${pass}건 통과`);
