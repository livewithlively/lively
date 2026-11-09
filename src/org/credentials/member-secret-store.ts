// per-user 백엔드 자격 vault 스토어(P1, #746) — 능동 커넥터 툴이 쓰는 자격을 사용자별 격리 보관·해소.
//  git-credential-store(owner=gateway|member:<id> + resolveGitSecret 우선순위)를 임의 kind 로 일반화한 것.
//  시크릿은 secret-box(AES-256-GCM, CONNECTOR_SECRET_KEY)로만 저장(암호문). meta 는 비밀 아닌 부속정보(평문 jsonb).
//
//  해소 체인(credential resolution chain) — 프로젝트 #746 P1 의 핵심:
//   · 비-PII read(gitlab read·prometheus·describe …) → allowFallback=true: member 자격 없으면 gateway(통합) 폴백.
//   · write/외부발신/raw-PII(MR push·slack send·google write) → allowFallback=false: member 자격만(사칭·통합오용 방지).
//  두 축(read/write)이 아니라 '호출자가 그 작업의 성격으로 allowFallback 을 정한다'가 규약.
import { itemsPool } from "../../db/client.js";
import { encryptSecret, decryptSecret } from "./secret-box.js";
import { KIND_RE, SCOPE_RE } from "./member-secret-rules.js";

export const GATEWAY_OWNER = "gateway";
export function memberOwner(memberId: string): string { return `member:${memberId}`; }

// kind/scope_key 표면 위생 — 인젝션/키오염 방지(영숫자·._:-, 소문자 정규화). kind 는 필수, scope_key 는 ''(단일) 허용.
//  정규식은 입구 판정(member-secret-rules.ts)과 한 벌이다.
export function normalizeKind(kind: unknown): string {
  const k = String(kind ?? "").trim().toLowerCase();
  if (!KIND_RE.test(k)) throw new Error(`자격 kind 형식 오류(소문자·숫자·_ 1~40자): ${k}`);
  return k;
}
export function normalizeScopeKey(scopeKey: unknown): string {
  const s = String(scopeKey ?? "").trim();
  if (!SCOPE_RE.test(s)) throw new Error(`자격 scope_key 형식 오류: ${s}`);
  return s;
}

// 웹 노출용(시크릿 없음) — 존재 플래그·meta·라벨만.
export interface MemberSecretPublic {
  owner: string; kind: string; scope_key: string;
  has_secret: boolean;
  meta: Record<string, unknown>;
  label: string | null;
  created_at: string | null; updated_at: string | null; updated_by: string | null; last_used_at: string | null;
}
// 내부용(복호 포함) — 커넥터 툴 주입 전용. 절대 응답 body 로 내보내지 않는다.
export interface MemberSecretResolved {
  owner: string; kind: string; scope_key: string;
  secret: string | null; // 복호된 시크릿(없으면 null — aws_role_arn 처럼 meta 만 쓰는 kind)
  meta: Record<string, unknown>;
}

interface Row {
  owner: string; kind: string; scope_key: string; secret_enc: string | null;
  meta: Record<string, unknown> | null; label: string | null;
  created_at: string | null; updated_at: string | null; updated_by: string | null; last_used_at: string | null;
}
function toPublic(r: Row): MemberSecretPublic {
  return {
    owner: r.owner, kind: r.kind, scope_key: r.scope_key,
    has_secret: !!r.secret_enc, meta: r.meta ?? {}, label: r.label ?? null,
    created_at: r.created_at ?? null, updated_at: r.updated_at ?? null,
    updated_by: r.updated_by ?? null, last_used_at: r.last_used_at ?? null,
  };
}

