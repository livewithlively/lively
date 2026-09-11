// #3892 — «표식 없는 세션» 고침의 **배선**을 지킨다(순수 판정은 src/terminal/session-meta-heal.test.ts).
//
// 왜 소스 텍스트를 보나: collectSessions·createSession 은 tmux·DB·브로커를 타서 여기서 부를 수 없고(session-list-desired-fallback
//  · session-tmux-inside-wiring 과 같은 사정), 이 변경의 실패 모양은 판정 함수가 틀리는 것이 아니라 **엉뚱한 값을 넘기거나
//  엉뚱한 자리에서 부르는 것**이다. 사건이 정확히 그 모양이었다 — 판정 함수(isAgentOffline)는 맞았는데 1차 패스가
//  해소 전 tmux 원시 하네스를 넘겼다. 그래서 «무엇을 넘기나 · 어느 순서로 부르나» 를 여기서 못박는다.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");
let pass = 0;
const ok = (cond, name) => { assert.ok(cond, name); pass++; console.log(`ok  ${name}`); };
/** 주석을 뗀 본문 — 「없어야 할 코드」 를 셀 때 설명 주석의 인용에 걸리지 않게(#835 «주석 잔류는 구조다»). */
const code = (s) => s.split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");

const src = read("src/terminal/sessions.ts");

