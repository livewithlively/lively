// 세션 대화창 라우트(#1719) — 새 셸(v2)의 세션 화면이 **터미널 대신 말풍선**으로 라이브 세션을 보이기 위한 두 통로.
//
//  ── 왜 ──
//  세션 화면의 가운데는 지금까지 웹터미널(xterm iframe)이었다. 리브(#1631)가 터미널을 걷어낸 이유가 여기에도 그대로
//  적용된다 — 까만 화면은 라이블리를 모르는 사람에게 무섭고, 대화의 구조(무엇을 물었고 무엇을 했나)가 안 보인다.
//  하네스들은 대화를 디스크에 **블록 단위로 즉시** append 하므로(claude jsonl · grok updates.jsonl · agy 스텝 로그 …), 그 파일을
//  오프셋부터 이어 읽으면 터미널을 안 보고도 같은 대화를 라이브로 따라갈 수 있다. 리브 turn 파일을 당겨 읽는 방식(web/liv-chat.ts
//  POLL_MS)과 같은 원리다.
//
//  ── 무엇 ──
//   GET  /api/ui/terminal/sessions/:id/transcript?from=&to=&tail=  — 이 박스의 대화 파일 창을 **공통 ChatLine ndjson** 으로. 화면이 렌더.
//   POST /api/ui/terminal/sessions/:id/keys {action}                — approve(승인·기본 선택) / deny(거부) / interrupt(중단) 한 동작.
//   글자(프롬프트)를 보내는 건 기존 POST …/prompt(#1664)를 그대로 쓴다 — 통로를 늘리지 않는다.
//
//  ── 하네스 무관(#1746) ──
//  파일이 어디 있고 어떻게 생겼고 승인이 어떤 키인지는 이 파일이 모른다 — 전부 harness-io/adapter.ts 의 어댑터가 답한다:
//   · 위치: 훅이 보고한 transcript_path(org_session_state, 세션 안에서 보고) 1급 → 소유자 뿌리 안인지 검증(locate.ts) → 없으면 규약 폴백.
//   · 모양: 어댑터 parse 가 원문을 공통 ChatLine 으로(줄 경계 정렬은 window.ts, 창 사이 파서 상태는 parse-cache.ts).
//   · 승인: 어댑터 answer 가 동작→키. 없는 하네스는 409 — 화면이 버튼을 안 그린다(SessionInfo.chat 능력 요약).
//  종전엔 이 세 축이 claude 하드코딩이라 비-Claude 세션은 404→빈 화면이었다([[session-chat-harness-parity-gap-1719]]).
//
//  ── 인가 ──
//  둘 다 **canAttach 와 동급**(입장할 수 있으면 터미널에서 직접 읽고 칠 수 있는 것과 같은 일이라 더 좁힐 이유가 없고,
//  더 넓히면 남의 대화를 읽거나 남의 AI 에게 Enter 를 치는 통로가 된다). tmux 에 없는(죽은) 세션의 기록 읽기는
//  세션 상세(GET …/sessions/:id)의 restorable 규칙과 같다 — 소유자·admin, 프로젝트 세션이면 전원(#452).
//
//  ── 안 하는 것 ──
//  · 노드(멤버 PC) 세션의 파일은 여기서 못 읽는다(파일이 그 컴퓨터에 있다) → 409 `node` 를 주고, 화면은 중앙 세션 기록
//    (v6/sessions/:uuid/log — Stop 훅이 턴마다 올린 것)으로 물러난다. 노드 릴레이 op 는 후속.
//  · 대화 id 를 **추측하지 않는다**(sessions.ts restore 원칙) — work-flag 훅이 보고한 매핑이 없으면 404.
import type express from "express";
import fsp from "node:fs/promises";
import type { LivelyUser } from "../context.js";
import { wrap, HttpError } from "../http/rest-util.js";
import { canAttach, sessionDir } from "./terminal-sessions.js";
import { getOpt } from "./tmux-exec.js";
import { resolveSessionDir } from "../sessions/session-desired.js";
import { getSessionState } from "../sessions/session-state.js";
import { findPrevTranscript } from "./terminal-transcript.js";
import { isChatKey, sendKeyToSession, type ChatKey } from "./send-keys.js";
import { nodeOfSession, nodeCanAttach } from "../node/registry.js";
import { transcriptRange } from "../sessions/transcript-range.js";
import { harnessIo, isChatAction, type ChatAction } from "./harness-io/adapter.js";
import { locateTranscript, ownerHomes } from "./harness-io/locate.js";
import { readAlignedWindow, fileReader, type AlignedWindow } from "./harness-io/window.js";
import { parseWindow } from "./harness-io/parse-cache.js";
import { toNdjson } from "./harness-io/chat-line.js";

