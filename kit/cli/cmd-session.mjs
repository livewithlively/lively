// ═══════════════════════════════════════════════════════════════════════════
// `lively resume|backfill|share` 서브커맨드 (#905 C1) — lively.mjs 에서 **원문 그대로** 분리한 조각(#1313 R52).
//  cmd-node.mjs 와 같은 레일: lively.mjs 가 dynamic import 로 부르고 공용 원시함수를 ctx 로 주입한다
//  (부트스트랩이 lively.mjs 한 파일만 내려받으므로 static import 는 못 쓴다 — 사연은 cmd-node.mjs 머리말).
//
//  주입 컨텍스트  ctx = { say, dim, bold, green, yellow, red, gateway, token, has }
// ═══════════════════════════════════════════════════════════════════════════
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { createHostEffects, entrypointHostEffects } from "./host-effects.mjs";

// lively.mjs 와 같은 계약(LIVELY_HOME 은 HOME 리다이렉트 — 샌드박스/테스트).
const HOME = process.env.LIVELY_HOME || homedir();
const WIN = process.platform === "win32";

// ── Claude Code 트랜스크립트 위치 (#1510) ────────────────────────────────────
// 트랜스크립트는 `~/.claude/projects/<cwd 를 인코딩한 폴더>/<세션id>.jsonl` 에 있다.
//  인코딩 규칙은 **Claude Code 쪽 구현**이라 우리가 정하는 값이 아니다 — mac/linux 실측은 `/`·`.` → `-`.
//  윈도우는 경로 구분자 `\` 와 드라이브 콜론 `:` 이 파일명에 못 들어가므로 그것도 치환 대상이다.
//  종전 코드는 `/[/.]/g` 뿐이라 윈도우 경로가 **그대로 남았고**, join(base, "C:\\Users\\…") 가
//  `…\projects\C:\Users\…` 를 만들어 `lively resume` 이 mkdir ENOENT 로 죽었다(share 는 세션 미발견).
//  ⚠ POSIX 는 `:` 가 합법 파일명 문자다 — 규칙을 넓히면 기존 폴더를 못 찾는다. 그래서 윈도우에서만 넓힌다.
//  ⚠ `win` 을 인자로 뺀 이유: 이 분기는 **자기 플랫폼에선 절반이 절대 실행되지 않는다.** 그대로 두면 윈도우
//   규칙은 윈도우 러너에서만 검증되고(=대부분의 개발·CI 에서 무방비), 이 프로젝트가 고친 결함이 정확히 그런
//   사각지대에서 났다. lively.mjs 의 winArg 를 순수함수로 직접 검증하는 관례와 같다(#1510).
export const encodeCwd = (cwd, win = WIN) => String(cwd).replace(win ? /[/\\:.]/g : /[/.]/g, "-");

// 트랜스크립트 앞부분에서 기록된 cwd 를 읽는다(앞쪽 라인에 나온다). 못 읽으면 null.
function cwdOfTranscript(buf) {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 65536));
  for (const line of head.split("\n")) {
    if (!line.includes('"cwd"')) continue;
    try { const o = JSON.parse(line); if (typeof o.cwd === "string" && o.cwd) return o.cwd; } catch { /* 부분/깨진 줄 */ }
  }
  return null;
}

// 이 cwd 의 트랜스크립트 폴더. **인코딩 규칙은 남의 구현이라 언제든 바뀔 수 있으므로** 규칙에만 기대지 않는다:
//  규칙으로 만든 이름이 이미 있으면 그것, 없으면 기존 폴더들의 트랜스크립트에 적힌 cwd 로 **내용 기반** 매칭한다.
//  (폴더 = cwd 인코딩이므로 폴더당 첫 .jsonl 하나만 보면 충분하다.) 끝내 못 찾으면 규칙 이름을 돌려준다 —
//  새로 만들 자리이므로 그게 정답이다.
export function projectsDirFor(cwd) {
  const base = join(HOME, ".claude", "projects");
  const guess = join(base, encodeCwd(cwd));
  if (existsSync(guess)) return guess;
  let dirs; try { dirs = readdirSync(base); } catch { return guess; }
  for (const d of dirs) {
    let inner; try { inner = readdirSync(join(base, d)); } catch { continue; }
    const f = inner.find((n) => n.endsWith(".jsonl"));
    if (!f) continue;
    let buf; try { buf = readFileSync(join(base, d, f)); } catch { continue; }
    if (cwdOfTranscript(buf) === cwd) return join(base, d);
  }
  return guess;
}

