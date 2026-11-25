// NAS 올리기 순서 — 같은 폴더의 임시 이름으로 받은 뒤 제 이름으로 옮긴다(nas-download-route.ts 의 PUT 이 쓴다).
//  FTP 연결과 떼어 둔 이유: 순서·정리 분기가 이 기능에서 가장 틀리기 쉬운 곳이라 가짜 세션으로 표 테스트한다.
import type { Readable } from "node:stream";

export interface UploadOps {
  size(raw: string): Promise<number | null>;
  stor(raw: string, body: Readable): Promise<number>;
  rename(fromRaw: string, toRaw: string): Promise<void>;
}

export type UploadResult =
  | { kind: "exists"; size: number }
  | { kind: "stored"; bytes: number; overwritten: boolean };

/**
 * overwrite 가 아니면 같은 이름이 있을 때 올리지 않고 그 크기를 돌려준다. 받은 바이트가 선언(declared)과 다르면 실패다.
 *  임시 파일이 남았을 수 있는 모든 실패에서 cleanupTemp 를 부른다 — 실패한 세션은 이미 버려졌을 수 있어 정리는 호출자가 새 세션으로 한다.
 */
export async function uploadAtomically(
  ops: UploadOps,
  o: { temp: string; target: string; overwrite: boolean; body: Readable; declared: number | null },
  cleanupTemp: () => Promise<void>,
): Promise<UploadResult> {
  const existing = await ops.size(o.target);
  if (existing !== null && !o.overwrite) return { kind: "exists", size: existing };
  // STOR 가 150 을 받는 순간 서버에 임시 파일이 생긴다 — 그 뒤 어디서 끊겨도 정리하도록 STOR 앞에서 표시한다.
  //  150 전에 거절됐다면 정리(DELE)가 «없음»으로 실패할 뿐이다.
  let tempMayExist = true;
  try {
    const bytes = await ops.stor(o.temp, o.body);
    if (o.declared !== null && bytes !== o.declared) throw new Error(`받은 바이트(${bytes})가 선언(${o.declared})과 다릅니다`);
    // 받는 사이 누가 같은 이름을 만들었으면 덮지 않는다 — FTP 에 «없을 때만 옮기기»가 없어 창을 이 확인 한 번으로 좁힌다
    if (!o.overwrite) {
      const now = await ops.size(o.target);
      if (now !== null) return { kind: "exists", size: now };
    }
    await ops.rename(o.temp, o.target);
    tempMayExist = false;
    return { kind: "stored", bytes, overwritten: existing !== null };
  } finally {
    if (tempMayExist) await cleanupTemp().catch(() => {});
  }
}
