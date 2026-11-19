// DB 소스 비밀번호를 시크릿 저장소에서 읽는다 (#1764) — GCP Secret Manager · AWS Secrets Manager.
//
//  자격: 게이트웨이가 도는 자리의 **기본 자격**만 쓴다. 게이트웨이에 키를 따로 넣지 않는다.
//   · GCP — 메타데이터 서버(VM · GKE 워크로드 아이덴티티 · Cloud Run)가 주는 서비스 계정 토큰. 주소는 구글 클라이언트
//     라이브러리와 같은 env(GCE_METADATA_HOST · GCE_METADATA_IP)로 바꿀 수 있다(기본 169.254.169.254).
//   · AWS — 게이트웨이 base 자격(env AWS_ACCESS_KEY_ID… → EC2 인스턴스 프로파일, aws-broker.resolveGatewayBaseCreds)으로
//     SigV4 서명(aws-json.awsCall — 공개 테스트 벡터로 못 박은 서명기).
//  메타데이터 서버 호출은 게이트웨이 **자신의** 자격 취득이다. DB 접속 대상의 SSRF 가드(source-guard 가 메타데이터 IP 로
//   접속하는 소스를 막는 것)와 별개 길이고, 주소는 고정값(또는 운영자 env)이라 사용자 입력이 섞이지 않는다.
//
//  보관: 값은 이 모듈의 메모리에만 둔다 — DB · 로그 · 응답 · 오류 문장에 싣지 않는다. 5분(SECRET_TTL_MS) 기억한 뒤 다시 읽는다.
//   다시 읽기가 **일시 오류**(저장소에 닿지 못함)로 실패하면 1시간 안의 마지막 값으로 버틴다. 권한 없음 · 시크릿 없음 같은
//   확정 오류는 그대로 낸다(권한을 거둔 것을 존중한다).
//  교체: 접속 인증이 실패하면 부르는 쪽(pool.ts · mysql-engine.ts)이 fresh 로 다시 읽어 한 번 더 붙는다.
//
//  값 해석: 끝의 줄바꿈은 뗀다(`echo pw | gcloud secrets versions add --data-file=-` 가 붙이는 \n — DB 비밀번호가 줄바꿈으로
//   끝날 일은 없다). 값이 {"password": …} JSON 이면 password 칸을 쓰고 username 칸이 있으면 함께 돌려준다(RDS 가 관리하는
//   시크릿 꼴). 사용자 이름은 접속 주소에 없을 때만 쓰인다(sources.ts · mysql-engine.ts).
import { logger } from "../log.js";
import { awsCall, jsonOf, AwsError, type AwsDeps } from "../net/aws/aws-json.js";
import { parseSecretRef, type SecretRef } from "./secret-ref.js";

export interface DbSecret {
  password: string;
  /** 시크릿이 {"username": …, "password": …} JSON 일 때만. */
  username?: string;
}

export type DbSecretReason =
  | "bad_ref"
  | "no_credentials"
  | "scope_insufficient"
  | "permission_denied"
  | "not_found"
  | "disabled"
  | "api_disabled"
  | "unavailable"
  | "bad_value";

const REASON_LABEL: Record<DbSecretReason, string> = {
  bad_ref: "참조 형식 오류",
  no_credentials: "자격 없음",
  scope_insufficient: "접근 범위 부족",
  permission_denied: "권한 없음",
  not_found: "시크릿 없음",
  disabled: "쓸 수 없는 버전",
  api_disabled: "API 꺼짐",
  unavailable: "저장소에 닿지 못함",
  bad_value: "값 형식 오류",
};

export interface DbSecretErrorOpts {
  /** 저장소가 준 상태 · 코드(예 «403 PERMISSION_DENIED/ACCESS_TOKEN_SCOPE_INSUFFICIENT» · «400 AccessDeniedException»). */
  providerCode?: string | null;
  /** 저장소가 준 오류 문장(시크릿 값은 들어 있지 않다) — 문장에는 싣지 않고 로그 · 진단용으로만 둔다. */
  providerMessage?: string | null;
  /** 어느 DB 소스의 접속이었는지 — 있으면 문장 앞에 붙는다. */
  source?: string | null;
}

