// 시크릿 봉투(at-rest 암호화) — 웹UI로 관리하는 git 자격(SSH 개인키·HTTPS 토큰) 등 **복원 가능한**
//  시크릿을 DB에 넣기 위한 대칭 암호화. (기존 관례인 env-ref/해시로는 복원이 불가 — git 자격은 실제로
//  git 에 넣어줘야 하므로 복원 가능한 암호화가 필요하다. #540 윤상민 결정: 웹 관리 편의 위해 DB 저장.)
//
//  AES-256-GCM(기밀+무결성). 키는 env ENCRYPTION_KEY(임의 길이 passphrase) → scryptSync 로 32B 유도(모듈
//   로드 1회 캐시, 고정 salt 로 도메인분리). 키 미설정이면 **fail-closed**(암·복호 모두 throw) — 평문 저장 금지.
//  포맷: "gcm1.<iv_b64url>.<tag_b64url>.<ct_b64url>" (버전 프리픽스로 향후 회전 여지).
import crypto from "node:crypto";

const SCRYPT_SALT = Buffer.from("lively:git-credential:v1"); // 고정 salt = 도메인 분리(비밀은 passphrase 자체)
const VERSION = "gcm1";

let cachedKey: Buffer | null = null;
let cachedFrom: string | null = null;

// env ENCRYPTION_KEY → 32B 키(캐시). 미설정/공백이면 null(호출부가 fail-closed 처리).
function deriveKey(): Buffer | null {
  const raw = (process.env.ENCRYPTION_KEY || "").trim();
  if (!raw) return null;
  if (cachedKey && cachedFrom === raw) return cachedKey;
  cachedKey = crypto.scryptSync(raw, SCRYPT_SALT, 32);
  cachedFrom = raw;
  return cachedKey;
}

// 봉투 암호화 준비됨? (ENCRYPTION_KEY 설정됨) — 라우트/UI 가 명확한 에러를 주기 위해 사전 확인용.
export function secretBoxReady(): boolean {
  return !!deriveKey();
}

// 평문 → 봉투 문자열. 키 없으면 throw(평문 저장 방지).
export function encryptSecret(plaintext: string): string {
  const key = deriveKey();
  if (!key) throw new Error("ENCRYPTION_KEY 가 설정되지 않았습니다 — 시크릿을 저장할 수 없습니다(관리자: 게이트웨이 env 에 ENCRYPTION_KEY 설정).");
  const iv = crypto.randomBytes(12); // GCM 표준 96-bit nonce
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

// 봉투 문자열 → 평문. 키 없거나 포맷/태그 불일치면 throw.
export function decryptSecret(blob: string): string {
  const key = deriveKey();
  if (!key) throw new Error("ENCRYPTION_KEY 가 설정되지 않았습니다 — 저장된 시크릿을 복호할 수 없습니다.");
  const parts = String(blob || "").split(".");
  if (parts.length !== 4 || parts[0] !== VERSION) throw new Error("시크릿 봉투 포맷 오류");
  const iv = Buffer.from(parts[1], "base64url");
  const tag = Buffer.from(parts[2], "base64url");
  const ct = Buffer.from(parts[3], "base64url");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
