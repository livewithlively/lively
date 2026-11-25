// FtpSession 사양 검증 — 테스트 안에 띄운 가짜 FTP 서버(127.0.0.1)로 로그인·LIST·RETR·쓰기 명령(SIZE·STOR·MKD·DELE·RMD·RNFR/RNTO)·경로 거부·타임아웃·QUIT 을 본다.
// 가짜 서버는 받은 명령을 원본 바이트로 기록하고, PASV 응답에는 일부러 엉뚱한 주소(10,9,9,9)를 넣는다.
// 실행: npm run build && node dist/net/ftp/ftp-client.test.js
import assert from "node:assert/strict";
import net from "node:net";
import { Readable } from "node:stream";
import { FtpSession, FtpError } from "./ftp-client.js";

let pass = 0;
const failed: string[] = [];
const t = (name: string, fn: () => Promise<void> | void): Promise<void> =>
  Promise.resolve().then(fn).then(
    () => { pass++; console.log(`ok  ${name}`); },
    (e) => { failed.push(name); console.log(`FAIL ${name}\n     ${String(e?.message ?? e).split("\n").join("\n     ")}`); },
  );

const EUCKR_MUNSEO = Buffer.from([0xb9, 0xae, 0xbc, 0xad]); // "문서" in EUC-KR
const DIR_RAW = Buffer.concat([Buffer.from("/"), EUCKR_MUNSEO]); // 원본 바이트 폴더 경로
const LIST_BODY = Buffer.concat([
  Buffer.from("-rw-r--r--    1 1000     1000           10 Jan 05  2024 "), EUCKR_MUNSEO, Buffer.from(".txt\r\n"),
  Buffer.from("drwxr-xr-x    2 1000     1000         4096 Jan 05  2024 sub\r\n"),
]);
const FILE_RAW = Buffer.concat([DIR_RAW, Buffer.from("/"), EUCKR_MUNSEO, Buffer.from(".bin")]);
const FILE_BYTES = Buffer.from(Array.from({ length: 70_000 }, (_, i) => (i * 7) % 256));

interface ServerOpts {
  silentAfterGreeting?: boolean; listFinal?: string; slowDataMs?: number; stallFirstListMs?: number; closeDataBeforeRetrReply?: boolean;
  storPrelim?: string; // STOR 수락 응답 코드(기본 150)
  storFinal?: string; // STOR 완료 응답(기본 226)
  storDropData?: boolean; // STOR 데이터 첫 조각을 받자마자 데이터 연결을 RST 로 끊고 426
}
interface FakeServer {
  port: number;
  log: Buffer[]; // 받은 명령 원본 바이트(CRLF 제외)
  dataConns: number;
  controlClosed: Promise<void>[]; // 연결마다 닫힘 약속
  stored: Map<string, Buffer>; // 원본 경로(latin1) → 파일 바이트 — SIZE·STOR·DELE·RNFR/RNTO 가 쓰는 상태
  dirs: Set<string>; // 원본 경로(latin1) — MKD·RMD 가 쓰는 상태
  close(): Promise<void>;
}

