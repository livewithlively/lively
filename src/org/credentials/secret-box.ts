// 대칭 시크릿 박스 (AES-256-GCM) — 원문 복원이 필요한 시크릿의 at-rest 암호화 (프로젝트 #541).
//
//   왜 해시가 아니라 암호화인가: 커넥터 토큰(Slack/Notion/Google …)은 커넥터가 **실제 값으로 API 를 호출**해야
//   하므로 복원 가능해야 한다. 비밀번호(auth/local-accounts.ts scrypt, 단방향 해시)와 목적이 다르다.
//
//   왜 DB 에 시크릿을 넣나(컨벤션 확장): 종전 컨벤션은 "시크릿은 .env, DB 엔 env 이름만"(org_db_source.auth_ref /
//   org_mcp_server.auth_env). 하지만 고객사 A 실박스처럼 SSM 전용(scp/파일편집 불가) 배포에선 .env 편집이 비현실적 →
//   관리탭에서 토큰을 넣어 **암호화해서 DB 에 저장**한다. 평문 시크릿을 DB 에 두지 않는다는 원칙은 유지(암호문만 저장).
//
//   마스터키 = env `CONNECTOR_SECRET_KEY` (권장: `openssl rand -hex 32`). **미설정이면 암호화 비활성**
//   (secretsEnabled()=false) → 커넥터 토큰은 종전대로 env 폴백만(무중단). 관리탭 토큰 저장만 막힌다(명시적 안내).
//
//   포맷: `gcm$<iv_b64>$<tag_b64>$<ct_b64>` — 자기기술적(복호화에 필요한 iv/tag 를 함께 저장). 키는 미포함.
//   ⚠ 마스터키를 잃거나 바꾸면 기존 암호문은 복호화 불가(재입력 필요) — 운영상 키를 .env 볼륨과 함께 보존.
import crypto from "node:crypto";

const KEY_ENV = "CONNECTOR_SECRET_KEY";
const ALGO = "aes-256-gcm";
const PREFIX = "gcm";

// 마스터키 32바이트 유도. hex64 면 그대로, 그 외 임의 문자열이면 sha256 으로 32바이트 파생(운영 유연성).
function masterKey(): Buffer | null {
  const raw = process.env[KEY_ENV]?.trim();
  if (!raw) return null;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) return Buffer.from(raw, "hex");
  return crypto.createHash("sha256").update(raw, "utf8").digest();
}

/** 마스터키 설정 여부 — false 면 관리탭 시크릿 저장 비활성(env 폴백만). 관리탭이 안내 배너에 사용. */
export function secretsEnabled(): boolean {
  return masterKey() !== null;
}

/** 값이 이 박스로 암호화된 형식인지(gcm$…). config 해소가 암호문↔평문 폴백을 구분. */
export function isEncrypted(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(PREFIX + "$");
}

/** 평문 → 암호문(gcm$iv$tag$ct). 마스터키 없으면 throw(호출자가 secretsEnabled 로 선체크). */
export function encryptSecret(plain: string): string {
  const key = masterKey();
  if (!key) throw new Error(`${KEY_ENV} 미설정 — 시크릿 암호화 저장 불가. 관리탭에서 토큰을 저장하려면 .env 에 ${KEY_ENV}(openssl rand -hex 32)를 설정하세요.`);
  const iv = crypto.randomBytes(12); // GCM 표준 96-bit nonce
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}$${iv.toString("base64")}$${tag.toString("base64")}$${ct.toString("base64")}`;
}

/** 암호문 → 평문. 마스터키 없음/포맷오류/변조(tag 불일치)면 throw. */
export function decryptSecret(enc: string): string {
  const key = masterKey();
  if (!key) throw new Error(`${KEY_ENV} 미설정 — 시크릿 복호화 불가.`);
  const parts = enc.split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) throw new Error("시크릿 포맷 오류 — gcm$iv$tag$ct 가 아닙니다.");
  const iv = Buffer.from(parts[1], "base64");
  const tag = Buffer.from(parts[2], "base64");
  const ct = Buffer.from(parts[3], "base64");
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** 복호화 시도, 실패(키 없음·포맷·변조)면 null — 해소 계층이 조용히 env 폴백하도록. */
export function tryDecryptSecret(enc: string): string | null {
  try { return decryptSecret(enc); } catch { return null; }
}
