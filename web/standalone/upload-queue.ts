// 세션 화면 파일 올리기 — 대기열의 순수 판정(#5361). DOM·네트워크를 모른다(시험이 브라우저 없이 직접 import 한다).
//
//  왜 따로 있나: 원준님 신고(2026-11-05) — 257MB 녹화 파일을 세션 화면에 끌어다 놓았더니 «업로드 중…» 알림이 3초 만에
//   사라지고, 다 올라갈 때까지 아무 표시가 없었다. 올라가는지 몰라 같은 파일을 한 번 더 놓았고, 두 업로드가 **같은 이름**으로
//   가서 경로가 입력창에 두 번 들어갔다. 진행 표시(terminal.ts 의 올리기 칸)가 기대는 판정 셋이 여기 산다:
//   · 같은 파일인가(uploadKey) — 이름·크기·수정 시각이 같으면 사람이 같은 파일을 다시 놓은 것으로 본다.
//   · 겹치지 않는 이름(freeUploadName) — 종전엔 **다 올라간 파일 목록**만 보고 골랐다. 올리는 중인 파일은 아직 목록에 없어
//     같은 이름이 두 번 나갔다(서버 PUT 은 그냥 덮어쓴다). 그래서 올리는 중인 이름도 예약으로 친다(UploadBook.reserve).
//   · 아직 올리는 중인가(UploadBook.busy) — 창 닫기 경고를 걸고 거두는 기준.
//  사람이 보는 숫자·문장(fmtBytes·upPercent·upStatusText)도 여기서 만든다 — 화면 없이 문구를 시험하려고.

/** 올릴 파일에서 이 모듈이 읽는 것만 — 브라우저 File 이 그대로 맞는다. */
export interface UpFileLike { name?: string; size?: number; lastModified?: number }

/** wait = 차례를 기다린다 · send = 보내는 중 · done = 다 올렸다 · fail = 못 올렸다 · cancel = 사람이 멈췄다. */
export type UpState = 'wait' | 'send' | 'done' | 'fail' | 'cancel';

export interface UpJob {
  id: number;
  /** 같은 파일 판정 표지(uploadKey). */
  key: string;
  /** 올릴 폴더(세션 폴더 기준 상대경로 — 끌어놓기는 'uploads'). 이름 예약은 같은 폴더 안에서만 겹친다. */
  dir: string;
  /** 서버에 놓일 이름. reserve 전엔 원래 이름(잠정), reserve 뒤엔 겹치지 않게 고른 이름. */
  name: string;
  /** 이 이름을 예약했나 — 잠정 이름은 남을 막지 않는다(같이 놓은 두 파일 중 앞 것이 원래 이름을 갖게). */
  reserved: boolean;
  size: number;
  /** 보낸 바이트(진행률). */
  loaded: number;
  state: UpState;
  /** 못 올린 이유(사람이 읽는 문장). */
  error: string;
  /** 다 올린 뒤 덧붙일 말(경로가 어디에 들어갔나). */
  note: string;
}

/** 같은 파일 판정 표지 — 폴더 + 이름·크기·수정 시각. 사람이 같은 파일을 두 번 놓으면 브라우저는 세 값이 같은 File 을 준다.
 *  폴더를 넣는 이유: 같은 파일이라도 다른 폴더로 올리는 것은 다른 일이다(파일 탐색기의 [업로드]는 지금 보는 폴더로 간다). */
export function uploadKey(f: UpFileLike, dir: string): string {
  const n = f && typeof f.name === 'string' ? f.name : '';
  const s = f && Number.isFinite(f.size) ? Number(f.size) : -1;
  const m = f && Number.isFinite(f.lastModified) ? Number(f.lastModified) : -1;
  return [String(dir || ''), n, s, m].join('\u0000');
}

/** 겹치지 않는 이름 — 원래 이름을 그대로 쓰되, 이미 있으면 '이름-2.png' · '-3' 으로 번호를 올린다(#1235).
 *  taken = 폴더에 이미 있는 이름 ∪ 올리는 중 예약한 이름. 확장자는 마지막 점부터(이름이 점으로 시작하면 확장자 없음). */
export function freeUploadName(name: string, taken: { has(n: string): boolean }): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 1000; i++) { const c = stem + '-' + i + ext; if (!taken.has(c)) return c; }
  for (;;) { const c = stem + '-' + Math.floor(Math.random() * 1e6) + ext; if (!taken.has(c)) return c; }
}