async function startServer(opts: ServerOpts = {}): Promise<FakeServer> {
  const log: Buffer[] = [];
  const controlClosed: Promise<void>[] = [];
  const sockets = new Set<net.Socket>();
  const dataServers = new Set<net.Server>();
  // 서버 1개의 파일 상태는 연결끼리 공유한다. "/ro/" 아래는 쓰기 거절(553), "/size-error" 는 SIZE 에 501.
  const stored = new Map<string, Buffer>([[FILE_RAW.toString("latin1"), FILE_BYTES]]);
  const dirs = new Set<string>(["/", DIR_RAW.toString("latin1")]);
  const fake = { log, dataConns: 0, controlClosed, stored, dirs } as FakeServer;

  const server = net.createServer((sock) => {
    sockets.add(sock);
    controlClosed.push(new Promise((res) => sock.on("close", () => { sockets.delete(sock); res(); })));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let cwd: Buffer = Buffer.from("/");
    let dataSock: Promise<net.Socket> | null = null;
    let rnfr: string | null = null;
    const send = (s: string) => { if (!sock.destroyed) sock.write(s, "latin1"); };
    send("220-Fake FTP\r\n220 ready\r\n");

    const startsWith = (b: Buffer, p: string) => b.subarray(0, p.length).toString("latin1").toUpperCase() === p;
    const arg = (b: Buffer, verb: string) => b.subarray(verb.length + 1);
    const resolvePath = (p: Buffer) => (p[0] === 0x2f ? p : Buffer.concat([cwd, cwd.at(-1) === 0x2f ? Buffer.alloc(0) : Buffer.from("/"), p]));

    const openPasv = async () => {
      const ds = net.createServer();
      dataServers.add(ds);
      dataSock = new Promise((res) => ds.once("connection", (c) => { fake.dataConns++; c.on("error", () => {}); res(c); ds.close(); }));
      await new Promise<void>((res) => ds.listen(0, "127.0.0.1", () => res()));
      const p = (ds.address() as net.AddressInfo).port;
      send(`227 Entering Passive Mode (10,9,9,9,${p >> 8},${p & 255}).\r\n`);
    };
    const sendData = async (payload: Buffer, final: string) => {
      if (!dataSock) { send("425 Use PASV first\r\n"); return; }
      send("150 Opening BINARY mode data connection\r\n");
      const c = await dataSock;
      dataSock = null;
      if (opts.slowDataMs) {
        // 데이터를 나눠 천천히 보낸다 — 그동안 제어 연결엔 아무 바이트도 오지 않는다
        const parts = 8;
        const size = Math.ceil(payload.length / parts);
        for (let k = 0; k < parts; k++) {
          if (c.destroyed) return;
          c.write(payload.subarray(k * size, (k + 1) * size));
          await new Promise((r) => setTimeout(r, opts.slowDataMs! / parts));
        }
        if (c.destroyed) return;
        await new Promise<void>((res) => c.end(() => res()));
      } else {
        await new Promise<void>((res) => c.end(payload, () => res()));
      }
      send(`${final}\r\n`);
    };

    let stalled = false;
    const handle = async (cmd: Buffer) => {
      log.push(cmd);
      if (opts.silentAfterGreeting) return;
      if (startsWith(cmd, "USER ")) send("331 Please specify the password.\r\n");
      else if (startsWith(cmd, "PASS ")) {
        if (arg(cmd, "PASS").toString() === "good") send("230-Welcome\r\n230-Second line\r\n230 Login successful.\r\n");
        else send("530 Login incorrect.\r\n");
      } else if (startsWith(cmd, "OPTS ")) send("501 Option not understood.\r\n");
      else if (startsWith(cmd, "TYPE ")) send("200 Switching to Binary mode.\r\n");
      else if (startsWith(cmd, "CWD ")) {
        const p = resolvePath(arg(cmd, "CWD"));
        if (p.equals(DIR_RAW) || p.equals(Buffer.from("/"))) { cwd = p; send("250 Directory successfully changed.\r\n"); }
        else send("550 Failed to change directory.\r\n");
      } else if (startsWith(cmd, "PASV")) await openPasv();
      else if (startsWith(cmd, "LIST") && opts.stallFirstListMs && !stalled) {
        // 전송을 시작(150)해 놓고 데이터를 보내지 않다가, 한참 뒤 실패 응답을 늦게 보낸다
        stalled = true;
        send("150 Here comes the directory listing.\r\n");
        const c = await dataSock!;
        dataSock = null;
        await new Promise((r) => setTimeout(r, opts.stallFirstListMs));
        c.destroy();
        send("426 Failure writing network stream.\r\n");
      }
      else if (startsWith(cmd, "LIST")) await sendData(LIST_BODY, opts.listFinal ?? "226 Directory send OK.");
      else if (startsWith(cmd, "RETR ") && opts.closeDataBeforeRetrReply) {
        // 응답(150)을 보내기 전에 데이터 연결을 RST 로 끊는다 — 클라이언트는 RETR 응답을 기다리는 중에 error·close 를 받는다
        const c = await dataSock!;
        dataSock = null;
        c.resetAndDestroy();
        await new Promise((r) => setTimeout(r, 100));
        send("150 Opening BINARY mode data connection\r\n");
      }
      else if (startsWith(cmd, "RETR ")) {
        if (resolvePath(arg(cmd, "RETR")).equals(FILE_RAW)) await sendData(FILE_BYTES, "226 Transfer complete.");
        else send("550 Failed to open file.\r\n");
      } else if (startsWith(cmd, "SIZE ")) {
        const p = resolvePath(arg(cmd, "SIZE")).toString("latin1");
        const f = stored.get(p);
        if (p === "/size-error") send("501 Bad SIZE argument.\r\n");
        else send(f ? `213 ${f.length}\r\n` : "550 Could not get file size.\r\n");
      } else if (startsWith(cmd, "STOR ")) {
        const p = resolvePath(arg(cmd, "STOR")).toString("latin1");
        if (!dataSock) { send("425 Use PASV first\r\n"); return; }
        if (p.startsWith("/ro/")) { send("553 Could not create file.\r\n"); return; }
        send(`${opts.storPrelim ?? "150"} Ok to send data.\r\n`);
        const c = await dataSock;
        dataSock = null;
        if (opts.storDropData) {
          await new Promise((r) => c.once("data", r));
          c.resetAndDestroy();
          send("426 Failure reading network stream.\r\n");
          return;
        }
        const chunks: Buffer[] = [];
        await new Promise<void>((res) => { c.on("data", (d: Buffer) => chunks.push(d)); c.on("end", () => res()); c.on("close", () => res()); });
        stored.set(p, Buffer.concat(chunks));
        send(`${opts.storFinal ?? "226 Transfer complete."}\r\n`);
      } else if (startsWith(cmd, "MKD ")) {
        const p = resolvePath(arg(cmd, "MKD")).toString("latin1");
        if (dirs.has(p) || stored.has(p)) send("550 Create directory operation failed.\r\n");
        else { dirs.add(p); send(`257 "${p}" created\r\n`); }
      } else if (startsWith(cmd, "DELE ")) {
        const p = resolvePath(arg(cmd, "DELE")).toString("latin1");
        if (stored.delete(p)) send("250 Delete operation successful.\r\n");
        else send("550 Delete operation failed.\r\n");
      } else if (startsWith(cmd, "RMD ")) {
        const p = resolvePath(arg(cmd, "RMD")).toString("latin1");
        if (p !== "/" && dirs.delete(p)) send("250 Remove directory operation successful.\r\n");
        else send("550 Remove directory operation failed.\r\n");
      } else if (startsWith(cmd, "RNFR ")) {
        const p = resolvePath(arg(cmd, "RNFR")).toString("latin1");
        if (stored.has(p) || dirs.has(p)) { rnfr = p; send("350 Ready for RNTO.\r\n"); }
        else { rnfr = null; send("550 RNFR command failed.\r\n"); }
      } else if (startsWith(cmd, "RNTO ")) {
        const p = resolvePath(arg(cmd, "RNTO")).toString("latin1");
        const from = rnfr;
        rnfr = null;
        if (from === null) send("503 RNFR required first.\r\n");
        else if (p.startsWith("/ro/")) send("553 Rename failed.\r\n");
        else {
          if (stored.has(from)) { stored.set(p, stored.get(from)!); stored.delete(from); }
          else { dirs.delete(from); dirs.add(p); }
          send("250 Rename successful.\r\n");
        }
      } else if (startsWith(cmd, "QUIT")) { send("221 Goodbye.\r\n"); sock.end(); }
      else send("500 Unknown command.\r\n");
    };

    let chain = Promise.resolve();
    sock.on("data", (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const cmd = buf.subarray(0, i);
        buf = buf.subarray(i + 2);
        chain = chain.then(() => handle(cmd));
      }
    });
  });
  await new Promise<void>((res) => server.listen(0, "127.0.0.1", () => res()));
  fake.port = (server.address() as net.AddressInfo).port;
  fake.close = async () => {
    for (const s of sockets) s.destroy();
    for (const ds of dataServers) ds.close();
    await new Promise<void>((res) => server.close(() => res()));
  };
  return fake;
}

