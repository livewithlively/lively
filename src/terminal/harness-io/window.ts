// 줄 경계에 맞춘 창(window) 읽기 — 대화 파일(로컬)과 중앙 세션 기록(DB 청크) **공용** (#1719 #1746).
//
//  ── 왜 ──
//  대화창은 파일을 바이트 오프셋으로 창을 내어 읽는다(꼬리 tail · 위로 [from,to) · 증분 from~). 바이트 오프셋은 줄 중간에 떨어질 수
//  있는데, 반 줄은 JSON 으로 못 읽는다. 종전엔 화면이 '첫 줄 버리기'와 '마지막 조각 이어붙이기(carry)'로 때웠고, 그 규칙이 창마다
//  달라 이음새에서 줄이 하나 사라지거나 두 번 그려질 자리가 있었다. 이제 **서버가 창을 줄 경계로 맞춰서** 준다 — 화면은 받은
//  X-Log-From/To 를 그대로 다음 창의 경계로 쓰면 된다(버리기·이어붙이기 없음).
//
//  ── 규칙 ──
//  · 시작: start>0 이고 그 앞 바이트가 개행이 아니면(줄 중간) → 다음 개행 뒤로 민다. 그 반 줄은 **앞 창의 것**이다.
//  · 끝:  ① 호출자가 to 를 명시했고(위로 읽기) end 가 줄 중간이면 → 다음 개행까지 **늘려** 읽는다(그 줄이 이 창의 마지막 줄).
//         그래야 앞 창의 시작(위 규칙으로 밀린 자리)과 정확히 만난다.
//        ② 끝이 파일 끝(증분·꼬리)인데 개행으로 안 끝나면(하네스가 쓰는 중) → 마지막 개행까지 **줄여** 준다. 반 줄은 다음 폴에서.
//  · 한 줄이 아무리 길어도 잃지 않되, 무한히 읽지는 않는다(MAX_LINE_SCAN) — 넘으면 그 자리에서 끊는다(다음 창이 이어 읽는다).
import { TRANSCRIPT_MAX_CHUNK } from "../../sessions/transcript-range.js";

/** 바이트 구간을 읽어 주는 것 — 파일 핸들이든 DB 청크든. [start,end) 를 돌려준다(짧게 돌려줘도 된다 = EOF). */
export interface ByteReader { read(start: number, end: number): Promise<Buffer> }

const NL = 0x0a;
const SCAN_STEP = 64 * 1024;                 // 개행을 찾아 더 읽을 때 한 번에 읽는 크기
const MAX_LINE_SCAN = TRANSCRIPT_MAX_CHUNK;   // 개행을 찾아 더 읽는 상한 — 이 안에 개행이 없으면 그 자리에서 끊는다

export interface AlignedWindow { from: number; to: number; data: Buffer }

/**
 * [start,end) 를 줄 경계에 맞춰 읽는다. size = 전체 길이(워터마크). extendEnd = to 가 명시됐나(끝을 늘려 맞출지, 줄여 맞출지).
 * 반환 from/to 가 화면의 다음 창 경계다. 빈 창이면 data.length==0, from==to.
 */
