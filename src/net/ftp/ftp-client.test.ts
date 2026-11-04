// FtpSession 사양 검증 — 테스트 안에 띄운 가짜 FTP 서버(127.0.0.1)로 로그인·LIST·RETR·경로 거부·타임아웃·QUIT 을 본다.
// 가짜 서버는 받은 명령을 원본 바이트로 기록하고, PASV 응답에는 일부러 엉뚱한 주소(10,9,9,9)를 넣는다.
// 실행: npm run build && node dist/net/ftp/ftp-client.test.js
import assert from "node:assert/strict";
import net from "node:net";
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

interface ServerOpts { silentAfterGreeting?: boolean; listFinal?: string }
interface FakeServer {
  port: number;
  log: Buffer[]; // 받은 명령 원본 바이트(CRLF 제외)
  dataConns: number;
  controlClosed: Promise<void>[]; // 연결마다 닫힘 약속
  close(): Promise<void>;
}

async function startServer(opts: ServerOpts = {}): Promise<FakeServer> {
  const log: Buffer[] = [];
  const controlClosed: Promise<void>[] = [];
  const sockets = new Set<net.Socket>();
  const dataServers = new Set<net.Server>();
  const fake = { log, dataConns: 0, controlClosed } as FakeServer;

  const server = net.createServer((sock) => {
    sockets.add(sock);
    controlClosed.push(new Promise((res) => sock.on("close", () => { sockets.delete(sock); res(); })));
    sock.on("error", () => {});
    let buf = Buffer.alloc(0);
    let cwd: Buffer = Buffer.from("/");
    let dataSock: Promise<net.Socket> | null = null;
    const send = (s: string) => { if (!sock.destroyed) sock.write(s); };
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
      await new Promise<void>((res) => c.end(payload, () => res()));
      send(`${final}\r\n`);
    };

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
      else if (startsWith(cmd, "LIST")) await sendData(LIST_BODY, opts.listFinal ?? "226 Directory send OK.");
      else if (startsWith(cmd, "RETR ")) {
        if (resolvePath(arg(cmd, "RETR")).equals(FILE_RAW)) await sendData(FILE_BYTES, "226 Transfer complete.");
        else send("550 Failed to open file.\r\n");
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