const cmds = (s: FakeServer) => s.log.map((b) => b.toString("latin1"));
const within = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`timeout: ${what}`)), ms).unref())]);
const connectTo = (s: FakeServer, password = "good", timeoutMs = 3_000) =>
  FtpSession.connect({ host: "127.0.0.1", port: s.port, user: "u1", password, timeoutMs });
const latin1 = (b: Buffer) => b.toString("latin1");

// 어느 단계가 걸려도 프로세스가 끝나게 하는 감시(정상 종료 시엔 unref 라 영향 없음)
setTimeout(() => { console.error("watchdog: test hung"); process.exit(2); }, 30_000).unref();

const srv = await startServer();

await t("connect: 여러 줄 220·230 을 한 응답으로, USER→PASS→OPTS UTF8 ON(실패 무시)→TYPE I", async () => {
  const before = srv.log.length;
  const s = await connectTo(srv);
  assert.deepEqual(cmds(srv).slice(before), ["USER u1", "PASS good", "OPTS UTF8 ON", "TYPE I"]);
  await s.close();
});

await t("connect: 로그인 거절(530)이면 FtpError 로 거부하고 연결을 닫는다", async () => {
  const conns = srv.controlClosed.length;
  await assert.rejects(connectTo(srv, "bad"), FtpError);
  assert.equal(srv.controlClosed.length, conns + 1);
  await within(srv.controlClosed[conns], 2_000, "control connection close after 530");
});