export async function readAlignedWindow(reader: ByteReader, size: number, start: number, end: number, extendEnd: boolean): Promise<AlignedWindow> {
  start = Math.max(0, Math.min(start, size)); end = Math.max(start, Math.min(end, size));
  if (end <= start) return { from: start, to: start, data: Buffer.alloc(0) };
  let buf = await reader.read(start, end);
  let bufStart = start;                       // buf[0] 의 파일 오프셋
  // ── 시작 정렬: 줄 중간이면 다음 개행 뒤로 ──
  if (start > 0) {
    const prev = await reader.read(start - 1, start);
    if (prev.length !== 1 || prev[0] !== NL) {
      let nl = buf.indexOf(NL);
      let scanned = buf.length;
      while (nl < 0 && bufStart + scanned < size && scanned < MAX_LINE_SCAN) {   // 창 안에 개행이 없다 — 더 읽어 찾는다
        const more = await reader.read(bufStart + scanned, Math.min(size, bufStart + scanned + SCAN_STEP));
        if (!more.length) break;
        buf = Buffer.concat([buf, more]); nl = buf.indexOf(NL, scanned); scanned = buf.length;
      }
      if (nl < 0) return { from: start, to: start, data: Buffer.alloc(0) };   // 이 창엔 온전한 줄이 없다
      buf = buf.subarray(nl + 1); bufStart = bufStart + nl + 1;
    }
  }
  // 시작 정렬이 요청 끝을 넘겨 읽었으면 요청 끝으로 되돌린다 — 그 너머는 다음(아래) 창이 이미 그린 줄이다(끝 늘리기는 아래에서 요청 끝 기준으로만).
  if (bufStart + buf.length > end) buf = buf.subarray(0, Math.max(0, end - bufStart));
  if (!buf.length) return { from: Math.min(bufStart, end), to: Math.min(bufStart, end), data: Buffer.alloc(0) };
  // ── 끝 정렬 ──
  let curEnd = bufStart + buf.length;         // 지금 buf 가 덮는 파일 오프셋 끝(== end)
  const endsWithNl = (): boolean => buf.length > 0 && buf[buf.length - 1] === NL;
  if (extendEnd && curEnd < size && !endsWithNl()) {
    // to 명시(위로 읽기): 다음 개행까지 늘린다 — 그 줄이 이 창의 마지막 줄(앞 창의 시작이 거기서 밀렸다).
    let scanned = 0;
    while (curEnd < size && scanned < MAX_LINE_SCAN) {
      const more = await reader.read(curEnd, Math.min(size, curEnd + SCAN_STEP));
      if (!more.length) break;
      const nl = more.indexOf(NL);
      if (nl >= 0) { buf = Buffer.concat([buf, more.subarray(0, nl + 1)]); curEnd += nl + 1; break; }
      buf = Buffer.concat([buf, more]); curEnd += more.length; scanned += more.length;
    }
  }
  if (!endsWithNl()) {
    // 파일 끝(쓰는 중)이거나 상한에 걸림 — 마지막 개행까지만. 반 줄은 다음 창(다음 폴)이 이어 읽는다.
    const last = buf.lastIndexOf(NL);
    if (last < 0) return { from: bufStart, to: bufStart, data: Buffer.alloc(0) };
    buf = buf.subarray(0, last + 1); curEnd = bufStart + last + 1;
  }
  return { from: bufStart, to: curEnd, data: buf };
}

/** 파일 핸들 → ByteReader. */
export function fileReader(fh: { read(buf: Buffer, off: number, len: number, pos: number): Promise<{ bytesRead: number }> }): ByteReader {
  return {
    async read(start, end) {
      const n = end - start;
      if (n <= 0) return Buffer.alloc(0);
      const b = Buffer.alloc(n);
      const r = await fh.read(b, 0, n, start);
      return b.subarray(0, r.bytesRead);
    },
  };
}

/**
 * 비싼 구간 읽기(원격 중계 exec 한 번 = 허브→노드→컨테이너 왕복) 앞에 두는 선읽기 캐시.
 *  readAlignedWindow 는 한 창에 read 를 여러 번 부른다 — 본 구간 · 시작 정렬용 `start-1` 한 바이트 · 끝 정렬용 SCAN_STEP
 *  전진. 원격에선 그게 전부 왕복이라, 첫 미스에서 **[start-1, end+SCAN_STEP)** 을 한 번에 당겨 두면 정상 경로는 왕복 1회다.
 *  캐시 밖(아주 긴 줄을 계속 좇는 경우)만 다시 당긴다. size = 파일 워터마크(그 너머는 요청하지 않는다).
 */
export function prefetchReader(fetch: (start: number, end: number) => Promise<Buffer>, size: number): ByteReader {
  let cacheStart = 0, cache: Buffer = Buffer.alloc(0);
  const covered = (s: number, e: number): boolean => cache.length > 0 && s >= cacheStart && e <= cacheStart + cache.length;
  return {
    async read(start, end) {
      const s = Math.max(0, start), e = Math.min(size, end);
      if (e <= s) return Buffer.alloc(0);
      if (!covered(s, e)) {
        const fs = Math.max(0, s - 1), fe = Math.min(size, e + SCAN_STEP);
        cache = await fetch(fs, fe); cacheStart = fs;
        // 짧게 돌아왔으면(파일이 그새 줄었거나 EOF) 덮는 범위도 그만큼이다 — covered 가 그 사실을 반영한다.
        if (!covered(s, Math.min(e, cacheStart + cache.length))) return Buffer.alloc(0);
      }
      return cache.subarray(s - cacheStart, Math.min(e, cacheStart + cache.length) - cacheStart);
    },
  };
}
