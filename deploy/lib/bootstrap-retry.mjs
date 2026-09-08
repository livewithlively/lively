// 부트스트랩 재시도(#2578) — deploy/bootstrap-*.mjs 공용. 의존성 0(node 내장만).
//
// 왜: 부트스트랩은 게이트웨이를 거치지 않고 DB 에 직접 쓴다(dist/org/store.js). 게이트웨이는 listen **뒤**에 스키마를
//  비동기로 마이그레이션하므로, 설치 스크립트가 /healthz 만 보고 곧장 이걸 돌리면 `column "tenant_id" does not exist`
//  (42703) 로 죽었다(2026-09-03 EC2 실측 — 관리자 없는 박스가 '완료'로 끝남). 1차 방어는 deploy/lib/common.sh 의
//  wait_ready(/readyz schema=ready). 이 재시도는 **2차 방어** — 사람이 손으로 돌릴 때(재부팅 직후·DB 컨테이너 기동 중),
//  구버전 게이트웨이(readyz 에 schema 없음) 위에서 돌 때 같은 창을 스스로 넘긴다.
//
// 재시도 대상 = «시간이 해결하는» 오류만:
//   Postgres  42703 undefined_column · 42P01 undefined_table · 42704 undefined_object · 42883 undefined_function
//             (마이그레이션이 아직 안 만든 것) · 57P03 cannot_connect_now(DB 기동 중) · 08xxx connection_exception
//   소켓      ECONNREFUSED · ECONNRESET · ETIMEDOUT · EPIPE · EAI_AGAIN (DB 컨테이너가 아직 안 떴다)
//  그 외(권한 42501 · 문법 · 제약 위반 · 자격증명 28P01)는 즉시 던진다 — 기다려도 안 바뀐다.
// 상한: BOOTSTRAP_RETRY_MAX_MS(기본 60000 · 0 = 재시도 없음). 백오프 500ms ×1.5, 최대 5s. 진행은 stderr 로(설치 로그에 남는다).

const RETRYABLE_PG = new Set(["42703", "42P01", "42704", "42883", "57P03"]);
const RETRYABLE_NET = new Set(["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EPIPE", "EAI_AGAIN"]);

function codeOf(err) {
  if (!err || typeof err !== "object") return "";
  const own = typeof err.code === "string" ? err.code : "";
  if (own) return own;
  // node net 은 여러 주소를 시도하면 AggregateError 로 싼다(errors[i].code) — 첫 원인을 본다.
  const inner = Array.isArray(err.errors) ? err.errors.find((e) => e && typeof e.code === "string") : null;
  if (inner) return inner.code;
  const cause = err.cause && typeof err.cause === "object" && typeof err.cause.code === "string" ? err.cause.code : "";
  return cause;
}

export function isRetryableBootstrapError(err) {
  const code = codeOf(err);
  if (!code) return false;
  if (RETRYABLE_PG.has(code) || RETRYABLE_NET.has(code)) return true;
  return /^08[0-9A-Z]{3}$/.test(code);   // connection_exception 계열(08000·08001·08003·08006·08004 …)
}

function budgetMs(opts) {
  const raw = (process.env.BOOTSTRAP_RETRY_MAX_MS ?? "").trim();
  if (/^\d+$/.test(raw)) return Number(raw);
  return opts.maxMs ?? 60_000;
}

/**
 * fn 을 실행하되 «시간이 해결하는» 오류면 백오프로 다시 시도한다. 상한을 넘기면 마지막 오류를 그대로 던진다.
 *  fn 은 멱등이어야 한다(부트스트랩 셋은 전부 upsert 다).
 *  opts.sleep / opts.now / opts.log 는 테스트 주입용.
 */
export async function withBootstrapRetry(label, fn, opts = {}) {
  const maxMs = budgetMs(opts);
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const log = opts.log ?? ((line) => console.error(line));
  const maxDelay = opts.maxDelayMs ?? 5_000;
  const started = now();
  let delay = opts.initialDelayMs ?? 500;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const elapsed = now() - started;
      if (!isRetryableBootstrapError(err) || elapsed + delay > maxMs) throw err;
      log(`[${label}] 재시도 ${attempt} — ${codeOf(err)} ${err && err.message ? String(err.message).split("\n")[0] : ""} (${delay}ms 뒤 · 경과 ${elapsed}/${maxMs}ms — 스키마 마이그레이션·DB 기동 대기)`);
      await sleep(delay);
      delay = Math.min(Math.round(delay * 1.5), maxDelay);
    }
  }
}

/** 최종 실패 보고 — 한 줄 요약(stderr) + exit 1. 스택은 두 번째 줄부터(설치 로그에 남되 요약 줄이 먼저 보이게). */
export function exitOnBootstrapFailure(label, err) {
  const code = codeOf(err);
  const msg = err && err.message ? String(err.message) : String(err);
  console.error(`[${label}] 실패${code ? ` (${code})` : ""}: ${msg}`);
  if (err && err.stack) console.error(err.stack);
  process.exit(1);
}
