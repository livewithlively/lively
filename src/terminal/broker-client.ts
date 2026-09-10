// 브로커 전송 어댑터 — «이 컨테이너에서 이 argv 를 돌려 세 칸을 다오» 를 브로커 HTTP API 로 나른다 (#2600 T2 (d) d2).
//
// ── 무엇을 하나 ───────────────────────────────────────────────────────────────
// 매니지드 배포에서 코어(게이트웨이/세션 호스트)는 tmux 를 **브로커** 를 통해 세션 컨테이너 안에서 돌린다. 오늘은 자식
//  프로세스(테넌트 이미지의 tmux-relay)가 그 일을 하고, 이 모듈은 코어가 **직접** 브로커를 부르는 클라이언트다.
//  «무엇을 어디로» 는 `tmux-route.ts`(순수)가 정하고, 여기는 **전송만** 한다 — 두 엔드포인트 뿐이다:
//   · `GET  /lvly/sessions`  → 이 노드가 아는 세션 줄(observed·sessions)
//   · 도커 엔진 exec 계약 3단(브로커가 그 모양으로 답한다):
//       ① `POST /containers/<c>/exec` → `{Id}`   ② `POST /exec/<Id>/start` (101 업그레이드 → raw 스트림 프레임)
//       ③ `GET  /exec/<Id>/json` → `{Running, ExitCode}`
//
// ── 전송 둘 ───────────────────────────────────────────────────────────────────
//  · 유닉스 소켓 — 헤더도 접두도 없다. 신원이 «어느 소켓으로 들어왔나» 라서다(그 테넌트에만 bind mount).
//  · 허브 — 중앙 게이트웨이는 노드와 호스트가 다르다. 허브의 클라이언트 포트로 보내면 허브가 slug→노드를 해석해 역방향
//    연결로 내려보낸다. 경로 접두 `/t/<slug>` 와 slug 귀속 토큰(HMAC-SHA256(secret, "hub:"+slug) hex — lvly-cloud
//    brokernet.hubClientToken 과 같은 구성)이 그 계약이다.
//    세션 컨테이너 exec 3단엔 `x-lvly-session` 도 싣는다(#3708) — 허브가 slug 보다 먼저 그 세션의 라우트로 노드를 고른다.
//    안 실으면 첫 홉이 테넌트 핀 노드로 가서 그 브로커가 세션 노드로 한 번 더 전달한다(2홉).
//
// ── 규율 ───────────────────────────────────────────────────────────────────────
//  ⚠ 환경변수를 읽지 않는다 — 전송 설정은 **인자로만** 받는다(코어 규율: 토폴로지 env 는 exec-topology 하나만 읽는다.
//   구조 시험 scripts/exec-topology-single-source.test.mjs 가 그걸 지킨다). 이 파일의 시험(T10)이 소스 문자열로 다시 확인한다.
//  ⚠ 런타임 의존은 node 내장(http·crypto)뿐. 코어 다른 모듈은 tmux-route 의 **타입만** 가져온다.
//  ⚠ `execCapture` 는 **던지지 않는다** — 실패를 전부 `TmuxOutcome` 으로 접는다. 컨테이너 없음/정지(404/409)는 `gone:true`
//   (tmux-route 의 gone 규약: 병합이 그 세션을 0행으로 접는다). 그 밖의 실패는 gone 없는 code 1 — 병합이 «통째로 못 봤다»
//   로 읽어 strict 호출은 던지고 목록은 desired 폴백으로 간다(#835 «모르면 없다고 말하지 않는다»).
//  ⚠ 업그레이드 소켓을 **우리가 먼저 닫지 않는다** — FIN 이 출력 프레임보다 먼저 도착해 teardown 이 앞서는 함정(테넌트 이미지
//   session-exec-relay 머리말의 실측). 명령이 끝나면 브로커가 닫는다. 매달림은 유휴 타임아웃이 끊는다.
import http from "node:http";
import { createHmac } from "node:crypto";
import type { SessionRow, TmuxOutcome } from "./tmux-route.js";

