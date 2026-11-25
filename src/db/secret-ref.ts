// DB 소스 비밀번호 참조(auth_ref) 꼴 판정 (#1764) — 순수 함수(네트워크 없음).
//  등록 도구(org_db_source_upsert) · 런타임 설정 허용 목록(allowed_db_secret_refs) · 접속 조립(sources/mysql-engine)이
//  모두 이 판정 하나를 쓴다 — 저장할 때 받은 꼴과 접속할 때 읽는 꼴이 어긋나지 않게.
//
//  꼴 셋:
//   · 환경변수 이름(종전 그대로)   ANALYTICS_DB_PW                                  → process.env[이름]
//   · GCP Secret Manager          gcp-sm:<프로젝트>/<시크릿>[#<버전>]               → 버전 생략 = latest
//   · AWS Secrets Manager         aws-sm:<리전>/<시크릿 이름>[#<버전>]              → 버전 생략 = AWSCURRENT
//                                 aws-sm:<시크릿 ARN>[#<버전>]                      → 리전은 ARN 에서
//  환경변수 이름에는 «:» 가 들어갈 수 없어서, «접두:» 가 붙은 값은 언제나 저장소 참조로 읽힌다(모르는 접두는 거절).
//  허용 목록은 지금처럼 **문자열 그대로** 비교한다 — 같은 시크릿이라도 꼴이 다르면 다른 항목이다(운영자가 적은 그대로만 연다).

export type SecretRef =
  | { kind: "env"; raw: string; name: string }
  | { kind: "gcp-sm"; raw: string; project: string; secret: string; version: string }
  | { kind: "aws-sm"; raw: string; region: string; secretId: string; versionId?: string; versionStage?: string };

export type SecretRefParse = { ok: true; ref: SecretRef } | { ok: false; error: string };

/** 참조 문자열 최대 길이 — AWS 시크릿 이름(512자)을 ARN 으로 적어도 들어가게. */
export const SECRET_REF_MAX = 600;

/** 사람에게 보여 줄 꼴 목록(오류 · 도구 설명 · 화면 안내 공용). */
export const SECRET_REF_FORMS =
  "환경변수 이름(예 ANALYTICS_DB_PW) · gcp-sm:<프로젝트>/<시크릿>[#버전] · aws-sm:<리전>/<시크릿 이름>[#버전] · aws-sm:<시크릿 ARN>[#버전]";

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const SCHEME_RE = /^([A-Za-z][A-Za-z0-9-]*):/;

// GCP — 프로젝트 ID(6~30자, 소문자로 시작) · 도메인 범위 프로젝트(example.com:my-project) · 프로젝트 번호.
//  시크릿 ID 는 글자·숫자·_·- 255자까지, 버전은 숫자 · latest · 버전 별칭(63자까지).
const GCP_PROJECT_RE = /^(?:(?:[a-z0-9-]+\.)+[a-z]{2,}:)?[a-z][a-z0-9-]{4,28}[a-z0-9]$/;
const GCP_PROJECT_NUM_RE = /^[1-9]\d{0,18}$/;
const GCP_SECRET_RE = /^[A-Za-z0-9_-]{1,255}$/;
const GCP_VERSION_RE = /^[A-Za-z0-9_-]{1,63}$/;

// AWS — 리전(us-gov-west-1 처럼 하이픈 여럿) · 시크릿 이름(글자·숫자·/_+=.@- 512자까지) · ARN.
//  버전 자리는 UUID 꼴이면 VersionId, 아니면 스테이징 라벨(AWSCURRENT · AWSPREVIOUS · 직접 붙인 라벨).
const AWS_REGION_RE = /^[a-z]{2}(?:-[a-z]+)+-\d{1,2}$/;
const AWS_NAME_RE = /^[A-Za-z0-9/_+=.@-]{1,512}$/;
const AWS_ARN_RE = /^arn:aws(?:-[a-z]+)*:secretsmanager:([a-z]{2}(?:-[a-z]+)+-\d{1,2}):\d{12}:secret:[A-Za-z0-9/_+=.@-]{1,512}$/;
const AWS_VERSION_ID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const AWS_STAGE_RE = /^[A-Za-z0-9_+=.@-]{1,256}$/;

/** 버전 꼬리(#…)를 떼어 낸다 — «#» 는 GCP · AWS 이름 어디에도 들어갈 수 없는 글자라 처음 나온 «#» 가 경계다(두 번이면 거절). */
function splitVersion(body: string): { locator: string; version: string | null } | { error: string } {
  const i = body.indexOf("#");
  if (i < 0) return { locator: body, version: null };
  if (body.indexOf("#", i + 1) >= 0) return { error: "«#» 는 버전 앞에 한 번만 씁니다" };
  const version = body.slice(i + 1);
  if (!version) return { error: "«#» 뒤에 버전이 비어 있습니다 — 버전을 적거나 «#» 를 빼세요" };
  return { locator: body.slice(0, i), version };
}

