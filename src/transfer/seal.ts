// 워크스페이스 간 옮기기(#5458) — 묶음 파일에 비밀번호 걸기(선택).
//
// 결정(상민님 2026-11-09): 비밀번호는 «걸지 말지 고르게». 걸면 파일 전체를 암호화한다.
//  그래서 비밀번호를 건 파일은 운영체제 기본 압축 풀기로는 열리지 않고, 내용 확인은 라이블리 가져오기 화면의
//  미리보기가 맡는다(받는 쪽이 적용 전에 무엇이 들어오는지 본다).
//
// 형식(한 파일):
//   MAGIC("LIVELY-SEALED-BUNDLE\n") + 머리 JSON 한 줄("\n" 로 끝) + 암호문 + 인증 꼬리표(16바이트)
//   머리 = { v:1, alg:"aes-256-gcm", kdf:"scrypt", N, r, p, salt(b64), iv(b64) }
//  · 키는 scrypt(비밀번호, salt) — 비밀번호를 그대로 키로 쓰지 않는다(짧은 비밀번호의 무차별 대입을 늦춘다).
//  · MAGIC+머리 전체를 AAD 로 묶는다 — 머리(예: N 을 낮추거나 iv 를 바꾼 것)를 고치면 열 때 인증에서 걸린다.
//  · 열 때 머리 값의 범위를 먼저 본다 — 남이 만든 파일이 N=2^30 을 적어 서버 메모리를 태우지 못하게.
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, type ScryptOptions } from "node:crypto";

const MAGIC = Buffer.from("LIVELY-SEALED-BUNDLE\n", "ascii");
const TAG_BYTES = 16;
const DEFAULT_N = 1 << 15; // 32,768 — 메모리 128·N·r = 32MiB
const DEFAULT_R = 8;
const DEFAULT_P = 1;
const MAXMEM = 96 * 1024 * 1024;

export class SealPasswordError extends Error {}
export class SealFormatError extends Error {}

interface SealHeader { v: 1; alg: "aes-256-gcm"; kdf: "scrypt"; N: number; r: number; p: number; salt: string; iv: string }

function scrypt(password: string, salt: Buffer, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize("NFC"), salt, 32, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

/** 비밀번호를 건 묶음인가(MAGIC 으로 시작) */
export function isSealed(buf: Buffer): boolean {
  return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);
}

/** 비밀번호 규칙 — 너무 짧으면 거는 의미가 없다. 화면과 API 가 같은 문구를 쓴다. */
export function assertUsablePassword(password: string): void {
  if (password.length < 8) throw new SealPasswordError("비밀번호는 8자 이상이어야 합니다");
  if (password.length > 256) throw new SealPasswordError("비밀번호가 너무 깁니다(256자 이하)");
}

/** zip 한 덩어리를 비밀번호로 잠근다. */
export async function sealBundle(zip: Buffer, password: string): Promise<Buffer> {
  assertUsablePassword(password);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header: SealHeader = { v: 1, alg: "aes-256-gcm", kdf: "scrypt", N: DEFAULT_N, r: DEFAULT_R, p: DEFAULT_P, salt: salt.toString("base64"), iv: iv.toString("base64") };
  const head = Buffer.concat([MAGIC, Buffer.from(JSON.stringify(header) + "\n", "utf8")]);
  const key = await scrypt(password, salt, { N: header.N, r: header.r, p: header.p, maxmem: MAXMEM });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(zip), cipher.final()]);
  return Buffer.concat([head, body, cipher.getAuthTag()]);
}

/** 잠긴 묶음을 연다. 비밀번호가 틀리거나 파일이 바뀌었으면 SealPasswordError(둘을 가를 수 없다 — GCM 인증 실패는 같은 신호다). */
export async function openSealedBundle(buf: Buffer, password: string): Promise<Buffer> {
  if (!isSealed(buf)) throw new SealFormatError("비밀번호를 건 묶음 파일이 아닙니다");
  const nl = buf.indexOf(0x0a, MAGIC.length);
  if (nl < 0 || nl - MAGIC.length > 1024) throw new SealFormatError("잠긴 묶음의 머리가 망가졌습니다");
  let header: SealHeader;
  try { header = JSON.parse(buf.subarray(MAGIC.length, nl).toString("utf8")) as SealHeader; }
  catch { throw new SealFormatError("잠긴 묶음의 머리를 읽지 못했습니다"); }
  //  `null`·숫자도 JSON 이다 — 객체가 아니면 아래 칸 읽기가 TypeError(500)로 죽는다(리뷰 지적 2026-11-09).
  if (!header || typeof header !== "object" || Array.isArray(header)) throw new SealFormatError("잠긴 묶음의 머리가 망가졌습니다");
  if (header.v !== 1 || header.alg !== "aes-256-gcm" || header.kdf !== "scrypt") {
    throw new SealFormatError("모르는 잠금 방식입니다 — 이 파일은 더 새 라이블리에서 만들어졌을 수 있습니다");
  }
  // 범위 검사 — 메모리·시간을 태우는 값을 막는다(scrypt 메모리 ≈ 128·N·r).
  const okPow2 = Number.isInteger(header.N) && header.N >= 1024 && header.N <= (1 << 17) && (header.N & (header.N - 1)) === 0;
  if (!okPow2 || !Number.isInteger(header.r) || header.r < 1 || header.r > 16 || !Number.isInteger(header.p) || header.p < 1 || header.p > 4
    || 128 * header.N * header.r > MAXMEM) {
    throw new SealFormatError("잠긴 묶음의 머리 값이 허용 범위를 벗어났습니다");
  }
  const salt = Buffer.from(String(header.salt ?? ""), "base64");
  const iv = Buffer.from(String(header.iv ?? ""), "base64");
  if (salt.length < 8 || iv.length !== 12) throw new SealFormatError("잠긴 묶음의 머리 값이 잘못되었습니다");
  const head = buf.subarray(0, nl + 1);
  if (buf.length < head.length + TAG_BYTES) throw new SealFormatError("잠긴 묶음이 잘렸습니다");
  const body = buf.subarray(head.length, buf.length - TAG_BYTES);
  const tag = buf.subarray(buf.length - TAG_BYTES);
  const key = await scrypt(password, salt, { N: header.N, r: header.r, p: header.p, maxmem: MAXMEM });
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(head);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(body), decipher.final()]);
  } catch {
    throw new SealPasswordError("비밀번호가 맞지 않거나 파일이 바뀌었습니다");
  }
}
