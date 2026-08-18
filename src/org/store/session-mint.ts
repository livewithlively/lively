// pending_session_mint — 컨트롤플레인 → 테넌트 세션 SSO 브리지(#1454 S1)의 저장 계층.
//  발급(mintSessionCode)은 org_session_mint capability(admin, delivery/tokens-devices.ts)가 부르고,
//  교환(exchangeSessionCode)은 무인증 GET /api/ui/session/exchange(web.ts)가 부른다.
//  관례는 형제 tokens.ts(mintToken)와 동형: 평문 코드는 1회만 반환·저장은 sha256, 발급/교환 모두
//  org_content_audit 에 남긴다. 셀프호스트 무해 — 발급 창구(admin)를 안 쓰면 이 표는 영원히 비어 있고
//  교환 라우트는 항상 실패 리다이렉트만 낸다(기존 로그인 경로 불변).
//  db 인자(기본 itemsPool)는 mintToken 의 client 오버로드(#880)와 같은 주입 seam — 단위 테스트가
//  가짜 풀로 해시·만료·1회성 계약을 검증한다(session-mint.test.ts). 실 DB 경로와 SQL 은 동일하다.
import crypto from "node:crypto";
import type pg from "pg";
import { itemsPool, type Db } from "../../db/client.js";
import { audit, sha256 } from "./audit.js";

// TTL 60초 — 용도가 '컨트롤플레인 → 테넌트 리다이렉트 한 홉'뿐이라 길 이유가 없다(길수록 유출된 코드가
//  살아 있는 창만 넓어진다). 만료 판정은 DB now() 기준(교환 UPDATE 의 WHERE) — 앱 시계에 의존하지 않는다.
export const SESSION_MINT_TTL_MS = 60_000;
// 코드 형태 — 'lvm_' prefix + 24바이트 base64url(=정확히 32자). 토큰 'lvk_'·웹세션 'lvs_' 와 같은 식별 관례.
const CODE_RE = /^lvm_[A-Za-z0-9_-]{32}$/;

export const genSessionMintCode = (): string => "lvm_" + crypto.randomBytes(24).toString("base64url");
export const isSessionMintCodeShape = (code: string): boolean => CODE_RE.test(code);

// 발급 — 평문 코드를 1회 반환(저장은 sha256 만). 대상 멤버의 존재·kind·state 검증은 호출부(capability)가
//  하고 여기는 저장만 한다(mintToken 과 같은 책임 분담). 감사는 tokens.ts:30-31 mintToken 과 같은 방식.
export async function mintSessionCode(
  memberId: string,
  actor?: string,
  source?: string,
  db: Db = itemsPool,
): Promise<{ code: string; codeHash: string; expiresAt: Date }> {
  const code = genSessionMintCode();
  const codeHash = sha256(code);
  const expiresAt = new Date(Date.now() + SESSION_MINT_TTL_MS);
  await db.query(
    `INSERT INTO pending_session_mint(code_hash, member_id, expires_at, created_by) VALUES($1,$2,$3,$4)`,
    [codeHash, memberId, expiresAt.toISOString(), actor ?? null],
  );
  // 평문 코드는 감사에도 남기지 않는다 — 해시 prefix 만(상관추적용, 해시는 비밀 아님 — revokeToken 관례).
  //  마지막 인자로 db 를 넘겨 audit 이 같은 커넥션/풀을 쓰게 한다(기본 itemsPool 이면 종전과 동일 경로).
  await audit("pending_session_mint", memberId, "mint",
    null, { memberId, code_hash_prefix: codeHash.slice(0, 12), expires_at: expiresAt.toISOString() },
    actor, source, db as unknown as pg.PoolClient);
  return { code, codeHash, expiresAt };
}