/** 시크릿을 못 읽었을 때의 오류 — 까닭(reason)을 가르고, 값은 어디에도 싣지 않는다. */
export class DbSecretError extends Error {
  readonly reason: DbSecretReason;
  readonly ref: string;
  readonly detail: string;
  readonly providerCode: string | null;
  readonly providerMessage: string | null;
  readonly source: string | null;
  constructor(reason: DbSecretReason, ref: string, detail: string, opts: DbSecretErrorOpts = {}) {
    const src = opts.source ? `db source '${opts.source}' ` : "";
    const code = opts.providerCode ? ` [${opts.providerCode}]` : "";
    super(`${src}비밀번호 시크릿(${ref})을 읽지 못했습니다 — ${REASON_LABEL[reason]}: ${detail}${code}`);
    this.name = "DbSecretError";
    this.reason = reason;
    this.ref = ref;
    this.detail = detail;
    this.providerCode = opts.providerCode ?? null;
    this.providerMessage = opts.providerMessage ?? null;
    this.source = opts.source ?? null;
  }
  /** 같은 오류에 DB 소스 이름을 붙인 판. */
  withSource(source: string): DbSecretError {
    return new DbSecretError(this.reason, this.ref, this.detail, {
      providerCode: this.providerCode, providerMessage: this.providerMessage, source,
    });
  }
  /** 같은 오류를 다른 참조의 것으로 — 여러 참조가 함께 기다린 GCP 토큰 받기가 실패했을 때 각자의 참조로 낸다. */
  forRef(ref: string): DbSecretError {
    if (ref === this.ref) return this;
    return new DbSecretError(this.reason, ref, this.detail, {
      providerCode: this.providerCode, providerMessage: this.providerMessage, source: this.source,
    });
  }
}

export const SECRET_TTL_MS = 5 * 60_000;
export const SECRET_MAX_STALE_MS = 60 * 60_000;
/** 저장소가 막혀 옛 값으로 버틴 뒤 이만큼은 다시 묻지 않고 옛 값을 곧바로 준다 — 새 연결마다 시간 초과를 기다리지 않게. */
export const SECRET_STALE_RETRY_MS = 30_000;
const METADATA_TIMEOUT_MS = 3_000;
const STORE_TIMEOUT_MS = 10_000;
const TOKEN_SKEW_MS = 60_000;
const ATTEMPTS = 3; // 일시 오류(네트워크 · 429 · 5xx)는 처음 포함 세 번까지

// ── 주입 가능한 바깥(시험이 가짜 메타데이터 서버 · 저장소를 끼운다) ──
export interface SecretStoreDeps {
  fetch: typeof fetch;
  now: () => number;
  /** GCP 메타데이터 서버 주소(끝 / 없음). */
  gcpMetadataBase: () => string;
  /** GCP Secret Manager REST 주소(끝 / 없음). */
  gcpSecretManagerBase: string;
  /** AWS 호출 주입(자격 · fetch · 다시 하기 간격). */
  aws: AwsDeps;
  /** 일시 오류 뒤 다시 하기 전 기다림(ms) — 시험은 0. */
  retryDelayMs: number;
}

const defaultDeps = (): SecretStoreDeps => ({
  fetch: (input, init) => fetch(input, init),
  now: () => Date.now(),
  gcpMetadataBase: () => {
    const h = (process.env.GCE_METADATA_HOST || process.env.GCE_METADATA_IP || "").trim();
    return `http://${h || "169.254.169.254"}`;
  },
  gcpSecretManagerBase: "https://secretmanager.googleapis.com/v1",
  aws: {},
  retryDelayMs: 250,
});

let deps: SecretStoreDeps = defaultDeps();

/** 시험 전용 — 바깥 주입(null = 기본으로 되돌림). 캐시는 함께 비운다. */
export function __setSecretStoreDepsForTest(over: Partial<SecretStoreDeps> | null): void {
  deps = over ? { ...defaultDeps(), ...over } : defaultDeps();
  __resetSecretStoreForTest();
}
/** 시험 전용 — 기억한 값 · 토큰 · 진행 중 읽기를 모두 비운다. */
export function __resetSecretStoreForTest(): void {
  cache.clear();
  inflight.clear();
  versions.clear();
  gcpToken = null;
  gcpTokenInflight = null;
  gcpMetadataSeen = false;
}