/** 이 페이지에서 올리는 중인 파일 장부. 끝난(done·fail·cancel) 것은 장부에서 빠진다 — 그 뒤 같은 파일을 다시 놓으면 새로 올린다. */
export class UploadBook {
  private seq = 0;
  private live = new Map<string, UpJob>();

  /** 올릴 파일을 세운다. 같은 폴더로 같은 파일이 이미 올라가는 중이면 새로 세우지 않고 그 일을 돌려준다(dup). */
  claim(f: UpFileLike, dir: string, name: string): { job: UpJob; dup: boolean } {
    const key = uploadKey(f, dir);
    const had = this.live.get(key);
    if (had) return { job: had, dup: true };
    const size = f && Number.isFinite(f.size) ? Math.max(0, Number(f.size)) : 0;
    const job: UpJob = { id: ++this.seq, key, dir: String(dir || ''), name: String(name || ''), reserved: false, size, loaded: 0, state: 'wait', error: '', note: '' };
    this.live.set(key, job);
    return { job, dup: false };
  }

  /** 같은 폴더에서 올리는 중인 다른 일이 예약한 이름들. */
  reservedIn(dir: string, except?: UpJob): Set<string> {
    const out = new Set<string>();
    for (const j of this.live.values()) if (j !== except && j.reserved && j.dir === String(dir || '')) out.add(j.name);
    return out;
  }

  /** 겹치지 않는 이름을 골라 예약한다. taken = 폴더에 이미 있는 이름(서버 목록). 고른 이름을 돌려준다.
   *  이미 장부에서 빠진 일(그 사이 취소)이면 고르기만 하고 예약하지 않는다. */
  reserve(job: UpJob, taken: Iterable<string>): string {
    const all = this.reservedIn(job.dir, job);
    for (const n of taken || []) all.add(n);
    const name = freeUploadName(job.name, all);
    job.name = name;
    if (this.live.get(job.key) === job) job.reserved = true;
    return name;
  }

  /** 장부에서 뺀다(다 올렸다 · 못 올렸다 · 취소했다). 같은 일을 두 번 빼도 무해하다. */
  release(job: UpJob): void {
    if (this.live.get(job.key) === job) this.live.delete(job.key);
    job.reserved = false;
  }

  /** 아직 올리는(또는 차례를 기다리는) 파일이 있나 — 창 닫기 경고의 기준. */
  busy(): boolean { return this.live.size > 0; }
}

/** 사람이 읽는 크기 — 1024 단위, MB 는 소수 한 자리, GB 는 두 자리. */
export function fmtBytes(n: number): string {
  const b = Number.isFinite(n) && n > 0 ? n : 0;
  if (b < 1024) return Math.round(b) + 'B';
  if (b < 1024 ** 2) return Math.round(b / 1024) + 'KB';
  if (b < 1024 ** 3) return (b / 1024 ** 2).toFixed(1) + 'MB';
  return (b / 1024 ** 3).toFixed(2) + 'GB';
}

/** 보낸 비율(0~100, 내림) — 다 보내기 전엔 100 을 말하지 않는다(서버가 저장을 마칠 때까지는 끝이 아니다). */
export function upPercent(loaded: number, total: number): number {
  if (!(total > 0)) return loaded > 0 ? 100 : 0;
  return Math.max(0, Math.min(100, Math.floor((loaded / total) * 100)));
}

/** 줄 아래 문장 — 화면 문구 규약대로 어미까지 맺는다(설명문은 명사로 끊지 않는다). */
export function upStatusText(job: UpJob): string {
  switch (job.state) {
    case 'wait': return '차례를 기다리고 있어요.';
    case 'send':
      return job.size > 0 && job.loaded >= job.size
        ? '다 보냈어요. 저장을 마치는 중이에요.'
        : fmtBytes(job.size) + ' 중 ' + fmtBytes(job.loaded) + '를 올렸어요.';
    case 'done': return '다 올렸어요.' + (job.note ? ' ' + job.note : '');
    case 'fail': return '올리지 못했어요.' + (job.error ? ' ' + job.error : '');
    default: return '올리기를 멈췄어요.';
  }
}
