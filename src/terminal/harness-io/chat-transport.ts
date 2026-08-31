// 대화 전송 추상 (#2439) — 하네스가 «어떻게» 말을 섞는지를 런타임에서 떼어 낸다.
//
//  ── 왜 필요한가 ──────────────────────────────────────────────────────────────────
//  런타임(claude-chat-runtime)이 `spawn` + stdin/stdout 에 직접 묶여 있었다. 그러면 stdio 가 아닌
//  하네스는 **런타임을 통째로 새로 써야 한다** — opencode 는 `serve` 로 HTTP 서버를 띄우고 SSE 로 읽고
//  POST 로 쓴다(실측: 엔드포인트 162개). 그 하나를 위해 두 번째 런타임을 만들면 «답 없이 매달린 요청은
//  없다» 같은 불변식이 두 벌이 되고, 반드시 한쪽이 빠진다(이 프로젝트가 계속 마주친 실패 모양이다).
//
//  ── 세 전송 ─────────────────────────────────────────────────────────────────────
//   stdio-jsonl    한 줄 = JSON 하나. 자식 프로세스의 stdout 을 읽고 stdin 에 쓴다.  (claude · antigravity)
//   jsonrpc-stdio  같은 파이프인데 JSON-RPC 프레이밍.                                (grok ACP · codex)
//   http-sse       서버를 띄우고 `/event` 를 SSE 로 구독, 쓰기는 POST.               (opencode)
//
//  ── 계약 ────────────────────────────────────────────────────────────────────────
//  전송은 **줄만 나른다.** 그 줄이 무슨 뜻인지는 번역기(harness-io/*-stream.ts)가 안다.
//  이 경계 덕분에 새 프로토콜이 와도 전송 하나 + 번역기 하나면 되고, 런타임·버스·화면은 안 바뀐다.
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../../log.js";

/** 전송 한 개 — 열려 있는 동안 줄을 흘리고, 우리가 줄을 쓸 수 있다. */
export interface ChatTransportConn {
  /** 하네스가 낸 줄 하나(개행 제거·trim 됨). JSON 이 아닐 수도 있다(사람이 읽을 로그) — 번역기가 판단한다. */
  onLine(fn: (line: string) => void): void;
  /** 하네스에 줄을 보낸다. 못 보내면 false(호출자가 폴백을 정한다 — 여기서 던지지 않는다). */
  send(line: string): boolean;
  /** 살아 있나. */
  alive(): boolean;
  /** 닫는다. 두 번 불러도 안전해야 한다. */
  close(): void;
}

/** 줄 경계 맞추기 — 청크는 줄 가운데서 끊긴다. 전송마다 다시 짜지 않게 한 곳에 둔다. */
export function lineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let carry = "";
  return (chunk: string) => {
    const text = carry + chunk;
    const lines = text.split("\n");
    carry = lines.pop() ?? "";
    for (const raw of lines) {
      const line = raw.trim();
      if (line) onLine(line);
    }
  };
}

/**
 * 자식 프로세스 stdio 전송 — `stdio-jsonl` 과 `jsonrpc-stdio` 가 **같은 구현**을 쓴다.
 *  프레이밍 차이(줄 하나가 이벤트냐 JSON-RPC 메시지냐)는 **번역기의 관심사**이지 전송의 것이 아니다.
 */
export function stdioTransport(argv: string[], cwd: string, opts?: {
  spawnFn?: (argv: string[], cwd: string) => ChildProcess;
  onStderr?: (text: string) => void;
}): ChatTransportConn {
  const child = opts?.spawnFn
    ? opts.spawnFn(argv, cwd)
    : spawn(argv[0], argv.slice(1), { cwd, stdio: ["pipe", "pipe", "pipe"] });
  let closed = false;

  return {
    onLine(fn) {
      const feed = lineSplitter(fn);
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (c: string) => { try { feed(c); } catch { /* 그 줄만 버린다 */ } });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (c: string) => { const s = String(c).trim(); if (s) opts?.onStderr?.(s); });
      const gone = () => { closed = true; };
      child.on("exit", gone); child.on("error", gone);
    },
    send(line) {
      if (closed || !child.stdin || child.stdin.destroyed) return false;
      try { child.stdin.write(line.endsWith("\n") ? line : line + "\n"); return true; }
      catch { return false; }
    },
    alive: () => !closed,
    close() {
      if (closed) return;
      closed = true;
      try { child.stdin?.end(); } catch { /* 이미 닫힘 */ }
      try { child.kill("SIGTERM"); } catch { /* 이미 죽음 */ }
    },
  };
}

