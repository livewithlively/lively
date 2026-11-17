// NAS 파일명 색인 — 구성원 본인 FTP 계정으로 폴더를 훑어 «이름·경로·크기·시각»만 모아 두고 검색한다.
//
//  왜 구성원마다 따로 색인하나: NAS 는 FTP 계정마다 열린 폴더가 다르다(예: vsftpd 가상 사용자마다 팀 폴더를 bind mount).
//   한 사람 색인을 다른 사람 검색에 쓰면 그 사람이 못 여는 폴더의 파일 이름이 새어 나간다. 그래서 캐시 키가 구성원이다.
//  왜 본문은 안 읽나: NAS 서류(계약서·신분증 스캔 등)에는 개인정보가 많다. 이 색인은 파일 이름만 다루고,
//   본문은 사람이 브라우저로 내려받는다(nas-download-route.ts). AI 에 본문을 주는 경로를 만들지 않는 것이 이 기능의 경계다.
import { parseListing, displayPath, type FtpListEntry } from "../ftp/ftp-list.js";

export interface NasEntry {
  /** 서버 원본 바이트 경로(latin1). 내려받기 링크에 이 값을 싣는다. */
  raw: string;
  /** 사람이 읽는 경로(UTF-8/EUC-KR 디코드 + NFC). 검색은 이 값으로 한다. */
  path: string;
  type: "file" | "dir";
  size: number;
  mtime: string;
}

export interface CrawlLimits {
  maxDirs: number;
  maxEntries: number;
  deadlineMs: number;
}

// 폴더 상한은 한 FTP 계정이 여는 범위 전체가 들어가게 둔다. 잘린 색인은 빠진 폴더의 파일을 «없다»고 답한다
//  (폴더 20000개 상한에서는 폴더 수만 개짜리 계정의 약 1/3 이 빠졌다).
//  항목 상한은 올리지 않는다 — 색인은 항목마다 경로 문자열 두 벌(raw·path)을 들고 메모리에 통째로 있고, 구성원마다 따로 캐시된다.
//  폴더 상한을 먼저 풀어야 했던 계정도 항목(폴더+파일)은 이 안에 들었다. 넘으면 truncated 로 알린다.
//  시간 상한은 폴더 수 상한을 세션 수(NAS_CRAWL_SESSIONS)로 나눠 훑는 속도에 맞춘다 — 폴더만 올리면 시간 상한에 먼저 걸린다.
export const DEFAULT_LIMITS: CrawlLimits = { maxDirs: 100_000, maxEntries: 200_000, deadlineMs: 30 * 60_000 };

export interface CrawlResult {
  entries: NasEntry[];
  dirs: number;
  /** 상한(폴더 수·항목 수·시간)에 걸려 끝까지 못 훑었으면 그 까닭. */
  truncated: string | null;
  /** 들어가지 못한 폴더 수(권한 없음 등). */
  failedDirs: number;
}

/** 폴더 하나의 LIST 본문을 주는 함수 — 실제로는 FtpSession.list, 시험에선 가짜. 한 lister 는 한 번에 한 폴더만 연다. */
export type DirLister = (rawDir: string) => Promise<string>;

const joinRaw = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

const isFatal = (e: unknown): boolean => (e as { fatal?: unknown } | null)?.fatal === true;

/**
 * root 아래를 너비 우선으로 훑는다. 심볼릭 링크는 따라가지 않는다(순환·chroot 밖 방지).
 *  lister 를 여러 개 주면 한 큐를 나눠 동시에 연다(FTP 세션 하나는 LIST 를 하나씩만 하므로 세션마다 lister 하나).
 *  왕복 지연이 LIST 시간을 지배하면 최대 세션 수만큼 빨라진다(실제 속도는 색인 완료 로그의 sessions·ms).
 *  한 lister 의 접속이 죽으면(fatal) 그 폴더를 큐에 되돌리고 나머지 lister 로 계속한다. 전부 죽으면 마지막 오류로 거부한다 —
 *  죽은 접속의 실패를 «권한 없는 폴더»로 세면 반쪽 색인이 성공으로 12시간 캐시된다.
 */
