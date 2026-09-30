// 위탁 경로 비밀 가림(#4422) — 사양 엣지 표 R1~R10. 순수 함수라 입력·기대 표를 그대로 잰다.
//
//  | #   | 입력                                              | 기대                                    |
//  |-----|---------------------------------------------------|-----------------------------------------|
//  | R1  | 리터럴 리스 값(모양 모름)                         | 가려짐                                  |
//  | R2  | sk-ant-oat01-…(값 모름)                           | 가려짐                                  |
//  | R3  | `-e CLAUDE_CODE_OAUTH_TOKEN=임의`(값·모양 모름)    | 이름은 남고 값만 가려짐                 |
//  | R4  | 비밀 아닌 좌표 env                                | 그대로                                  |
//  | R5  | 경계: 리터럴 8자 → 가림 / 7자 → 그대로             |                                         |
//  | R6  | execFile 오류(cmd·stderr·stdout 속성)             | 새 Error · 가린 문장 · 위험 속성 없음   |
//  | R7  | null·undefined·빈 문자열·비문자 값                | 던지지 않음                             |
//  | R8  | JSON 토큰 칸 · JWT                                | 값만 가려짐(구조 보존 — 다시 파싱된다)  |
//  | R9  | URL userinfo 자격                                 | 자격만 가려짐, 호스트 남음              |
//  | R10 | 같은 값 여러 번 · 긴 값이 짧은 값을 품음           | 조각 없이 전부 가려짐                   |
//  | R11 | 모양만 수준 — 산문(Bearer 글·MAX_TOKENS=·KEY=값) | 산문 그대로, 토큰 모양만 가림           |
//  | R12 | 낱말 경계 — desk-ant-… · risk-0123… · X_sk-ant-… | 앞 둘은 그대로, 셋째는 가림             |
//  | R13 | 결과 행 규칙 — last_assign 전체 · 요약 모양만 · 원본 불변 · null·비객체 |                     |
import { strict as assert } from "node:assert";
import { redactTaskText, redactTaskShapes, redactTaskJson, redactTaskResult, redactTaskRow, redactTaskError, taskSecretValues, TASK_REDACTED } from "./task-secrets.js";
import { redactString } from "../org/ingest/redact.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };
const SETUP = "sk-ant-oat01-" + "x".repeat(40) + "_Y-" + "9".repeat(30);