export type BrokerTransport =
  /** 유닉스 소켓 — 헤더·접두 없음(신원 = 어느 소켓). */
  | { kind: "socket"; socketPath: string }
  /** 허브 — 헤더 `x-lvly-channel-auth` = HMAC-SHA256(secret, "hub:"+slug) hex · 경로 접두 `/t/<slug>` · 세션 컨테이너 exec 엔 `x-lvly-session`. */
  | { kind: "hub"; url: string; secret: string; slug: string };

export interface BrokerClient {
  /**
   * `GET /lvly/sessions` → `{ observed, sessions }`. SessionRow 는 tmux-route 의 것({sid, container, inside}) — 그 밖의 칸은 버린다.
   *  HTTP 비-2xx·JSON 오류·행 형식 오류는 **throw** — 목록을 못 본 것을 빈 목록으로 접지 않는다(#2616).
   */
  listSessions(): Promise<{ observed: boolean; sessions: SessionRow[] }>;
  /** 컨테이너 안에서 argv 를 돌려 세 칸을 받는다. 절대 throw 하지 않는다 — 실패는 TmuxOutcome 으로(머리말 규율). */
  execCapture(container: string, argv: string[]): Promise<TmuxOutcome>;
}

/** 허브 인증 헤더 이름 — lvly-cloud brokernet.CH_AUTH_HEADER 와 같다. */
export const HUB_AUTH_HEADER = "x-lvly-channel-auth";

/**
 * 목록 범위 헤더(#3797 T7) — lvly-cloud `sessionroute.LIST_SCOPE_HEADER` / `LIST_SCOPE_NODE` 와 **같은
 *  이름·같은 값**이어야 한다. 브로커는 `isNodeScoped(h)` 로 정확히 이 문자열만 본다: 한 글자만 달라도
 *  판정이 거짓이 되어 **조용히 클러스터 전역으로 되돌아간다**(오류가 아니라 «전부 답함» 으로 보인다).
 */
export const LIST_SCOPE_HEADER = "x-lvly-list-scope";
export const LIST_SCOPE_NODE = "node";

/**
 * 세션 지목 헤더(#3708) — lvly-cloud `brokernet.CH_SESSION_HEADER` 와 **같은 이름**이어야 한다. 허브는 이걸 보면
 *  테넌트 배치보다 **먼저** 그 세션의 라우트로 첫 홉을 고른다(#3681 ③). 이름이 한 글자만 달라도 오류가 아니라
 *  **조용히 테넌트 배치로 떨어지고**, 핀 노드의 브로커가 세션 노드로 한 번 더 전달한다(2홉).
 */
export const SESSION_HEADER = "x-lvly-session";
/** 허브가 받는 세션 id 규격 — lvly-cloud `hubsessionroute.SAFE_SESSION`(= `sessionroute.SAFE_SESSION`)과 같은 자. */
const HUB_SAFE_SESSION = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/**
 * 컨테이너 이름 → 허브에 밝힐 세션 id(순수). 세션 컨테이너가 아니거나 밝히면 안 되는 이름이면 null 이다.
 *  ★ lvly-cloud `sessionroute.parseSessionFromContainer(name, slug)` 와 **같은 규칙·같은 인자 순서**다 —
 *   두 레포가 같은 이름에서 같은 세션을 읽어야 한다.
 *  · 접두 `lvly-s-<slug>-` 로 자른다 — slug 에도 `-` 가 있어 slug 를 파싱하지 않고 접두를 대조한다.
 *  · `fs` 는 세션이 아니라 파일 op 컨테이너다. 빈 id 도 세션이 아니다.
 *  · 허브 규격 밖이면 안 싣는다 — 실어 봐야 허브가 «형식 밖» 을 찍고 배치로 떨어질 뿐이다.
 */
export function sessionOfContainer(container: string, slug: string): string | null {
  const prefix = `lvly-s-${slug}-`;
  if (!container.startsWith(prefix)) return null;
  const sid = container.slice(prefix.length);
  return sid !== "fs" && HUB_SAFE_SESSION.test(sid) ? sid : null;
}
/** 허브 클라이언트 토큰(순수) — lvly-cloud brokernet.hubClientToken 과 같은 구성. slug 에 묶여 탈취해도 그 테넌트뿐이다. */
export function hubClientToken(secret: string, slug: string): string {
  return createHmac("sha256", secret).update(`hub:${slug}`).digest("hex");
}

