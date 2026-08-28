// 세션 = 대화 **여럿** (#2233) — 타임라인이 세션 전체를 보려면 파일 하나로는 모자란다.
//
//  ── 무엇이 잘못됐었나 ──
//  화면의 타임라인은 「지금 붙어 있는 대화 파일」 하나만 읽었다(org_session_state.claude_session_id, last-write-wins).
//  그런데 한 박스는 살면서 대화를 여러 번 갈아탄다 — `/clear` · resume · **포크**(claude 가 「제목 (2)」 로 새 파일을
//  연다) · 맥락 압축 롤오버(compact_boundary). 갈아탈 때마다 그 전 대화의 질문이 화면에서 통째로 사라졌다.
//   실측(2026-08-27, box-jang-ebdb3a82): 그 박스 폴더에 대화 파일 5개 · 사람이 던진 질문 43개인데 타임라인엔 **1개**.
//
//  ── 무엇을 합치나(그리고 왜 폴더를 통째로 믿지 않나) ──
//  ① 기록된 사슬(org_session_conv) — 훅이 보고한 (박스, 대화) 쌍. **확정**이다. 오늘 이후의 모든 갈아탐을 덮는다.
//  ② 맥락 압축 사슬 — 파일 첫 줄 compact_boundary.logicalParentUuid 로 이어진 부모(terminal-transcript.findPrevTranscript).
//     파일 안의 증거라 확정이고, 기록이 없던 과거에도 통한다.
//  ③ 폴더의 나머지 대화 — **이 폴더를 이 박스만 쓸 때만**. 박스 세션 폴더(~/box/<나>/sessions/<box-id>)는 늘 단독이고,
//     프로젝트 폴더는 세션을 여럿 띄우면 공유된다(실측: project/1719 에 박스 11개). 공유 폴더를 통째로 합치면
//     **남의 질문이 내 타임라인에 뜬다** — 빠지는 것보다 나쁘다. 그래서 공유면 ①②만 쓴다.
//  어느 경우든 **다른 박스가 자기 것으로 갖고 있는 대화는 배제**한다(마지막 안전핀).
//
//  ── 읽기는 왜 여기서 안 하나 ──
//  여기서는 '어떤 파일들인가'만 정한다. 파일을 어떻게 여는지(로컬 fs · 멤버 실행환경 중계)는 transcript-fs 파사드가,
//  창 정렬·파싱은 window/parse-cache 가 이미 안다 — 라우트가 그 셋을 엮는다.
import path from "node:path";
import type { HarnessSessionAdapter } from "./adapter.js";
import type { TranscriptFs } from "./transcript-fs.js";
import { readAlignedWindow } from "./window.js";
import { parseWindow } from "./parse-cache.js";
import { toThinNdjson } from "./chat-line.js";

export interface ConvFile { uuid: string; file: string; size: number; mtimeMs: number }

export interface ConvChainOpts {
  /** 지금 붙어 있는 대화 파일(늘 사슬의 마지막). */
  curFile: string;
  curUuid: string;
  curSize: number;
  /** 이 폴더를 이 박스만 쓰나 — 아니면 폴더의 나머지는 안 본다(머리말 ③). */
  exclusive: boolean;
  /** 기록된 사슬(org_session_conv)의 대화 uuid — 확정. */
  known?: string[];
  /** 다른 박스가 갖고 있는 대화 uuid — 무슨 일이 있어도 배제. */
  taken?: ReadonlySet<string>;
  /** 사슬 전체(**지금 대화를 포함**)가 읽을 원문 바이트 상한. 넘치면 최신 대화부터 담고 거기서 끊는다. */
  budget: number;
  /** 사슬에 담을 파일 수 상한(폭주 방지). */
  maxFiles?: number;
}

const MAX_FILES = 12;
const COMPACT_HOPS = 8;

/** 이 대화 파일이 있는 폴더의 대화 uuid 전부(어댑터 규약을 통과한 이름만). '누가 가져갔나'를 한 번에 묻는 데 쓴다. */
export async function convUuidsInDir(io: HarnessSessionAdapter, tfs: TranscriptFs, anyFile: string): Promise<string[]> {
  const entries = await tfs.listDir(path.dirname(anyFile)).catch(() => []);
  return entries.filter((e) => io.filePattern.test(e.name)).map((e) => e.name.replace(/\.[A-Za-z0-9]+$/, ""));
}