function parseGcp(raw: string, body: string): SecretRefParse {
  const sv = splitVersion(body);
  if ("error" in sv) return { ok: false, error: `gcp-sm 참조 형식 오류: ${sv.error}` };
  const slash = sv.locator.indexOf("/");
  if (slash < 0) return { ok: false, error: "gcp-sm 참조 형식 오류: gcp-sm:<프로젝트>/<시크릿>[#버전] 꼴이어야 합니다" };
  const project = sv.locator.slice(0, slash);
  const secret = sv.locator.slice(slash + 1);
  if (!GCP_PROJECT_RE.test(project) && !GCP_PROJECT_NUM_RE.test(project)) {
    return { ok: false, error: `gcp-sm 참조 형식 오류: 프로젝트 '${project}' 는 GCP 프로젝트 ID(소문자로 시작 6~30자) 또는 프로젝트 번호여야 합니다` };
  }
  if (!GCP_SECRET_RE.test(secret)) {
    return { ok: false, error: `gcp-sm 참조 형식 오류: 시크릿 이름 '${secret}' 는 글자·숫자·_·- 로 된 255자 이하여야 합니다(경로 «/» 는 쓸 수 없습니다)` };
  }
  const version = sv.version ?? "latest";
  if (!GCP_VERSION_RE.test(version)) {
    return { ok: false, error: `gcp-sm 참조 형식 오류: 버전 '${version}' 는 숫자 · latest · 버전 별칭이어야 합니다` };
  }
  return { ok: true, ref: { kind: "gcp-sm", raw, project, secret, version } };
}

function parseAws(raw: string, body: string): SecretRefParse {
  const sv = splitVersion(body);
  if ("error" in sv) return { ok: false, error: `aws-sm 참조 형식 오류: ${sv.error}` };
  let region: string;
  let secretId: string;
  if (sv.locator.startsWith("arn:")) {
    const m = AWS_ARN_RE.exec(sv.locator);
    if (!m) return { ok: false, error: "aws-sm 참조 형식 오류: ARN 은 arn:aws:secretsmanager:<리전>:<계정 12자리>:secret:<이름> 꼴이어야 합니다" };
    region = m[1];
    secretId = sv.locator;
  } else {
    const slash = sv.locator.indexOf("/");
    if (slash < 0) return { ok: false, error: "aws-sm 참조 형식 오류: aws-sm:<리전>/<시크릿 이름>[#버전] 또는 aws-sm:<시크릿 ARN> 꼴이어야 합니다" };
    region = sv.locator.slice(0, slash);
    secretId = sv.locator.slice(slash + 1);
    if (!AWS_REGION_RE.test(region)) {
      return { ok: false, error: `aws-sm 참조 형식 오류: 첫 칸 '${region}' 이 AWS 리전(예 ap-northeast-2)이 아닙니다 — aws-sm:<리전>/<시크릿 이름>` };
    }
    if (!AWS_NAME_RE.test(secretId)) {
      return { ok: false, error: `aws-sm 참조 형식 오류: 시크릿 이름 '${secretId}' 는 글자·숫자·/_+=.@- 로 된 512자 이하여야 합니다` };
    }
  }
  const out: SecretRef = { kind: "aws-sm", raw, region, secretId };
  if (sv.version !== null) {
    if (AWS_VERSION_ID_RE.test(sv.version)) out.versionId = sv.version;
    else if (AWS_STAGE_RE.test(sv.version)) out.versionStage = sv.version;
    else return { ok: false, error: `aws-sm 참조 형식 오류: 버전 '${sv.version}' 는 스테이징 라벨(AWSCURRENT 등) 또는 버전 ID(UUID)여야 합니다` };
  }
  return { ok: true, ref: out };
}

/** auth_ref 문자열 → 참조. 앞뒤 공백은 부르는 쪽이 이미 걷었다고 본다(공백이 남아 있으면 형식 오류). */
export function parseSecretRef(raw: string): SecretRefParse {
  if (typeof raw !== "string" || raw === "") return { ok: false, error: "비밀번호 참조가 비어 있습니다" };
  if (raw.length > SECRET_REF_MAX) return { ok: false, error: `비밀번호 참조가 너무 깁니다(${SECRET_REF_MAX}자 이하)` };
  const sm = SCHEME_RE.exec(raw);
  if (!sm) {
    if (ENV_NAME_RE.test(raw)) return { ok: true, ref: { kind: "env", raw, name: raw } };
    return { ok: false, error: `비밀번호 참조는 ${SECRET_REF_FORMS} 중 하나여야 합니다(시크릿 값 금지)` };
  }
  const scheme = sm[1].toLowerCase();
  const body = raw.slice(sm[0].length);
  if (scheme === "gcp-sm" && sm[1] === "gcp-sm") return parseGcp(raw, body);
  if (scheme === "aws-sm" && sm[1] === "aws-sm") return parseAws(raw, body);
  if (scheme === "gcp-sm" || scheme === "aws-sm") return { ok: false, error: `접두는 소문자로 씁니다 — '${scheme}:'` };
  return { ok: false, error: `지원하지 않는 시크릿 저장소 '${sm[1]}:' — ${SECRET_REF_FORMS} 만 받습니다` };
}

/** 시크릿 저장소 참조인가(gcp-sm: · aws-sm: 접두) — 형식이 맞는지는 parseSecretRef 가 따로 본다. */
export function isSecretStoreRef(raw: string | null | undefined): raw is string {
  return typeof raw === "string" && /^(?:gcp-sm|aws-sm):/.test(raw);
}
