// 노드 로컬 대화 기록 제한 읽기 — RPC가 받은 session id를 이 노드의 실제 세션 메타와 결합해 경로를 정한다.
//
// Codex rollout은 날짜가 든 파일 이름이라 전용 탐색기를 쓰고, Claude 등 규약 경로가 있는 하네스는 공통
// harness-io locate를 쓴다. 어느 쪽도 호출자가 파일 경로를 넘길 수 없다. 이 경계를 지켜야 게이트웨이의
// 세션 접근 허가가 노드의 임의 파일 읽기로 넓어지지 않는다.
import fsp from "node:fs/promises";
import type { SessionInfo } from "../terminal/catalog.js";
import { harnessIo } from "../terminal/harness-io/adapter.js";
import { CODEX_TRANSCRIPT_CHUNK_BYTES, readLocalRolloutChunk, type LocalRolloutChunk } from "../terminal/harness-io/codex-app-server-daemon.js";
import { locateTranscript, type LocateCtx, type Located } from "../terminal/harness-io/locate.js";

const NOT_FOUND: LocalRolloutChunk = { found: false, size: 0, offset: 0, data: "", eof: true };

type SessionTranscript = Pick<SessionInfo, "harness" | "dir" | "owner">;
type Locate = (adapter: NonNullable<ReturnType<typeof harnessIo>>, ctx: LocateCtx) => Promise<Located | null>;

export interface LocalChatTranscriptDeps {
  locate?: Locate;
  readCodex?: typeof readLocalRolloutChunk;
}

async function readFileChunk(file: string, offsetRaw: number, lenRaw: number): Promise<LocalRolloutChunk> {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile()) return NOT_FOUND;
    const size = st.size;
    const offset = Number.isFinite(offsetRaw) ? Math.max(0, Math.min(size, Math.floor(offsetRaw))) : 0;
    const len = Number.isFinite(lenRaw) ? Math.max(0, Math.min(CODEX_TRANSCRIPT_CHUNK_BYTES, Math.floor(lenRaw))) : 0;
    if (len === 0 || offset >= size) return { found: true, size, offset, data: "", eof: offset >= size };
    const fh = await fsp.open(file, "r");
    try {
      const buf = Buffer.alloc(Math.min(len, size - offset));
      const { bytesRead } = await fh.read(buf, 0, buf.length, offset);
      return { found: true, size, offset, data: buf.subarray(0, bytesRead).toString("base64"), eof: offset + bytesRead >= size };
    } finally { await fh.close(); }
  } catch { return NOT_FOUND; }
}

/** 실제 노드 세션 메타와 서버 보관 대화 id로만 로컬 기록을 읽는다. len=0은 크기 조회다. */
export async function readLocalSessionTranscriptChunk(
  session: SessionTranscript | null | undefined,
  threadId: string,
  offset: number,
  len: number,
  deps: LocalChatTranscriptDeps = {},
): Promise<LocalRolloutChunk> {
  if (!session) return NOT_FOUND;
  const io = harnessIo(session.harness);
  if (!io?.parse || !threadId || (io.convIdOk && !io.convIdOk(threadId))) return NOT_FOUND;
  if (io.key === "codex") return (deps.readCodex ?? readLocalRolloutChunk)(threadId, offset, len);
  if (!io.pathFor) return NOT_FOUND;
  const found = await (deps.locate ?? locateTranscript)(io, { cwd: session.dir, convId: threadId, owner: session.owner });
  return found ? readFileChunk(found.file, offset, len) : NOT_FOUND;
}
