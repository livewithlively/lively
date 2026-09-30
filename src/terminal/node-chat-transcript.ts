// 원격 노드 대화 읽기 (#3982·#3870) — 파일은 노드에서 제한 청크로, 해석은 게이트웨이의 하네스 파서로 한다.
//
// 하네스 응답은 노드 로컬 기록에 영속되지만 중앙 session_log가 비어 있을 수 있다(Codex app-server는 Stop 훅이
// 돌지 않고, Claude 노드 파일도 중앙 호스트에 없다). 따라서 대화 UI가 중앙 기록으로 물러나면 답과 실행 설정을 잃는다. 노드는 임의 경로가 아닌
// 검증된 session id + threadId만 받아 하네스 규약 안의 원문 바이트를 돌려주고, 게이트웨이가 줄 정렬·파싱·인가를 맡는다.
import { transcriptRange } from "../sessions/transcript-range.js";
import { harnessIo } from "./harness-io/adapter.js";
import { toNdjson, toThinNdjson } from "./harness-io/chat-line.js";
import { parseWindow } from "./harness-io/parse-cache.js";
import { prefetchReader, readAlignedWindow } from "./harness-io/window.js";

export interface NodeRolloutChunk {
  found: boolean;
  size: number;
  offset: number;
  data: string;
  eof: boolean;
}

type TranscriptRpc = (
  nodeId: string,
  op: "chatTranscript",
  args: Record<string, unknown>,
) => Promise<unknown>;

export interface NodeTranscript {
  uuid: string;
  harness: string;
  bytes: number;
  from: number;
  to: number;
  ndjson: string;
}

const DEFAULT_CHUNK_BYTES = 384 * 1024;

const asChunk = (raw: unknown): NodeRolloutChunk | null => {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const size = Number(o.size), offset = Number(o.offset);
  if (typeof o.found !== "boolean" || !Number.isFinite(size) || size < 0 || !Number.isFinite(offset) || offset < 0 || typeof o.data !== "string") return null;
  return { found: o.found, size: Math.floor(size), offset: Math.floor(offset), data: o.data, eof: o.eof === true };
};

export async function readNodeTranscript(o: {
  nodeId: string;
  sessionId: string;
  threadId: string;
  harness: string;
  query: { from?: unknown; to?: unknown; tail?: unknown; fmt?: unknown };
  rpc: TranscriptRpc;
  /** 테스트 seam. 운영은 WS 1MB 아래의 안전한 청크를 쓴다. */
  chunkBytes?: number;
}): Promise<NodeTranscript | null> {
  const io = harnessIo(o.harness);
  if (!io?.parse || !/^[A-Za-z0-9._-]{8,128}$/.test(o.threadId) || (io.convIdOk && !io.convIdOk(o.threadId))) return null;
  const chunkBytes = Math.max(1, Math.min(DEFAULT_CHUNK_BYTES, Math.floor(o.chunkBytes ?? DEFAULT_CHUNK_BYTES)));
  const stat = asChunk(await o.rpc(o.nodeId, "chatTranscript", { id: o.sessionId, threadId: o.threadId, offset: 0, len: 0 }));
  if (!stat?.found) return null;
  const size = stat.size;
  const { start, end } = transcriptRange(size, o.query);
  const reader = prefetchReader(async (from, to) => {
    const parts: Buffer[] = [];
    let offset = from;
    while (offset < to) {
      const len = Math.min(chunkBytes, to - offset);
      const part = asChunk(await o.rpc(o.nodeId, "chatTranscript", {
        id: o.sessionId, threadId: o.threadId, offset, len,
      }));
      if (!part?.found || part.offset !== offset) break;
      const buf = Buffer.from(part.data, "base64");
      if (!buf.length || buf.length > len) break;
      const accepted = buf.subarray(0, Math.min(buf.length, to - offset));
      parts.push(accepted);
      offset += accepted.length;
      if (part.eof) break;
    }
    return Buffer.concat(parts);
  }, size);
  const win = end > start
    ? await readAlignedWindow(reader, size, start, end, o.query.to !== undefined)
    : { from: start, to: start, data: Buffer.alloc(0) };
  const lines = win.data.length
    ? parseWindow(io.parse, `node|${o.nodeId}|${o.sessionId}|${io.key}|${o.threadId}`, win.from, win.to, win.data.toString("utf8"))
    : [];
  return {
    uuid: o.threadId,
    harness: io.key,
    bytes: size,
    from: win.from,
    to: win.to,
    ndjson: String(o.query.fmt ?? "") === "thin" ? toThinNdjson(lines) : toNdjson(lines),
  };
}
