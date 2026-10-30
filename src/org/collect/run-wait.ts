// 수집 실행 기다리기(#4213 T13) — collect_claude_run_get {wait_sec} 가 «언제까지» 기다리나. 순수(읽기·시계·잠은 넣어 준다).
//
//  리브(처음 연결 대화)는 목록·수집 실행이 끝나면 곧바로 collect_units 로 찾은 곳을 세어 첫 보고를 한다. 그런데 저장 단계(run-ingest —
//   원문을 수집 단위 표로 넣는 일)는 실행이 끝난 **뒤에** 따로 돈다(terminal/collect-run.ts noteIngest — 기다리지 않고 던지지 않는다).
//   실행의 state 만 보고 돌려주면 리브가 저장 전의 단위 수를 보고 «찾은 곳 0» 이라고 말할 수 있다(격리 리뷰 2026-10-17).
//   그래서 목록·수집 실행은 저장 단계가 끝(done · failed)날 때까지가 «끝» 이다.

/** collect_claude_run_get 응답에서 이 판정이 보는 칸. */
export interface RunWaitView {
  state: string;
  /** 저장 단계 — getRunIngest: 실행 기록이 없으면 null · 있으면 {mode, ...ingest}(차례를 아직 안 잡았으면 state 가 없다). */
  ingest: Record<string, unknown> | null;
}

/** 저장 단계가 있는 실행 종류(점검 probe 는 저장하지 않는다). */
const INGEST_MODES: ReadonlySet<string> = new Set(["listing", "collect"]);

/** 기다림이 끝났나 — 실행이 끝났고, 목록·수집 실행이면 저장 단계까지 끝났다. */
export function collectRunSettled(v: RunWaitView): boolean {
  if (v.state !== "done") return false;
  const ing = v.ingest;
  if (!ing || !INGEST_MODES.has(String(ing.mode ?? ""))) return true;
  const st = String(ing.state ?? "");
  return st === "done" || st === "failed";
}

export interface RunWaitDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 다시 읽는 간격(기본 3초). */
  pollMs?: number;
  /** 기다림 상한(초, 기본 25 — MCP 장기 대기는 전송이 끊긴다). */
  maxSec?: number;
}

/**
 * 끝날 때까지(또는 waitSec 이 다 될 때까지) 읽는다 — 늘 한 번은 읽고, 마지막으로 읽은 값을 돌려준다.
 *  waitSec 은 0~maxSec 로 자른다(음수·NaN 은 0 — 기다리지 않음).
 */
export async function waitForCollectRun<V extends RunWaitView>(read: () => Promise<V>, waitSec: number | undefined, deps: RunWaitDeps = {}): Promise<V> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = Math.max(1, deps.pollMs ?? 3000);
  const maxSec = Math.max(0, deps.maxSec ?? 25);
  const sec = Number.isFinite(waitSec) ? Math.min(maxSec, Math.max(0, Number(waitSec))) : 0;
  const deadline = now() + sec * 1000;
  let view = await read();
  while (!collectRunSettled(view) && now() < deadline) {
    await sleep(Math.min(pollMs, Math.max(0, deadline - now())));
    view = await read();
  }
  return view;
}
