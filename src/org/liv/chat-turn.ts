// 리브 대화 턴 — 시작·관측이 사는 한 자리(#1631).
//
//  ── 왜 capability 밖으로 꺼냈나 ──
//  종전엔 리브 탭의 [보내기](me_liv_turn)만 턴을 띄웠다. 이제 서버도 사람 대신 턴을 띄운다 —
//   · 처음 설정이 끝난 직후의 **킥오프**(delivery/welcome.ts — 종전엔 홈 탭에 tmux 세션을 열었다)
//   · 첫 수집 뒤의 **증류 지시**(liv/second-turn-sweep.ts — 종전엔 그 tmux 세션에 프롬프트를 배달했다)
//  두 길이 각자 spawnTaskSession 을 부르면 안전선(--disallowedTools · bypassPermissions:false)이 세 벌이 되고,
//  한 벌만 낡아도 사람 앞에서 승인 없이 도는 리브가 생긴다. 그래서 스폰은 여기 하나다.
//
//  ── 숨김 턴(hidden) ──
//  서버가 띄운 턴의 지시문은 사람이 쓴 것이 아니다. 화면이 그걸 «내 말» 말풍선으로 그리면 사람은 «내가 이런 걸
//  보낸 적이 없는데» 가 된다(원준 2026-09-14). 그래서 턴 기록에 hidden·kind 를 남기고, 화면은 그 턴을
//  «리브가 워크스페이스를 맞추는 중» 으로 그린다. 지시문 원문은 턴 폴더(prompt)에만 있고 프로필엔 짧은 표식만 남는다.
//
//  ── 왜 이 길엔 승인 프롬프트가 없나 ──
//  헤드리스 task 세션(LIVELY_SESSION_KIND=task)은 이름 짓기 안내·첫 지시 프로젝트 자동 생성 훅이 건너뛰고(#1979 항목4),
//  도구 경계는 거부 목록(liv-turn.ts)이라 «Do you want to proceed?» 가 설 자리 자체가 없다. tmux 세션 킥오프에서
//  사람이 봤던 session_rename·project_rename_v6 승인 화면(2026-09-14 실측)이 여기서는 구조적으로 안 생긴다.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { LivelyUser } from "../../context.js";
import { livTurnArgs } from "../delivery/liv-turn.js";

/** 한 턴 프롬프트 상한 — **사람이 채팅창에 치는 양**이다(자료 본문은 올리기로 간다). 창구(me_liv_turn)가 잰다 —
 *  서버가 조립하는 숨김 턴의 지시문은 실측을 실어 이보다 길 수 있어 여기서 재지 않는다. */
export const LIV_TURN_MAX = 8000;
/** 턴 id 는 **우리가 만든 hex 뿐**이다. 사람이 준 값이 폴더 이름이 되면 그 자리가 곧 경로 이동이다. */
export const LIV_TURN_ID_RE = /^t[0-9a-f]{16}$/;
/** 헤드리스 턴이 도는 몇 초 동안 사이드바에 보일 이름 — 없으면 `위탁 #t…` 로 뜬다(사람 말이 아니다). */
export const LIV_CHAT_LABEL = "리브 — 대화";

export const newLivTurnId = (): string => `t${crypto.randomBytes(8).toString("hex")}`;

export type LivTurnKind = "kickoff" | "distill";

/** 이 사람의 리브 대화 폴더 안에서 그 턴의 작업 폴더. 남의 것은 구조상 가리킬 수 없다
 *  (루트가 principal 로 해석되고, 턴 id 는 화이트리스트 정규식을 통과한 hex 뿐이다). */
export async function livTurnDir(user: LivelyUser, turnId: string): Promise<string> {
  if (!LIV_TURN_ID_RE.test(turnId)) throw new Error("턴 id 형식이 아닙니다");
  const { resolveRootPath, ensureMemberOsUser } = await import("../../terminal/profiles.js");
  const osUser = await ensureMemberOsUser(user).catch(() => null);
  const { abs } = await resolveRootPath(user, "personal", "liv", osUser ?? null);
  return path.join(abs, ".lively-task", turnId);
}