const userOf = (req: express.Request): LivelyUser => (req.auth?.extra ?? {}) as unknown as LivelyUser;
const idOf = (u: LivelyUser): string => u.userId || u.email || "";

// 세션에 붙을 수 있나(라이브) 또는 죽었어도 그 기록을 볼 수 있나(restorable 규칙). 못 보면 throw.
async function gateRead(id: string, req: express.Request): Promise<void> {
  const u = userOf(req); const uid = idOf(u);
  if (!uid) throw new HttpError(403, "사용자 신원이 없습니다");
  const nodeId = nodeOfSession(id);
  if (nodeId) {
    const v = await nodeCanAttach(nodeId, id, uid);
    if (!v.ok) throw new HttpError(v.code === 4410 ? 404 : v.code === 4462 ? 503 : 403, v.reason);
    throw new HttpError(409, "node");   // 인가는 되지만 파일이 그 컴퓨터에 있다 — 화면이 중앙 기록으로 물러난다
  }
  if (await canAttach(id, uid)) return;
  const st = await getSessionState(id);
  const mine = !!st && (st.owner === uid || !!u.scopes?.includes("admin"));
  if (st && (mine || (st.project_id ?? 0) > 0)) return;
  throw new HttpError(403, "세션에 접근할 수 없습니다");
}

// 이 세션의 하네스 — desired-state 미러(있으면) → 라이브 tmux 옵션(@box_harness) 폴백. 둘 다 없으면 ''(모름 → 못 읽는 하네스로 다룬다, claude 로 추측하지 않는다).
async function harnessOf(id: string, stHarness: string | null | undefined): Promise<string> {
  if (stHarness) return stHarness;
  return (await getOpt(id, "@box_harness").catch(() => "")) || "";
}

// 구 화면(Enter|Escape 키 이름)도 받는다 — 하위호환. 뜻은 claude 대화상자 기준(Enter=승인, Esc=중단)이었으므로 그대로 옮긴다.
function actionOf(body: Record<string, unknown>): ChatAction | null {
  if (isChatAction(body.action)) return body.action;
  if (isChatKey(body.key)) return body.key === "Enter" ? "approve" : "interrupt";
  return null;
}