/**
 * 프레임 하나의 길이 상한. 도커 raw 스트림의 길이 칸은 uint32 라 잘못된 바이트가 «4GiB 를 기다려라» 로 읽힐 수 있다 —
 *  그러면 소켓이 닫힐 때까지 메모리에 쌓는다. tmux 의 한 프레임은 파이프 버퍼 크기(수십 KiB) 근처다. 넘으면 프로토콜 오류로 접는다.
 */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/**
 * 도커 비-TTY raw 스트림 디먹서(순수·증분) — 8바이트 머리(byte0 = 종류 1=stdout·2=stderr, byte4~7 = BE uint32 길이) + 페이로드.
 *  ★ 프레임 경계는 TCP 청크와 무관하다 — 머리가 3+5 로, 페이로드가 둘로 쪼개져 올 수 있다. 바이트를 누적해 **완전한 프레임만**
 *   소비한다. 페이로드는 Buffer 로 모아 끝에 한 번 utf8 로 푼다(멀티바이트 문자가 프레임 경계에 걸려도 깨지지 않는다).
 *  종류 2 만 stderr, 나머지(1 = stdout · 그 밖의 값)는 stdout — 테넌트 이미지 relay 의 디먹서와 같은 판정.
 */
export function makeDemuxer(): { feed(chunk: Buffer): void; stdout(): string; stderr(): string; error(): string | null } {
  let buf: Buffer = Buffer.alloc(0);
  const out: Buffer[] = [], err: Buffer[] = [];
  let error: string | null = null;
  return {
    feed(chunk: Buffer): void {
      if (error) return;
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        if (buf.length < 8) return;
        const len = buf.readUInt32BE(4);
        if (len > MAX_FRAME_BYTES) { error = `프레임 길이 ${len} 이 상한(${MAX_FRAME_BYTES})을 넘는다 — raw 스트림이 아니다`; buf = Buffer.alloc(0); return; }
        if (buf.length < 8 + len) return;
        (buf[0] === 2 ? err : out).push(buf.subarray(8, 8 + len));
        buf = buf.subarray(8 + len);
      }
    },
    stdout: () => Buffer.concat(out).toString("utf8"),
    stderr: () => Buffer.concat(err).toString("utf8"),
    error: () => error,
  };
}

type Wire = { base: http.RequestOptions; headers: Record<string, string>; prefix: string };

/** 전송 → 요청 밑그림(순수). 소켓은 `socketPath`·빈 헤더·빈 접두, 허브는 host/port·토큰 헤더·`/t/<slug>`. */
export function wireOf(t: BrokerTransport): Wire {
  if (t.kind === "socket") return { base: { socketPath: t.socketPath }, headers: {}, prefix: "" };
  const u = new URL(t.url);
  //  허브는 평문 http 다(내부 주소). https 는 이 모듈의 계약 밖 — 조용히 http 로 보내지 않는다.
  if (u.protocol !== "http:") throw new Error(`허브 URL 은 http 여야 한다: ${t.url}`);
  return {
    base: { host: u.hostname, port: Number(u.port) || 80 },
    headers: { [HUB_AUTH_HEADER]: hubClientToken(t.secret, t.slug) },
    prefix: `/t/${t.slug}`,
  };
}

interface Reply { status: number; body: string }

const fail = (stderr: string): TmuxOutcome => ({ code: 1, stdout: "", stderr });