export interface LivChatTurnOpts {
  /** 이 턴의 지시문(사람 말 또는 서버가 조립한 지시). 프롬프트 파일로만 간다 — 셸 인자에 실리지 않는다. */
  text: string;
  /** true 면 이어가던 대화를 놓고 새로 시작한다. */
  restart?: boolean;
  /** 서버가 띄운 턴 — 화면이 «내 말» 로 그리지 않는다(위 머리말). */
  hidden?: boolean;
  kind?: LivTurnKind;
  /** 사이드바에 잠깐 보일 이름. 없으면 LIV_CHAT_LABEL. */
  label?: string;
  /** true 면 마지막 턴이 아직 도는 중일 때 띄우지 않고 LivChatBusyError 를 던진다 — 서버가 띄우는 턴(2턴 스윕)용.
   *  사람의 턴은 화면이 입력을 막으므로 종전대로 검사하지 않는다(막으면 «보냈는데 사라진 말» 이 생긴다). */
  unlessBusy?: boolean;
}

export interface LivChatTurnStart { turn_id: string; resumed: boolean; chat_id: string }

/**
 * 같은 사람의 턴 시작을 **한 줄로 세운다**(#1631 격리 리뷰). 리브 탭 [보내기]와 2턴 스윕이 같은 대화를 동시에 이어받으면
 *  두 프로세스가 같은 세션을 --resume 하고, 프로필 turns[] 의 읽고-쓰기가 서로를 덮는다. 종전엔 «화면이 입력을 막는다» 가
 *  유일한 방패였는데(store/members.ts appendLivTurn 머리말), 서버가 띄우는 턴(스윕)은 그 방패를 안 지난다.
 *  게이트웨이는 테넌트당 한 프로세스라 프로세스 안 잠금이면 된다 — 앞 시작이 실패해도 뒤 시작은 막지 않는다.
 */
const inflight = new Map<string, Promise<unknown>>();
async function withTurnLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inflight.get(userId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  inflight.set(userId, run);
  try { return await run; } finally { if (inflight.get(userId) === run) inflight.delete(userId); }
}

/** 리브가 아직 앞 턴을 답하는 중이라 이 턴을 띄우지 않았다(unlessBusy). 스윕은 이걸 «실패» 가 아니라 «다음 tick 에 다시» 로 다룬다. */
export class LivChatBusyError extends Error {
  readonly code = "liv-chat-busy" as const;
  constructor(readonly turnId: string) { super(`리브가 아직 답하는 중입니다(턴 ${turnId})`); }
}

/**
 * 지금 이 사람의 리브 대화에서 **마지막 턴**이 도는 중이면 그 턴 id, 아니면 null — 스윕의 «리브가 바쁜가».
 *  ⚠ 킥오프 턴 id(welcome.liv_turn_id)는 고정값이라 그것만 보면 첫 턴 뒤로는 영영 «한가함» 이 된다(격리 리뷰) — 사람이 리브와
 *   대화 중인지는 **마지막 턴**이 말한다. 대화가 없으면 바쁘지 않다. 폴더가 없는 턴(null)은 끝난 것으로 본다.
 */
export async function livChatRunningTurn(user: LivelyUser): Promise<string | null> {
  const { getLivProfile } = await import("../store.js");
  const turns = (await getLivProfile(user.userId).catch(() => null))?.chat?.turns ?? [];
  const last = turns.length ? turns[turns.length - 1] : null;
  return last && (await livTurnDone(user, last.id)) === false ? last.id : null;
}

