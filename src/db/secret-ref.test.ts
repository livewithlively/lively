// #1764 비밀번호 참조(auth_ref) 꼴 판정 — 순수 함수 단위 시험(네트워크 없음).
//  사양(스크래치 spec.md A): 환경변수 이름은 종전 그대로 env, gcp-sm:<프로젝트>/<시크릿>[#버전](생략 = latest),
//   aws-sm:<리전>/<시크릿 이름>[#버전] · aws-sm:<ARN>[#버전](생략 = AWSCURRENT — 버전 칸 없음, UUID 꼴 = VersionId).
//   모르는 접두 · 대문자 접두 · 빈 칸 · «#» 두 번 · 600자 초과는 거절. 어느 꼴도 아닌 값(붙여 넣은 비밀번호)은 오류 문장에 되싣지 않는다.
// 실행: npm run build && node dist/db/secret-ref.test.js
import assert from "node:assert/strict";
import { parseSecretRef, isSecretStoreRef, SECRET_REF_MAX, type SecretRef } from "./secret-ref.js";

let pass = 0;
const t = (name: string, fn: () => void): void => {
  fn();
  pass++;
  console.log(`ok  ${name}`);
};
const okRef = (raw: string): SecretRef => {
  const r = parseSecretRef(raw);
  assert.ok(r.ok, `${raw.slice(0, 80)} 는 받혀야 한다: ${r.ok ? "" : r.error}`);
  return r.ref;
};
const bad = (raw: string, re?: RegExp): string => {
  const r = parseSecretRef(raw);
  assert.ok(!r.ok, `${raw.slice(0, 80)} 는 거절돼야 한다`);
  if (re) assert.match(r.error, re, `${raw.slice(0, 80)} 의 오류 문장`);
  return r.error;
};

// ── 환경변수 이름(종전 그대로) ──
t("env: 대문자 이름", () => assert.deepEqual(okRef("ANALYTICS_PW"), { kind: "env", raw: "ANALYTICS_PW", name: "ANALYTICS_PW" }));
t("env: 밑줄로 시작", () => assert.equal(okRef("_X1").kind, "env"));
t("env 거절: 숫자로 시작", () => bad("1ABC"));
t("env 거절: 빈 문자열", () => bad("", /비어/));
t("거절: 어느 꼴도 아닌 값은 오류에 되싣지 않는다(붙여 넣은 비밀번호)", () => {
  const e = bad("Hunter2!secret pw");
  assert.ok(!e.includes("Hunter2"), `오류 문장에 입력값이 실렸다: ${e}`);
});

// ── GCP ──
t("gcp: 버전 생략 = latest", () =>
  assert.deepEqual(okRef("gcp-sm:my-project/db-pw"), { kind: "gcp-sm", raw: "gcp-sm:my-project/db-pw", project: "my-project", secret: "db-pw", version: "latest" }));
t("gcp: 숫자 버전", () => assert.equal((okRef("gcp-sm:my-project/db-pw#5") as { version: string }).version, "5"));
t("gcp: latest 명시", () => assert.equal((okRef("gcp-sm:my-project/db-pw#latest") as { version: string }).version, "latest"));
t("gcp: 버전 별칭", () => assert.equal((okRef("gcp-sm:my-project/db-pw#prod_alias-1") as { version: string }).version, "prod_alias-1"));
t("gcp: 프로젝트 번호", () => assert.equal((okRef("gcp-sm:123456789012/db_pw") as { project: string }).project, "123456789012"));
t("gcp: 도메인 범위 프로젝트", () => assert.equal((okRef("gcp-sm:example.com:my-project/db") as { project: string }).project, "example.com:my-project"));
t("gcp 거절: 시크릿 없음", () => bad("gcp-sm:my-project", /프로젝트>\/<시크릿>/));
t("gcp 거절: 프로젝트 대문자", () => bad("gcp-sm:My-Project/db", /프로젝트/));
t("gcp 거절: 프로젝트 너무 짧음", () => bad("gcp-sm:abc/db", /프로젝트/));
t("gcp 거절: 시크릿 이름에 «/»", () => bad("gcp-sm:my-project/a/b", /시크릿 이름/));
t("gcp 거절: «#» 뒤가 비었다", () => bad("gcp-sm:my-project/db#", /비어/));
t("gcp 거절: «#» 두 번", () => bad("gcp-sm:my-project/db#1#2", /한 번만/));
t("gcp 거절: 대문자 접두", () => bad("GCP-SM:my-project/db", /소문자/));
t("gcp 거절: 공백", () => bad("gcp-sm:my-project/db pw"));