const sleep = (ms: number): Promise<void> => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());

/** fetch 실패 까닭을 한 낱말로(값 · 주소 없이). */
function netWhy(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "시간 초과";
  const code = (e as { cause?: { code?: unknown } })?.cause?.code;
  return code ? String(code) : ((e as Error)?.message || "연결 실패").slice(0, 120);
}

// ── 값 해석 ──
/** 저장소에서 받은 글 → DB 비밀번호(+ 사용자 이름). 값이 든 오류 문장은 만들지 않는다. */
export function interpretSecretValue(text: string, ref: string): DbSecret {
  const t = text.replace(/[\r\n]+$/, "");
  if (t === "") throw new DbSecretError("bad_value", ref, "시크릿 값이 비어 있습니다");
  if (t.startsWith("{")) {
    let j: unknown;
    try { j = JSON.parse(t); } catch { j = undefined; } // JSON 이 아니면 «{» 로 시작하는 비밀번호다
    if (j !== null && typeof j === "object" && !Array.isArray(j)) {
      const o = j as Record<string, unknown>;
      if (typeof o.password !== "string" || o.password === "") {
        throw new DbSecretError("bad_value", ref,
          "JSON 시크릿에 password 칸(글자)이 없습니다 — 비밀번호만 담거나 {\"username\": …, \"password\": …} 꼴로 두세요");
      }
      const username = typeof o.username === "string" && o.username !== "" ? o.username : undefined;
      return username ? { password: o.password, username } : { password: o.password };
    }
  }
  return { password: t };
}

// ── GCP Secret Manager ──
let gcpToken: { token: string; exp: number } | null = null;
let gcpTokenInflight: Promise<string> | null = null;
/** 이 프로세스에서 GCP 메타데이터 서버가 한 번이라도 답했는가 — 그 뒤의 연결 실패 · 시간 초과는 «자격 없음» 이 아니라 일시 오류다. */
let gcpMetadataSeen = false;

// 토큰은 여러 참조가 함께 기다린다 — 오류는 참조 없이("") 만들고 gcpAccessToken 이 부른 쪽의 참조로 바꿔 낸다.
async function fetchGcpToken(): Promise<string> {
  const ref = "";
  const url = `${deps.gcpMetadataBase()}/computeMetadata/v1/instance/service-accounts/default/token`;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await deps.fetch(url, { headers: { "Metadata-Flavor": "Google" }, signal: AbortSignal.timeout(METADATA_TIMEOUT_MS), redirect: "error" });
    } catch (e) {
      if (gcpMetadataSeen) {
        if (attempt < ATTEMPTS) { await sleep(deps.retryDelayMs * attempt); continue; }
        throw new DbSecretError("unavailable", ref, `GCP 메타데이터 서버가 잠시 응답하지 않습니다(${netWhy(e)})`);
      }
      throw new DbSecretError("no_credentials", ref,
        `GCP 메타데이터 서버에 닿지 않습니다(${netWhy(e)}) — 게이트웨이가 GCP VM · GKE · Cloud Run 안에서 돌고 서비스 계정이 붙어 있어야 합니다`);
    }
    // 같은 주소(169.254.169.254)에 AWS IMDS 같은 다른 메타데이터 서버가 답할 수 있다 — GCP 응답 머리로 가린다.
    if ((res.headers.get("metadata-flavor") ?? "").toLowerCase() !== "google") {
      await res.body?.cancel().catch(() => undefined);
      throw new DbSecretError("no_credentials", ref,
        `메타데이터 주소의 응답이 GCP 메타데이터 서버가 아닙니다(HTTP ${res.status}) — GCP 밖에서 도는 게이트웨이는 gcp-sm 참조를 읽을 수 없습니다`);
    }
    gcpMetadataSeen = true;
    if (res.status === 200) {
      const j = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown } | null;
      if (!j || typeof j.access_token !== "string" || j.access_token === "") {
        throw new DbSecretError("unavailable", ref, "메타데이터 서버의 토큰 응답 형식이 맞지 않습니다");
      }
      const ttlMs = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in * 1000 : 5 * 60_000;
      gcpToken = { token: j.access_token, exp: deps.now() + ttlMs };
      return j.access_token;
    }
    await res.body?.cancel().catch(() => undefined);
    if ((res.status === 429 || res.status >= 500) && attempt < ATTEMPTS) { await sleep(deps.retryDelayMs * attempt); continue; }
    if (res.status === 404) {
      throw new DbSecretError("no_credentials", ref,
        "이 VM(워크로드)에 서비스 계정이 연결돼 있지 않습니다 — VM 에 서비스 계정을 붙이세요(GKE 는 워크로드 아이덴티티 연결)", { providerCode: "metadata 404" });
    }
    if (res.status === 429 || res.status >= 500) {
      throw new DbSecretError("unavailable", ref, "메타데이터 서버가 일시 오류를 냈습니다", { providerCode: `metadata ${res.status}` });
    }
    throw new DbSecretError("no_credentials", ref, "메타데이터 서버가 서비스 계정 토큰을 주지 않았습니다", { providerCode: `metadata ${res.status}` });
  }
}