/**
 * **턴마다 프로세스** 전송 (antigravity `agy`).
 *
 *  ── 왜 이런 게 필요한가 (실측 2026-09-01, agy 1.1.22) ────────────────────────
 *  agy 는 `--input-format stream-json` 을 광고하지만 실제로는 **아직 안 된다** — 바이너리 문자열이
 *  그 사실을 말한다: `stream input message event %q is not supported yet`. 어떤 이름을 넣어도
 *  «ignoring unsupported stream input message event» 로 무시된다(user_input·user_message·user_turn 전부).
 *
 *  대신 **대화를 잇는 길이 따로 있다**: `--conversation=<id>`. 실측으로 확인했다 —
 *  턴1 `--print="say A"` → conversation_id 획득 → 턴2 `--conversation=<id> --print="what did I ask?"`
 *  → `num_turns=2` 이고 앞 질문을 기억한다.
 *
 *  즉 이 하네스는 «파이프 하나가 계속 산다» 가 아니라 **«턴마다 프로세스가 나고 죽는다»** 다.
 *  그 차이를 런타임이 알 필요는 없다 — 전송이 흡수한다(그게 이 층의 존재 이유다).
 *
 *  ⚠ 그래서 `alive()` 는 **늘 true** 다: 프로세스가 없는 게 정상 상태이지 죽은 게 아니다.
 *   여기서 false 를 내면 런타임이 매 턴 뒤 «죽었다» 며 승인을 마감하고 작업 목록을 비운다.
 */
export function perTurnTransport(o: {
  /** 이 프롬프트로 한 턴을 돌릴 argv 를 만든다(대화 id 를 아는 것은 호출자다). */
  argvFor: (text: string, convId: string) => string[];
  cwd: string;
  /** 하네스가 준 대화 id 를 기억한다 — 다음 턴이 그걸로 이어 붙는다(잃으면 새 대화가 열린다). */
  onConvId?: (id: string) => void;
  spawnFn?: (argv: string[], cwd: string) => ChildProcess;
}): ChatTransportConn & { setConvId(id: string): void; abort(): boolean } {
  let convId = "";
  let closed = false;
  let lineCb: ((line: string) => void) | null = null;
  //  ★ **지금 도는 턴의 프로세스**. 이 전송에는 «멈춤을 보낼 파이프» 가 없으므로(stdin 이 안 열린다)
  //   멈춤은 곧 그 프로세스를 끝내는 것이다. 그래서 여기서 쥐고 있어야 한다.
  let running: ChildProcess | null = null;

  return {
    onLine(fn) { lineCb = fn; },
    setConvId(id) { convId = id; },
    send(text) {
      if (closed) return false;
      const argv = o.argvFor(text, convId);
      if (!argv.length) return false;
      try {
        const child = o.spawnFn
          ? o.spawnFn(argv, o.cwd)
          : spawn(argv[0], argv.slice(1), { cwd: o.cwd, stdio: ["ignore", "pipe", "pipe"] });
        running = child;
        //  턴이 끝나면 놓는다 — 안 놓으면 다음 «멈춤» 이 이미 죽은 프로세스를 겨눈다(멈춘 척이 된다).
        const release = (): void => { if (running === child) running = null; };
        child.on("exit", release); child.on("error", release);
        const feed = lineSplitter((line) => {
          //  첫 줄(init)이 대화 id 를 준다 — 다음 턴이 그걸로 이어 붙는다.
          if (!convId && line.includes('"conversation_id"')) {
            try {
              const id = (JSON.parse(line) as { conversation_id?: unknown }).conversation_id;
              if (typeof id === "string" && id) { convId = id; o.onConvId?.(id); }
            } catch { /* 그 줄만 넘긴다 */ }
          }
          lineCb?.(line);
        });
        child.stdout?.setEncoding("utf8");
        child.stdout?.on("data", (c: string) => { try { feed(c); } catch { /* 그 줄만 버린다 */ } });
        child.stderr?.setEncoding("utf8");
        child.stderr?.on("data", () => { /* 진단은 호출자 몫 — 이벤트로 올리지 않는다 */ });
        return true;
      } catch { return false; }
    },
    //  ★ 프로세스가 없는 게 **정상**이다(턴 사이). 여기서 false 를 내면 런타임이 매 턴 뒤
    //   «죽었다» 며 승인을 마감하고 작업 목록을 비운다.
    alive: () => !closed,
    //  ★ 멈춤 = 그 턴의 프로세스를 끝낸다. 도는 턴이 없으면 **false** — 멈춘 척하지 않는다.
    abort() {
      if (!running) return false;
      try { running.kill("SIGTERM"); return true; } catch { return false; }
    },
    close() {
      closed = true;
      try { running?.kill("SIGTERM"); } catch { /* 이미 죽음 */ }
      running = null;
    },
  };
}

