// 최소 FTP 클라이언트 — NAS(vsftpd) 파일명 검색·내려받기 전용(net/nas). 읽기 명령(CWD·LIST·RETR)만 쓴다.
//  쓰는 명령이 몇 개뿐이라 의존성을 더하지 않고 node:net 위에 직접 짰다.
//
//  ⚠ 평문 FTP 다. 비밀번호가 평문으로 오가므로 게이트웨이와 NAS 가 같은 사설망(VPC peering)에 있을 때만 쓴다.
//  ⚠ PASV 응답의 주소는 쓰지 않고 제어 연결의 주소로 데이터 연결을 연다. 서버가 NAT 뒤에서 다른 주소를 알려 줘도
//   엉뚱한 곳에 붙지 않게 하려는 것이고, 데이터 연결이 제어 연결과 다른 호스트로 새는 길(FTP bounce)도 막는다.
import net from "node:net";
import { Readable } from "node:stream";
import { parsePasvPort, isSafeRawPath } from "./ftp-list.js";

export interface FtpConnectOpts {
  host: string;
  port: number;
  user: string;
  password: string;
  /** 응답 하나를 기다리는 최대 시간(ms). */
  timeoutMs?: number;
}

export class FtpError extends Error {
  constructor(message: string, readonly code: number | null = null) { super(message); this.name = "FtpError"; }
}

interface Reply { code: number; text: string }

const DEFAULT_TIMEOUT = 20_000;

export class FtpSession {
  private buf = "";
  private replies: Reply[] = [];
  private waiters: Array<{ resolve: (r: Reply) => void; reject: (e: Error) => void }> = [];
  private dead: Error | null = null;

  private constructor(private readonly sock: net.Socket, private readonly host: string, private readonly timeoutMs: number) {
    sock.on("data", (chunk: Buffer) => this.onData(chunk.toString("latin1")));
    sock.on("error", (e) => this.fail(e));
    sock.on("close", () => this.fail(new FtpError("FTP 제어 연결이 닫혔습니다")));
    sock.setTimeout(timeoutMs, () => { this.fail(new FtpError("FTP 서버 응답 시간 초과")); sock.destroy(); });
  }

  static async connect(o: FtpConnectOpts): Promise<FtpSession> {
    const timeoutMs = o.timeoutMs ?? DEFAULT_TIMEOUT;
    const sock = net.connect({ host: o.host, port: o.port });
    const s = new FtpSession(sock, o.host, timeoutMs);
    try {
      await s.expect([220]);
      const u = await s.cmd(`USER ${o.user}`);
      if (u.code === 331) await s.cmdExpect(`PASS ${o.password}`, [230], "로그인 실패(아이디·비밀번호 확인)");
      else if (u.code !== 230) throw new FtpError(`로그인 실패: ${u.code} ${u.text}`, u.code);
      await s.cmd("OPTS UTF8 ON"); // 거절돼도 바이트 그대로 받으면 되므로 결과를 보지 않는다
      await s.cmdExpect("TYPE I", [200], "전송 방식 설정 실패");
      return s;
    } catch (e) {
      sock.destroy();
      throw e;
    }
  }

  private onData(text: string): void {
    this.buf += text;
    for (;;) {
      const r = this.takeReply();
      if (!r) break;
      const w = this.waiters.shift();
      if (w) w.resolve(r); else this.replies.push(r);
    }
  }

  // 완결된 응답 하나를 버퍼에서 떼어 낸다. 여러 줄 응답은 `123-` 로 시작해 `123 ` 줄에서 끝난다(RFC 959 §4.2).
  private takeReply(): Reply | null {
    let start = 0;
    let firstCode: string | null = null;
    for (;;) {
      const nl = this.buf.indexOf("\n", start);
      if (nl < 0) return null;
      const line = this.buf.slice(start, nl).replace(/\r$/, "");
      const m = /^(\d{3})([ -])/.exec(line);
      if (firstCode === null) {
        if (!m) { start = nl + 1; continue; }
        firstCode = m[1]!;
        if (m[2] === " ") {
          this.buf = this.buf.slice(nl + 1);
          return { code: Number(firstCode), text: line.slice(4) };
        }
      } else if (m && m[1] === firstCode && m[2] === " ") {
        const text = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        return { code: Number(firstCode), text };
      }
      start = nl + 1;
    }
  }

