// on-demand 아티팩트 materialize (#541) — 바이너리 자료([BINARY] 스텁)의 원본을 커넥터에서 필요할 때만 내려받아
//  짧은 TTL 임시 경로에 저장하고 경로를 돌려준다. distill 세션이 그 경로를 Read(Claude PDF·이미지 네이티브 파싱)해
//  내용을 확보한다. 저장은 transient(mtime TTL opportunistic GC) — eager 전량 저장의 스토리지 폭발 회피.
//  커넥터 무관: connectors[external_system].fetchArtifact(external_id) 로 dispatch. 크기 캡은 여기(도구)가 단일정책으로 강제.
import { createWriteStream } from "node:fs";
import { mkdir, readdir, stat, unlink, writeFile } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import path from "node:path";
import { getSource } from "./source-store.js";
import { connectors } from "../connectors/index.js";
import { stateDir } from "../ops/state-dir.js";

const TTL_MS = 6 * 60 * 60 * 1000; // 임시 아티팩트 수명(6h) — Read 직후 무의미해지므로 짧게. mtime 기준 GC.
const MAX_ARTIFACT_BYTES = 50_000_000; // 단일 캡(50MB) — 커넥터는 상한 미적용, 여기서 size 선검사 + 스트리밍 abort.

// 임시경로: stateDir("artifact-cache") = 게이트웨이 런타임 쓰기 루트(#618, 서비스유저 소유). 파일 0644 — 격리 세션
//  유저(#524)도 크로스유저 Read 가능(notion-assets/drive-artifacts 패턴; tmpdir 0600 은 크로스유저 불가).
//  구 process.cwd()/data 는 WorkingDirectory 가 타 uid 소유면 EACCES(#606/#618 클래스) → stateDir 로 이관 완료.
function cacheDir(): string {
  return stateDir("artifact-cache");
}

const EXT_BY_MIME: Record<string, string> = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/tiff": "tiff",
};
// Read 가 확장자로 타입을 인지하므로 mime → 확장자 매핑(vision 대상 위주). 미지는 이미지면 서브타입, 아니면 bin.
function extFromMime(mime: string): string {
  const m = mime.toLowerCase().split(";")[0].trim();
  return EXT_BY_MIME[m] || (m.startsWith("image/") ? m.slice(6).replace(/[^a-z0-9]/g, "") || "img" : "bin");
}

// opportunistic GC — TTL 초과 파일 unlink. 매 materialize 앞에서 실행(캐시 파일 수 적어 저렴 → 별도 스케줄러 잡 불필요).
async function gcCache(dir: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return; // 디렉터리 없음 등 → GC 대상 없음
  }
  const now = Date.now();
  for (const n of names) {
    const p = path.join(dir, n);
    try {
      const st = await stat(p);
      if (now - st.mtimeMs > TTL_MS) await unlink(p);
    } catch {
      /* 경합/이미 삭제 무시 */
    }
  }
}

// 스트림/버퍼를 캡 강제하며 파일로 저장. 초과 시 abort+unlink+throw. 반환 = 저장 바이트 수.
async function writeCapped(input: Readable | Buffer, outPath: string, max: number): Promise<number> {
  if (Buffer.isBuffer(input)) {
    if (input.byteLength > max) throw new Error(`아티팩트 과대(${input.byteLength}B > ${max}B)`);
    await writeFile(outPath, input, { mode: 0o644 });
    return input.byteLength;
  }
  let total = 0;
  try {
    await pipeline(
      input,
      async function* (src: AsyncIterable<Buffer>) {
        for await (const chunk of src) {
          total += chunk.length;
          if (total > max) throw new Error(`아티팩트 스트리밍 상한 초과(${max}B) — 중단`);
          yield chunk;
        }
      },
      createWriteStream(outPath, { mode: 0o644 }),
    );
  } catch (e) {
    await unlink(outPath).catch(() => {});
    throw e;
  }
  return total;
}

export interface MaterializedArtifact {
  path: string;
  mime: string;
  bytes: number;
  expires_at: string;
}

// source_id → 커넥터에서 원본 on-demand 페치 → 임시경로 저장 → {path, mime, bytes, expires_at}.
//  unavailable(삭제/이동/미지원)·과대는 throw(도구가 에러 반환 → distill 이 그 자료 skip).
export async function materializeSourceArtifact(sourceId: number): Promise<MaterializedArtifact> {
  const src = await getSource(sourceId);
  if (!src) throw new Error(`자료 #${sourceId} 없음`);
  const system = typeof src.external_system === "string" ? src.external_system : "";
  const extId = typeof src.external_id === "string" ? src.external_id : "";
  if (!system || !extId) {
    throw new Error(`자료 #${sourceId} 는 외부 커넥터 파일이 아닙니다(external_system/external_id 없음)`);
  }
  const conn = connectors[system];
  if (!conn?.fetchArtifact) {
    throw new Error(`커넥터 '${system}' 는 on-demand 아티팩트(fetchArtifact)를 지원하지 않습니다`);
  }

  const art = await conn.fetchArtifact(extId);
  if (!art) {
    throw new Error(`아티팩트 unavailable — 원본 삭제/이동/권한상실 (source #${sourceId}, ${system}:${extId})`);
  }

  // size 힌트 선검사(캡 단일정책) — 스트림 소비 전 조기 차단.
  if (art.size != null && art.size > MAX_ARTIFACT_BYTES) {
    if (art.stream instanceof Readable) art.stream.destroy();
    throw new Error(`아티팩트 과대(${art.size}B > ${MAX_ARTIFACT_BYTES}B) — 페치 생략(source #${sourceId})`);
  }

  const dir = cacheDir();
  await mkdir(dir, { recursive: true });
  await gcCache(dir); // 쓰기 전 오래된 것 청소.

  const safeId = `${system}-${extId.replace(/[^a-zA-Z0-9._-]/g, "_")}`.slice(0, 120);
  const outPath = path.join(dir, `${safeId}.${extFromMime(art.mime)}`);
  const bytes = await writeCapped(art.stream, outPath, MAX_ARTIFACT_BYTES);

  return { path: outPath, mime: art.mime, bytes, expires_at: new Date(Date.now() + TTL_MS).toISOString() };
}