/**
 * HTTP + SSE 전송 (opencode `serve`).
 *
 *  ⚠ **읽기와 쓰기의 주소가 다르다** — 읽기는 `GET /event`(SSE 스트림), 쓰기는 `POST` 로 각각의
 *   엔드포인트다(`/session/{id}/prompt_async` 등). 그래서 `send` 는 «한 줄» 을 그대로 못 보낸다:
 *   호출자가 **어디로 보낼지**를 알아야 한다. 그 지식은 하네스별이므로 `postLine` 으로 주입받는다.
 *   (이 비대칭이 stdio 와 http 의 진짜 차이다 — 파이프는 한 구멍이고 HTTP 는 라우트가 여럿이다.)
 *
 *  ⚠ **말 없는 연결을 살아 있다고 착각하지 않는다.** 서버가 조용하면 그게 정상인지 죽은 건지 알 수 없다 —
 *   침묵이 길면 끊고 호출자가 다시 붙게 한다(2026-08-26 실측 사고와 같은 처방).
 */
export function sseTransport(o: {
  eventUrl: string;
  postLine: (line: string) => Promise<boolean>;
  headers?: Record<string, string>;
  silenceMs?: number;
  fetchFn?: typeof fetch;
}): ChatTransportConn {
  const ctl = new AbortController();
  let closed = false;
  let lineCb: ((line: string) => void) | null = null;
  const SILENCE = o.silenceMs ?? 40_000;
  const doFetch = o.fetchFn ?? fetch;

  async function pump(): Promise<void> {
    let wait = 1000;
    while (!closed) {
      const attempt = new AbortController();
      const onAll = () => attempt.abort();
      ctl.signal.addEventListener("abort", onAll);
      let silence: NodeJS.Timeout | null = null;
      const beat = () => { if (silence) clearTimeout(silence); silence = setTimeout(() => attempt.abort(), SILENCE); };
      try {
        const res = await doFetch(o.eventUrl, { headers: o.headers, signal: attempt.signal });
        if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
        wait = 1000;
        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const dec = new TextDecoder();
        //  SSE 는 `data: …` 프레임이다 — 그 껍질을 벗겨 **줄**만 위로 올린다(번역기는 SSE 를 모른다).
        const feed = lineSplitter((raw) => {
          if (raw.startsWith(":")) return;                       // 하트비트 주석
          const line = raw.startsWith("data:") ? raw.slice(5).trim() : raw;
          if (line) lineCb?.(line);
        });
        beat();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          beat();
          feed(dec.decode(value, { stream: true }));
        }
      } catch { /* 끊겼다 — 아래에서 다시 붙는다 */ }
      finally { if (silence) clearTimeout(silence); ctl.signal.removeEventListener("abort", onAll); }
      if (closed) break;
      await new Promise((r) => setTimeout(r, wait));
      wait = Math.min(wait * 1.6, 15_000);                       // 서버 재기동 중에 폭주하지 않게
    }
  }

  return {
    onLine(fn) { lineCb = fn; void pump(); },
    send(line) {
      if (closed) return false;
      //  ⚠ POST 는 비동기다 — 여기서 기다리면 호출자가 턴 길이만큼 매달린다. 떼어 보내고 실패는 로그로.
      void o.postLine(line).catch((err) => logger.warn({ err: (err as Error)?.message }, "SSE 전송 쓰기 실패"));
      return true;
    },
    alive: () => !closed,
    close() { if (closed) return; closed = true; try { ctl.abort(); } catch { /* noop */ } },
  };
}
