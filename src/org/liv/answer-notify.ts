// 리브의 답 알림(#4180) — 리브가 답을 마치면(또는 물음을 걸어 두면) 「확인할 것」에 «리브가 답했어요 — 답 앞부분» 을 남긴다.
//
//  ── 왜 (회의 2026-09-21) ──
//  «리브가 너무 조용하다. 리브도 내가 뭐 하면 답이 올 거잖아 — 걔도 알림 좀 띄워야 돼.» 리브는 진짜 세션이라(#4032) 답이 끝나는
//  순간은 세션 단계 전이(busy → idle · busy → waiting)로 이미 서버에 온다(terminal/routes.ts notifyPhaseChange). 그 자리에서 이 세션이
//  리브 세션인지 보고, 대화 파일 꼬리에서 마지막 assistant 글을 발췌해 알림 본문에 싣는다 — «3시간 전» 만 있는 알림이 아니라
//  무슨 답인지가 보이게.
//
//  ── 어떤 세션이 리브인가 ──
//  ① 작업 폴더 이름이 리브 폴더(LIV_SUBPATH) — 리브 부팅 훅과 같은 게이트(org/liv/session.ts 머리말). 서버가 정한 자리라 정본.
//  ② 세션 이름이 리브 세션 이름(«리브 — 대화» · 킥오프 이름) — 폴더를 모르는 경로(노드 릴레이) 의 폴백.
//  ③ 둘 다 아니고 폴더를 **모르면** 그 사람의 리브 좌표(liv_profile)와 대조 — DB 왕복이 있어 답 전이에서만, 모를 때만.
import path from "node:path";
import { logger } from "../../log.js";
import { LIV_SUBPATH } from "./folder.js";
import { LIV_CHAT_LABEL, currentLivSessionId } from "./session.js";
import { LIV_SESSION_LABEL } from "./kickoff.js";
import { notifySystem } from "../../apps/notify.js";
import type { ChatLine } from "../../terminal/harness-io/chat-line.js";

export interface PhaseChangeLike { prev: string | null; phase: string; at: number }

/** (순수) 리브가 «답한» 전이인가 — 일하다(busy) 멈춘 것(idle) 또는 물음을 걸어 둔 것(waiting). 시작(idle→busy)·하트비트는 아니다. */
export function isLivAnswerTransition(c: PhaseChangeLike | null | undefined): boolean {
  return !!c && c.prev === "busy" && (c.phase === "idle" || c.phase === "waiting");
}

/** (순수) 폴더·이름으로 리브 세션인지 판정. 모르면 false — 부르는 쪽이 좌표 대조로 넘어간다. */
export function looksLikeLivSession(f: { dir?: string | null; label?: string | null }): boolean {
  const dir = String(f.dir ?? "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (dir && path.posix.basename(dir) === LIV_SUBPATH) return true;
  const label = String(f.label ?? "").trim();
  return !!label && (label === LIV_CHAT_LABEL || label === LIV_SESSION_LABEL);
}

/** (순수) 대화 줄들에서 **마지막 assistant 글**의 발췌 — 도구 호출·생각은 건너뛰고 text 블록만 잇는다. 없으면 빈 문자열. */
export function lastAssistantExcerpt(lines: ReadonlyArray<ChatLine>, max = 200): string {
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (l.type !== "assistant" || l.isSidechain) continue;
    const text = l.message.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join(" ");
    const t = text.replace(/\s+/g, " ").trim();
    if (!t) continue;
    return t.length > max ? t.slice(0, max) + "…" : t;
  }
  return "";
}

/** (순수) 알림 문구 — 물음이면 «리브가 물어요», 답이면 «리브가 답했어요». 본문은 발췌, 없으면 리브 탭으로 안내. */
export function livAnswerText(phase: string, excerpt: string): { title: string; body: string } {
  const asking = phase === "waiting";
  return {
    title: asking ? "리브가 물어요" : "리브가 답했어요",
    body: excerpt || (asking ? "리브 탭에서 답을 골라 주세요." : "리브 탭에서 답을 볼 수 있어요."),
  };
}

/** 꼬리 창 크기 — 한 턴의 답은 이 안에 든다(도구 결과가 커도 마지막 assistant 글은 끝에 있다). */
const TAIL_BYTES = 96 * 1024;

/** 이 세션 대화 파일의 꼬리에서 마지막 assistant 글을 발췌한다. 못 읽으면 빈 문자열(노드 세션·아직 매핑 없음·못 읽는 하네스). */
async function readAnswerExcerpt(sessionId: string): Promise<string> {
  try {
    const { resolveTranscript } = await import("../../terminal/transcript-locate.js");
    const { readAlignedWindow } = await import("../../terminal/harness-io/window.js");
    const t = await resolveTranscript(sessionId);
    if (!t.ok) return "";
    const { io, tfs, found } = t;
    const start = Math.max(0, found.size - TAIL_BYTES);
    const win = await tfs.read(found.file, found.size, (r) => readAlignedWindow(r, found.size, start, found.size, true));
    if (!win.data.length) return "";
    //  창은 줄 경계에 맞춰 잘려 있다 — 어댑터 파서에 빈 상태로 넘긴다(중간부터 읽어도 한 줄이 한 이벤트라 마지막 글은 온다).
    const parsed = io.parse(win.data.toString("utf8"), {});
    return lastAssistantExcerpt(parsed.lines);
  } catch (err) {
    logger.debug({ err, session: sessionId }, "리브 답 발췌 실패(비치명 — 본문 없이 알린다)");
    return "";
  }
}

/**
 * 세션 단계 전이 한 건을 받아, 리브의 답이면 그 사람에게 알림을 남긴다. 아니면 아무 일도 하지 않는다.
 *  @returns 알림을 남겼나(억제·거부·해당 없음은 false)
 */
export async function maybeNotifyLivAnswer(o: {
  sessionId: string; owner: string; change: PhaseChangeLike;
  dir?: string | null; label?: string | null;
}): Promise<boolean> {
  if (!o.owner || !isLivAnswerTransition(o.change)) return false;
  let liv = looksLikeLivSession({ dir: o.dir, label: o.label });
  //  폴더를 모르는 경로(노드 릴레이)만 좌표 대조 — 아는데 다르면 리브가 아니다(DB 왕복을 세션마다 하지 않는다).
  if (!liv && !o.dir) liv = (await currentLivSessionId(o.owner, { heal: false }).catch(() => null)) === o.sessionId;
  if (!liv) return false;
  const excerpt = await readAnswerExcerpt(o.sessionId);
  const text = livAnswerText(o.change.phase, excerpt);
  const r = await notifySystem({
    kind: "liv", memberId: o.owner, title: text.title, body: text.body, href: "#/liv",
    //  같은 전이가 두 길(중앙 보고·노드 릴레이)로 두 번 오면 한 건 — 초 단위 시각이 열쇠.
    dedupe_key: `liv:answer:${o.sessionId}:${o.change.at}`,
  }).catch((err) => { logger.warn({ err, session: o.sessionId }, "리브 답 알림 실패(비치명)"); return null; });
  return !!r && r.ok && !("suppressed" in r);
}
