// 훅이 사람에게 묻는 길 (#2439) — «벤더가 헤드리스에서 못 묻는» 하네스를 위한 되돌아오는 문.
//
// 왜 이게 필요한가 (실측 2026-09-01, agy 1.1.22)
//   antigravity 는 헤드리스(-p)에서 승인을 **못 묻는다** — 물음이 우리 스트림으로 안 오고 그냥
//   auto-deny 된다("a tool required the … permission that headless mode cannot prompt for").
//   오래 «벤더가 막았다» 고 적어 뒀는데 **틀린 읽기**였다. 저건 금지가 아니라 «아무도 안 물었을
//   때의 기본값» 이다. 벤더 문서(바이너리 내장 「Lifecycle Hooks」)가 길을 다 적어 뒀다:
//     · PreToolUse 훅 stdin 에 `toolCall{name,args}` 가 통째로 온다 — 스트림이 비우는 내용이 훅엔 온다.
//     · 출력이 `{"decision":"allow"|"deny"|"ask"|"force_ask","reason":…}`.
//     · "Hooks run synchronously and **block the agent loop**" — 벤더가 한계로 적은 이 문장이
//       우리에겐 **기능**이다. 붙잡아 두는 동안 사람에게 물을 수 있다.
//   그래서 벤더가 못 묻는 자리를 우리가 대신 묻는다. 훅이 여기로 와서 «사람이 뭐랬어?» 를 묻고,
//   우리는 이미 있는 버스(ask())에 그대로 걸어 화면이 카드를 그리게 한 뒤, 답을 훅에 돌려준다.
//
// ★ 왜 별도의 문인가 — 다른 하네스는 자기 프로토콜 위에서 되묻는다(claude 는 control_request,
//   opencode 는 REST). antigravity 는 그 자리가 **없고** 훅만 있다. 훅은 별개 프로세스라 파이프를
//   공유하지 않으므로, 되돌아올 주소가 필요하다. 그 주소가 이 파일이다.
//
// ⚠ 경계 — **루프백에만** 붙이고 **토큰**을 요구한다. 이 문은 «사람에게 묻기» 만 할 수 있고
//   세션을 열거하거나 남의 세션에 끼어들 수 없다(요청이 세션 id 를 들고 와야 하고, 그 세션에
//   화면이 안 붙어 있으면 그냥 기본값으로 마감된다 — 즉 열어 두는 쪽으로는 절대 안 기운다).
import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { logger } from "../../log.js";
import { ask } from "./runtime-bus.js";
import type { PermissionAnswer, PermissionAsk } from "./session-event.js";

/** 답을 못 받으면 **거부** — 모르면 넓게 열지 않는다(런타임의 DENY 와 같은 값). */
const DENY: PermissionAnswer = { allow: false, scope: "once" };

/** 훅이 죽기 전에 답이 돌아와야 한다 — 하네스 훅 timeout 보다 **짧게** 잡는다(안 그러면 훅이 먼저 죽는다). */
const DEFAULT_TTL_MS = 10 * 60 * 1000;

let server: Server | null = null;
let token = "";
let port = 0;

/** 이 문의 뒤에서 실제로 묻는 함수 — 테스트가 갈아 끼운다(HTTP 는 얇은 껍데기라는 뜻). */
type AskFn = (sessionId: string, id: string, payload: PermissionAsk, ttlMs: number) => Promise<PermissionAnswer>;
const defaultAsk: AskFn = (s, id, payload, ttlMs) => ask<PermissionAnswer>(s, id, payload, DENY, ttlMs);

function readBody(req: NodeJS.ReadableStream, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve) => {
    let buf = ""; let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(buf); } };
    req.setEncoding?.("utf8");
    req.on("data", (c: string) => { buf += c; if (buf.length > limit) finish(); });
    req.on("end", finish);
    req.on("error", finish);
  });
}

/**
 * 훅이 보낸 한 건을 사람에게 묻고 답을 돌려준다.
 * ⚠ 예외를 밖으로 내지 않는다 — 훅은 **반드시** 유효한 답을 받아야 하고, 못 받으면 거부로 접는다.
 */