async function gcpAccessToken(ref: string, force: boolean): Promise<string> {
  if (force) gcpToken = null;
  if (gcpToken && gcpToken.exp - TOKEN_SKEW_MS > deps.now()) return gcpToken.token;
  gcpTokenInflight ??= fetchGcpToken().finally(() => { gcpTokenInflight = null; });
  try {
    return await gcpTokenInflight;
  } catch (e) {
    throw e instanceof DbSecretError ? e.forRef(ref) : e;
  }
}

interface GoogleError { status: number; grpc: string; reason: string; message: string }

async function googleErrorOf(res: Response): Promise<GoogleError> {
  const text = await res.text().catch(() => "");
  let e: Record<string, unknown> = {};
  try { e = ((JSON.parse(text) as { error?: Record<string, unknown> })?.error ?? {}) as Record<string, unknown>; } catch { /* JSON 아닌 본문 */ }
  const details = Array.isArray(e.details) ? (e.details as Array<Record<string, unknown>>) : [];
  const reason = String(details.find((d) => typeof d?.reason === "string")?.reason ?? "");
  return { status: res.status, grpc: String(e.status ?? ""), reason, message: String(e.message ?? "").slice(0, 300) };
}

function gcpError(ref: string, g: GoogleError): DbSecretError {
  // 예: «403 PERMISSION_DENIED/ACCESS_TOKEN_SCOPE_INSUFFICIENT» · «404 NOT_FOUND»
  const providerCode = `${g.status}${g.grpc ? ` ${g.grpc}` : ""}${g.reason ? `/${g.reason}` : ""}`;
  const opts = { providerCode, providerMessage: g.message || null };
  if (g.status === 401) {
    return new DbSecretError("no_credentials", ref, "Secret Manager 가 서비스 계정 토큰을 받지 않았습니다(만료 · 무효)", opts);
  }
  if (g.status === 403) {
    if (g.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || /insufficient authentication scopes/i.test(g.message)) {
      return new DbSecretError("scope_insufficient", ref,
        "VM(노드)의 API 액세스 범위에 cloud-platform 이 없습니다 — 인스턴스 범위를 https://www.googleapis.com/auth/cloud-platform 으로 바꾸세요(VM 을 멈춰야 바꿀 수 있습니다)", opts);
    }
    if (g.reason === "SERVICE_DISABLED" || /has not been used in project|is disabled/i.test(g.message)) {
      return new DbSecretError("api_disabled", ref, "그 프로젝트에서 Secret Manager API(secretmanager.googleapis.com)가 꺼져 있습니다", opts);
    }
    return new DbSecretError("permission_denied", ref,
      "서비스 계정에 이 시크릿의 «Secret Manager 보안 비밀 접근자»(roles/secretmanager.secretAccessor) 역할이 없습니다 — GCP 는 시크릿이 없을 때도 이 응답을 주니 프로젝트 · 이름도 확인하세요", opts);
  }
  if (g.status === 404) {
    return new DbSecretError("not_found", ref, "시크릿 또는 그 버전이 없습니다 — 프로젝트 · 시크릿 이름 · 버전을 확인하세요", opts);
  }
  if (g.status === 400 && (g.grpc === "FAILED_PRECONDITION" || /DISABLED|DESTROYED/.test(g.message))) {
    return new DbSecretError("disabled", ref, "그 버전은 사용 중지(DISABLED)되었거나 폐기(DESTROYED)되었습니다 — 버전을 다시 켜거나 다른 버전을 가리키세요", opts);
  }
  if (g.status === 400) return new DbSecretError("bad_ref", ref, "Secret Manager 가 요청을 거절했습니다(형식)", opts);
  return new DbSecretError("unavailable", ref, "Secret Manager 가 일시 오류를 냈습니다", opts);
}

