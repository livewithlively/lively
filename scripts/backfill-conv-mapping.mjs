#!/usr/bin/env node
// 대화 매핑 백필(#2151) — 매핑을 잃어 **복원이 늘 후보 picker 로 떨어지는** 세션을 되살린다.
//
// 왜 필요한가: 훅(work-flag)은 (박스, 대화)당 **1회성** 완료 표식(`<box>.<uuid>.mapped`)을 쓰고, 그 판정을
//  응답 **본문이 아니라 HTTP 상태**로 한다. 종전 게이트웨이는 '어디에도 못 적었다'를 `200 {ok:false}` 로
//  답했으므로(#2151 로 404 로 고침), 그 한 번의 실패가 **영구 포기**로 굳었다 — 그 세션은 매핑 없이 남고
//  복원이 `--resume`(인자 없음) = 후보 picker 가 된다. 2026-08-27 실측: 한 계정의 복원 가능 claude 세션
//  124개 중 51개가 이 상태였다. 게이트웨이 수정은 **앞으로**를 막을 뿐, 이미 굳은 것은 안 풀린다.
//
// 무엇을 근거로 되살리나 — **추측하지 않는다.** 훅이 남긴 완료 표식 파일 이름이 곧 `(박스 id, 대화 uuid)`
//  쌍이다. 그건 그 박스에서 그 대화가 실제로 돌았다는 **기록된 사실**이지 '그 폴더의 최근 대화' 같은 추정이
//  아니다(그 추정 폴백은 #1437·#2122 에서 의도적으로 금지됐다 — 격리 홈에서 남의 대화를 집는다).
//  대화 파일이 실제로 있는지도 확인한 뒤에만 보고한다.
//
// 어디서 도나: **그 세션이 돌던 노드(그 사람 PC)** 에서. 표식은 그 머신의 per-user tmp 에만 있다.
// 무엇을 바꾸나: 게이트웨이의 매핑 두 곳(desired-state 행 · 노드 내구 맵)뿐. 세션·대화·파일은 안 건드린다.
//
// 사용:
//   node scripts/backfill-conv-mapping.mjs            # 무엇을 할지만 보여준다(기본 — dry-run)
//   node scripts/backfill-conv-mapping.mjs --apply    # 실제로 보고한다
// 환경: LIVELY_TOKEN(없으면 ~/.lively/token) · LIVELY_GATEWAY_URL(없으면 ~/.lively/gateway-url)
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const APPLY = process.argv.includes("--apply");
const readCfg = (rel) => { try { return readFileSync(join(homedir(), ".lively", rel), "utf8").trim(); } catch { return ""; } };
const TOKEN = (process.env.LIVELY_TOKEN || "").trim() || readCfg("token");
const GW = ((process.env.LIVELY_GATEWAY_URL || "").trim() || readCfg("gateway-url") || "http://localhost:8080").replace(/\/$/, "");
const FLAG_DIR = join(tmpdir(), "lively-hooks");   // work-flag.mjs 와 같은 자리(전 플랫폼 per-user tmp)
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!TOKEN) { console.error("LIVELY_TOKEN 이 없습니다(또는 ~/.lively/token)."); process.exit(2); }

// ── ① 훅이 남긴 (박스, 대화) 쌍 — `<box-id>.<uuid>.mapped` 파일명이 곧 사실이다. ──
//  같은 박스에 여러 대화가 잡히면(/clear·branch 로 uuid 가 바뀐 경우) **가장 최근 표식**이 그 박스의 현재 대화다.
function pairsFromFlags() {
  const byBox = new Map();
  let files = [];
  try { files = readdirSync(FLAG_DIR); } catch { return byBox; }
  for (const f of files) {
    if (!f.endsWith(".mapped")) continue;               // `.mapped.try`(쿨다운)는 성공 표식이 아니다
    const stem = f.slice(0, -".mapped".length);
    const dot = stem.lastIndexOf(".");
    if (dot <= 0) continue;
    const boxId = stem.slice(0, dot);
    const uuid = stem.slice(dot + 1);
    if (!boxId.startsWith("box-") || !UUID_RE.test(uuid)) continue;   // claude 대화 id 규약만(모르는 하네스는 손대지 않는다)
    let at = 0; try { at = statSync(join(FLAG_DIR, f)).mtimeMs; } catch { /* 무시 */ }
    const prev = byBox.get(boxId);
    if (!prev || at > prev.at) byBox.set(boxId, { uuid, at });
  }
  return byBox;
}

// ── ② 대화 파일이 실제로 있나 — 없는 id 로 매핑을 심으면 복원이 즉사한다(routes.ts 의 transcriptResumable 과 같은 이유). ──
function transcriptPathFor(uuid) {
  const root = join(homedir(), ".claude", "projects");
  let dirs = [];
  try { dirs = readdirSync(root); } catch { return null; }
  for (const d of dirs) {
    const p = join(root, d, `${uuid}.jsonl`);
    if (existsSync(p)) return p;
  }
  return null;
}

const api = async (path, init) => {
  const r = await fetch(`${GW}${path}`, {
    ...init,
    headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...(init?.headers || {}) },
  });
  return { ok: r.ok, status: r.status, body: await r.text() };
};

const pairs = pairsFromFlags();
console.log(`훅 표식에서 찾은 (박스, 대화) 쌍: ${pairs.size}건  ·  게이트웨이: ${GW}  ·  ${APPLY ? "적용" : "미리보기(dry-run)"}`);

const list = await api("/api/ui/terminal/sessions");
if (!list.ok) { console.error(`세션 목록 조회 실패 HTTP ${list.status}`); process.exit(1); }
const sessions = JSON.parse(list.body).sessions || [];

const targets = [];
for (const s of sessions) {
  if (s.claudeSessionId) continue;                       // 이미 매핑이 있다 — 건드리지 않는다
  if ((s.harness || "claude") !== "claude") continue;    // 대화 id 규약을 확정한 하네스만
  const hit = pairs.get(s.id);
  if (!hit) continue;                                    // 이 머신에 기록이 없다 — 지어내지 않는다
  const tpath = transcriptPathFor(hit.uuid);
  if (!tpath) continue;                                  // 대화 파일이 없다 — 없는 id 로 심지 않는다
  targets.push({ id: s.id, uuid: hit.uuid, tpath, label: s.label || s.id });
}

console.log(`매핑 없는 claude 세션 ${sessions.filter((s) => !s.claudeSessionId && (s.harness || "claude") === "claude").length}건 중 되살릴 수 있는 것: ${targets.length}건\n`);

let done = 0; const failed = [];
for (const t of targets) {
  if (!APPLY) { console.log(`  · ${t.id}  ←  ${t.uuid}   ${t.label}`); continue; }
  const r = await api(`/api/ui/terminal/sessions/${encodeURIComponent(t.id)}/claude-uuid`,
    { method: "POST", body: JSON.stringify({ uuid: t.uuid, transcript_path: t.tpath }) });
  if (r.ok) { done++; console.log(`  ✓ ${t.id}  ←  ${t.uuid}   ${t.label}`); }
  else { failed.push({ id: t.id, status: r.status, body: r.body.slice(0, 160) }); console.log(`  ✗ ${t.id}  HTTP ${r.status}  ${r.body.slice(0, 120)}`); }
}

if (APPLY) {
  console.log(`\n되살림 ${done}건 · 실패 ${failed.length}건`);
  process.exit(failed.length ? 1 : 0);
} else {
  console.log(`\n(미리보기입니다 — 실제로 보고하려면 --apply)`);
}
