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
import { HttpError } from "../http-error.js";
import { memberMkdir, memberMv, memberRm, memberWriteFrom, UPLOAD_STALL_MS, UPLOAD_STALLED } from "./terminal-member-fs.js";

export const UPLOAD_TOO_LARGE = "too large"; // memberWriteFrom 이 이미 쓰던 문구 — 그대로 통일
export { UPLOAD_STALL_MS, UPLOAD_STALLED };  // 정지 상한(#1272) — 정의는 terminal-member-fs(순환 import 방지)

// 저장 이름의 정본 = **NFC**(#1278b). 맥은 파일명을 NFD(자모 분해)로 보내는데, 리눅스 ext4·NTFS 는 NFC/NFD 를
//  **서로 다른 이름**으로 본다(실측: 리눅스에서 NFC 로 다시 쓰면 파일이 2개가 된다). 그대로 저장하면 같은 문서가
//  OS 마다 다른 이름으로 갈라져 프로젝트 폴더 동기화가 중복을 만든다.
//  NFC 를 고르는 이유 — ① 상호교환 표준(UAX#15/W3C) ② 윈도·리눅스가 네이티브로 만드는 형태
//  ③ 맥은 NFC 를 폴딩으로 흡수한다(실측: NFC 이름으로 NFD 파일이 열리고, NFC 로 써도 사본이 안 생긴다)
//  ④ 한글이 음절당 3바이트(NFD 9바이트) → NAME_MAX·윈도 경로길이 여유가 3배.
//  ⚠ **생성 경로에만** 적용한다 — 읽기·삭제까지 정규화하면 예전에 NFD 로 저장된 파일에 접근할 수 없다.
export const nfcPath = (p: unknown): string => String(p ?? "").normalize("NFC");

// 파일명 상한(#1278) — ext4 등 리눅스 fs 의 **컴포넌트당 255바이트**. 문자 수가 아니라 바이트다.
const NAME_MAX = 255;
// UTF-8 경계를 깨지 않고 max 바이트 이하로 자른다(멀티바이트 문자 중간 절단 방지 — 자르면 U+FFFD 가 남아 그걸 떼낸다).
const truncBytes = (s: string, max: number): string => {
  const b = Buffer.from(s, "utf8");
  if (b.length <= max) return s;
  return b.subarray(0, max).toString("utf8").replace(/�+$/, "");
};
// 임시파일명은 `.<원본명>.upload-<hex12>` 라 원본보다 21바이트 길다. 그 길이를 상한에 대해 검사하지 않아
//  **원본은 저장 가능한데(≤255B) 임시파일명이 안 들어가** ENAMETOOLONG → 500 이 나던 버그(#1278).
//  맥은 한글 파일명을 NFD(자모 분해)로 보내 음절당 9바이트가 되므로, 화면상 40자 남짓한 이름도 240바이트를 넘어
//  흔히 걸렸다(md 374개 폴더 업로드에서 '간헐적 500' 으로 관측). → 원본명 쪽을 바이트 기준으로 잘라 상한을 지킨다.
//  유일성은 잘려도 hex 난수가 보장하고, 목적지 이름(rename 대상)은 원본 그대로라 최종 파일명은 손상되지 않는다.
const tmpPathFor = (abs: string): string => {
  const suffix = `.upload-${crypto.randomBytes(6).toString("hex")}`;
  const room = NAME_MAX - 1 - suffix.length;   // 1 = 앞에 붙는 dotfile 마커 '.'
  return path.join(path.dirname(abs), `.${truncBytes(path.basename(abs), room)}${suffix}`);
};

// src → 임시파일. 초과·끊김·쓰기오류·정지면 reject(임시파일 정리는 호출부).
function writeTmp(src: Readable, tmp: string, maxBytes: number, stallMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = fs.createWriteStream(tmp);
    let size = 0;
    let failed = false;
    let idle: NodeJS.Timeout | undefined;
    const clearIdle = (): void => { if (idle) { clearTimeout(idle); idle = undefined; } };
    const armIdle = (): void => {   // 청크마다 다시 셈 — 느린 회선은 살리고, 무진행 정지만 잡는다(#1272)
      clearIdle();
      if (stallMs > 0) idle = setTimeout(() => fail(new Error(UPLOAD_STALLED)), stallMs);
    };
    const fail = (e: Error): void => {
      if (failed) return;
      failed = true;
      clearIdle();
      src.unpipe(ws);
      ws.destroy(); // 레거시 pipe 는 source 오류 시 dest 를 안 닫는다 → fd 누수 방지로 직접 닫는다
      reject(e);
    };
    armIdle();
    src.on("data", (c: Buffer) => {
      size += c.length;
      armIdle();
      // 초과분은 더 읽지 않되 **소켓은 죽이지 않는다** — 죽이면 413 응답을 보낼 상대가 사라진다(그냥 실패로 보임).
      if (size > maxBytes) { src.pause(); fail(new Error(UPLOAD_TOO_LARGE)); }
    });
    src.on("end", clearIdle);   // 다 받았으면 ws.finish 까지의 flush 를 정지로 오판하지 않는다
    src.on("error", fail); // ← 클라이언트가 끊으면(취소) 여기로 온다: 'aborted' / ECONNRESET
    src.on("close", () => { if (!src.readableEnded) fail(new Error("aborted")); }); // error 없이 끊긴 경우 방어
    ws.on("error", fail);
    ws.on("finish", () => { clearIdle(); if (!failed) resolve(); });
    src.pipe(ws);
  });
}

