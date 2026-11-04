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

export const DEFAULT_LIMITS: CrawlLimits = { maxDirs: 20_000, maxEntries: 200_000, deadlineMs: 10 * 60_000 };

export interface CrawlResult {
  entries: NasEntry[];
  dirs: number;
  /** 상한(폴더 수·항목 수·시간)에 걸려 끝까지 못 훑었으면 그 까닭. */
  truncated: string | null;
  /** 들어가지 못한 폴더 수(권한 없음 등). */
  failedDirs: number;
}

/** 폴더 하나의 LIST 본문을 주는 함수 — 실제로는 FtpSession.list, 시험에선 가짜. */
export type DirLister = (rawDir: string) => Promise<string>;

const joinRaw = (dir: string, name: string): string => (dir === "/" ? `/${name}` : `${dir}/${name}`);

/** root 아래를 너비 우선으로 훑는다. 심볼릭 링크는 따라가지 않는다(순환·chroot 밖 방지). */
export async function crawl(list: DirLister, root = "/", limits: CrawlLimits = DEFAULT_LIMITS, now: () => number = Date.now): Promise<CrawlResult> {
  const started = now();
  const entries: NasEntry[] = [];
  const queue: string[] = [root];
  let dirs = 0;
  let failedDirs = 0;
  let truncated: string | null = null;
  while (queue.length) {
    if (dirs >= limits.maxDirs) { truncated = `폴더 ${limits.maxDirs}개 상한`; break; }
    if (now() - started > limits.deadlineMs) { truncated = `시간 상한 ${Math.round(limits.deadlineMs / 1000)}초`; break; }
    const dir = queue.shift()!;
    dirs++;
    let items: FtpListEntry[];
    try {
      items = parseListing(await list(dir));
    } catch {
      failedDirs++;
      continue;
    }
    for (const it of items) {
      if (it.type !== "file" && it.type !== "dir") continue;
      const raw = joinRaw(dir, it.name);
      entries.push({ raw, path: displayPath(raw), type: it.type, size: it.size, mtime: it.mtime });
      if (it.type === "dir") queue.push(raw);
      if (entries.length >= limits.maxEntries) break;
    }
    if (entries.length >= limits.maxEntries) { truncated = `항목 ${limits.maxEntries}개 상한`; break; }
  }
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
  error: string | null;
}

export const INDEX_TTL_MS = 12 * 60 * 60_000;
/** 동시에 들고 있는 구성원 색인 수 — 넘으면 가장 오래된 것을 버린다(메모리 상한). */
export const INDEX_MAX_MEMBERS = 10;

/**
 * 구성원별 색인을 들고 있다가 낡으면 다시 만든다. 같은 구성원의 색인 만들기는 한 번에 하나다.
 *  키에 FTP 아이디를 같이 넣는다 — 구성원이 자격을 다른 FTP 계정으로 바꾸면 옛 계정의 색인을 쓰지 않게.
 */
export class NasIndexCache {
  private states = new Map<string, IndexState>();
  constructor(private readonly now: () => number = Date.now) {}

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
    const p = run().then(
      (r) => { s.result = r; s.builtAt = this.now(); s.error = null; return r; },
      (e: unknown) => { s.error = e instanceof Error ? e.message : String(e); throw e; },
    ).finally(() => { s.building = null; });
    p.catch(() => {}); // 기다리는 쪽이 없을 수 있다(첫 호출이 시간 안에 못 받고 돌아간 경우)
    s.building = p;
    return p;
  }

  drop(key: string): void { this.states.delete(key); }

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