async function readGcpSecret(ref: Extract<SecretRef, { kind: "gcp-sm" }>): Promise<string> {
  // 참조 판정(secret-ref.ts)이 글자를 URL 에 안전한 것으로 묶어 두었다 — 인코딩 없이 경로에 넣는다.
  const url = `${deps.gcpSecretManagerBase}/projects/${ref.project}/secrets/${ref.secret}/versions/${ref.version}:access`;
  let tokenRefreshed = false;
  for (let attempt = 1; ; attempt++) {
    const token = await gcpAccessToken(ref.raw, false);
    let res: Response;
    try {
      res = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        signal: AbortSignal.timeout(STORE_TIMEOUT_MS),
        redirect: "error", // 토큰을 다른 호스트로 따라 보내지 않는다
      });
    } catch (e) {
      if (attempt < ATTEMPTS) { await sleep(deps.retryDelayMs * attempt); continue; }
      throw new DbSecretError("unavailable", ref.raw, `Secret Manager 에 닿지 않습니다(${netWhy(e)})`);
    }
    if (res.status === 200) {
      const j = (await res.json().catch(() => null)) as { payload?: { data?: unknown } } | null;
      const data = j?.payload?.data;
      if (typeof data !== "string") throw new DbSecretError("bad_value", ref.raw, "응답에 값(payload.data)이 없습니다");
      return Buffer.from(data, "base64").toString("utf8");
    }
    const g = await googleErrorOf(res);
    if (g.status === 401 && !tokenRefreshed) { tokenRefreshed = true; gcpToken = null; continue; } // 토큰이 막 만료됐을 수 있다 — 새 토큰으로 한 번
    if ((g.status === 429 || g.status >= 500) && attempt < ATTEMPTS) { await sleep(deps.retryDelayMs * attempt); continue; }
    throw gcpError(ref.raw, g);
  }
}

// ── AWS Secrets Manager ──
const AWS_CRED_CODES = new Set([
  "UnrecognizedClientException", "InvalidClientTokenId", "InvalidSignatureException", "SignatureDoesNotMatch",
  "ExpiredTokenException", "ExpiredToken", "IncompleteSignature", "MissingAuthenticationToken", "AuthFailure",
]);

function awsError(ref: string, e: unknown): DbSecretError {
  if (!(e instanceof AwsError)) {
    return new DbSecretError("unavailable", ref, `Secrets Manager 호출이 실패했습니다(${netWhy(e)})`);
  }
  const opts = { providerCode: e.status ? `${e.status} ${e.code}` : e.code, providerMessage: e.message.slice(0, 300) };
  if (e.code === "NoCredentials") {
    return new DbSecretError("no_credentials", ref,
      "게이트웨이에 AWS 자격이 없습니다 — EC2 인스턴스 프로파일(IAM 역할)을 붙이거나 게이트웨이 env 에 AWS 자격을 두세요(컨테이너 안이면 IMDS 홉 제한이 2 이상이어야 합니다)", opts);
  }
  if (AWS_CRED_CODES.has(e.code)) return new DbSecretError("no_credentials", ref, "AWS 가 게이트웨이 자격을 받지 않았습니다(무효 · 만료)", opts);
  if (e.code === "AccessDeniedException" || e.code === "AccessDenied") {
    return new DbSecretError("permission_denied", ref,
      "게이트웨이 자격(IAM 역할 · 사용자)에 이 시크릿의 secretsmanager:GetSecretValue 권한이 없습니다(고객 관리형 KMS 키로 암호화했다면 그 키의 kms:Decrypt 도 필요합니다)", opts);
  }
  if (e.code === "DecryptionFailure") {
    return new DbSecretError("permission_denied", ref, "KMS 키로 복호화하지 못했습니다 — 게이트웨이 자격(IAM 역할 · 사용자)에 그 키의 kms:Decrypt 권한이 필요합니다", opts);
  }
  if (e.code === "ResourceNotFoundException") {
    return new DbSecretError("not_found", ref, "그 리전에 시크릿(또는 그 버전)이 없습니다 — 리전 · 이름 · 버전을 확인하세요", opts);
  }
  if (e.code === "InvalidRequestException") {
    return new DbSecretError("disabled", ref, "지금은 읽을 수 없는 시크릿입니다(삭제 예약 등)", opts);
  }
  if (e.code === "InvalidParameterException" || e.code === "ValidationException") {
    return new DbSecretError("bad_ref", ref, "Secrets Manager 가 요청 값을 거절했습니다", opts);
  }
  return new DbSecretError("unavailable", ref, "Secrets Manager 가 일시 오류를 냈습니다", opts);
}

