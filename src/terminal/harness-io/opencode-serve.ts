// opencode 서버 기동 (#2439) — `opencode serve` 를 세션 경계 안에서 띄우고 그 포트로 붙는다.
//
//  ── 왜 이 파일이 따로 있나 ──────────────────────────────────────────────────────
//  다른 하네스는 **프로세스를 띄우면 곧 파이프**다(stdin/stdout). opencode 는 한 단계가 더 있다:
//  서버를 띄우고 → **포트가 열리기를 기다리고** → HTTP 로 붙는다. 그 비대칭이 `chat-adapters` 의
//  `argv` 축에 안 맞아(argv 만으로는 «포트를 어떻게 아느냐» 를 답 못 한다) 여기로 뺐다.
//
//  ── 포트를 어떻게 정하나 ────────────────────────────────────────────────────────
//  `--port 0`(임의 포트)을 쓰면 **우리가 그 번호를 모른다** — stdout 을 파싱해야 하는데 그건 형식
//  변화에 부서진다. 그래서 codex 가 이미 쓰는 **세션 id 파생 포트**(sessionPort)를 그대로 쓴다:
//  같은 세션은 늘 같은 포트라 재접속이 쉽고, 세션끼리 안 겹치며, 파싱이 없다.
//
//  ── 경계 ────────────────────────────────────────────────────────────────────────
//  · 프로세스는 **세션 실행 경계 안에서** 뜬다(claude·codex 와 같은 사다리).
//  · `--hostname 127.0.0.1` — 그 컨테이너 밖으로 포트를 열지 않는다. 테넌트 네트워크에 열면
//    같은 테넌트의 다른 멤버가 남의 opencode 를 조종할 수 있다(codex app-server 가 같은 판단을 했다).
import { spawn } from "node:child_process";
import { logger } from "../../log.js";
import { sessionPort, waitPort } from "./codex-app-server-daemon.js";
import { sessionSpawnArgv } from "../session-exec.js";
import { memberSpawnArgv } from "../terminal-member-fs.js";

/** 이 세션의 opencode 서버가 쓸 포트 — 세션 id 에서 결정론적으로 나온다(파싱 없음). */
export function opencodeServePort(sessionId: string): number {
  //  ⚠ codex 와 **다른 슬롯**(nth=1)을 쓴다. 한 세션이 두 하네스를 동시에 쓸 일은 없지만,
  //   같은 번호를 쓰면 전환 직후 «앞 하네스의 죽어가는 서버» 에 붙을 수 있다.
  return sessionPort(sessionId, 1);
}

/** (순수 — 테스트 seam) `opencode serve` 를 띄울 argv. */
export function opencodeServeArgv(port: number): string[] {
  //  ⚠ `--hostname 127.0.0.1` 은 **보안 경계**다(머리말). 기본값에 기대지 않고 명시한다.
  return ["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"];
}

/** 이 세션의 서버 주소들 — 읽기(SSE)와 쓰기(POST)의 **주소가 다르다**(chat-transport 머리말). */
export function opencodeUrls(port: number): { base: string; event: string } {
  const base = `http://127.0.0.1:${port}`;
  return { base, event: `${base}/event` };
}

/**
 * 서버를 **보장**한다 — 이미 떠 있으면 그대로, 없으면 띄우고 포트가 열릴 때까지 기다린다.
 *
 *  ⚠ 실패를 «떴다» 로 접지 않는다: 포트가 안 열리면 null 을 돌려주고 호출자가 폴백을 정한다.
 *   여기서 던지면 그 세션은 대화창도 터미널도 아닌 상태로 남는다.
 */