await t("list: CWD(원본 바이트)→PASV→LIST, 데이터는 제어 연결 호스트로, 본문은 latin1 문자열", async () => {
  const s = await connectTo(srv);
  const before = srv.log.length;
  const dataBefore = srv.dataConns;
  const body = await s.list(latin1(DIR_RAW));
  assert.equal(body, latin1(LIST_BODY));
  const sent = srv.log.slice(before);
  assert.deepEqual(sent.map((b) => b.subarray(0, 4).toString("latin1").toUpperCase()), ["CWD ", "PASV", "LIST"]);
  assert.ok(sent[0].equals(Buffer.concat([Buffer.from("CWD "), DIR_RAW])), `CWD bytes ${sent[0].toString("hex")}`);
  // PASV 응답 주소는 10.9.9.9 였다 — 127.0.0.1 의 데이터 서버로 붙었어야 성공한다
  assert.equal(srv.dataConns, dataBefore + 1);
  await s.close();
});

await t("list: CWD 실패(550)·226 대신 다른 종료 응답이면 실패", async () => {
  {
    const s = await connectTo(srv);
    await assert.rejects(s.list("/no-such-dir"));
    await s.close();
  }
  {
    const bad = await startServer({ listFinal: "451 Transfer aborted." });
    const s = await connectTo(bad);
    await assert.rejects(within(s.list(latin1(DIR_RAW)), 4_000, "list with 451"));
    await within(s.close(), 2_000, "close after 451").catch(() => {});
    await bad.close();
  }
});

await t("retr: 파일 바이트 스트림과 226 까지 기다리는 done", async () => {
  const s = await connectTo(srv);
  const before = srv.log.length;
  const { stream, done } = await s.retr(latin1(FILE_RAW));
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
  await within(done, 3_000, "retr done");
  assert.ok(Buffer.concat(chunks).equals(FILE_BYTES));
  assert.ok(srv.log.slice(before).some((b) => b.subarray(0, 5).toString("latin1").toUpperCase() === "RETR "));
  await s.close();
});

await t("list/retr: CR·LF·NUL·상대경로·.. 마디는 서버에 아무 명령도 보내지 않고 FtpError", async () => {
  const s = await connectTo(srv);
  const unsafe = ["/a\r\nDELE x", "/a\nb", "/a\0b", "relative/dir", "/a/../b", "/.."];
  for (const p of unsafe) {
    const before = srv.log.length;
    await assert.rejects(s.list(p), FtpError, `list ${JSON.stringify(p)}`);
    await assert.rejects(s.retr(p), FtpError, `retr ${JSON.stringify(p)}`);
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(srv.log.length, before, `sent for ${JSON.stringify(p)}: ${cmds(srv).slice(before).join(" | ")}`);
  }
  await s.close();
});