// ── collectSessions ─────────────────────────────────────────────────────────────
{
  const i = src.indexOf("async function collectSessions(");
  assert.ok(i > 0, "collectSessions 를 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("\n}\n", i));
  const parseStart = blk.indexOf('for (const line of out.split("\\n"))');
  const desiredAt = blk.indexOf("await loadDesiredMap(");
  assert.ok(parseStart > 0 && desiredAt > parseStart, "1차 파싱 구간과 desired 조회를 찾지 못했습니다 — 아래 단언이 무의미하다");
  const firstPass = code(blk.slice(parseStart, desiredAt));
  ok(!/isAgentOffline\(|observeAgentRun\(|shellWorking\s*=|isSpinning\(/.test(firstPass),
    "WR1 1차(파싱) 구간은 실행 관측을 하지 않는다 — 해소 전 tmux 원시 하네스로 재면 «AI 종료 + 셸 작업» 모순이 난다(E27)");

  const resolveAt = blk.indexOf("resolveDesired(", desiredAt);
  const obsAt = blk.indexOf("observeAgentRun(", desiredAt);
  const obsCall = obsAt > 0 ? blk.slice(obsAt, blk.indexOf(");", obsAt)) : "";
  ok(resolveAt > desiredAt && obsAt > resolveAt, "WR2-a 관측은 desired 해소(resolveDesired) 뒤에 한다(E28)");
  ok(/harness:\s*d\.harness\b/.test(obsCall), "WR2-b ★ 관측에 넘기는 하네스는 해소된 값(d.harness)이다 — 원시 표식이 아니다(E28)");

  const visAt = blk.indexOf("canSeeSession(", obsAt);
  const hiddenAt = blk.indexOf("hiddenUnknown && dirToProjectFolder(", obsAt);
  const firstGate = [visAt, hiddenAt].filter((x) => x > 0).sort((a, b) => a - b)[0] ?? -1;
  assert.ok(firstGate > obsAt, "가시성 관문을 찾지 못했습니다 — 아래 단언이 무의미하다");
  const busyAt = blk.indexOf("setLastBusy(p.name", obsAt);
  ok(busyAt > obsAt && busyAt < firstGate, "WR3 마지막 작업 시각 갱신은 관측 뒤 · 가시성 관문 앞(뷰어 무관)이다(E29)");

  const needAt = blk.indexOf("needsMetaHeal(", resolveAt);
  const healAt = blk.indexOf('healSessionMeta(p.name, row, "list")', resolveAt);
  ok(needAt > resolveAt && needAt < firstGate, "WR4-a 되채우기 판정(needsMetaHeal)은 해소 뒤 · 가시성 관문 앞이다(E30)");
  ok(/needsMetaHeal\(\{\s*harnessRaw:\s*p\.harnessRaw,\s*row,\s*managed:\s*p\.managed\s*\}\)/.test(blk), "WR4-b 판정 재료는 tmux 원시 하네스 · DB 행 · 상시세션 표식이다(E30)");
  ok(healAt > needAt && healAt < firstGate, "WR4-c 보내는 것은 공용 창구 healSessionMeta(…, \"list\") 이고 가시성 관문 앞이다(E30·E50)");
  ok(!/tmuxBatchQuiet\(metaHealCmds\(/.test(code(blk)), "WR4-d collectSessions 가 되채움 명령을 **직접** 보내지 않는다 — 창구가 둘이면 쿨다운이 갈린다(E50)");

  const pushAt = blk.indexOf("rows.push({", firstGate);
  const push = pushAt > 0 ? code(blk.slice(pushAt, blk.indexOf("});", pushAt))) : "";
  ok(pushAt > 0 && /\boffline,\s*busy,\s*shellWorking,\s*lastBusy\b/.test(push) && /\breportedFresh\b/.test(push), "WR5-a 행에 담는 관측값은 2차에서 잰 값이다(E31)");
  ok(!/p\.(offline|busy|shellWorking|reportedFresh|lastBusy)\b/.test(push), "WR5-b 1차 객체의 옛 관측 필드를 싣지 않는다(E31)");
}

// ── 공용 창구 healSessionMeta (E51) ──────────────────────────────────────────────
{
  const i = src.indexOf("export function healSessionMeta(");
  assert.ok(i > 0, "healSessionMeta 를 찾지 못했습니다");
  const body = src.slice(i, src.indexOf("\n}\n", i));
  const gateAt = body.indexOf("if (!metaHealGate(id, Date.now())) return false;");
  const warnAt = body.indexOf("logger.warn(");
  const sendAt = body.indexOf("void tmuxBatchQuiet(metaHealCmds(id, row));");
  ok(gateAt > 0 && warnAt > gateAt && sendAt > warnAt, "WR10 창구는 쿨다운 → 로그 → 삼키는 묶음을 떼어 보냄 순서다(쿨다운에 걸리면 로그도 안 남긴다)(E51)");
  ok(/DB desired 행으로 되채운다/.test(body) && /via/.test(body), "WR10-b 로그에 갈래(via)를 싣는다 — 목록·스냅샷 중 누가 찾았나(E51)");
}

// ── 세션 호스트 스냅샷 정비 (E52~E54) ─────────────────────────────────────────────
{
  const reg = read("src/node/registry.ts");
  const i = reg.indexOf("export function sessionHostSnapshotSessions(");
  assert.ok(i > 0, "sessionHostSnapshotSessions 를 찾지 못했습니다");
  const body = code(reg.slice(i, reg.indexOf("\n}\n", i)));
  ok(/return nodeSnapshotSessions\(nodes, STATE_STALE_MS, true\);/.test(body), "WR11-a 선언된 세션 호스트만(declaredOnly=true) — 멤버 PC 노드 판은 게이트웨이 tmux 로 칠 수 없다(E52)");
  ok(!/recordSnapshotCensus\(|nodeSessionsInScope\(/.test(body), "WR11-b 알림 스윕의 사유 계수를 거치지 않는다(계기 오염 금지)(E52)");

  const sweep = read("src/sessions/outbox-request-sweep.ts");
  const jobAt = sweep.indexOf('key: "session-meta-heal"');
  const job = jobAt > 0 ? sweep.slice(jobAt, sweep.indexOf("},", jobAt)) : "";
  ok(jobAt > 0 && /intervalMs: META_HEAL_SWEEP_MS/.test(job) && /sweepSessionMetaHeal\(\)/.test(job), "WR12-a 요청 정비표에 session-meta-heal 이 있고 sweepSessionMetaHeal 을 부른다(E53)");
  ok(!/scope:\s*"global"/.test(job), "WR12-b 테넌트 스코프다 — 스냅샷·DB 행을 그 테넌트로 좁혀야 한다(E53)");
  ok(/export const META_HEAL_SWEEP_MS = 60_000;/.test(sweep), "WR12-c 주기는 되채우기 쿨다운과 같은 60초다(E53)");

  const mod = code(read("src/sessions/session-meta-heal-sweep.ts"));
  ok(/sessionHostSnapshotSessions\(\)/.test(mod) && /loadDesired: loadDesiredMap/.test(mod) && /healSessionMeta\(id, row, "snapshot"\)/.test(mod),
    "WR13 기본 배선: 선언 호스트 스냅샷 · DB 한 번 조회 · 공용 창구(snapshot 갈래)(E54)");
}

// ── createSession ───────────────────────────────────────────────────────────────
{
  const i = src.indexOf("export async function createSession(");
  assert.ok(i > 0, "createSession 을 찾지 못했습니다");
  const blk = src.slice(i, src.indexOf("\n}\n", i));
  const metaAt = blk.indexOf("const meta = sessionMetaCmds(id,");
  ok(metaAt > 0, "WR6-a 표식 목록은 한 벌 빌더(sessionMetaCmds)에서 온다(E32·E34)");
  const tryAt = blk.indexOf("try { await tmuxBatch(meta); }", metaAt);
  ok(tryAt > metaAt, "WR6-b 표식 묶음은 try 안에서 보낸다 — 실패를 그냥 던지지 않는다(E32)");
  const catchBody = tryAt > 0 ? blk.slice(tryAt, blk.indexOf("\n  }\n", tryAt)) : "";
  const killAt = catchBody.indexOf('"kill-session", "-t", id');
  const delAt = catchBody.indexOf("deleteSessionState(id)");
  ok(killAt > 0, "WR6-c 실패하면 방금 만든 판을 kill 한다(E32)");
  ok(delAt > killAt && /if \(gone && inside && mirrored\) await deleteSessionState\(id\)/.test(catchBody),
    "WR6-d ★ DB 행은 판이 사라진 게 확인됐고(gone) 이번 호출이 먼저 쓴 행(inside·mirrored)일 때만 지운다(E32)");
  ok(/isSessionGoneError\(/.test(catchBody), "WR6-e «사라졌다» 는 kill 성공 또는 «그런 세션 없음» 확답이다(E32)");
  ok(/throw new HttpError\(503,/.test(catchBody) && catchBody.indexOf("throw new HttpError(503,") > delAt, "WR6-f 되돌린 뒤 503 으로 알린다(E32)");
  ok(/await tmuxBatchQuiet\(sessionWindowCmds\(id,/.test(blk), "WR7 창·기록 범위 옵션도 한 벌 빌더(sessionWindowCmds)에서 온다(E33)");
  ok(!/"@box_harness"/.test(code(blk)), "WR8 createSession 본문에 @box_harness 를 인라인으로 박는 코드가 없다 — 목록은 한 벌이다(E34)");
}

// ── 노드 번들 ────────────────────────────────────────────────────────────────────
{
  const allow = JSON.parse(read("scripts/node-agent-allowed-modules.json"));
  ok(allow.includes("dist/terminal/session-meta-heal.js"), "WR9 새 모듈은 노드 번들 허용목록에 있다(sessions.ts 가 import 한다)(E35)");
}

console.log(`\n${pass} assertions passed`);