t("R1 리터럴 리스 값은 모양을 몰라도 가려진다", () => {
  const v = "plain lease value without any known shape";
  const out = redactTaskText(`spawn failed: ${v} (end)`, taskSecretValues({ K: v }));
  assert.ok(!out.includes(v), out);
  assert.ok(out.includes("spawn failed:") && out.includes("(end)"), "주변 문장은 남는다");
});
t("R2 setup-token 모양은 값을 몰라도 가려진다(공통 규칙에 Anthropic 모양이 있다)", () => {
  assert.ok(!redactTaskText(`token ${SETUP} here`).includes(SETUP));
  assert.ok(!redactString(`token ${SETUP} here`).includes(SETUP), "공통 redactString 도 Anthropic 모양을 잡는다(#4048 규칙 구멍)");
  const api = "sk-ant-api03-" + "k".repeat(50);
  assert.ok(!redactTaskText(api).includes(api), "API 키 모양도");
});
t("R3 비밀 이름의 KEY=값 은 값도 모양도 몰라도 값만 가려진다", () => {
  for (const [line, name] of [
    ["-e CLAUDE_CODE_OAUTH_TOKEN=zzz-unknown-shape-123 -c /w", "CLAUDE_CODE_OAUTH_TOKEN"],
    ["LIVELY_MCP_TOKEN='abc def ghi'", "LIVELY_MCP_TOKEN"],
    ['CODEX_AUTH_JSON="{x}" next', "CODEX_AUTH_JSON"],
    ["GH_TOKEN=abc123", "GH_TOKEN"],
    ["DB_PASSWORD=hunter2", "DB_PASSWORD"],
  ] as const) {
    const out = redactTaskText(line);
    assert.ok(out.includes(`${name}=${TASK_REDACTED}`), `${name}: ${out}`);
    assert.ok(!/zzz-unknown|abc def|\{x\}|abc123|hunter2/.test(out), `${name} 값이 남았다: ${out}`);
  }
  assert.ok(redactTaskText("-e CLAUDE_CODE_OAUTH_TOKEN=zzz -c /w").endsWith(" -c /w"), "다음 인자는 남는다");
  //  값만 — 닫는 따옴표·괄호는 남아 JSON 이 다시 파싱된다(리뷰 지적: `\S+` 는 `"}` 까지 먹었다).
  const inJson = redactTaskText(JSON.stringify({ env: "GH_TOKEN=abc", q: 'x GH_TOKEN="p q" y' }));
  assert.deepEqual(JSON.parse(inJson), { env: `GH_TOKEN=${TASK_REDACTED}`, q: `x GH_TOKEN=${TASK_REDACTED} y` }, inJson);
  assert.equal(redactTaskText("MAX_TOKENS=4096 TOKEN_FILE=/x"), "MAX_TOKENS=4096 TOKEN_FILE=/x", "비밀 이름으로 **끝나지** 않으면 설정값이다");
});
t("R4 비밀 아닌 좌표 env 는 그대로", () => {
  const line = "new-session -d -s box-a1 -e LANG=C.UTF-8 -e LIVELY_TASK_WS=/work/shared/delegated/task-9 -e LIVELY_TASK_ID=9 -e LIVELY_SESSION_ID=box-a1 -e CLAUDE_CONFIG_DIR=/home/x/.claude -e LVLY_TENANT_SLUG=lively-46e3";
  assert.equal(redactTaskText(line), line);
});
t("R5 리터럴 경계 — 8자는 가리고 7자는 두지 않는다(과잉 가림 방지)", () => {
  assert.equal(redactTaskText("a 12345678 b", taskSecretValues({ k: "12345678" })), `a ${TASK_REDACTED} b`);
  assert.equal(redactTaskText("a 1234567 b", taskSecretValues({ k: "1234567" })), "a 1234567 b");
  assert.deepEqual(taskSecretValues({ a: "1234567", b: 42 as unknown as string, c: null as unknown as string }), [], "짧은 값·비문자는 모으지 않는다");
});
t("R6 execFile 오류 — 새 Error, 가린 문장, 명령줄·자식 출력 속성 없음, 분기용 속성은 옮긴다", () => {
  const e = Object.assign(new Error(`Command failed: tmux new-session -e CLAUDE_CODE_OAUTH_TOKEN=${SETUP}\npsmux: failed`), {
    cmd: `tmux new-session -e CLAUDE_CODE_OAUTH_TOKEN=${SETUP}`, stderr: "psmux: failed", stdout: "", code: 1, sent: true, killed: false,
  });
  const out = redactTaskError(e, taskSecretValues({ K: SETUP }));
  assert.notEqual(out, e, "새 객체여야 한다(원본의 cmd 가 따라가지 않게)");
  const all = JSON.stringify(Object.fromEntries(Object.getOwnPropertyNames(out).map((k) => [k, (out as unknown as Record<string, unknown>)[k]])));
  assert.ok(!all.includes(SETUP), all);
  assert.ok(out.message.includes("psmux: failed"), "원인 문장은 남는다");
  for (const k of ["cmd", "stderr", "stdout"]) assert.ok(!Object.hasOwn(out, k), `${k} 가 따라왔다`);
  assert.equal((out as unknown as { sent: boolean }).sent, true, "sent 는 rpcMaybeSent 가 읽는다 — 잃으면 재전송 판단이 바뀐다");
  assert.equal((out as unknown as { code: number }).code, 1);
  //  가릴 게 없으면 **원래 오류 그대로**(타입·상태코드 보존 — 무회귀).
  class HttpLike extends Error { status = 409; }
  const clean = new HttpLike("레포의 git 주소가 레지스트리에 없습니다");
  assert.equal(redactTaskError(clean, taskSecretValues({ K: SETUP })), clean);
});
t("R7 무엇이 와도 던지지 않는다", () => {
  assert.equal(redactTaskText(null), "");
  assert.equal(redactTaskText(undefined), "");
  assert.equal(redactTaskText(""), "");
  assert.equal(redactTaskText(42), "42");
  assert.ok(redactTaskError("plain string") instanceof Error);
  assert.ok(redactTaskError(undefined) instanceof Error);
  assert.deepEqual(taskSecretValues(undefined, null), []);
});
t("R8 JSON 토큰 칸·JWT — 값만 가려지고 구조는 다시 파싱된다", () => {
  //  JWT 모양은 조립한다 — 한 덩어리 리터럴이면 시크릿 스캔(gitleaks jwt 룰)이 픽스처를 실값으로 본다.
  const jwt = ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiI0NDIyIn0", "s".repeat(43)].join(".");
  const doc = JSON.stringify({ items: [1, 2], access_token: "opaque-token-value-abc", note: `bearer-less ${jwt}` });
  const out = redactTaskText(doc);
  assert.ok(!out.includes("opaque-token-value-abc") && !out.includes(jwt), out);
  const parsed = JSON.parse(out) as { items: number[]; access_token: string };
  assert.deepEqual(parsed.items, [1, 2], "구조가 깨졌다 — 결과를 파싱하는 소비자가 죽는다");
  assert.equal(parsed.access_token, TASK_REDACTED);
  const at = new Date("2026-09-22T07:05:26.048Z");
  const deep = JSON.parse(redactTaskJson({ a: [SETUP, 3, true, null], b: { c: `x ${SETUP}` }, at, gone: undefined }));
  assert.deepEqual(deep, { a: [TASK_REDACTED, 3, true, null], b: { c: `x ${TASK_REDACTED}` }, at: at.toISOString() },
    "저장 가림은 문자열 잎만 바꾸고 직렬화 규칙(Date→ISO·undefined 생략)은 JSON.stringify 그대로다");
});
t("R9 URL 에 박힌 자격은 가리고 호스트는 남긴다", () => {
  const out = redactTaskText("fatal: unable to access 'https://x-access-token:ghs_" + "a".repeat(36) + "@github.com/org/repo.git/'");
  assert.ok(out.includes(`https://${TASK_REDACTED}@github.com/org/repo.git`), out);
  assert.ok(!out.includes("ghs_"), out);
  assert.ok(!redactTaskText("token ghs_" + "b".repeat(36)).includes("ghs_"), "앱 설치 토큰 모양 단독도");
});
t("R10 같은 값 여러 번·긴 값이 짧은 값을 품어도 조각이 남지 않는다", () => {
  const short = "abcdefgh12";
  const long = `${short}-and-more-secret`;
  const out = redactTaskText(`${long} / ${short} / ${long}`, taskSecretValues({ s: short, l: long }));
  assert.equal(out, `${TASK_REDACTED} / ${TASK_REDACTED} / ${TASK_REDACTED}`);
  assert.ok(!out.includes("-and-more-secret"), "짧은 값을 먼저 바꾸면 긴 값의 꼬리가 남는다");
});