await t("timeoutMs 안에 응답이 없으면 FtpError", async () => {
  const silent = await startServer({ silentAfterGreeting: true });
  const started = Date.now();
  await assert.rejects(within(connectTo(silent, "good", 300), 3_000, "connect timeout"), FtpError);
  assert.ok(Date.now() - started < 2_500);
  await silent.close();
});

await t("전송이 timeoutMs 보다 오래 걸려도 데이터가 흐르는 동안엔 실패하지 않는다", async () => {
  const slow = await startServer({ slowDataMs: 900 });
  try {
    const s = await FtpSession.connect({ host: "127.0.0.1", port: slow.port, user: "u1", password: "good", timeoutMs: 300 });
    const { stream, done } = await s.retr(latin1(FILE_RAW));
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    await within(done, 5_000, "slow retr");
    assert.ok(Buffer.concat(chunks).equals(FILE_BYTES));
    await s.close();
  } finally { await slow.close(); }
});

await t("받는 쪽이 스트림을 중간에 끊으면 done 이 timeoutMs 를 기다리지 않고 끝난다", async () => {
  const slow = await startServer({ slowDataMs: 2_000 });
  try {
    const s = await FtpSession.connect({ host: "127.0.0.1", port: slow.port, user: "u1", password: "good", timeoutMs: 10_000 });
    const { stream, done } = await s.retr(latin1(FILE_RAW));
    await new Promise((r) => stream.once("data", r));
    stream.destroy(new Error("client closed"));
    await within(done.then(() => "ok", () => "rejected"), 1_500, "abort settle");
    // 중도 끊김 뒤 세션은 버려진다 — 늦은 응답이 다음 명령에 섞이지 않게
    await assert.rejects(() => s.list("/"), (e: unknown) => e instanceof FtpError && e.fatal === true);
    await s.close();
  } finally { await slow.close(); }
});

await t("전송 시작(150) 뒤 데이터 단계가 실패하면 그 세션은 더 쓸 수 없다(fatal) — 응답이 밀린 채 다음 명령을 보내지 않는다", async () => {
  const st = await startServer({ stallFirstListMs: 600 });
  try {
    const s = await FtpSession.connect({ host: "127.0.0.1", port: st.port, user: "u1", password: "good", timeoutMs: 300 });
    await assert.rejects(() => s.list("/"));
    await new Promise((r) => setTimeout(r, 700)); // 서버의 늦은 426 이 도착할 시간
    await assert.rejects(() => s.list("/"), (e: unknown) => e instanceof FtpError && e.fatal === true);
    await s.close();
  } finally { await st.close(); }
});

await t("RETR 응답을 기다리는 사이 데이터 연결이 끊겨도(RST) 프로세스가 죽지 않고 done 이 fatal 로 끝난다", async () => {
  const cs = await startServer({ closeDataBeforeRetrReply: true });
  try {
    const s = await FtpSession.connect({ host: "127.0.0.1", port: cs.port, user: "u1", password: "good", timeoutMs: 10_000 });
    const { done } = await s.retr(latin1(FILE_RAW));
    const r = await within(done.then(() => "ok", (e: unknown) => (e instanceof FtpError && e.fatal ? "fatal" : "other")), 1_500, "early close settle");
    assert.equal(r, "fatal");
    await s.close();
  } finally { await cs.close(); }
});

// ---- 쓰기 명령 ----
const FILE_KEY = latin1(FILE_RAW);
const DIR_KEY = latin1(DIR_RAW);
const utf8Raw = (s: string) => Buffer.from(s, "utf8").toString("latin1");
const codeOf = (e: unknown) => Number((e as any)?.code);
const isFatal = (e: unknown) => e instanceof FtpError && e.fatal === true;
const nonFatalWithCode = (code: number) => (e: unknown) =>
  e instanceof FtpError && codeOf(e) === code && e.fatal !== true;
const bodyOf = (b: Buffer, parts = 3) => {
  const size = Math.ceil(b.length / parts);
  return Readable.from(Array.from({ length: parts }, (_, k) => b.subarray(k * size, (k + 1) * size)));
};
const writeCmds = (s: FakeServer, from: number) =>
  cmds(s).slice(from).filter((c) => !/^(PASV|TYPE )/i.test(c));

