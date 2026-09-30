// 위탁 경로의 비밀 가림(#4422) — 자격 리스(setup-token 등)가 오류 문장을 타고 기록·응답·로그로 새지 않게.
//
//  사고(2026-09-22 위탁 #4074): 판 생성(`psmux new-session`)이 실패하자 Node execFile 의 오류 문장 "Command failed: <argv 전체>" 가
//   `org_task.result.last_assign.reason` 에 그대로 저장됐다. 그때는 리스가 tmux 명령줄(`-e K=V`)에 펼쳐져 있어 토큰이 통째로 실렸다.
//   근본 수정은 리스를 명령줄에서 빼는 것(tasks.ts — 0600 파일)이고, 이 모듈은 **그래도 남는 경로**를 막는 겹이다:
//   구 노드 번들이 가리지 않은 원문을 돌려주는 경우 · 모양을 모르는 다른 오류 문장에 값이 섞이는 경우 · 이미 저장된 옛 행.
//
//  가림은 두 수준이다.
//   · 전체(redactTaskText) — 오류 문장·배정 실패 기록·로그. 기계가 만든 문장이라 과잉 가림의 대가가 작다.
//     ① 리터럴 — 이번 위탁이 실제로 실은 값(리스 env·레포 자격). 모양을 몰라도 잡는다. 8자 미만은 과잉 가림이라 뺀다.
//     ② 이름 — 비밀 이름으로 **끝나는** `KEY=값`(명령줄·env 덤프 모양). 값도 모양도 모르는 게이트웨이 쪽(구 노드의 원문)이 이걸로 잡는다.
//     ③ 모양 — 공통 규칙(org/ingest/redact · #4048) 전부 + URL 에 박힌 자격 + JSON 토큰 칸.
//   · 모양만(redactTaskShapes) — AI 가 쓴 결과 요약처럼 **산문이 주인**인 자리. ①·③ 의 토큰 모양만 — «MAX_TOKENS=4096» 이나
//     «Bearer authentication» 같은 글을 망가뜨리지 않는다.
//  ⚠ 가림은 값 자리만 바꾼다(키·따옴표·괄호는 남긴다) — JSON 을 품은 문장도 가린 뒤 다시 파싱된다(시험 R3·R8).
//  ⚠ 노드 에이전트 번들에 실린다(tasks.ts) — DB·무거운 모듈을 물지 않는다(scripts/node-agent-allowed-modules.json).
import { redactString, redactTokenShapes } from "../org/ingest/redact.js";

export const TASK_REDACTED = "[REDACTED]";   // redactString 과 같은 표식 — 한 기록 안에서 두 표식이 섞이지 않게

//  리스 env 이름 규칙 — 이 이름은 워커 스크립트에 **그대로** 박힌다(tasks.ts taskScript). 규칙 밖이면 싣지 않는다.
export const LEASE_ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;