export async function handleAskRequest(
  body: unknown,
  deps: { ask?: AskFn } = {},
): Promise<{ status: number; body: PermissionAnswer & { ok: boolean } }> {
  const b = (body && typeof body === "object") ? body as Record<string, unknown> : {};
  const sessionId = String(b.session || "").trim();
  const id = String(b.id || "").trim();
  if (!sessionId || !id) return { status: 400, body: { ok: false, ...DENY } };

  //  ★ 훅이 준 재료를 **우리 낱말로** 옮긴다 — 하네스 낱말은 여기서 끊는다(★3).
  const payload: PermissionAsk = {
    id,
    toolName: String(b.toolName || "tool"),
    title: String(b.title || b.toolName || "확인이 필요합니다"),
    description: typeof b.why === "string" ? b.why : undefined,
    input: (b.input && typeof b.input === "object") ? b.input as Record<string, unknown> : undefined,
    questions: Array.isArray(b.questions) && b.questions.length ? b.questions as PermissionAsk["questions"] : undefined,
  };
  const ttl = Number(b.ttlMs) > 0 ? Math.min(Number(b.ttlMs), DEFAULT_TTL_MS) : DEFAULT_TTL_MS;
  try {
    const v = await (deps.ask ?? defaultAsk)(sessionId, id, payload, ttl);
    return { status: 200, body: { ok: true, ...v } };
  } catch (err) {
    logger.warn({ sessionId, id, err: (err as Error)?.message }, "훅 물음 처리 실패 — 거부로 접는다");
    return { status: 200, body: { ok: false, ...DENY } };
  }
}

/** 문을 연다(멱등). 이미 열려 있으면 그대로 쓴다 — 프로세스당 하나면 충분하다. */
function ensureServer(): void {
  if (server) return;
  token = randomBytes(24).toString("hex");
  const s = createServer((req, res) => {
    void (async () => {
      const reply = (status: number, obj: unknown): void => {
        const text = JSON.stringify(obj);
        res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
        res.end(text);
      };
      try {
        if (req.method !== "POST" || (req.url || "").split("?")[0] !== "/ask") return reply(404, { ok: false });
        //  ⚠ 토큰은 **헤더**로 받는다 — URL 에 실으면 로그·ps 에 남는다.
        if (String(req.headers["x-lively-ask"] || "") !== token) return reply(403, { ok: false, ...DENY });
        let parsed: unknown = null;
        try { parsed = JSON.parse((await readBody(req)) || "{}"); } catch { parsed = null; }
        const out = await handleAskRequest(parsed);
        reply(out.status, out.body);
      } catch {
        //  어떤 실패에서도 훅에 **유효한 답 한 번**을 준다(훅이 무효 출력을 내면 그 세션 전 툴이 fail-closed deny 된다).
        try { reply(200, { ok: false, ...DENY }); } catch { /* 연결이 이미 끊겼다 */ }
      }
    })();
  });
  //  ★ 루프백 전용. 0 = 아무 빈 포트(고정 포트를 잡으면 한 기계에서 두 게이트웨이가 못 뜬다).
  s.listen(0, "127.0.0.1", () => {
    const a = s.address();
    port = (a && typeof a === "object") ? a.port : 0;
    logger.info({ port }, "훅 물음 문을 열었다(루프백)");
  });
  if (typeof s.unref === "function") s.unref();   // 이 문이 프로세스를 붙잡지 않는다
  server = s;
}

/**
 * 하네스 자식에게 실어 보낼 env — **이게 있는 자식만** 사람에게 물을 수 있다.
 *  ⚠ 켜고 끄는 축이 파일이 아니라 env 인 이유: antigravity 훅 설정은 **전역 한 벌**이라
 *   (`~/.gemini/config/hooks.json` — 워크스페이스 `.agents/hooks.json` 은 안 뜬다, 실측)
 *   세션마다 갈아 끼울 수 없다. 그래서 «이 세션이 대화창에서 도는가» 는 자식 env 로 전한다 —
 *   터미널에서 사람이 직접 띄운 agy 에는 이 값이 없으니 종전 동작 그대로다.
 */
//  ⚠ **아직 못 잰 것** — 세션 실행 사다리(sessionSpawnArgv·memberSpawnArgv)가 중계 명령을 한 겹 두르는데,
//   그 중계가 env 를 안쪽까지 넘기는지는 배치마다 다를 수 있다. 안 넘어가면 이 값이 자식에 없어서
//   **종전 동작(중립 ask)** 으로 접힌다 — 나빠지지는 않지만 축이 안 열린다.
//   ★ 그때도 토큰을 argv 로 옮기지 마라 — `ps` 에 남는다. 중계에 env 통과를 더하는 쪽이 옳다.
export function askBridgeEnv(sessionId: string): Record<string, string> {
  ensureServer();
  if (!port) return {};   // 아직 안 붙었다 — 이번 턴은 종전 동작(다음 턴부터 붙는다)
  return {
    LIVELY_ASK_URL: `http://127.0.0.1:${port}/ask`,
    LIVELY_ASK_TOKEN: token,
    LIVELY_ASK_SESSION: sessionId,
  };
}

/** 테스트용 — 문을 닫고 상태를 비운다. */
export function closeAskBridge(): void {
  try { server?.close(); } catch { /* 이미 닫혔다 */ }
  server = null; port = 0; token = "";
}