export async function crawl(listers: DirLister | readonly DirLister[], root = "/", limits: CrawlLimits = DEFAULT_LIMITS, now: () => number = Date.now): Promise<CrawlResult> {
  const pool = typeof listers === "function" ? [listers] : [...listers];
  if (!pool.length) throw new Error("crawl: lister 가 하나도 없다");
  const started = now();
  const entries: NasEntry[] = [];
  const queue: string[] = [root];
  let dirs = 0;
  let failedDirs = 0;
  let truncated: string | null = null;
  let inflight = 0;
  let alive = pool.length;
  let lastFatal: unknown = null;
  const waiters: Array<() => void> = [];
  const wakeAll = (): void => { while (waiters.length) waiters.shift()!(); };

  const worker = async (list: DirLister): Promise<void> => {
    for (;;) {
      if (truncated !== null) return;
      if (!queue.length) {
        // 다른 lister 가 연 폴더에서 하위 폴더가 나올 수 있다 — 진행 중인 것이 다 끝나야 정말 끝이다
        if (inflight === 0) return;
        await new Promise<void>((r) => waiters.push(r));
        continue;
      }
      if (dirs >= limits.maxDirs) { truncated = `폴더 ${limits.maxDirs}개 상한`; wakeAll(); return; }
      if (now() - started > limits.deadlineMs) { truncated = `시간 상한 ${Math.round(limits.deadlineMs / 1000)}초`; wakeAll(); return; }
      const dir = queue.shift()!;
      dirs++;
      inflight++;
      let items: FtpListEntry[];
      try {
        items = parseListing(await list(dir));
      } catch (e) {
        inflight--;
        if (isFatal(e)) {
          dirs--;
          queue.unshift(dir);
          alive--;
          lastFatal = e;
          wakeAll();
          return;
        }
        failedDirs++;
        wakeAll();
        continue;
      }
      inflight--;
      for (const it of items) {
        if (it.type !== "file" && it.type !== "dir") continue;
        // 넣기 전에 본다 — 다른 lister 가 이미 상한을 채웠으면 이 폴더 결과도 더 넣지 않는다
        if (entries.length >= limits.maxEntries) break;
        const raw = joinRaw(dir, it.name);
        entries.push({ raw, path: displayPath(raw), type: it.type, size: it.size, mtime: it.mtime });
        if (it.type === "dir") queue.push(raw);
      }
      if (entries.length >= limits.maxEntries) truncated ??= `항목 ${limits.maxEntries}개 상한`;
      wakeAll();
    }
  };

  await Promise.all(pool.map(worker));
  if (alive === 0) throw lastFatal;
  return { entries, dirs, truncated, failedDirs };
}

export interface SearchOpts {
  /** 이 경로(사람이 읽는 꼴) 아래만. */
  under?: string;
  type?: "file" | "dir";
  limit?: number;
}

const norm = (s: string): string => s.normalize("NFC").toLowerCase();
const baseName = (p: string): string => p.slice(p.lastIndexOf("/") + 1);

/**
 * 공백으로 나눈 낱말이 **모두** 경로에 든 항목(대소문자 무시). 순서: 파일 이름에 든 낱말 수가 많은 것 → 최근 것.
 *  낱말 없이 under 만 주면 그 아래 전부를 최근 순으로.
 */
export function searchEntries(entries: readonly NasEntry[], query: string, opts: SearchOpts = {}): { total: number; items: NasEntry[] } {
  const terms = norm(query).split(/\s+/).filter(Boolean);
  const under = opts.under ? norm(opts.under).replace(/\/+$/, "") : "";
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const scored: Array<{ e: NasEntry; score: number }> = [];
  for (const e of entries) {
    if (opts.type && e.type !== opts.type) continue;
    const p = norm(e.path);
    if (under && !(p === under || p.startsWith(under + "/"))) continue;
    if (!terms.every((t) => p.includes(t))) continue;
    const b = norm(baseName(e.path));
    scored.push({ e, score: terms.filter((t) => b.includes(t)).length });
  }
  scored.sort((a, b) => b.score - a.score || (a.e.mtime < b.e.mtime ? 1 : a.e.mtime > b.e.mtime ? -1 : 0));
  return { total: scored.length, items: scored.slice(0, limit).map((x) => x.e) };
}

// ── 구성원별 색인 캐시 ───────────────────────────────────────────────────────────────────────

export interface IndexState {
  builtAt: number | null;
  result: CrawlResult | null;
  building: Promise<CrawlResult> | null;
  /** 마지막 실패를 errorText 로 분류한 문구(원문 아님). nas_find 응답의 last_error 로 그대로 나간다. */
  error: string | null;
  /** 색인을 만드는 도중 NAS 가 바뀌었다 — 그 색인은 완성돼도 낡은 것으로 본다. */
  staleOnBuild?: boolean;
}