// 업로드 수신: dirname mkdir -p → 임시파일 → 목적지로 rename.
//  실패·중단이면 임시파일만 지우고 목적지는 건드리지 않는다(기존 파일이 있었다면 그대로 살아있다).
//  osUser: 격리 멤버(#524)면 그 uid 로 써서 파일 소유자 = 멤버. null 이면 게이트웨이 uid.
export async function receiveUpload(
  src: Readable, abs: string, maxBytes: number, osUser: string | null, stallMs = UPLOAD_STALL_MS,
): Promise<void> {
  const tmp = tmpPathFor(abs);
  if (osUser) {
    await memberMkdir(osUser, path.dirname(abs));
    try {
      await memberWriteFrom(osUser, tmp, src, maxBytes, stallMs);
      await memberMv(osUser, tmp, abs);
    } catch (e) {
      await memberRm(osUser, tmp).catch(() => { /* 못 지워도 목적지는 무손상 */ });
      throw e;
    }
    return;
  }
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  try {
    await writeTmp(src, tmp, maxBytes, stallMs);
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
  // 정지(#1272) — 요청은 살아 있는데 본문이 오지 않는다. 취소와 달리 **응답할 상대가 있으므로** 말해 준다.
  //  전형적 원인: 사내 PC 문서보안(DLP) 에이전트나 프록시가 본문 중계를 멈춘 것(브라우저엔 그쪽이 403 을 준다).
  if (m === UPLOAD_STALLED) {
    return new HttpError(408, "업로드가 중간에 멈췄습니다(파일 본문이 도착하지 않음) — PC 보안프로그램(DLP)이나 사내 프록시가 파일 전송을 막고 있을 수 있습니다.");
  }
  if (/aborted|ECONNRESET|socket hang up|premature close/i.test(m)) return null;
  // 이름이 상한을 넘음(#1278) — 임시파일명은 이제 잘라서 지키므로 여기 오는 건 **목적지 이름 자체가** 255바이트 초과.
  //  500 으로 뭉개면 사용자가 원인을 못 찾는다(무엇을 줄여야 하는지 말해 준다). 격리 경로는 mv 의 stderr 로 오므로 문구도 함께 본다.
  if ((e as NodeJS.ErrnoException)?.code === "ENAMETOOLONG" || /ENAMETOOLONG|name too long/i.test(m)) {
    return new HttpError(400, `파일 이름이 너무 깁니다(한 이름에 ${NAME_MAX}바이트까지) — 이름을 줄여 다시 올려주세요. 한글은 맥에서 올리면 글자당 최대 9바이트로 계산됩니다.`);
  }
  // 디스크 부족(#813 T5) — '업로드 실패'(500)로 뭉뚱그리면 사용자가 파일 탓/네트워크 탓을 하며 계속 재시도한다.
  //  원인이 디스크면 그렇게 말하고 무엇을 해야 하는지 알려준다. (격리 멤버 경로는 자식 프로세스 stderr 로 온다.)
  if ((e as NodeJS.ErrnoException)?.code === "ENOSPC" || (e as NodeJS.ErrnoException)?.code === "EDQUOT"
      || /ENOSPC|no space left on device|quota exceeded/i.test(m)) {
    return new HttpError(507, "디스크 공간이 부족해 업로드하지 못했습니다 — 관리 ▸ 저장소·로그 에서 정리하세요.");
  }
  // 원인 미상 — 사용자에겐 짧게, **원인 오류는 cause 로 실어** wrap 이 로그에 남기게 한다(#1278: 500 이 무흔적이던 문제).
  return new HttpError(500, "업로드 실패", { cause: e });
}
