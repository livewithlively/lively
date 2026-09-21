// lib/autosave.ts — 자동저장의 **상태기계**(#4084). DOM·fetch·타이머를 모른다(전부 받는다) — 그래서 값으로 시험한다
//  (scripts/autosave.test.mjs). 글칸에 묶는 일은 부르는 쪽(v2/panes-tasks.ts autoSave)이 한다.
//
//  약속 넷:
//   ① 쓰면 delayMs 뒤에 저장한다(그 사이 더 쓰면 미룬다).
//   ② **flush 는 도는 저장이 실제로 끝날 때까지 기다린다.** 종전 판은 `if (saving) return` 이 곧바로 풀려, 부른 쪽이
//      «저장됐다» 고 믿고 글칸을 걷은 뒤에야 그 저장이 충돌(409)로 끝났다 — 글은 사라진 글칸에만 있었다(격리 리뷰 2026-09-20).
//   ③ 실패를 되풀이하지 않는다 — 자동 재시도 없음, flush 의 재시도는 한 번. 'pause' 로 받은 실패(사람이 풀어야 하는 충돌)는
//      setSaved 로 풀릴 때까지 아무것도 보내지 않는다.
//   ④ destroy 뒤엔 새 타이머를 걸지 않는다(도는 저장은 끝까지 가되, 그 뒤를 잇지 않는다).
export type FailVerdict = 'pause' | 'handled' | void;
export type AutoSaveStatus = 'idle' | 'typing' | 'saving' | 'saved' | 'failed';
export interface AutoSaveIO {
  /** 글칸의 지금 글. */
  read(): string;
  /** 서버에 실제로 남은 글을 돌려준다(합쳐졌으면 보낸 것과 다르다). 던지면 실패. */
  save(text: string): Promise<string>;
  /** 서버가 남긴 글이 보낸 것과 다르다 — 글칸이 보낸 그대로면 그 글로 맞춘다(더 친 글이 있으면 건드리지 않는다). */
  adopt?(kept: string, sent: string): void;
  status?(s: AutoSaveStatus): void;
  onSaved?(kept: string): void;
  /** 'pause' = 사람이 풀어야 한다 · 'handled' = 안내는 내가 했다 · 없음 = 상태 'failed' 로 알린다.
   *  ★둘째 인자는 **실패한 그 순간 글칸에 있는 글(live)** 이다 — 보낸 글(sent)이 아니다. 저장이 가는 동안 사람은 더 친다.
   *   실패한 글을 어딘가 남기려는 쪽이 sent 를 남기면 그 사이 친 글이 빠진다(격리 재리뷰 2026-09-21). 남길 것은 늘 live 다. */
  onFail?(e: unknown, live: string, sent: string): FailVerdict;
  delayMs: number;
  setTimer(fn: () => void, ms: number): unknown;
  clearTimer(h: unknown): void;
}
export interface AutoSaveCore {
  input(): void; flush(): Promise<void>; dirty(): boolean; paused(): boolean; setSaved(v: string): void; destroy(): void;
}

export function autoSaveCore(io: AutoSaveIO, initial: string): AutoSaveCore {
  let timer: unknown = null, inflight: Promise<void> | null = null, saved = initial;
  let paused = false, dead = false, lastOk = true;
  const stopTimer = (): void => { if (timer !== null) { io.clearTimer(timer); timer = null; } };

  const attempt = async (): Promise<void> => {
    const text = io.read();
    io.status?.('saving');
    try {
      const kept = await io.save(text);
      saved = kept; lastOk = true;
      if (kept !== text) io.adopt?.(kept, text);
      io.status?.('saved');
      io.onSaved?.(kept);
    } catch (e) {
      lastOk = false;
      const v = io.onFail?.(e, io.read(), text);
      if (v === 'pause') paused = true;
      else if (v !== 'handled') io.status?.('failed');
    }
  };
  /** 한 번 저장한다. 이미 도는 중이면 **그 약속**을 돌려준다(새로 시작하지 않는다). */
  const run = (): Promise<void> => {
    if (inflight) return inflight;
    if (paused || io.read() === saved) { if (!paused) io.status?.('idle'); return Promise.resolve(); }
    inflight = attempt().finally(() => {
      inflight = null;
      if (!dead && !paused && lastOk && io.read() !== saved) queue();   // 저장하는 동안 더 친 글 — 성공했을 때만 잇는다
    });
    return inflight;
  };
  const queue = (): void => {
    if (paused || dead) return;
    io.status?.('typing');
    stopTimer();
    timer = io.setTimer(() => { timer = null; void run(); }, io.delayMs);
  };
  return {
    input: queue,
    flush: async () => {
      stopTimer();
      if (inflight) await inflight;                         // 도는 저장을 끝까지 — 그 결과(충돌 포함)를 본 뒤에 돌아간다
      if (!paused && io.read() !== saved) { stopTimer(); await run(); }   // 그동안 더 친 글·아직 안 보낸 글을 한 번 더(실패해도 한 번뿐)
    },
    dirty: () => io.read() !== saved,
    paused: () => paused,
    setSaved: (v: string) => { saved = v; paused = false; lastOk = true; },
    destroy: () => { dead = true; stopTimer(); },
  };
}