/**
 * 이 세션이 살면서 돌린 대화 파일들 — **오래된 → 최신** 순. 첫 원소가 가장 오래된 대화, 마지막이 지금 대화다.
 * 지금 대화는 어떤 경우에도 빠지지 않는다(사슬을 못 만들어도 최소 1개).
 */
export async function resolveConvChain(
  io: HarnessSessionAdapter, tfs: TranscriptFs, opts: ConvChainOpts,
): Promise<ConvFile[]> {
  const dir = path.dirname(opts.curFile);
  const taken = opts.taken ?? new Set<string>();
  const maxFiles = opts.maxFiles ?? MAX_FILES;

  // 폴더에 무엇이 있나 — 이름은 어댑터 규약을 통과한 것만(claude 는 <uuid>.jsonl).
  const entries = (await tfs.listDir(dir).catch(() => []))
    .filter((e) => io.filePattern.test(e.name));
  const mtimeOf = new Map(entries.map((e) => [e.name, e.mtimeMs] as const));
  const uuidOfName = (name: string): string => name.replace(/\.[A-Za-z0-9]+$/, "");
  const nameOfUuid = new Map(entries.map((e) => [uuidOfName(e.name), e.name] as const));

  // ── 후보 모으기 ──
  const want = new Set<string>();                       // 대화 uuid
  for (const u of opts.known ?? []) if (u && u !== opts.curUuid) want.add(u);
  //  ② 맥락 압축 사슬 — 지금 파일에서 거슬러 올라간다(파일 안의 증거라 공유 폴더에서도 안전).
  let cursor: string | null = opts.curFile;
  for (let hop = 0; hop < COMPACT_HOPS && cursor; hop++) {
    const prev: string | null = await tfs.prevTranscript(cursor).catch(() => null);
    if (!prev || prev === opts.curUuid || want.has(prev)) break;
    want.add(prev);
    const nm = nameOfUuid.get(prev);
    cursor = nm ? path.join(dir, nm) : null;
  }
  //  ③ 단독 폴더면 나머지도 이 박스의 것이다.
  if (opts.exclusive) for (const e of entries) { const u = uuidOfName(e.name); if (u !== opts.curUuid) want.add(u); }

  // ── 실물로 굳히기 ──
  const olders: ConvFile[] = [];
  for (const uuid of want) {
    if (taken.has(uuid)) continue;
    const name = nameOfUuid.get(uuid);
    if (!name) continue;                                // 폴더에 없는 대화(지워졌거나 다른 호스트) — 조용히 건너뛴다
    const file = path.join(dir, name);
    if (file === opts.curFile) continue;
    const size = await tfs.stat(file).catch(() => null);
    if (!size) continue;                                // 0바이트·없음
    olders.push({ uuid, file, size, mtimeMs: mtimeOf.get(name) ?? 0 });
  }
  olders.sort((a, b) => a.mtimeMs - b.mtimeMs);

  // ── 예산 — 최신부터 담고, 안 들어가는 순간 **거기서 끊는다**. 지금 대화는 예산과 무관하게 늘 담는다. ──
  //  ⚠ 못 담은 것을 건너뛰고 더 작은 옛 대화를 마저 담으면 사슬 **가운데가 빈다** — 화면엔 옛 질문과 최근 질문
  //   사이가 통째로 사라진 것처럼 보이고, 그건 "앞부분만 못 불러왔어요"라는 안내로 설명되지 않는다.
  //   잘림은 늘 **앞쪽 한 군데**여야 한다(파일 안에서 꼬리부터 읽는 것과 같은 규율).
  //  ⚠ 예산은 지금 대화까지 **포함한** 총량이다 — 세션 화면을 열 때마다 게이트웨이가 파싱하는 양의 천장이고,
  //   그 천장이 사슬 때문에 늘어나면 안 된다(종전엔 파일 하나에 같은 상한이 걸려 있었다).
  const cur: ConvFile = { uuid: opts.curUuid, file: opts.curFile, size: opts.curSize, mtimeMs: Number.MAX_SAFE_INTEGER };
  const picked: ConvFile[] = [];
  let spent = Math.min(opts.curSize, opts.budget);
  for (let i = olders.length - 1; i >= 0; i--) {
    if (picked.length + 1 >= maxFiles) break;
    const f = olders[i];
    if (spent + f.size > opts.budget) break;
    spent += f.size;
    picked.push(f);
  }
  picked.sort((a, b) => a.mtimeMs - b.mtimeMs);
  return [...picked, cur];
}