export async function ensureOpencodeServe(o: {
  sessionId: string;
  cwd: string;
  osUser: string | null;
  waitMs?: number;
  spawnFn?: (argv: string[], cwd: string) => { unref?: () => void };
  waitPortFn?: (port: number, ms: number) => Promise<boolean>;
}): Promise<{ port: number; started: boolean } | null> {
  const port = opencodeServePort(o.sessionId);
  const wait = o.waitPortFn ?? ((p, ms) => waitPort(p, ms));

  //  이미 살아 있으면 다시 띄우지 않는다 — 두 서버가 같은 포트를 다투면 둘 다 못 쓴다.
  if (await wait(port, 300)) return { port, started: false };

  const inner = opencodeServeArgv(port);
  const bySession = sessionSpawnArgv(o.sessionId, inner);
  const argv = bySession.length ? bySession : (o.osUser ? memberSpawnArgv(o.osUser, inner) : inner);

  try {
    if (o.spawnFn) o.spawnFn(argv, o.cwd);
    else {
      //  ⚠ `detached` 로 띄우고 stdio 를 버린다 — 이 서버는 **세션이 사는 동안** 살아야 하고,
      //   우리가 파이프를 붙들면 게이트웨이 재기동이 그 서버를 함께 죽인다.
      const child = spawn(argv[0], argv.slice(1), { cwd: o.cwd, detached: true, stdio: "ignore" });
      child.unref();
    }
  } catch (err) {
    logger.warn({ sessionId: o.sessionId, err: (err as Error)?.message }, "opencode serve 기동 실패");
    return null;
  }

  const ok = await wait(port, o.waitMs ?? 8000);
  if (!ok) {
    logger.warn({ sessionId: o.sessionId, port }, "opencode serve 가 시간 안에 포트를 안 열었다");
    return null;
  }
  logger.info({ sessionId: o.sessionId, port }, "opencode serve 기동");
  return { port, started: true };
}

/**
 * opencode 세션을 만든다 — **인증 없이 된다**(실측 2026-09-01: `POST /session` → `{"id":"ses_…"}`).
 *  우리 세션 id 와 **다른 id** 다. 그 짝을 런타임이 쥔다(대화를 잇는 단서라 잃으면 새 대화가 열린다).
 */
export async function opencodeNewSession(o: {
  base: string; cwd?: string; fetchFn?: typeof fetch;
}): Promise<string | null> {
  const doFetch = o.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${o.base}/session`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify(o.cwd ? { directory: o.cwd } : {}),
    });
    if (!res.ok) return null;
    const j = await res.json() as { id?: unknown };
    return typeof j?.id === "string" && j.id ? j.id : null;
  } catch { return null; }
}

/**
 * 사람 말을 보낸다 — opencode 는 **POST 로 쓴다**(SSE 는 읽기 전용).
 *  세션 id 는 opencode 쪽 것이라 호출자가 쥔다(우리 세션 id 와 다르다).
 */
export async function opencodePost(o: {
  base: string;
  opencodeSessionId: string;
  text: string;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const doFetch = o.fetchFn ?? fetch;
  try {
    //  실측 엔드포인트(1.18.25 OpenAPI): POST /session/{id}/prompt_async
    const res = await doFetch(`${o.base}/session/${encodeURIComponent(o.opencodeSessionId)}/prompt_async`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ parts: [{ type: "text", text: o.text }] }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * 승인에 답한다 — opencode 는 이 축이 **API 로 열려 있다**(실측: `/permission/{requestID}/reply`).
 *  다른 하네스는 프로토콜 왕복인데 여기선 REST 호출 한 번이다.
 */
export async function opencodeReplyPermission(o: {
  base: string;
  requestId: string;
  allow: boolean;
  always?: boolean;
  fetchFn?: typeof fetch;
}): Promise<boolean> {
  const doFetch = o.fetchFn ?? fetch;
  try {
    const res = await doFetch(`${o.base}/permission/${encodeURIComponent(o.requestId)}/reply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      //  ⚠ «항상 허용» 은 별개 축이다 — 한 번 허용과 섞으면 사람이 의도보다 넓게 열어 준다.
      body: JSON.stringify({ response: o.allow ? (o.always ? "always" : "once") : "reject" }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