// ctx 주입 슬롯 — 아래 함수 본문은 lively.mjs 원문 그대로다(이름·들여쓰기 무변경).
let say, dim, bold, green, yellow, red, gateway, token, has;
let hostEffects = createHostEffects();
const spawnSync = (...args) => hostEffects.spawnSync(...args);
const fetch = (...args) => hostEffects.fetch(...args);

export function sessionCommands(ctx) {
  ({ say, dim, bold, green, yellow, red, gateway, token, has } = ctx);
  hostEffects = ctx.hostEffects || entrypointHostEffects();
  return { cmdResume, cmdBackfill, cmdShare };
}

// lively resume <sid> — 다른 환경/멤버에서 만든 내 세션을 이 PC 로 이어받는다(#905 C1 슬⑤c).
//  중앙 트랜스크립트를 이 머신의 claude 프로젝트 경로로 물질화한 뒤 `claude --resume <sid>` 를 띄운다.
//  인가: 워터마크 GET 이 **소유자 전용**(owner && owner!==나 → 403) — 남의 세션은 못 이어받는다(canResumeAsOrigin=owner,
//   열람보다 강한 게이트). ⚠ cwd 정합: claude --resume 은 트랜스크립트가 기록된 cwd 와 현재 cwd 가 어긋나면 어색할 수
//   있다 — 환경 무관 동일 abs 경로(프로젝트 워크스페이스 격리)가 전제다(#905 설계). --print 는 물질화만 하고 명령만 출력.
async function cmdResume(args) {
  const o = { node: "", print: false, _: [] };
  for (let i = 0; i < args.length; i++) {
    const t = args[i];
    if (t === "--node") o.node = String(args[++i] ?? "");
    else if (t === "--print" || t === "--dry-run") o.print = true;
    else o._.push(t);
  }
  const sid = o._[0];
  if (!sid || !/^[A-Za-z0-9._-]{1,64}$/.test(sid)) { say(red("사용법: lively resume <세션id> [--node <id>] [--print]")); process.exit(2); }
  const gw = gateway(), tok = token();
  if (!gw) { say(red("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>` 로 지정하세요.")); process.exit(1); }
  if (!tok) { say(red("로그인이 필요합니다 — `lively login` 을 먼저 실행하세요.")); process.exit(1); }
  const q = new URLSearchParams({ node: o.node }).toString();
  const H = { authorization: `Bearer ${tok}` };

  // 1) 소유권·오프셋 — 워터마크는 소유자 전용(비소유자 403). 이어받기는 열람보다 강한 게이트다.
  let total = 0;
  try {
    const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?${q}`, { headers: H });
    if (r.status === 401 || r.status === 403) { say(red("이 세션을 이어받을 수 없습니다 — 소유자가 아니거나 접근 권한이 없습니다.")); process.exit(1); }
    if (!r.ok) { say(red(`게이트웨이 오류 ${r.status}.`)); process.exit(1); }
    total = Number((await r.json())?.bytes) || 0;
  } catch (e) { say(red(`게이트웨이 접속 실패: ${e.message}`)); process.exit(1); }
  if (total <= 0) { say(red(`세션 ${sid} 의 중앙 기록이 없습니다(캡처 꺼짐/미수집?) — 이어받을 내용이 없습니다.`)); process.exit(1); }

  // 2) 트랜스크립트 원문(x-ndjson) 회수.
  let body;
  try {
    const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${q}`, { headers: H });
    if (!r.ok) { say(red(`트랜스크립트 회수 실패 ${r.status}.`)); process.exit(1); }
    body = Buffer.from(await r.arrayBuffer());
  } catch (e) { say(red(`트랜스크립트 회수 실패: ${e.message}`)); process.exit(1); }
  if (!body.length) { say(red("회수된 트랜스크립트가 비었습니다.")); process.exit(1); }

  // 3) 이 머신의 claude 프로젝트 경로로 물질화(cwd 인코딩 — projectsDirFor 머리말 참조).
  const dir = projectsDirFor(process.cwd());
  const file = join(dir, `${sid}.jsonl`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, body);
  say(dim(`  · 트랜스크립트 물질화: ${file} (${body.length} 바이트)`));

  // 4) claude --resume 실행(또는 --print 면 명령만 출력하고 끝).
  if (o.print) { say(`claude --resume ${sid}`); return; }
  if (!has("claude")) { say(red(`claude 실행파일을 못 찾았습니다 — 물질화만 완료. 수동으로 \`claude --resume ${sid}\` 하세요.`)); process.exit(1); }
  const st = spawnSync("claude", ["--resume", sid], { stdio: "inherit", cwd: process.cwd() }).status;
  process.exit(st ?? 0);
}