// OAuth 브로커 내부 슬롯 — 사용자 자격이 아니라 인프라(임시 PKCE verifier·DCR 클라정보). 공개 목록에서 숨긴다(#746 리뷰 #1).
//  ★ 정본이 여기 있는 이유(#1881 G3): 이 값은 **금고 슬롯의 예약 키**라 금고 모듈의 것이다. 예전엔 oauth-broker 가
//   따로 선언하고 여기선 문자열을 다시 적었는데, 그러면 ① 두 곳이 어긋날 수 있고 ② 금고만 읽으면 되는 모듈
//   (google-token-source 등)이 무거운 oauth-broker 를 끌어와 **import 순환**이 생긴다(실제로 났다).
//   oauth-broker 는 이제 여기서 재수출한다 — 기존 import 경로는 그대로 산다.
export const CLIENT_SCOPE = "oauth:client"; // owner=gateway — 조직 공용 OAuth 클라이언트(client_id/secret)
export const PKCE_SCOPE = "oauth:pkce";     // owner=member — 콜백까지만 사는 1회용 verifier
const HIDDEN_SCOPE_KEYS = [PKCE_SCOPE, CLIENT_SCOPE];

export async function listMemberSecretsPublic(owner: string): Promise<MemberSecretPublic[]> {
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE owner=$1 AND scope_key <> ALL($2) ORDER BY kind, scope_key", [owner, HIDDEN_SCOPE_KEYS]);
  return (r.rows as Row[]).map(toPublic);
}

// 특정 kind 전체(owner 무관) — 관리자 개관용(시크릿 없음). member_id 는 owner 에서 파생.
export async function listSecretsByKindPublic(kind: string): Promise<MemberSecretPublic[]> {
  const k = normalizeKind(kind);
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE kind=$1 AND scope_key <> ALL($2) ORDER BY owner, scope_key", [k, HIDDEN_SCOPE_KEYS]);
  return (r.rows as Row[]).map(toPublic);
}

// 칸 하나의 공개 정보(시크릿 없음) — 목록이 숨기는 예약 칸(oauth:client)도 owner·kind·scope_key 로 콕 집으면 읽힌다.
//  [외부 앱 연결]의 «앱 등록 보기» 가 등록한 때를 보이려고 쓴다(#4991). 관리자 판정은 호출자.
export async function getMemberSecretPublic(owner: string, kindRaw: unknown, scopeKeyRaw: unknown): Promise<MemberSecretPublic | null> {
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key=$3",
    [owner, normalizeKind(kindRaw), normalizeScopeKey(scopeKeyRaw)]);
  const row = r.rows[0] as Row | undefined;
  return row ? toPublic(row) : null;
}

// upsert — secret 은 봉투 암호화(있을 때만; 없으면 기존 유지). meta 는 병합 아니라 교체(명시적). owner 검증은 호출자.
export async function setMemberSecret(
  owner: string, kindRaw: unknown, scopeKeyRaw: unknown,
  input: { secret?: string | null; meta?: Record<string, unknown>; label?: string | null }, actor: string,
): Promise<MemberSecretPublic> {
  const kind = normalizeKind(kindRaw);
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  // secret: undefined/null=변경 안 함(기존 유지), 빈 문자열도 "변경 안 함"으로 취급(실수로 비우기 방지 — 삭제는 delete 로).
  //  ⚠ trim 필수 — 여기 오는 건 전부 한 줄 API 토큰(PAT·xoxp·refresh token·ARN)인데, 사람이 복붙하면
  //  꼬리 개행/공백이 딸려온다. 그대로 저장하면 헤더에 실려 나가 원격이 401 을 내고, 값이 비노출이라
  //  "토큰이 맞는데 왜 401 이지" 로 몇 시간을 태운다(#825 진단 중 발견). 공백만 있으면 빈 값 → '변경 안 함'.
  const secret = typeof input.secret === "string" ? input.secret.trim() : input.secret;
  const hasSecret = typeof secret === "string" && secret.length > 0;
  const enc = hasSecret ? encryptSecret(secret as string) : null;
  const meta = input.meta && typeof input.meta === "object" ? input.meta : {};
  await itemsPool.query(
    `INSERT INTO member_secret(owner,kind,scope_key,secret_enc,meta,label,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,now(),$7)
     ON CONFLICT (tenant_id, owner,kind,scope_key) DO UPDATE SET
       secret_enc=COALESCE(EXCLUDED.secret_enc, member_secret.secret_enc),
       meta=EXCLUDED.meta, label=EXCLUDED.label, updated_at=now(), updated_by=EXCLUDED.updated_by`,
    [owner, kind, scopeKey, enc, JSON.stringify(meta), input.label ?? null, actor],
  );
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key=$3", [owner, kind, scopeKey]);
  return toPublic(r.rows[0] as Row);
}

