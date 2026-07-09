// per-user 백엔드 자격 vault 스토어(P1, #746) — 능동 커넥터 툴이 쓰는 자격을 사용자별 격리 보관·해소.
//  git-credential-store(owner=gateway|member:<id> + resolveGitSecret 우선순위)를 임의 kind 로 일반화한 것.
//  시크릿은 secret-box(AES-256-GCM, CONNECTOR_SECRET_KEY)로만 저장(암호문). meta 는 비밀 아닌 부속정보(평문 jsonb).
//
//  해소 체인(credential resolution chain) — 프로젝트 #746 P1 의 핵심:
//   · 비-PII read(gitlab read·prometheus·describe …) → allowFallback=true: member 자격 없으면 gateway(통합) 폴백.
//   · write/외부발신/raw-PII(MR push·slack send·google write) → allowFallback=false: member 자격만(사칭·통합오용 방지).
//  두 축(read/write)이 아니라 '호출자가 그 작업의 성격으로 allowFallback 을 정한다'가 규약.
import { itemsPool } from "../items/store.js";
import { encryptSecret, decryptSecret } from "./secret-box.js";

export const GATEWAY_OWNER = "gateway";
export function memberOwner(memberId: string): string { return `member:${memberId}`; }

// kind/scope_key 표면 위생 — 인젝션/키오염 방지(영숫자·._:-, 소문자 정규화). kind 는 필수, scope_key 는 ''(단일) 허용.
const KIND_RE = /^[a-z0-9_]{1,40}$/;
const SCOPE_RE = /^[A-Za-z0-9._:-]{0,120}$/;
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

export async function listMemberSecretsPublic(owner: string): Promise<MemberSecretPublic[]> {
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE owner=$1 ORDER BY kind, scope_key", [owner]);
  return (r.rows as Row[]).map(toPublic);
}

// 특정 kind 전체(owner 무관) — 관리자 개관용(시크릿 없음). member_id 는 owner 에서 파생.
export async function listSecretsByKindPublic(kind: string): Promise<MemberSecretPublic[]> {
  const k = normalizeKind(kind);
  const r = await itemsPool.query("SELECT * FROM member_secret WHERE kind=$1 ORDER BY owner, scope_key", [k]);
  return (r.rows as Row[]).map(toPublic);
}

// upsert — secret 은 봉투 암호화(있을 때만; 없으면 기존 유지). meta 는 병합 아니라 교체(명시적). owner 검증은 호출자.
export async function setMemberSecret(
  owner: string, kindRaw: unknown, scopeKeyRaw: unknown,
  input: { secret?: string | null; meta?: Record<string, unknown>; label?: string | null }, actor: string,
): Promise<MemberSecretPublic> {
  const kind = normalizeKind(kindRaw);
  const scopeKey = normalizeScopeKey(scopeKeyRaw);
  // secret: undefined/null=변경 안 함(기존 유지), 빈 문자열도 "변경 안 함"으로 취급(실수로 비우기 방지 — 삭제는 delete 로).
  const hasSecret = typeof input.secret === "string" && input.secret.length > 0;
  const enc = hasSecret ? encryptSecret(input.secret as string) : null;
  const meta = input.meta && typeof input.meta === "object" ? input.meta : {};
  await itemsPool.query(
    `INSERT INTO member_secret(owner,kind,scope_key,secret_enc,meta,label,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5::jsonb,$6,now(),$7)
     ON CONFLICT (owner,kind,scope_key) DO UPDATE SET
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
  return (r.rowCount ?? 0) > 0;
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
  const allowFallback = opts.allowFallback !== false; // 기본 true(read 관례) — write 경로가 명시적으로 false 를 넘긴다
  if (memberId) {
    const mine = await getMemberSecret(memberOwner(memberId), kind, scopeKey);
    if (mine) return mine;
  }
  if (!allowFallback) return null; // per-user 필수 경로 — 통합 폴백 금지
  return getMemberSecret(GATEWAY_OWNER, kind, scopeKey);
}