// ── AWS ──
t("aws: 리전/이름(이름에 «/»)", () =>
  assert.deepEqual(okRef("aws-sm:ap-northeast-2/prod/db/pw"), { kind: "aws-sm", raw: "aws-sm:ap-northeast-2/prod/db/pw", region: "ap-northeast-2", secretId: "prod/db/pw" }));
t("aws: 하이픈 여럿인 리전", () => assert.equal((okRef("aws-sm:us-gov-west-1/x") as { region: string }).region, "us-gov-west-1"));
t("aws: ARN — 리전은 ARN 에서, SecretId 는 ARN 그대로", () => {
  const arn = "arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:prod/db-AbCdEf";
  const r = okRef(`aws-sm:${arn}`) as { region: string; secretId: string };
  assert.equal(r.region, "ap-northeast-2");
  assert.equal(r.secretId, arn);
});
t("aws: 중국 파티션 ARN", () =>
  assert.equal((okRef("aws-sm:arn:aws-cn:secretsmanager:cn-north-1:123456789012:secret:x") as { region: string }).region, "cn-north-1"));
t("aws: 스테이징 라벨", () => {
  const r = okRef("aws-sm:ap-northeast-2/prod/db#AWSPREVIOUS") as { versionStage?: string; versionId?: string };
  assert.equal(r.versionStage, "AWSPREVIOUS");
  assert.equal(r.versionId, undefined);
});
t("aws: UUID 꼴 = 버전 ID", () => {
  const r = okRef("aws-sm:ap-northeast-2/prod/db#3f2504e0-4f89-11d3-9a0c-0305e82c3301") as { versionStage?: string; versionId?: string };
  assert.equal(r.versionId, "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  assert.equal(r.versionStage, undefined);
});
t("aws: 버전 생략 = 버전 칸 없음(AWSCURRENT)", () => {
  const r = okRef("aws-sm:ap-northeast-2/prod/db") as { versionStage?: string; versionId?: string };
  assert.equal(r.versionStage, undefined);
  assert.equal(r.versionId, undefined);
});
t("aws 거절: 리전 없이 이름만", () => bad("aws-sm:prod/db", /리전/));
t("aws 거절: 이름 비었다", () => bad("aws-sm:ap-northeast-2/", /시크릿 이름/));
t("aws 거절: 잘못된 ARN(계정 자릿수)", () => bad("aws-sm:arn:aws:secretsmanager:ap-northeast-2:12345:secret:x", /ARN/));
t("aws 거절: «/» 없음", () => bad("aws-sm:ap-northeast-2", /aws-sm:<리전>/));

// ── 길이 경계(E7) — 정확히 600자는 받고 601자는 거절 ──
const ARN_PREFIX = "aws-sm:arn:aws:secretsmanager:ap-northeast-2:123456789012:secret:";
const at600 = ARN_PREFIX + "a".repeat(512) + "#" + "S".repeat(600 - ARN_PREFIX.length - 512 - 1);
t("경계: 정확히 600자 참조는 받는다", () => {
  assert.equal(at600.length, SECRET_REF_MAX);
  assert.equal(okRef(at600).kind, "aws-sm");
});
t("경계: 601자 참조는 거절", () => bad(at600 + "S", /너무 깁니다/));

// ── 그 밖 ──
t("거절: 모르는 저장소", () => bad("vault:secret/db", /지원하지 않는/));
t("isSecretStoreRef: 저장소 접두만 참", () => {
  assert.equal(isSecretStoreRef("gcp-sm:my-project/db"), true);
  assert.equal(isSecretStoreRef("aws-sm:ap-northeast-2/db"), true);
  assert.equal(isSecretStoreRef("ANALYTICS_PW"), false);
  assert.equal(isSecretStoreRef(null), false);
  assert.equal(isSecretStoreRef(undefined), false);
  assert.equal(isSecretStoreRef(""), false);
});

console.log(`\n${pass} passed`);