async function readAwsSecret(ref: Extract<SecretRef, { kind: "aws-sm" }>): Promise<string> {
  const host = `secretsmanager.${ref.region}.${ref.region.startsWith("cn-") ? "amazonaws.com.cn" : "amazonaws.com"}`;
  const body: Record<string, string> = { SecretId: ref.secretId };
  if (ref.versionId) body.VersionId = ref.versionId;
  if (ref.versionStage) body.VersionStage = ref.versionStage;
  let r;
  try {
    r = await awsCall(
      { service: "secretsmanager", region: ref.region, host, method: "POST", path: [], body,
        target: { header: "secretsmanager.GetSecretValue", jsonVersion: "1.1" }, timeoutMs: STORE_TIMEOUT_MS },
      { ...deps.aws, attempts: deps.aws.attempts ?? ATTEMPTS, retryDelayMs: deps.aws.retryDelayMs ?? deps.retryDelayMs },
    );
  } catch (e) {
    throw awsError(ref.raw, e);
  }
  const j = jsonOf<{ SecretString?: unknown; SecretBinary?: unknown }>(r);
  if (typeof j.SecretString === "string") return j.SecretString;
  if (typeof j.SecretBinary === "string") return Buffer.from(j.SecretBinary, "base64").toString("utf8");
  throw new DbSecretError("bad_value", ref.raw, "응답에 값(SecretString · SecretBinary)이 없습니다");
}

// ── 읽기 + 기억 ──
interface Entry {
  value: DbSecret;
  at: number;
  /** 저장소가 막혀 이 값으로 버티는 중이면, 이 시각 전에는 다시 묻지 않는다. */
  retryAfter?: number;
}
const cache = new Map<string, Entry>();
/** 진행 중 읽기 — fresh 읽기는 fresh 읽기에만 합류한다(옛 값으로 버틸 수 있는 보통 읽기의 결과를 «새로 읽은 값» 으로 받지 않게). */
const inflight = new Map<string, { p: Promise<DbSecret>; fresh: boolean }>();
/** 참조별 값 판 번호 — 값이 바뀌어 기억할 때마다 1 오른다. 풀이 «내 접속이 실패한 뒤 값이 바뀌었나» 를 가리는 데 쓴다. */
const versions = new Map<string, number>();

const sameSecret = (a: DbSecret, b: DbSecret): boolean => a.password === b.password && a.username === b.username;

/** 참조의 지금 값 판 번호(아직 읽은 적 없으면 0). 값 자체는 내주지 않는다. */
export function secretVersion(raw: string): number {
  return versions.get(raw) ?? 0;
}

async function fetchSecret(raw: string): Promise<DbSecret> {
  const p = parseSecretRef(raw);
  if (!p.ok) throw new DbSecretError("bad_ref", raw, p.error);
  const ref = p.ref;
  if (ref.kind === "env") throw new DbSecretError("bad_ref", raw, "환경변수 참조는 시크릿 저장소에서 읽지 않습니다(배선 오류)");
  const text = ref.kind === "gcp-sm" ? await readGcpSecret(ref) : await readAwsSecret(ref);
  return interpretSecretValue(text, raw);
}