// lively backfill [--dry-run] — 이 머신의 **기존** claude 트랜스크립트를 중앙에 소급 업로드(#905 C1).
//  캡처 훅은 "켠 뒤 늘어나는 델타"만 보낸다 → 웹뷰가 과거 세션은 못 본다. 이 명령이 ~/.claude/projects/*/*.jsonl
//  전체를 훑어 서버 워터마크부터 올린다(훅과 동일 로직의 배치판). 멱등(offset-CAS): 이미 올라간 건 서버가 흡수.
//  소유자=인증한 나. 세션 공유가 꺼져 있으면 서버가 막는다(관리 ▸ 세션 공유를 먼저 켜라). --dry-run 은 조회만.
// 트랜스크립트의 cwd → `.lively/project.json` 마커의 project_id(구조화된 정본 — 경로 휴리스틱 아님). 없으면 null.
//  cwd 는 앞쪽 라인에 나오므로 앞부분만 스캔. cwd 에서 위로 올라가며 마커를 찾는다.
function projectIdForTranscript(buf) {
  const cwd = cwdOfTranscript(buf);
  if (!cwd) return null;
  let dir = cwd;
  for (let i = 0; i < 40 && dir; i++) {
    try { const m = JSON.parse(readFileSync(join(dir, ".lively", "project.json"), "utf8")); if (m && Number.isInteger(m.project_id) && m.project_id > 0) return m.project_id; } catch { /* 마커 없음·파손 */ }
    const p = dirname(dir); if (p === dir) break; dir = p;
  }
  return null;
}

