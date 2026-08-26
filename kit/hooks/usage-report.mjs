#!/usr/bin/env node
// statusLine 훅 — 상시(managed) 세션에만 스폰타임 --settings 로 배선된다(src/terminal/catalog.ts managedStatusLineSpec).
//  목적: Claude 구독 rate-limit 소진율(5시간·7일 창)을 게이트웨이로 보고해 관리탭 상시세션 목록에 보이게 한다.
//  왜 statusLine 인가: rate_limits 는 **statusLine stdin JSON 에만** 실린다 — hook stdin·REST 어디에도 없다(CC 문서 확인).
//   그래서 세션 안에서 도는 이 스크립트만이 그 값을 볼 수 있고, 그걸 POST 로 밖(게이트웨이)에 내보낸다.
//  값 존재 조건(CC 문서): rate_limits 는 **구독 계정(Pro/Max/Team)·그 세션 첫 API 응답 이후**에만 나타나고,
//   각 창(five_hour·seven_day)은 독립적으로 부재할 수 있다 → 없으면 조용히 아무것도 안 보낸다(가짜 0 금지).
//  rate limit 은 계정 단위 quota 라 게이트웨이가 **토큰의 계정**으로 키잉한다(이 스크립트는 boxId·account 를 모른다 —
//   토큰만 실으면 서버가 계정을 안다). 여기선 그저 rate_limits 를 그대로 전달한다.
//
// ⚠ statusLine 은 여기선 **수집 통로로만** 쓴다 — 상태줄에 소진율을 표시하지 않는다(stdout 무출력).
//   rate_limits 를 볼 수 있는 유일한 자리가 statusLine stdin 이라 이 메커니즘을 쓸 뿐, **표시 면은 웹 UI**
//   (관리탭 상시세션 목록의 usage pill)다. 상태줄엔 아무것도 안 찍어 그 세션 화면을 바꾸지 않는다.
//  동작: 스로틀 통과 시에만 게이트웨이로 POST 하고 exit. statusLine 은 렌더마다 실행되는 핫패스라
//   POST 는 30초 스로틀 + 1.2초 타임박스 + fail-open(어떤 실패든 무해). 대부분의 렌더는 스로틀에 걸려
//   네트워크 I/O 없이 즉시 종료. 비활성화: LIVELY_OFF=1.
import { readFileSync, writeFileSync, statSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
// 네트워크는 HostEffects 경계를 통과한다(kit R5 격리 계약 — work-flag.mjs 와 동형). 직접 fetch 는 테스트 격리 린트가 막는다.
import { hostEffects } from "./host-effects-port.mjs";

const fetch = (...args) => hostEffects.fetch(...args);

const THROTTLE_MS = 30_000;

// ── 순수 로직(테스트 대상) ────────────────────────────────────────────────

/** stdin JSON 에서 rate_limits 를 정규화. 유효 창이 하나도 없으면 null(보낼 것 없음). */
export function extractRateLimits(input) {
  const rl = input && typeof input === "object" ? input.rate_limits : null;
  if (!rl || typeof rl !== "object") return null;
  const win = (w) => {
    if (!w || typeof w !== "object" || typeof w.used_percentage !== "number" || !Number.isFinite(w.used_percentage)) return undefined;
    return { used_percentage: w.used_percentage, resets_at: typeof w.resets_at === "number" ? w.resets_at : null };
  };
  const five_hour = win(rl.five_hour);
  const seven_day = win(rl.seven_day);
  if (!five_hour && !seven_day) return null;
  return { ...(five_hour ? { five_hour } : {}), ...(seven_day ? { seven_day } : {}) };
}

/** 값 시그니처(정수 % 만) — 이게 바뀌면 스로틀을 뚫고 즉시 보고한다(급변 반영). */
export function usageSignature(rl) {
  if (!rl) return "";
  const p = (w) => (w ? Math.round(w.used_percentage) : "-");
  return `${p(rl.five_hour)}/${p(rl.seven_day)}`;
}

/** 보고할까 — 이전 시그니처와 다르거나(값 변화), 마지막 시도 후 throttleMs 지났으면. */
export function shouldReport(prevSig, curSig, lastAtMs, nowMs, throttleMs = THROTTLE_MS) {
  if (prevSig !== curSig) return true;
  return (nowMs - lastAtMs) >= throttleMs;
}

// ── IO ────────────────────────────────────────────────────────────────────

function readStdin(ms = 1500) {
  return new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(buf), ms);
    try { process.stdin.setEncoding("utf8"); } catch { /* no tty */ }
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(buf); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(buf); });
  });
}

