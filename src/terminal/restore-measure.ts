// 복원 한 번의 측정 한 줄 (#4697 T7) — 하네스 종료 규칙(#4695)·즉시 철거(#4696) 뒤 7일 측정의 재료.
//
// ── 왜 따로 남기나 ───────────────────────────────────────────────────────────────────────────────────
//  새 규칙에선 끝난 세션의 하네스를 3분 만에 끄고, 사람이 다시 말을 걸면 그때 되살린다(POST …/restore). 그래서 «하루에 몇 번 되살리나 ·
//   얼마나 걸리나 · 몇 번 실패하나 · 끄기 전에 남긴 쪽지(쓰다 만 글·답을 기다리던 질문)가 몇 번 돌아오나» 가 이 규칙의 값이다.
//  그런데 복원 라우트는 갈래마다 로그가 달랐고(같은 id 성공만 한 줄 · 새 id 성공은 미배달 지시가 있을 때만 · 4xx 는 wrap 이 안 남김),
//   걸린 시간은 어디에도 없었다. 갈래 코드는 건드리지 않고 **라우트 앞에서** 한 줄로 잰다 — 응답이 끝난 뒤(finish) 상태 코드·응답 모양으로
//   결말을 가른다. 갈래를 하나 더해도 이 줄은 저절로 따라간다.
//  ⚠ 사람이 쓴 글은 싣지 않는다 — 쪽지는 «있었나» 와 질문의 종류만 센다.
import type express from "express";
import { logger } from "../log.js";
import { currentTenant } from "../org/tenant-context.js";
import type { SessionStopNote } from "../sessions/session-state.js";

/** 복원 결말 — same-id(같은 id 로 되살림 #4694) · new-id(새 id) · alive(이미 살아 있었다) · moved(이미 이어진 세션으로 안내) · error · other. */
export type RestoreOutcome = "same-id" | "new-id" | "alive" | "moved" | "error" | "other";

export interface RestoreMeasure {
  tenant: string | null;
  id: string;
  /** 요청 도착 → 응답 끝(같은 세션의 앞 복원을 기다린 시간 포함 — 사람이 기다린 시간) */
  ms: number;
  status: number;
  outcome: RestoreOutcome;
  /** 노드(멤버 PC) 세션 복원이었나 */
  node?: true;
  /** 이어 열기 판(precise · picker · fresh — resumedKind) */
  resumed?: string;
  newId?: string;
  force?: true;
  /** 요청 때 그 세션에 남아 있던 쪽지 — 하네스 종료 규칙이 끄기 전에 남긴 것 */
  note?: { why: SessionStopNote["why"]; draft: boolean; question: string | null; agoSec: number };
  error?: string;
  /** 응답이 끝나기 전에 사람 쪽이 끊었다(롤 교대·탭 닫음) — 화면은 다시 묻는다(web/lib/restore-retry.ts). 결말은 그 뒤 서버가 낸 응답이다. */
  aborted?: true;
}

/** (순수) 응답 하나 → 측정 한 줄. */
export function restoreMeasureOf(o: {
  id: string; tenant: string | null; ms: number; status: number; body: unknown;
  note: SessionStopNote | null; nowSec: number; force: boolean;
}): RestoreMeasure {
  const b = o.body && typeof o.body === "object" && !Array.isArray(o.body) ? o.body as Record<string, unknown> : {};
  const session = b.session && typeof b.session === "object" ? b.session as { id?: unknown; node?: unknown } : null;
  const sid = typeof session?.id === "string" ? session.id : null;
  const outcome: RestoreOutcome = o.status >= 400 ? "error"
    : b.already ? (b.movedTo ? "moved" : "alive")
    : sid ? (sid === o.id ? "same-id" : "new-id")
    : "other";
  const m: RestoreMeasure = { tenant: o.tenant, id: o.id, ms: Math.max(0, Math.round(o.ms)), status: o.status, outcome };
  if (session?.node || b.node) m.node = true;
  if (typeof b.resumed === "string" && b.resumed) m.resumed = b.resumed;
  if (sid && sid !== o.id) m.newId = sid;
  if (o.force) m.force = true;
  if (o.note) {
    m.note = { why: o.note.why, draft: !!o.note.draft, question: o.note.question?.kind ?? null, agoSec: Math.max(0, Math.round(o.nowSec - o.note.at)) };
  }
  if (outcome === "error") m.error = String(b.error ?? "").slice(0, 160);
  return m;
}

/**
 * 복원 라우트 앞에 끼우는 측정 미들웨어 — 응답이 끝나면(finish) 한 줄을 남긴다. 측정이 실패해도 요청은 그대로 간다.
 *  사람 쪽이 먼저 끊으면(finish 없이 close) 서버가 응답을 낼 때(res.json) 그 결말로 한 줄을 남기고 aborted 를 단다 — 끊긴 복원도
 *  서버에선 끝까지 돌아 하네스를 띄우므로, 안 남기면 «되살림» 이 줄고 화면의 재시도가 낸 «이미 살아 있음» 만 남는다(격리 리뷰).
 *  @param readNote  요청 때의 쪽지(장부 행) — 갈래가 도는 동안 함께 읽는다(쪽지는 그 세션이 다음 턴을 시작해야 지워지므로 복원 중엔 그대로다)
 *  @param log       남기는 자리(시험이 바꿔 끼운다)
 */
export function restoreMeasureMiddleware(
  readNote: (id: string) => Promise<SessionStopNote | null | undefined>,
  log: (m: RestoreMeasure) => void = (m) => logger.info(m, "restore: 측정(#4697)"),
): express.RequestHandler {
  return (req, res, next) => {
    const t0 = Date.now();
    const id = String(req.params.id ?? "");
    const tenant = currentTenant()?.slug ?? null;   // finish 콜백에선 요청 컨텍스트가 없을 수 있어 지금 잡는다
    const force = req.query.force === "1" || req.query.force === "true";
    const note = readNote(id).then((n) => n ?? null, () => null);
    let body: unknown;
    let answered = false, aborted = false, logged = false;
    const emit = (): void => {
      if (logged) return;
      logged = true;
      const ms = Date.now() - t0;
      void note.then((n) => {
        const m = restoreMeasureOf({ id, tenant, ms, status: res.statusCode, body, note: n, nowSec: Math.floor(Date.now() / 1000), force });
        log(aborted ? { ...m, aborted: true } : m);
      }).catch(() => { /* 측정 실패는 삼킨다 — 요청은 이미 끝났다 */ });
    };
    const json = res.json.bind(res);
    res.json = ((b: unknown) => {
      body = b; answered = true;
      const out = json(b);
      if (aborted) emit();     // 끊긴 뒤에 낸 응답 — finish 가 안 올 수 있다
      return out;
    }) as typeof res.json;
    res.once("finish", emit);
    res.once("close", () => {
      if (res.writableFinished) return;   // 정상 종료(finish 가 이미 찍었다)
      aborted = true;
      if (answered) emit();
    });
    next();
  };
}