// 교환 — 1회용 코드 → member_id. **원자적 소비**: used_at 마킹과 유효성(미사용·미만료) 판정을 UPDATE 한 문장으로
//  묶어 동시 교환(double-spend)을 DB 가 차단한다(#880 device consume 과 같은 원리 — 여긴 후속 발급이 없어 tx 불요).
//  실패 사유(없음/만료/기사용)는 구분해 노출하지 않는다 — 무인증 표면이라 존재 여부 자체가 정보다.
export async function exchangeSessionCode(
  code: string,
  meta?: { ip?: string | null },
  db: Db = itemsPool,
): Promise<{ memberId: string } | null> {
  if (!isSessionMintCodeShape(String(code ?? ""))) return null; // 형태 불일치 — DB 왕복 없이 종료(스캐너 노이즈 차단)
  // lazy GC — 만료 1시간 경과 행 삭제(reapDeviceAuth 의 lazy 백업 관례. 스케줄러 없이도 표가 bound 되게).
  try { await db.query(`DELETE FROM pending_session_mint WHERE expires_at < now() - interval '1 hour'`); } catch { /* GC 실패는 교환과 무관 — 무시 */ }
  const r = await db.query(
    `UPDATE pending_session_mint SET used_at=now()
      WHERE code_hash=$1 AND used_at IS NULL AND expires_at > now()
      RETURNING member_id`,
    [sha256(String(code))],
  );
  const row = r.rows[0] as { member_id: string } | undefined;
  if (!row) return null;
  // 발급↔교환 사이 비활성화 방어 — 세션은 사람 본인 행위라 비활성 멤버에겐 만들면 안 된다(userFromSession 과 동일 기준).
  //  코드는 위에서 이미 소비됐다(재시도 무의미 — 비활성 멤버의 코드를 살려 둘 이유가 없다).
  const m = await db.query(`SELECT state FROM org_member WHERE id=$1`, [row.member_id]);
  const state = (m.rows[0] as { state?: string } | undefined)?.state;
  if (state !== "active") return null;
  // 감사 — 무인증 교환 '성공'은 반드시 남긴다(누가 언제 어떤 IP 로 로그인 브리지를 탔나).
  //  ⚠ 실패는 남기지 않는다: 무인증 표면이라 임의 code 난사가 append-only 감사 테이블을 무한정 키울 수 있다(DoS).
  await audit("pending_session_mint", row.member_id, "exchange",
    null, { member_id: row.member_id, ip: meta?.ip ?? null }, row.member_id, "web", db as unknown as pg.PoolClient);
  return { memberId: row.member_id };
}

// 교환 성공 뒤 착지 경로(순수) — `?to=` 로 받은 **해시 경로**를 /ui/ 뒤에 붙인다(#1771).
//  왜 필요한가: CP 는 종전에 exchange URL 뒤에 프래그먼트를 그대로 달아 브라우저의 "Location 에 프래그먼트가
//  없으면 원래 것을 유지" 동작에 기댔다. 그 경로는 서버가 모르는 값이라 화이트리스트가 CP 한 곳뿐이고,
//  `#/activate?code=XXXX-XXXX` 처럼 쿼리가 든 해시는 걸러졌다(CLI/데스크톱 승인이 홈으로 떨어졌다).
//  여기서 서버가 직접 Location 에 싣고 형태를 검증한다 — 열린 리다이렉트 방지: 반드시 `#/` 로 시작하는
//  **동일 출처 해시 경로**만 허용하고, 스킴·호스트·`//`·공백·제어문자는 전부 기본 착지(/ui/)로 떨어뜨린다.
const LANDING_HASH_RE = /^#\/[A-Za-z0-9/_\-.?=&%+~:@,]*$/;
export function exchangeLandingPath(to: unknown): string {
  const s = typeof to === "string" ? to.trim() : "";
  if (!s || s.length > 512) return "/ui/";
  if (!LANDING_HASH_RE.test(s)) return "/ui/";
  if (s.startsWith("#//")) return "/ui/"; // `#//evil.com` 류 — 브라우저는 해시로 보지만 사람이 오독할 수 있어 잘라낸다
  return `/ui/${s}`;
}