const LITERAL_MIN = 8;
//  비밀 이름 — 그 낱말로 **끝나야** 한다(`CLAUDE_CODE_OAUTH_TOKEN`·`LIVELY_MCP_TOKEN`·`CODEX_AUTH_JSON`·`GH_TOKEN`·`DB_PASSWORD`).
//   `MAX_TOKENS`·`TOKEN_FILE` 같은 설정값과 `LIVELY_TASK_WS`·`LANG` 같은 좌표는 걸리지 않는다(시험 R3·R4).
const SECRET_NAME = "[A-Z][A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY|AUTH_JSON|CREDENTIALS?)";
//  값 — 따옴표로 묶였으면 그 안, 아니면 공백·따옴표·구분자 전까지. `\S+` 는 JSON 의 닫는 따옴표·괄호까지 먹어 구조를 깼다(리뷰 지적).
//   JSON 문자열 **안**에 든 문장(`\"값\"` — 이스케이프된 따옴표)도 그 따옴표 사이를 값으로 본다(아니면 첫 글자 `\` 에서 멈춰 값이 샌다).
const SECRET_ASSIGN = new RegExp(`\\b(${SECRET_NAME})=(\\\\"[^"\\\\\\n]*\\\\"|"[^"\\n]*"|'[^'\\n]*'|[^\\s"'\`,;)}\\]\\\\]+)`, "g");
//  URL 에 박힌 자격(`https://x-access-token:<토큰>@github.com/…`) — 호스트는 남긴다(원인 문장은 읽혀야 한다).
const URL_USERINFO = /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"']+:[^\s/@"']+@/gi;
//  JSON 토큰 칸 — 값만 바꾼다(칸·따옴표는 남긴다).
const JSON_TOKEN_FIELD = /("(?:access_token|refresh_token|id_token|accessToken|refreshToken)"\s*:\s*")[^"]*(")/g;

/** 가릴 리터럴 값 모으기 — 문자열만, 8자 이상, 중복 없이, **긴 것부터**(긴 값이 짧은 값을 품으면 짧은 것부터 바꿀 때 조각이 남는다). */
export function taskSecretValues(...sources: Array<Record<string, unknown> | null | undefined>): string[] {
  const out = new Set<string>();
  for (const src of sources) {
    for (const v of Object.values(src ?? {})) {
      if (typeof v === "string" && v.trim().length >= LITERAL_MIN) { out.add(v); out.add(v.trim()); }
    }
  }
  return [...out].filter((v) => v.length >= LITERAL_MIN).sort((a, b) => b.length - a.length);
}

function asText(text: unknown): string {
  if (text === null || text === undefined) return "";
  return typeof text === "string" ? text : String(text);
}
function scrubLiterals(s: string, secrets: readonly string[]): string {
  for (const v of secrets) if (typeof v === "string" && v.length >= LITERAL_MIN) s = s.split(v).join(TASK_REDACTED);
  return s;
}

/** (순수) 기계가 만든 문장(오류·배정 실패·로그)을 가린다 — 전체 수준. 무엇이 와도 던지지 않는다. */
export function redactTaskText(text: unknown, secrets: readonly string[] = []): string {
  let s = scrubLiterals(asText(text), secrets);
  s = s.replace(SECRET_ASSIGN, `$1=${TASK_REDACTED}`);
  s = s.replace(URL_USERINFO, `$1${TASK_REDACTED}@`);
  s = s.replace(JSON_TOKEN_FIELD, `$1${TASK_REDACTED}$2`);
  return redactString(s);
}

/** (순수) 산문이 주인인 글(AI 결과 요약)을 가린다 — 리터럴 + 토큰 모양만. 이름·문맥 규칙은 쓰지 않는다. */
export function redactTaskShapes(text: unknown, secrets: readonly string[] = []): string {
  let s = scrubLiterals(asText(text), secrets);
  s = s.replace(URL_USERINFO, `$1${TASK_REDACTED}@`);
  s = s.replace(JSON_TOKEN_FIELD, `$1${TASK_REDACTED}$2`);
  return redactTokenShapes(s);
}

/** (순수) 값을 JSON 으로 굳히며 가린다 — 문자열 잎만 바꾸고 키·배열·수는 그대로다.
 *  직렬화 규칙(toJSON·undefined 생략)은 JSON.stringify 그대로다 — replacer 는 toJSON 뒤의 값을 받으므로 Date 도 문자열로 가려진다. */
export function redactTaskJson(v: unknown, level: "full" | "shapes" = "full"): string {
  const f = level === "full" ? redactTaskText : redactTaskShapes;
  return JSON.stringify(v, (_k, x: unknown) => (typeof x === "string" ? f(x) : x)) ?? "null";
}

/**
 * org_task.result 의 가림 규칙 — **한 곳**에서 정한다. 저장 직전(task-store markFinished)과 읽기(delegate_status·list)가 같이 쓴다.
 *  · `last_assign` — 스폰 오류 원문이다(사고 자리) → 전체 수준.
 *  · 그 밖(summary = AI 가 쓴 최종 답 등) → 모양만.
 *  객체가 아니면(옛 행의 이상한 값) 통째로 모양만 가린다.
 */
export function redactTaskResult<T>(result: T): T {
  if (result === null || result === undefined) return result;
  if (typeof result !== "object" || Array.isArray(result)) return JSON.parse(redactTaskJson(result, "shapes")) as T;
  const { last_assign: lastAssign, ...rest } = result as Record<string, unknown>;
  const out = JSON.parse(redactTaskJson(rest, "shapes")) as Record<string, unknown>;
  if (lastAssign !== undefined) out.last_assign = JSON.parse(redactTaskJson(lastAssign, "full"));
  return out as T;
}

/** 밖으로 내보낼 태스크 행 — result·error 를 가린 사본(원본은 안 바꾼다). 가림이 들어가기 전에 쌓인 옛 행도 읽는 순간 가려진다. */
export function redactTaskRow<T extends { result?: unknown; error?: unknown }>(row: T): T;
export function redactTaskRow<T extends { result?: unknown; error?: unknown }>(row: T | null | undefined): T | null | undefined;
export function redactTaskRow<T extends { result?: unknown; error?: unknown }>(row: T | null | undefined): T | null | undefined {
  if (!row) return row;
  return {
    ...row,
    result: redactTaskResult(row.result),
    error: typeof row.error === "string" ? redactTaskText(row.error) : row.error,
  };
}

//  execFile·spawn 오류가 다는 속성 — 명령줄 전체(cmd·spawnargs)와 자식 출력(stdout·stderr). 로거가 `{ err }` 로 받으면 통째로 찍힌다.
const RISKY_PROPS = ["cmd", "spawnargs", "stdout", "stderr"] as const;
//  호출부가 갈라 읽는 속성 — 옮겨 싣는다(비밀이 아니다). `sent` 는 rpc-error.rpcMaybeSent 가, `status` 는 HttpError 소비자가 본다.
const KEEP_PROPS = ["sent", "code", "status"] as const;

/**
 * (순수) 밖으로 나갈 오류를 가린다. 가릴 것이 없으면 **원래 오류를 그대로** 돌려준다(타입·상태코드 보존 — 무회귀).
 *  가릴 것이 있으면 새 Error 로: 문장은 가리고, 명령줄·자식 출력 속성은 버리고, 분기용 원시 속성만 옮긴다.
 */
export function redactTaskError(err: unknown, secrets: readonly string[] = []): Error {
  const e = err instanceof Error ? err : new Error(String(err));
  const message = redactTaskText(e.message, secrets);
  const risky = RISKY_PROPS.some((k) => Object.hasOwn(e, k));
  if (message === e.message && !risky && err instanceof Error) return e;
  const out = new Error(message);
  for (const k of KEEP_PROPS) {
    const v = (e as unknown as Record<string, unknown>)[k];
    if (typeof v === "boolean" || typeof v === "number" || (typeof v === "string" && v.length <= 64 && redactTaskText(v, secrets) === v)) {
      (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return out;
}
