// 업로드 수신 — **임시파일에 받아 다 받은 뒤 rename**(원자적 교체). 목적지 파일에 직접 쓰지 않는다.
//  왜(#797 — 업로드 취소): `createWriteStream(목적지)` + `req.pipe(ws)` 는 브라우저가 업로드를 끊는 순간
//  (취소 버튼·새로고침·네트워크 끊김) **부분 파일을 목적지에 그대로 남기고**, 덮어쓰기 업로드였다면
//  **원본을 잘라 없앤다**(open 이 즉시 truncate). 실제 재현: 43바이트 원본이 262KB 짜리 미완성 데이터로 덮였다.
//  → 임시파일 경유면 끊겨도 목적지는 손대지 않은 상태 그대로다. "N개 올리고 취소함"이 정직해진다.
//  임시파일은 **같은 폴더의 숨김 파일**이다: 같은 파일시스템이라 rename 이 원자적이고(EXDEV 없음),
//  dotfile 이라 목록·매니페스트(둘 다 dotfile 을 숨긴다)에 잠깐도 안 보인다.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Readable } from "node:stream";
import { HttpError } from "./capabilities/rest-util.js";
import { memberMkdir, memberMv, memberRm, memberWriteFrom } from "./terminal-member-fs.js";

export const UPLOAD_TOO_LARGE = "too large"; // memberWriteFrom 이 이미 쓰던 문구 — 그대로 통일

const tmpPathFor = (abs: string): string =>
  path.join(path.dirname(abs), `.${path.basename(abs)}.upload-${crypto.randomBytes(6).toString("hex")}`);

// src → 임시파일. 초과·끊김·쓰기오류면 reject(임시파일 정리는 호출부).
function writeTmp(src: Readable, tmp: string, maxBytes: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    let failed = false;
    const fail = (e: Error): void => {
      if (failed) return;
      failed = true;
      src.unpipe(ws);
      ws.destroy(); // 레거시 pipe 는 source 오류 시 dest 를 안 닫는다 → fd 누수 방지로 직접 닫는다
      reject(e);
    };
    src.on("data", (c: Buffer) => {
      size += c.length;
      // 초과분은 더 읽지 않되 **소켓은 죽이지 않는다** — 죽이면 413 응답을 보낼 상대가 사라진다(그냥 실패로 보임).
      if (size > maxBytes) { src.pause(); fail(new Error(UPLOAD_TOO_LARGE)); }
    });
    src.on("error", fail); // ← 클라이언트가 끊으면(취소) 여기로 온다: 'aborted' / ECONNRESET
    ws.on("error", fail);
    ws.on("finish", () => { if (!failed) resolve(); });
    src.pipe(ws);
  });
}

// 업로드 수신: dirname mkdir -p → 임시파일 → 목적지로 rename.
//  실패·중단이면 임시파일만 지우고 목적지는 건드리지 않는다(기존 파일이 있었다면 그대로 살아있다).
//  osUser: 격리 멤버(#524)면 그 uid 로 써서 파일 소유자 = 멤버. null 이면 게이트웨이 uid.
export async function receiveUpload(src: Readable, abs: string, maxBytes: number, osUser: string | null): Promise<void> {
  const tmp = tmpPathFor(abs);
  if (osUser) {
    await memberMkdir(osUser, path.dirname(abs));
    try {
      await memberWriteFrom(osUser, tmp, src, maxBytes);
      await memberMv(osUser, tmp, abs);
    } catch (e) {
      await memberRm(osUser, tmp).catch(() => { /* 못 지워도 목적지는 무손상 */ });
      throw e;
    }
    return;
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  try {
    await writeTmp(src, tmp, maxBytes);
    await fsp.rename(tmp, abs); // ← 여기까지 와야 목적지가 바뀐다(원자적)
  } catch (e) {
    await fsp.rm(tmp, { force: true }).catch(() => { /* 못 지워도 목적지는 무손상 */ });
    throw e;
  }
}

// 업로드 실패 → HTTP 에러. **취소(클라이언트가 끊음)면 null** — 응답할 상대가 없으니 조용히 끝낸다(500 로그도 남기지 않는다).
export function uploadError(e: unknown): HttpError | null {
  const m = e instanceof Error ? e.message : "";
  if (m === UPLOAD_TOO_LARGE) return new HttpError(413, "파일이 너무 큽니다(50MB 초과)");
  if (/aborted|ECONNRESET|socket hang up|premature close/i.test(m)) return null;
  return new HttpError(500, "업로드 실패");
}