await t("size: SIZE <원본 바이트> — 213 은 바이트 수, 550 은 null, 그 밖의 코드는 code 를 단 FtpError", async () => {
  const s = await connectTo(srv);
  const before = srv.log.length;
  assert.equal(await s.size(FILE_KEY), FILE_BYTES.length);
  assert.ok(srv.log[before].equals(Buffer.concat([Buffer.from("SIZE "), FILE_RAW])), `SIZE bytes ${srv.log[before].toString("hex")}`);
  assert.equal(await s.size("/no-such.bin"), null);
  await assert.rejects(s.size("/size-error"), (e: unknown) => e instanceof FtpError && codeOf(e) === 501);
  await s.close();
});

await t("stor: 데이터 연결을 열고 STOR <원본 바이트>, body 를 전부 보내 완료 응답 뒤 올린 바이트 수를 돌려준다", async () => {
  const s = await connectTo(srv);
  const target = Buffer.concat([DIR_RAW, Buffer.from("/"), Buffer.from("올림.bin", "utf8")]);
  const before = srv.log.length;
  const dataBefore = srv.dataConns;
  const n = await within(s.stor(latin1(target), bodyOf(FILE_BYTES)), 5_000, "stor");
  assert.equal(n, FILE_BYTES.length);
  const sent = srv.log.slice(before);
  const storCmds = sent.filter((b) => b.subarray(0, 5).toString("latin1").toUpperCase() === "STOR ");
  assert.equal(storCmds.length, 1);
  assert.ok(storCmds[0].equals(Buffer.concat([Buffer.from("STOR "), target])), `STOR bytes ${storCmds[0].toString("hex")}`);
  assert.equal(srv.dataConns, dataBefore + 1);
  assert.ok(srv.stored.get(latin1(target))?.equals(FILE_BYTES), "서버가 받은 바이트");
  await s.close();
});

await t("stor: 수락 125/150·완료 226/250 이면 성공, 완료 응답이 그 밖이면 fatal FtpError 이고 세션은 더 못 쓴다", async () => {
  const cases: [string, ServerOpts, boolean][] = [
    ["125 수락", { storPrelim: "125" }, true],
    ["250 완료", { storFinal: "250 Transfer done." }, true],
    ["451 완료 실패", { storFinal: "451 Local error in processing." }, false],
  ];
  for (const [label, opts, ok] of cases) {
    const fs = await startServer(opts);
    try {
      const s = await connectTo(fs);
      const p = within(s.stor("/up.bin", bodyOf(FILE_BYTES)), 5_000, `stor ${label}`);
      if (ok) {
        assert.equal(await p, FILE_BYTES.length, label);
        assert.equal(await s.size("/up.bin"), FILE_BYTES.length, `${label}: 다음 명령`);
      } else {
        await assert.rejects(p, isFatal, label);
        await assert.rejects(() => s.size(FILE_KEY), isFatal, `${label}: 다음 명령`);
      }
      await within(s.close(), 2_000, `close ${label}`).catch(() => {});
    } finally { await fs.close(); }
  }
});

await t("stor: 전송 중 데이터 연결이 끊기면 fatal FtpError 로 끝나고 세션은 더 못 쓴다", async () => {
  const dr = await startServer({ storDropData: true });
  try {
    const s = await connectTo(dr, "good", 3_000);
    async function* slow() {
      for (let i = 0; i < 40; i++) { yield Buffer.alloc(64 * 1024, i); await new Promise((r) => setTimeout(r, 10)); }
    }
    await assert.rejects(within(s.stor("/up.bin", Readable.from(slow())), 5_000, "stor drop"), isFatal);
    await assert.rejects(() => s.size(FILE_KEY), isFatal);
    await within(s.close(), 2_000, "close after drop").catch(() => {});
  } finally { await dr.close(); }
});