/**
 * 리브에게 한 턴을 건다 — 리브 탭의 [보내기]와 서버 킥오프·증류 지시가 **같은 문**을 지난다.
 *  · 이어갈 대화가 있으면 이어받고(--resume), 없거나 restart 면 새로 만든다(--session-id).
 *    ⚠ 첫 턴과 이어가는 턴은 주는 플래그가 다르다 — 뒤집으면 «리브가 방금 한 말을 잊는다» 또는 «없는 대화를 이어받으려다 죽는다».
 *  · 스폰이 성공한 뒤에 기억한다 — 실패한 턴의 세션 id 를 남기면 다음 턴이 없는 대화를 이어받으려 한다.
 *  · 세션 id 를 **두 곳에** 남긴다(프로필 · 턴 폴더). 멈추기는 이게 없으면 아예 불가능하다.
 */
export async function startLivChatTurn(user: LivelyUser, o: LivChatTurnOpts): Promise<LivChatTurnStart> {
  const userId = user?.userId;
  if (!userId) throw new Error("인증된 사용자가 아닙니다");
  const text = String(o.text ?? "").trim();
  if (!text) throw new Error("할 말이 비어 있습니다");

  return await withTurnLock(userId, async () => {
    if (o.unlessBusy) {
      const running = await livChatRunningTurn(user);
      if (running) throw new LivChatBusyError(running);
    }
    const { getLivProfile, setLivChat, appendLivTurn } = await import("../store.js");
    const prof = await getLivProfile(userId);
    const prev = o.restart ? null : (prof.chat ?? null);
    const sessionId = prev?.session_id ?? crypto.randomUUID();
    const resume = !!prev;

    const turnId = newLivTurnId();
    // 동적 import — node/tasks 는 tmux·pty 를 끌고 오는 무거운 모듈이고 org/* 에서 정적으로 걸면 순환(check-imports) 위험.
    const { spawnTaskSession } = await import("../../node/tasks.js");
    const spawned = await spawnTaskSession({
      user, taskId: turnId, rootKey: "personal", subpath: "liv",
      prompt: text, harness: "claude",
      extraFlags: livTurnArgs({ sessionId, resume }),
      bypassPermissions: false,   // ⚠ 리브의 안전선. 이 줄이 사라지면 사람 앞에서 승인 없이 돈다.
      label: o.label ?? LIV_CHAT_LABEL,
    });

    const now = new Date().toISOString();
    if (!resume) await setLivChat(userId, { session_id: sessionId, started_at: now, turns: [] });
    await fsp.writeFile(path.join(spawned.taskDir, "session"), spawned.sessionId, "utf8").catch(() => { /* best-effort */ });
    // 되그릴 수 있게 턴을 잇는다. **사람이 한 말만** 담는다 — 리브의 말은 그 턴의 진행 파일이 정본이다.
    //  숨김 턴은 지시문 대신 짧은 표식만 남긴다(지시문은 턴 폴더의 prompt 에 있다 — 프로필에 3KB 지시문을 복제하지 않는다).
    await appendLivTurn(userId, {
      id: turnId, at: now, sid: spawned.sessionId,
      text: o.hidden ? `[리브가 스스로 시작한 턴] ${o.kind === "distill" ? "자료 정리(증류)" : "처음 설정 점검"}` : text,
      ...(o.hidden ? { hidden: true as const } : {}),
      ...(o.kind ? { kind: o.kind } : {}),
    });
    return { turn_id: turnId, resumed: resume, chat_id: sessionId };
  });
}

/**
 * 그 턴이 끝났나 — 턴 폴더의 exit 파일이 곧 «끝남»(node/tasks tailTask 와 같은 판정).
 *  null = 모름(폴더가 없다 — 스폰 전에 죽었거나 청소됐다). 2턴 스윕은 null 을 «막혀 있음» 이 아니라 «관측 불가» 로 다룬다.
 */
export async function livTurnDone(user: LivelyUser, turnId: string): Promise<boolean | null> {
  if (!LIV_TURN_ID_RE.test(turnId)) return null;
  const dir = await livTurnDir(user, turnId).catch(() => null);
  if (!dir) return null;
  try { await fsp.access(dir); } catch { return null; }
  try { await fsp.access(path.join(dir, "exit")); return true; } catch { return false; }
}