t("R11 모양만 수준은 산문을 그대로 두고 토큰 모양만 가린다(AI 가 쓴 요약용)", () => {
  const prose = "Added Bearer authentication middleware; set MAX_TOKENS=4096 and GH_TOKEN=abc in CI";
  assert.equal(redactTaskShapes(prose), prose);
  assert.notEqual(redactTaskText(prose), prose, "배선 — 전체 수준은 같은 글을 가린다(두 수준이 실제로 다르다)");
  assert.equal(redactTaskShapes(`${prose} ${SETUP}`), `${prose} ${TASK_REDACTED}`);
  assert.equal(redactTaskShapes("lease plain value 4422!", ["lease plain value 4422!"]), TASK_REDACTED, "리터럴은 모양만 수준에서도 가린다");
});
t("R12 토큰 모양은 낱말 안에서 시작하지 않는다", () => {
  for (const w of ["desk-ant-colony-optimization-algorithm", "risk-0123456789abcdefghij"]) assert.equal(redactTaskText(w), w, w);
  const glued = `X_${SETUP}`;
  assert.equal(redactTaskText(glued), `X_${TASK_REDACTED}`, "밑줄 뒤에 붙은 토큰은 가린다");
});
t("R13 결과 행 규칙 — last_assign 은 전체, 요약은 모양만, 원본은 그대로", () => {
  const row = {
    id: 7, status: "failed",
    result: { summary: "Added Bearer authentication middleware", last_assign: { code: "spawn_error", reason: "-e CLAUDE_CODE_OAUTH_TOKEN=zzz-unknown-shape" }, exit: 1 },
    error: `boom GH_TOKEN=abc ${SETUP}`,
  };
  const before = JSON.stringify(row);
  const out = redactTaskRow(row);
  assert.equal(JSON.stringify(row), before, "원본 행을 바꾸면 안 된다(호출부가 같은 객체를 다시 쓴다)");
  assert.equal(out.id, 7);
  assert.equal(out.result.summary, "Added Bearer authentication middleware", "요약 산문은 그대로");
  assert.equal(out.result.last_assign.reason, `-e CLAUDE_CODE_OAUTH_TOKEN=${TASK_REDACTED}`, "배정 실패 원문은 이름 규칙까지");
  assert.equal(out.result.exit, 1);
  assert.equal(out.error, `boom GH_TOKEN=${TASK_REDACTED} ${TASK_REDACTED}`);
  assert.equal(redactTaskRow(null), null);
  assert.equal(redactTaskResult(null), null);
  assert.equal(redactTaskResult(`x ${SETUP}`), `x ${TASK_REDACTED}`, "옛 행의 비객체 결과도 가린다");
  assert.deepEqual(redactTaskRow({ result: undefined, error: null }), { result: undefined, error: null });
});

console.log(`task-secrets.test: ok (${pass})`);