  private fail(e: Error): void {
    if (this.dead) return;
    this.dead = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  private next(): Promise<Reply> {
    const queued = this.replies.shift();
    if (queued) return Promise.resolve(queued);
    if (this.dead) return Promise.reject(this.dead);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  private async expect(codes: number[], what = "FTP 응답 오류"): Promise<Reply> {
    const r = await this.next();
    if (!codes.includes(r.code)) throw new FtpError(`${what}: ${r.code} ${r.text}`, r.code);
    return r;
  }

  private send(line: string): void {
    if (/[\r\n\0]/.test(line)) throw new FtpError("FTP 명령에 줄바꿈·NUL 이 들어 있어 보내지 않았습니다");
    if (this.dead) throw this.dead;
    this.sock.write(Buffer.from(line + "\r\n", "latin1"));
  }

  private async cmd(line: string): Promise<Reply> {
    this.send(line);
    return this.next();
  }

  private async cmdExpect(line: string, codes: number[], what?: string): Promise<Reply> {
    this.send(line);
    return this.expect(codes, what);
  }

  private async openData(): Promise<net.Socket> {
    const r = await this.cmdExpect("PASV", [227], "수동 모드 진입 실패");
    const port = parsePasvPort(r.text);
    if (!port) throw new FtpError(`PASV 응답을 읽지 못했습니다: ${r.text}`);
    const data = net.connect({ host: this.host, port });
    data.setTimeout(this.timeoutMs, () => data.destroy(new FtpError("FTP 데이터 연결 시간 초과")));
    await new Promise<void>((resolve, reject) => {
      data.once("connect", resolve);
      data.once("error", reject);
    });
    return data;
  }

  /** 디렉토리 하나의 LIST 본문(latin1). rawDir 는 서버가 준 원본 바이트 경로다. */
  async list(rawDir: string): Promise<string> {
    if (!isSafeRawPath(rawDir)) throw new FtpError("쓸 수 없는 경로입니다");
    await this.cmdExpect(`CWD ${rawDir}`, [250], "폴더에 들어가지 못했습니다");
    const data = await this.openData();
    const chunks: Buffer[] = [];
    const done = new Promise<void>((resolve, reject) => {
      data.on("data", (c: Buffer) => chunks.push(c));
      data.once("end", resolve);
      data.once("error", reject);
    });
    done.catch(() => {}); // 명령이 먼저 실패하면 아래 catch 가 처리한다 — 처리되지 않은 거절로 프로세스를 흔들지 않게
    try {
      await this.cmdExpect("LIST", [125, 150], "목록을 받지 못했습니다");
      await done;
      await this.expect([226, 250], "목록 전송이 끝나지 않았습니다");
    } catch (e) {
      data.destroy();
      throw e;
    }
    return Buffer.concat(chunks).toString("latin1");
  }

  /**
   * 파일 하나를 스트림으로. 다 읽으면 done 이 서버의 전송 완료 응답까지 기다린다.
   *  호출자는 stream 을 소비한 뒤 done 을 기다려야 같은 세션으로 다음 명령을 보낼 수 있다.
   */
  async retr(rawPath: string): Promise<{ stream: Readable; done: Promise<void> }> {
    if (!isSafeRawPath(rawPath)) throw new FtpError("쓸 수 없는 경로입니다");
    const data = await this.openData();
    try {
      await this.cmdExpect(`RETR ${rawPath}`, [125, 150], "파일을 열지 못했습니다");
    } catch (e) {
      data.destroy();
      throw e;
    }
    const ended = new Promise<void>((resolve, reject) => {
      data.once("end", resolve);
      data.once("error", reject);
    });
    const done = ended.then(() => this.expect([226, 250], "파일 전송이 끝나지 않았습니다")).then(() => undefined);
    done.catch(() => {}); // 호출자가 stream 오류를 먼저 받아 done 을 기다리지 않을 수 있다
    return { stream: data, done };
  }

  async close(): Promise<void> {
    try {
      if (!this.dead) this.send("QUIT");
    } catch { /* 이미 닫힘 */ }
    this.sock.end();
    this.sock.destroy();
  }
}