/**
 * 시크릿 저장소 참조(gcp-sm: · aws-sm:)의 값을 읽는다. 5분 안에 읽은 값은 다시 묻지 않는다.
 *  fresh — 기억한 값을 건너뛰고 지금 다시 읽는다(접속 인증이 실패한 뒤). 옛 값으로 버티지 않는다.
 *  같은 참조의 읽기가 이미 진행 중이면 그 결과를 함께 쓴다(fresh 는 fresh 읽기에만 합류한다).
 */
export async function readDbSecret(raw: string, opts: { fresh?: boolean } = {}): Promise<DbSecret> {
  const fresh = opts.fresh === true;
  const now = deps.now();
  const hit = cache.get(raw);
  if (!fresh && hit) {
    if (now - hit.at < SECRET_TTL_MS) return hit.value;
    // 저장소가 막혀 옛 값으로 버티는 중 — 잠시는 다시 묻지 않는다(1시간 상한은 그대로).
    if (hit.retryAfter !== undefined && now < hit.retryAfter && now - hit.at < SECRET_MAX_STALE_MS) return hit.value;
  }
  const running = inflight.get(raw);
  if (running && (running.fresh || !fresh)) return running.p;
  const entry: { p: Promise<DbSecret>; fresh: boolean } = { p: Promise.resolve({ password: "" }), fresh };
  entry.p = (async (): Promise<DbSecret> => {
    try {
      const value = await fetchSecret(raw);
      const prev = cache.get(raw);
      cache.set(raw, { value, at: deps.now() });
      if (!prev || !sameSecret(prev.value, value)) versions.set(raw, secretVersion(raw) + 1);
      if (!prev) logger.info({ ref: raw }, "DB 소스 시크릿을 읽었다");
      else if (!sameSecret(prev.value, value)) logger.info({ ref: raw }, "DB 소스 시크릿 값이 바뀌었다(교체) — 새 값으로 접속한다");
      return value;
    } catch (e) {
      const err = e instanceof DbSecretError ? e : new DbSecretError("unavailable", raw, netWhy(e));
      const stale = cache.get(raw);
      if (!fresh && stale && err.reason === "unavailable" && deps.now() - stale.at < SECRET_MAX_STALE_MS) {
        stale.retryAfter = deps.now() + SECRET_STALE_RETRY_MS;
        logger.warn({ ref: raw, reason: err.reason, code: err.providerCode }, "DB 소스 시크릿 다시 읽기 일시 실패 — 기억한 값을 계속 쓴다");
        return stale.value;
      }
      logger.warn({ ref: raw, reason: err.reason, code: err.providerCode, provider: err.providerMessage }, "DB 소스 시크릿을 읽지 못했다");
      throw err;
    } finally {
      if (inflight.get(raw) === entry) inflight.delete(raw);
    }
  })();
  inflight.set(raw, entry);
  return entry.p;
}

/**
 * 시크릿을 다시 읽은 뒤에도 DB 인증이 실패했을 때의 오류. sameValue = 다시 읽은 값이 그대로라 붙어 보지도 않았다(mysql).
 *  원래 오류의 code · errno 는 그대로 옮긴다(부르는 쪽 · 감사가 DB 오류 코드로 가른다). 시크릿 값은 싣지 않는다.
 */
export function secretAuthRetryFailed(source: string, ref: string, cause: unknown, sameValue = false): Error {
  const how = sameValue
    ? `시크릿(${ref})을 다시 읽었지만 값이 그대로라 다시 붙지 않았습니다`
    : `시크릿(${ref})을 다시 읽어 한 번 더 붙었지만 또 실패했습니다`;
  const err = new Error(
    `db source '${source}' DB 인증 실패 — ${how}. 시크릿 값과 DB 의 비밀번호(사용자 이름)가 맞는지 확인하세요: ${(cause as Error)?.message ?? String(cause)}`,
    { cause },
  );
  const c = cause as { code?: unknown; errno?: unknown } | null;
  if (c?.code !== undefined) (err as { code?: unknown }).code = c.code;
  if (c?.errno !== undefined) (err as { errno?: unknown }).errno = c.errno;
  return err;
}

/** 기억한 값을 버린다 — 소스를 고치거나 지울 때(다음 접속이 새로 읽게). null · 환경변수 이름은 무시한다. */
export function forgetDbSecret(raw: string | null | undefined): void {
  if (raw) cache.delete(raw);
}