async function main() {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);
  const raw = await readStdin();
  let input; try { input = JSON.parse(raw); } catch { process.exit(0); }
  const rl = extractRateLimits(input);
  // 상태줄엔 아무것도 출력하지 않는다 — 표시 면은 웹 UI(usage pill). 여기선 수집만.
  if (!rl) process.exit(0); // 보낼 값 없음(구독 아님·첫 응답 전·둘 다 부재)

  // 스로틀 판정 — 세션별 상태 파일(시그니처 + mtime).
  //  ⚠ 상태파일은 **홈(~/.lively/)** 에 둔다(공유 /tmp 아님). 이 훅은 스로틀이 무력화되면 "보고 안 함"이 아니라
  //   **렌더마다 POST**(1.2s 타임박스)로 기운다 — 공유 /tmp 를 다른 OS 유저가 0700 로 선점하면 EACCES 로
  //   매번 prevSig="" → 게이트웨이 연타. 홈은 이 유저 소유·격리라 그 표면이 없다(work-flag 는 실패해도 플래그만
  //   놓쳐 무해해서 /tmp 를 쓰지만, 이 훅은 네트워크 핫패스라 격리가 필요하다).
  const dir = join(homedir(), ".lively", "usage-state");
  const sid = String(input?.session_id ?? "nosid").replace(/[^A-Za-z0-9._-]/g, "_");
  const stateFile = join(dir, `${sid}.usage`);
  const curSig = usageSignature(rl);
  let prevSig = ""; let lastAt = 0;
  try { prevSig = readFileSync(stateFile, "utf8").trim(); lastAt = statSync(stateFile).mtimeMs; } catch { /* 첫 보고 */ }
  if (!shouldReport(prevSig, curSig, lastAt, Date.now())) process.exit(0);

  // (3) 토큰·게이트웨이 — env 우선, 없으면 ~/.lively/{token,gateway-url}. 토큰 없으면 조용히 종료.
  const readCfg = (rel) => { try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim(); } catch { return ""; } };
  const token = (process.env.LIVELY_TOKEN || "").trim() || readCfg("token");
  const gw = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readCfg("gateway-url") || "http://localhost:8080").replace(/\/$/, "");
  if (!token) process.exit(0);

  // 시도했음을 먼저 기록(성공·실패 무관 — 스로틀은 '시도' 기준이라 게이트웨이가 잠깐 죽어도 핫패스를 안 때린다).
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); writeFileSync(stateFile, curSig); } catch { /* fail-open */ }

  const ctl = new AbortController();
  const to = setTimeout(() => ctl.abort(), 1200);
  try {
    const hdrs = { "content-type": "application/json", authorization: `Bearer ${token}` };
    const boxId = String(process.env.LIVELY_SESSION_ID || "").trim();
    if (boxId) hdrs["x-lively-session"] = boxId;
    await fetch(`${gw}/api/ui/terminal/usage`, { method: "POST", signal: ctl.signal, headers: hdrs, body: JSON.stringify({ rate_limits: rl }) });
  } catch { /* fail-open — 게이트웨이 다운/타임아웃이 상태줄을 막지 않는다 */ }
  finally { clearTimeout(to); }
  process.exit(0);
}

// import 로 불릴 땐(테스트) main 을 돌리지 않는다 — 순수 함수만 노출.
if (import.meta.url === `file://${process.argv[1]}`) main();