export function registerSessionChatRoutes(app: express.Express, auth: express.RequestHandler): void {
  app.get("/api/ui/terminal/sessions/:id/transcript", auth, wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(id)) throw new HttpError(400, "세션 id 형식 오류");
    await gateRead(id, req);
    const st = await getSessionState(id);
    const mapped = st?.claude_session_id || "";
    res.setHeader("Cache-Control", "no-store");
    // ?uuid= — 이 박스의 **다른 대화 파일**(맥락 압축 전 파일 — 아래 X-Prev-Session 으로 알려준 것). 같은 실행 폴더·같은 소유자 뿌리
    //  안에서만 찾으므로 남의 대화를 가리킬 수 없다(박스 인가는 위 gateRead 가 이미 했다).
    const want = String(req.query.uuid ?? "").trim();
    if (want && !/^[A-Za-z0-9._-]{1,128}$/.test(want)) throw new HttpError(400, "uuid 형식 오류");
    const harness = await harnessOf(id, st?.harness);
    const io = harnessIo(harness);
    if (!io || !io.parse) throw new HttpError(409, `${io?.label || harness || "이 하네스"} 의 대화는 아직 여기서 읽을 수 없습니다 — 터미널로 보세요.`);
    // 실행 폴더 — desired-state 미러가 있으면 그것, 없으면 tmux 옵션(라이브).
    const cwd = st?.dir || await resolveSessionDir(id, () => sessionDir(id)).catch(() => "");
    let uuid = want || mapped;
    let scanned: { convId: string; file: string; size: number } | null = null;
    if (!uuid && io.latest) {
      // 매핑(훅 보고)이 아직 없다 — 이 cwd 의 규약 폴더에서 최신 대화 파일을 찾는다(#1719: "터미널엔 보이는데 대화창이 비었다").
      //  훅이 언젠가 보고하면 mapped 가 생겨 이 스캔은 다시 안 돈다. want(?uuid=)가 있으면 정확 요청이므로 스캔하지 않는다.
      scanned = await io.latest(io.roots(ownerHomes(st?.owner || ""), st?.owner || ""), cwd).catch(() => null);
      if (scanned) uuid = scanned.convId;
    }
    if (!uuid) throw new HttpError(404, "이 세션의 대화 id 를 아직 모릅니다(첫 대화가 오가면 생깁니다).");
    //  훅이 보고한 파일 경로는 **지금 매핑된 대화**의 것이다 — 다른 uuid(?uuid=, 압축 전 파일)를 찾을 땐 규약으로만(그 경로를 주면 엉뚱한 현재 파일을 읽는다).
    const found = scanned ?? await locateTranscript(io, { cwd, convId: uuid, owner: st?.owner || "", reportedPath: uuid === mapped ? st?.transcript_path : null });
    if (!found) throw new HttpError(404, "대화 기록 파일을 찾지 못했습니다(아직 한 줄도 안 쌓였거나 이 박스가 읽을 수 없는 곳에 있습니다).");
    const q = req.query as Record<string, unknown>;
    const { start, end } = transcriptRange(found.size, q);
    // 창이 파일 머리(0)에 닿았고 그 파일이 압축으로 시작하면 이전 파일 uuid 를 함께 준다 — 화면이 [압축 전 대화 불러오기]를 낸다.
    //  (claude 의 compact_boundary 사슬 — 다른 하네스 파일엔 그 표식이 없어 null 이 돌아온다.)
    if (start === 0 && found.size > 0) {
      const prev = await findPrevTranscript(found.file);
      if (prev) res.setHeader("X-Prev-Session", prev);
    }
    const explicitTo = q.to !== undefined;
    let win: AlignedWindow = { from: start, to: start, data: Buffer.alloc(0) };
    if (end > start) {
      const fh = await fsp.open(found.file, "r");
      try { win = await readAlignedWindow(fileReader(fh), found.size, start, end, explicitTo); }
      finally { await fh.close(); }
    }
    const lines = win.data.length ? parseWindow(io.parse, `${id}|${found.file}`, win.from, win.to, win.data.toString("utf8")) : [];
    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("X-Log-Bytes", String(found.size));   // 전체 워터마크(원문 바이트) — 화면이 증분 tail 에 쓴다(v6 log 와 같은 헤더)
    res.setHeader("X-Log-From", String(win.from));      // 줄 경계에 맞춘 창 — 화면은 이 값을 그대로 다음 창의 경계로 쓴다
    res.setHeader("X-Log-To", String(win.to));
    res.setHeader("X-Session-Uuid", uuid);
    res.setHeader("X-Harness", io.key);
    res.end(toNdjson(lines));
  }));

  app.post("/api/ui/terminal/sessions/:id/keys", auth, wrap(async (req, res) => {
    const id = String(req.params.id ?? "");
    const body = (req.body ?? {}) as Record<string, unknown>;
    const action = actionOf(body);
    if (!action) throw new HttpError(400, "action 은 approve|deny|interrupt 만 허용됩니다");
    const uid = idOf(userOf(req));
    if (nodeOfSession(id)) throw new HttpError(409, "그 컴퓨터의 세션에는 아직 키를 보낼 수 없습니다 — 터미널에서 직접 눌러 주세요.");
    if (!(await canAttach(id, uid))) throw new HttpError(403, "세션에 접근할 수 없습니다");
    const st = await getSessionState(id);
    const harness = await harnessOf(id, st?.harness);
    const io = harnessIo(harness);
    if (!io?.answer) throw new HttpError(409, `${io?.label || harness || "이 하네스"} 는 아직 여기서 승인·중단을 대신 누를 수 없습니다 — 터미널에서 눌러 주세요.`);
    const key: ChatKey = io.answer(action);
    await sendKeyToSession(id, key);
    res.setHeader("Cache-Control", "no-store");
    res.json({ ok: true, action, key });
  }));
}