export function makeBrokerClient(
  t: BrokerTransport,
  /**
   * `listScope: "node"` 면 목록 요청에만 범위 헤더를 싣는다 — 세션 호스트가 «자기 노드 것만» 보고하는
   *  근거다. 기본(미지정)은 종전 그대로(전역) — 중앙 게이트웨이가 한 바이트도 안 바뀐다.
   * ⚠ **exec 3단에는 안 싣는다.** 브로커의 exec 라우팅은 세션 축(라우트 파일)이라 범위와 무관하고,
   *  거기 실으면 «그 세션이 다른 노드에 있을 때» 를 우리가 모르게 막는다.
   */
  opts?: { timeoutMs?: number; listScope?: "node" | "cluster" },
): BrokerClient {
  const timeoutMs = opts?.timeoutMs ?? 15_000;
  const wire = wireOf(t);

  /**
   * 세션 컨테이너 exec 3단에 싣는 세션 지목(#3708) — **허브 전송에서만**, 그리고 **세 요청 전부에** 싣는다.
   *  `/exec/<id>/start`·`/json` 은 URL 에 세션이 없어 이 헤더가 허브의 유일한 단서다 — 하나라도 빠지면 그 요청만
   *  테넌트 핀 노드로 가서 그 브로커가 한 번 더 전달한다(참고 구현: lvly-cloud `session-exec-relay.cjs` 의 AUTH).
   *  소켓은 싣지 않는다 — 이 헤더를 읽는 것은 허브뿐이고 브로커는 안 읽는다.
   */
  const sessionHeadersFor = (container: string): Record<string, string> | undefined => {
    if (t.kind !== "hub") return undefined;
    const sid = sessionOfContainer(container, t.slug);
    return sid === null ? undefined : { [SESSION_HEADER]: sid };
  };

  /** 요청-응답 한 번. 비-2xx 도 resolve(호출자가 상태로 갈린다) · 전송 오류·타임아웃은 reject. */
  const call = (method: "GET" | "POST", path: string, body?: unknown, extra?: Record<string, string>): Promise<Reply> => new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const headers: Record<string, string> = { ...wire.headers, ...extra };
    if (data !== null) { headers["content-type"] = "application/json"; headers["content-length"] = String(Buffer.byteLength(data)); }
    //  agent:false — 연결을 재사용하지 않는다. 유닉스 소켓·허브 모두 요청 하나가 연결 하나다(keep-alive 소켓이 남아 서버 종료를 붙드는 일이 없다).
    const rq = http.request({ ...wire.base, agent: false, method, path: `${wire.prefix}${path}`, headers, timeout: timeoutMs }, (rs) => {
      const chunks: Buffer[] = [];
      rs.on("data", (d: Buffer) => chunks.push(d));
      rs.on("error", reject);
      rs.on("end", () => resolve({ status: rs.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    rq.on("timeout", () => rq.destroy(new Error(`브로커 응답 없음(${timeoutMs}ms): ${method} ${path}`)));
    rq.on("error", reject);
    rq.end(data ?? undefined);
  });

  /** exec-start — 101 업그레이드 뒤 raw 스트림을 끝까지 읽는다. 업그레이드가 아니면·끊기면·유휴 타임아웃이면 reject. */
  const startAndCapture = (execId: string, extra?: Record<string, string>): Promise<{ stdout: string; stderr: string }> => new Promise((resolve, reject) => {
    const data = JSON.stringify({ Detach: false, Tty: false });
    const rq = http.request({
      ...wire.base, agent: false, method: "POST", path: `${wire.prefix}/exec/${execId}/start`,
      headers: {
        ...wire.headers, ...extra, "content-type": "application/json", "content-length": String(Buffer.byteLength(data)),
        connection: "Upgrade", upgrade: "tcp",
      },
      timeout: timeoutMs,
    });
    let settled = false;
    const done = (fn: () => void): void => { if (settled) return; settled = true; fn(); };
    rq.on("upgrade", (_rs, sock, head) => {
      const demux = makeDemuxer();
      if (head.length) demux.feed(head);
      sock.on("data", (d: Buffer) => demux.feed(d));
      //  유휴 타임아웃 — 명령이 끝나면 브로커가 닫는다. 아무 바이트도 안 오는 채 timeoutMs 가 지나면 매달린 것이다.
      sock.setTimeout(timeoutMs, () => { done(() => reject(new Error(`exec 스트림 유휴 타임아웃(${timeoutMs}ms)`))); sock.destroy(); });
      sock.on("error", (e: Error) => done(() => reject(new Error(`exec 스트림 오류: ${e.message}`))));
      sock.on("close", () => done(() => {
        const err = demux.error();
        if (err) reject(new Error(err)); else resolve({ stdout: demux.stdout(), stderr: demux.stderr() });
      }));
    });
    rq.on("response", (rs) => {
      //  업그레이드 대신 보통 응답 — 브로커는 도커처럼 200 본문으로 프레임을 흘릴 수도 있지만, 이 클라이언트의 계약은 101 이다.
      const chunks: Buffer[] = [];
      rs.on("data", (d: Buffer) => chunks.push(d));
      rs.on("end", () => done(() => reject(new Error(`exec start 미업그레이드(${rs.statusCode}): ${Buffer.concat(chunks).toString("utf8").slice(0, 200)}`))));
      rs.on("error", (e: Error) => done(() => reject(e)));
    });
    rq.on("timeout", () => rq.destroy(new Error(`exec start 응답 없음(${timeoutMs}ms)`)));
    rq.on("error", (e: Error) => done(() => reject(e)));
    rq.end(data);
  });

  return {
    async listSessions() {
      const r = await call("GET", "/lvly/sessions", undefined,
        opts?.listScope === "node" ? { [LIST_SCOPE_HEADER]: LIST_SCOPE_NODE } : undefined);
      if (r.status < 200 || r.status >= 300) throw new Error(`broker sessions ${r.status}: ${r.body.slice(0, 200)}`);
      let j: unknown;
      try { j = JSON.parse(r.body); } catch (e) { throw new Error(`broker sessions 본문이 JSON 이 아니다: ${(e as Error).message}`); }
      const o = (j && typeof j === "object" ? j : {}) as { observed?: unknown; sessions?: unknown };
      if (!Array.isArray(o.sessions)) throw new Error("broker sessions 본문에 sessions 배열이 없다");
      const sessions: SessionRow[] = o.sessions.map((row: unknown, i: number) => {
        const s = (row && typeof row === "object" ? row : {}) as { sid?: unknown; container?: unknown; inside?: unknown };
        if (typeof s.sid !== "string" || typeof s.container !== "string") throw new Error(`broker sessions 행 ${i} 에 sid/container 가 없다`);
        return { sid: s.sid, container: s.container, inside: s.inside === true };
      });
      return { observed: o.observed === true, sessions };
    },

    async execCapture(container, argv) {
      const via = sessionHeadersFor(container);   // #3708 — 세 요청이 같은 값을 싣는다(허브 · 세션 컨테이너일 때만)
      // ① exec-create
      let created: Reply;
      try {
        created = await call("POST", `/containers/${encodeURIComponent(container)}/exec`,
          { AttachStdout: true, AttachStderr: true, Tty: false, Cmd: argv }, via);
      } catch (e) {
        return fail(`broker exec-create 실패: ${(e as Error).message}`);
      }
      //  404/409 = 컨테이너 없음/정지 = 그 세션 없음(tmux-route 의 gone 규약). 문구는 브로커 것(«No such container» 등)을 그대로 싣는다.
      if (created.status === 404 || created.status === 409) return { ...fail(`${created.status}: ${created.body.slice(0, 200)}`), gone: true };
      if (created.status < 200 || created.status >= 300) return fail(`broker exec-create 실패: ${created.status}: ${created.body.slice(0, 200)}`);
      let execId = "";
      try { const id = (JSON.parse(created.body) as { Id?: unknown }).Id; if (typeof id === "string" && id) execId = id; } catch { /* 아래에서 실패로 접는다 */ }
      if (!execId) return fail(`broker exec-create 실패: exec id 없음: ${created.body.slice(0, 200)}`);

      // ② exec-start (101 → raw 스트림)
      let captured: { stdout: string; stderr: string };
      try { captured = await startAndCapture(execId, via); }
      catch (e) { return fail(`broker exec-start 실패: ${(e as Error).message}`); }

      // ③ exec-inspect → 종료코드
      try {
        const r = await call("GET", `/exec/${execId}/json`, undefined, via);
        if (r.status < 200 || r.status >= 300) return { code: 1, stdout: captured.stdout, stderr: `${captured.stderr}${captured.stderr && !captured.stderr.endsWith("\n") ? "\n" : ""}broker exec-inspect 실패: ${r.status}: ${r.body.slice(0, 200)}` };
        const j = JSON.parse(r.body) as { Running?: unknown; ExitCode?: unknown };
        const code = typeof j.ExitCode === "number" ? j.ExitCode : 1;
        return { code, stdout: captured.stdout, stderr: captured.stderr };
      } catch (e) {
        return { code: 1, stdout: captured.stdout, stderr: `${captured.stderr}${captured.stderr && !captured.stderr.endsWith("\n") ? "\n" : ""}broker exec-inspect 실패: ${(e as Error).message}` };
      }
    },
  };
}