// ── 사슬 읽기 ────────────────────────────────────────────────────────────────
//  지난 대화 파일은 **더 자라지 않는다**(끝난 대화다). 그래서 (경로+크기)가 같으면 얇은 판도 같다 —
//  세션 화면을 열 때마다 수십 MB 를 다시 파싱하지 않도록 그 결과만 들고 있는다. 지금 대화는 계속 자라
//  거의 늘 빗나가므로 캐시가 있으나 마나지만, 옛 파일에서 값을 다 뽑는다(사슬의 덩치는 거기 있다).
//  ⚠ 열쇠에 **상한(cap)까지** 넣는다 — 얇은 판의 내용은 (파일, 크기) 만으로 정해지지 않는다. 상한이 작으면
//   꼬리부터만 읽으므로 같은 파일이라도 답이 다르고, '앞이 잘렸다(from)'도 함께 달라진다. 상한을 뺀 열쇠로
//   캐시하면 잘린 판을 안 잘린 것처럼 돌려주게 된다(실측: 테스트 [16]이 from=0 으로 잡아냈다).
interface ThinPart { text: string; from: number }
const thinCache = new Map<string, ThinPart>();
let thinCacheBytes = 0;
const THIN_CACHE_MAX = 32 * 1024 * 1024;

function thinCached(key: string): ThinPart | undefined {
  const hit = thinCache.get(key);
  if (hit === undefined) return undefined;
  thinCache.delete(key); thinCache.set(key, hit);          // LRU — 방금 쓴 것을 맨 뒤로
  return hit;
}
function thinRemember(key: string, part: ThinPart): void {
  if (part.text.length > THIN_CACHE_MAX) return;
  thinCache.set(key, part); thinCacheBytes += part.text.length;
  while (thinCacheBytes > THIN_CACHE_MAX) {
    const oldest = thinCache.keys().next().value;
    if (oldest === undefined) break;
    thinCacheBytes -= (thinCache.get(oldest)?.text ?? "").length;
    thinCache.delete(oldest);
  }
}

/**
 * 사슬을 통째로 **얇은 판**(#1819 fmt=thin) 으로. 오래된 대화가 앞에, 지금 대화가 뒤에 온다.
 * 돌려주는 `from` 은 **가장 오래된 파일에서 잘라 낸 앞머리 바이트** — 0 이 아니면 화면이 "앞이 잘렸다"를 알린다.
 */
export async function readThinChain(
  io: HarnessSessionAdapter, tfs: TranscriptFs, chain: ConvFile[], perFileCap: number, source: string,
): Promise<{ ndjson: string; from: number }> {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < chain.length; i++) {
    const f = chain[i];
    const key = `${f.file}|${f.size}|${perFileCap}`;
    const done = i < chain.length - 1;                                // 지금 대화는 계속 자라므로 캐시하지 않는다
    let part = done ? thinCached(key) : undefined;
    if (!part) {
      const start = Math.max(0, f.size - perFileCap);
      let text = "";
      if (f.size > start) {
        const win = await tfs.read(f.file, f.size, (r) => readAlignedWindow(r, f.size, start, f.size, false)).catch(() => null);
        if (win && win.data.length) {
          const lines = parseWindow(io.parse!, `${source}|${f.file}`, win.from, win.to, win.data.toString("utf8"));
          text = toThinNdjson(lines);
        }
      }
      part = { text, from: start };
      if (done) thinRemember(key, part);
    }
    if (i === 0) from = part.from;
    if (part.text) parts.push(part.text);
  }
  return { ndjson: parts.join(""), from };
}