async function cmdBackfill(args) {
  const dry = args.includes("--dry-run") || args.includes("--print");
  const gw = gateway(), tok = token();
  if (!gw) { say(red("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>`.")); process.exit(1); }
  if (!tok) { say(red("로그인이 필요합니다 — `lively login`.")); process.exit(1); }
  const base = join(HOME, ".claude", "projects");
  let dirs;
  try { dirs = readdirSync(base); } catch { say(`claude 기록 폴더가 없습니다: ${base} — 올릴 게 없습니다.`); return; }
  const files = [];
  for (const d of dirs) {
    let inner; try { inner = readdirSync(join(base, d)); } catch { continue; }
    for (const f of inner) if (f.endsWith(".jsonl")) files.push({ sid: f.slice(0, -6), path: join(base, d, f) });
  }
  if (!files.length) { say("올릴 트랜스크립트가 없습니다."); return; }
  say(`발견: ${files.length}개 세션 트랜스크립트${dry ? dim("  (dry-run — 전송 안 함)") : ""}`);
  const H = { authorization: `Bearer ${tok}` };
  const MAXD = 8 * 1024 * 1024;
  let sent = 0, already = 0, skipped = 0, failed = 0, bytesUp = 0, mapped = 0;
  for (const { sid, path: fp } of files) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sid)) { skipped++; continue; }
    let full; try { full = readFileSync(fp); } catch { skipped++; continue; }
    if (!full.length) { skipped++; continue; }
    // 서버 워터마크 + 캡처 정책(한 왕복).
    let from = 0;
    try {
      const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?node=`, { headers: H });
      if (r.status === 401 || r.status === 403) { say(red("접근 거부(세션 공유 꺼짐 또는 토큰 무효) — 관리 ▸ 세션 공유를 켜고 다시 시도하세요.")); process.exit(1); }
      if (!r.ok) { failed++; continue; }
      const j = await r.json();
      from = Number(j.bytes) || 0;
      if (j.capture && j.capture.enabled !== true) { say(red("세션 공유가 꺼져 있습니다 — 관리 ▸ 세션 공유에서 켜세요.")); process.exit(1); }
    } catch { failed++; continue; }
    // 프로젝트 귀속 값 — .lively/project.json 마커에서(구조화된 정본). append 쿼리에 실어 서버가 멤버 확인 후 매핑.
    const projectId = projectIdForTranscript(full);
    const projQ = projectId ? { project: String(projectId) } : {};
    if (full.length <= from) {
      // 내용은 이미 다 올라감 — 프로젝트 매핑만 갱신(0바이트 append + 마커 project). projectId 없으면 그냥 스킵.
      if (projectId && !dry) {
        try {
          await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${new URLSearchParams({ at: String(from), node: "", harness: "claude", ...projQ })}`,
            { method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: Buffer.alloc(0) });
          mapped++;
        } catch { /* 비치명 */ }
      }
      already++; continue;
    }
    if (dry) { say(dim(`  [dry] ${sid}  ${from}→${full.length} (+${full.length - from}B)${projectId ? ` · project ${projectId}` : ""}`)); sent++; continue; }
    // 델타를 MAXD 청크로 순차 POST(offset-CAS 가 이어붙임). 응답 bytes 로 다음 오프셋 정정.
    let ok = true;
    while (from < full.length) {
      const end = Math.min(full.length, from + MAXD);
      const buf = full.subarray(from, end);
      try {
        const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${new URLSearchParams({ at: String(from), node: "", harness: "claude", ...projQ })}`, {
          method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: buf });
        if (!r.ok) { ok = false; break; }
        const j = await r.json();
        const nb = Number(j.bytes);
        bytesUp += buf.length;
        from = Number.isFinite(nb) && nb > from ? nb : end;   // 서버 진실로 전진(중복/gap 정정)
      } catch { ok = false; break; }
    }
    if (ok) sent++; else failed++;
  }
  say(`완료 — 전송 ${sent} · 이미있음 ${already} · 프로젝트매핑 ${mapped} · 건너뜀 ${skipped} · 실패 ${failed}${bytesUp ? ` · ${Math.round(bytesUp / 1024)}KB` : ""}`);
}

// lively share [<세션id>] [--node <id>] [--json] — 이 세션(진행 중 포함)을 팀원과 공유(#905 C1 · #911 요구3).
//  사람 트리거(LLM 은 '언제 공유할지' 모른다). ① 대상 세션 확정(인자 or 이 cwd 의 가장 최근 트랜스크립트=현재 세션)
//  ② 로컬이 서버보다 앞서면 델타를 지금 올려(1시간짜리 응답 진행 중이어도 최신이 보이게) ③ 열람 링크(웹뷰)를 출력.
//  열람 권한(서버 게이트): 소유자 항상 · view_policy=attach 면 이 세션이 매핑된 프로젝트의 멤버. 사람 출력=stderr, stdout=--json.
async function cmdShare(args) {
  const o = { node: "", json: false, _: [] };
  for (let i = 0; i < args.length; i++) { const t = args[i]; if (t === "--node") o.node = String(args[++i] ?? ""); else if (t === "--json") o.json = true; else if (!t.startsWith("-")) o._.push(t); }
  const gw = gateway(), tok = token();
  if (!gw) { say(red("게이트웨이 주소를 모릅니다 — `lively login --gateway <url>`.")); process.exit(1); }
  if (!tok) { say(red("로그인이 필요합니다 — `lively login`.")); process.exit(1); }
  const encDir = projectsDirFor(process.cwd());

  // 1) 대상 세션 — 인자 or 이 cwd 의 가장 최근 트랜스크립트(현재 세션). 로컬 파일이 있으면 델타도 올린다.
  let sid = o._[0], fp = null;
  if (sid) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(sid)) { say(red("세션 id 형식 오류.")); process.exit(2); }
    const p = join(encDir, `${sid}.jsonl`); if (existsSync(p)) fp = p;
  } else {
    let bestMt = -1;
    try { for (const f of readdirSync(encDir)) { if (!f.endsWith(".jsonl")) continue; const st = statSync(join(encDir, f)); if (st.mtimeMs > bestMt) { bestMt = st.mtimeMs; sid = f.slice(0, -6); fp = join(encDir, f); } } } catch { /* 폴더 없음 */ }
    if (!sid) { say(red("이 폴더에서 만든 세션을 찾지 못했습니다 — `lively share <세션id>` 로 직접 지정하세요.")); process.exit(1); }
  }

  const H = { authorization: `Bearer ${tok}` };
  const q = new URLSearchParams({ node: o.node }).toString();

  // 2) 워터마크 + 캡처 정책(소유자 게이트). 로컬이 앞서면 델타를 지금 올린다(진행 중 공유).
  let serverBytes = 0, captureOn = true;
  try {
    const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log/watermark?${q}`, { headers: H });
    if (r.status === 401 || r.status === 403) { say(red("이 세션을 공유할 수 없습니다 — 소유자가 아니거나 접근 권한이 없습니다.")); process.exit(1); }
    if (r.ok) { const j = await r.json(); serverBytes = Number(j.bytes) || 0; captureOn = !(j.capture && j.capture.enabled !== true); }
  } catch (e) { say(red(`게이트웨이 접속 실패: ${e.message}`)); process.exit(1); }

  let pushed = 0, projectId = null;
  if (fp) {
    let full = null; try { full = readFileSync(fp); } catch { /* */ }
    if (full && full.length) {
      projectId = projectIdForTranscript(full);
      if (!captureOn) say(yellow("⚠ 세션 공유가 꺼져 있어 최신 내용을 못 올렸습니다 — 관리 ▸ 세션 공유를 켜면 진행 중 내용까지 공유됩니다."));
      else if (full.length > serverBytes) {
        const MAXD = 8 * 1024 * 1024; let from = serverBytes;
        while (from < full.length) {
          const end = Math.min(full.length, from + MAXD);
          try {
            const r = await fetch(`${gw}/api/ui/v6/sessions/${encodeURIComponent(sid)}/log?${new URLSearchParams({ at: String(from), node: o.node, harness: "claude", ...(projectId ? { project: String(projectId) } : {}) })}`, { method: "POST", headers: { ...H, "content-type": "application/octet-stream" }, body: full.subarray(from, end) });
            if (!r.ok) break;
            const j = await r.json(); const nb = Number(j.bytes); pushed += (end - from); from = Number.isFinite(nb) && nb > from ? nb : end;
          } catch { break; }
        }
      }
    }
  }

  // 3) 열람 링크.
  const link = `${gw}/ui/#/sessions/${encodeURIComponent(sid)}${o.node ? "?node=" + encodeURIComponent(o.node) : ""}`;
  if (o.json) { process.stdout.write(JSON.stringify({ session_id: sid, link, pushed_bytes: pushed, project_id: projectId }, null, 2) + "\n"); return; }
  say(`\n${green("✓")} 세션 공유 링크${pushed ? dim(`  (최신 ${Math.round(pushed / 1024)}KB 올림)`) : ""}`);
  say(`  ${bold(link)}`);
  say(`  ${dim(projectId
    ? `열람 권한 있는 사람(소유자 · 프로젝트 #${projectId} 멤버)과 공유하세요.`
    : "프로젝트에 연결돼 있지 않아 지금은 소유자만 볼 수 있습니다 — `lively init` 으로 연결하면 팀원도 열람할 수 있습니다.")}`);
  say("");
}