/**
 * 실패 → 색인 상태에 남길 문구. 원문(소켓 오류의 사설 IP·포트, FTP 서버 응답문)은 상태를 거쳐 AI 응답에 실리므로
 *  여기서 걸러야 한다. 기본값은 아무것도 옮기지 않는 고정 문구다 — 분류기를 안 준 캐시도 원문을 흘리지 않게.
 */
export type IndexErrorText = (e: unknown) => string;
const NO_RAW_ERROR: IndexErrorText = () => "색인을 만들지 못했습니다";

export const INDEX_TTL_MS = 12 * 60 * 60_000;
/** 동시에 들고 있는 구성원 색인 수 — 넘으면 가장 오래된 것을 버린다(메모리 상한). */
export const INDEX_MAX_MEMBERS = 10;
/** 동시에 도는 색인 만들기 수 — 한 번에 여러 명이 처음 부르면 그만큼(색인마다 세션 여러 개) FTP 접속이 시간 상한까지 열린다. 넘으면 줄을 선다. */
export const INDEX_MAX_CONCURRENT_BUILDS = 2;

/**
 * 구성원별 색인을 들고 있다가 낡으면 다시 만든다. 같은 구성원의 색인 만들기는 한 번에 하나다.
 *  키에 FTP 아이디를 같이 넣는다 — 구성원이 자격을 다른 FTP 계정으로 바꾸면 옛 계정의 색인을 쓰지 않게.
 */
export class NasIndexCache {
  private states = new Map<string, IndexState>();
  private running = 0;
  private queue: Array<() => void> = [];
  constructor(
    private readonly now: () => number = Date.now,
    private readonly maxConcurrent = INDEX_MAX_CONCURRENT_BUILDS,
    private readonly errorText: IndexErrorText = NO_RAW_ERROR,
  ) {}

  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.maxConcurrent) await new Promise<void>((r) => this.queue.push(r));
    this.running++;
    try { return await fn(); } finally {
      this.running--;
      this.queue.shift()?.();
    }
  }

  get(key: string): IndexState {
    let s = this.states.get(key);
    if (!s) {
      s = { builtAt: null, result: null, building: null, error: null };
      this.states.set(key, s);
      this.evict(key);
    }
    return s;
  }

  isFresh(key: string): boolean {
    const s = this.states.get(key);
    return !!(s?.result && s.builtAt !== null && this.now() - s.builtAt < INDEX_TTL_MS);
  }

  /** 색인 만들기를 시작한다(이미 진행 중이면 그 약속을 돌려준다). */
  build(key: string, run: () => Promise<CrawlResult>): Promise<CrawlResult> {
    const s = this.get(key);
    if (s.building) return s.building;
    s.staleOnBuild = false; // 이전 build 가 실패해 남은 표시를 새 build 로 넘기지 않는다(그 전의 markStale 은 builtAt=null 로 이미 반영)
    const p = this.slot(run).then(
      (r) => { s.result = r; s.builtAt = s.staleOnBuild ? null : this.now(); s.error = null; return r; },
      (e: unknown) => { s.error = this.errorText(e); throw e; },
    ).finally(() => { s.building = null; });
    p.catch(() => {}); // 기다리는 쪽이 없을 수 있다(첫 호출이 시간 안에 못 받고 돌아간 경우)
    s.building = p;
    return p;
  }

  drop(key: string): void { this.states.delete(key); }

  /** NAS 를 바꾼 뒤 부른다 — 다음 검색이 색인을 다시 만든다(그동안은 직전 색인으로 답한다). */
  markStale(key: string): void {
    const s = this.states.get(key);
    if (!s) return;
    s.builtAt = null;
    if (s.building) s.staleOnBuild = true;
  }

  // 상한은 키 수로 센다. 진행 중인 키는 버리지 않으므로 잠깐 넘을 수 있다(동시 색인 수만큼).
  // keep = 방금 넣은 키. 아직 builtAt 이 없어 «가장 오래된 것»으로 보이지만, 곧 색인을 만들 자리라 버리면 안 된다.
  private evict(keep: string): void {
    while (this.states.size > INDEX_MAX_MEMBERS) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, v] of this.states) {
        if (k === keep || v.building) continue;
        const at = v.builtAt ?? -1;
        if (at < oldest) { oldest = at; oldestKey = k; }
      }
      if (oldestKey === null) break;
      this.states.delete(oldestKey);
    }
  }
}