export async function deleteMemberSecret(owner: string, kindRaw: unknown, scopeKeyRaw: unknown): Promise<boolean> {
  const kind = normalizeKind(kindRaw);
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  const r = await itemsPool.query("DELETE FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key=$3", [owner, kind, scopeKey]);
  const deleted = (r.rowCount ?? 0) > 0;
  //  그 칸으로 돌던 수집기를 끈다 — 안 그러면 키가 사라져도 «모으는 중» 깃발이 남는다(collector-orphans.ts).
  //   지우는 길이 여럿(내 자격·관리자·OAuth 끊기)이라 여기 한 자리에서 한다. 동적 import 는 금고 ↔ 수집기 저장소 순환을 끊으려고.
  //   best-effort — 끄기 실패가 삭제를 되돌리면 안 된다(그래도 상태 계산이 키 유무를 직접 보므로 화면은 맞다).
  if (deleted) {
    try {
      const { stopOrphanedCollectors } = await import("./collector-orphans.js");
      await stopOrphanedCollectors(owner, kind);
    } catch (e) { console.warn(`stopOrphanedCollectors 실패(무시) owner=${owner} kind=${kind}: ${(e as Error).message}`); }
  }
  return deleted;
}

// 내부 — 복호 포함 조회(단일 owner). last_used_at 갱신(best-effort). 커넥터 주입 전용.
export async function getMemberSecret(owner: string, kind: string, scopeKey: string): Promise<MemberSecretResolved | null> {
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE owner=$1 AND kind=$2 AND scope_key=$3", [owner, kind, scopeKey]);
  const row = r.rows[0] as Row | undefined;
  if (!row) return null;
  itemsPool.query("UPDATE member_secret SET last_used_at=now() WHERE owner=$1 AND kind=$2 AND scope_key=$3", [owner, kind, scopeKey]).catch(() => {});
  return {
    owner: row.owner, kind: row.kind, scope_key: row.scope_key,
    secret: row.secret_enc ? decryptSecret(row.secret_enc) : null,
    meta: row.meta ?? {},
  };
}

// ── 해소 체인(P1 핵심) — 커넥터 툴이 호출. member 우선 → allowFallback 이면 gateway(통합) 폴백 → null. ──
//  allowFallback=false(write·외부발신·raw-PII): 오직 member 자격만. member 자격 없으면 null(호출자가 "개인 자격 등록 필요" 안내).
//  allowFallback=true(비-PII read): member 없으면 gateway 통합 자격으로 폴백(온보딩 0 — 기본 제공).
export interface ResolveOpts { scopeKey?: string; allowFallback?: boolean }
export async function resolveMemberSecret(
  memberId: string | null | undefined, kindRaw: unknown, opts: ResolveOpts = {},
): Promise<MemberSecretResolved | null> {
  const kind = normalizeKind(kindRaw);
  const scopeKey = normalizeScopeKey(opts.scopeKey ?? "");
  // fail-safe 기본값 = false(통합 폴백 금지). 비-PII read 만 호출측이 명시적으로 allowFallback:true 를 넘긴다 —
  //  옵션을 잊은 신규 커넥터가 조용히 사칭 위험(통합 자격 오용)에 빠지지 않게, 안전한 쪽(per-user 전용)을 디폴트로.
  const allowFallback = opts.allowFallback === true;
  if (memberId) {
    const mine = await getMemberSecret(memberOwner(memberId), kind, scopeKey);
    if (mine) return mine;
  }
  if (!allowFallback) return null; // per-user 필수 경로 — 통합 폴백 금지
  return getMemberSecret(GATEWAY_OWNER, kind, scopeKey);
}