await t("mkd·rename·dele·rmd: 원본 바이트 경로로 MKD·RNFR→RNTO·DELE·RMD 를 보내고 성공 응답이면 끝난다", async () => {
  const s = await connectTo(srv);
  const dir = utf8Raw("/새 폴더");
  const f1 = `${dir}/${utf8Raw("가.bin")}`;
  const f2 = `${dir}/${utf8Raw("나.bin")}`;
  const before = srv.log.length;
  await s.mkd(dir);
  assert.ok(srv.dirs.has(dir));
  await s.stor(f1, bodyOf(Buffer.from("hello"), 1));
  await s.rename(f1, f2);
  assert.ok(srv.stored.has(f2) && !srv.stored.has(f1), "이름이 바뀌었다");
  await s.dele(f2);
  assert.ok(!srv.stored.has(f2));
  await s.rmd(dir);
  assert.ok(!srv.dirs.has(dir));
  assert.deepEqual(writeCmds(srv, before), [`MKD ${dir}`, `STOR ${f1}`, `RNFR ${f1}`, `RNTO ${f2}`, `DELE ${f2}`, `RMD ${dir}`]);
  await s.close();
});

await t("쓰기 명령 실패: 기대 코드가 아니면 code 를 단 비치명 FtpError, 같은 세션의 다음 명령은 응답이 밀리지 않는다", async () => {
  const s = await connectTo(srv);
  const cases: [string, (x: FtpSession) => Promise<unknown>, number, string | null][] = [
    ["mkd 이미 있음", (x) => x.mkd(DIR_KEY), 550, null],
    ["dele 없는 파일", (x) => x.dele("/none.bin"), 550, null],
    ["rmd 없는 폴더", (x) => x.rmd("/none-dir"), 550, null],
    ["rename RNFR 거절", (x) => x.rename("/none.bin", "/x.bin"), 550, "RNTO"],
    ["rename RNTO 거절", (x) => x.rename(FILE_KEY, "/ro/x.bin"), 553, null],
    ["stor STOR 거절", (x) => x.stor("/ro/x.bin", bodyOf(Buffer.from("x"), 1)), 553, null],
  ];
  for (const [label, op, code, notSent] of cases) {
    const before = srv.log.length;
    await assert.rejects(within(op(s), 3_000, label), nonFatalWithCode(code), label);
    if (notSent) assert.ok(!cmds(srv).slice(before).some((c) => c.toUpperCase().startsWith(notSent)), `${label}: ${notSent} 를 보냈다`);
    assert.equal(await s.size(FILE_KEY), FILE_BYTES.length, `${label}: 다음 명령`);
  }
  assert.ok(srv.stored.has(FILE_KEY) && !srv.stored.has("/ro/x.bin"));
  await s.close();
});

await t("size·stor·mkd·dele·rmd·rename: 안전하지 않은 경로면 아무 명령도 보내지 않고 FtpError", async () => {
  const s = await connectTo(srv);
  const unsafe = ["/a\r\nDELE x", "/a\nb", "/a\0b", "relative/x", "/a/../b", "/.."];
  for (const p of unsafe) {
    const ops: [string, () => Promise<unknown>][] = [
      ["size", () => s.size(p)],
      ["stor", () => s.stor(p, Readable.from([]))],
      ["mkd", () => s.mkd(p)],
      ["dele", () => s.dele(p)],
      ["rmd", () => s.rmd(p)],
      ["rename from", () => s.rename(p, "/ok.bin")],
      ["rename to", () => s.rename(FILE_KEY, p)],
    ];
    for (const [label, op] of ops) {
      const before = srv.log.length;
      await assert.rejects(op, FtpError, `${label} ${JSON.stringify(p)}`);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(srv.log.length, before, `${label} ${JSON.stringify(p)} sent: ${cmds(srv).slice(before).join(" | ")}`);
    }
  }
  await s.close();
});

await t("close: QUIT 을 보내고 연결을 닫는다", async () => {
  const s = await connectTo(srv);
  const conn = srv.controlClosed.length - 1;
  const before = srv.log.length;
  await s.close();
  await within(srv.controlClosed[conn], 2_000, "control close after QUIT");
  assert.deepEqual(cmds(srv).slice(before), ["QUIT"]);
});

await srv.close();
console.log(`\n${pass} passed, ${failed.length} failed`);
if (failed.length) process.exitCode = 1;
