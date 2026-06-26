#!/usr/bin/env node
// Stop 훅 — "파일 작업은 했는데 컨텍스트 스토어 기록이 없는" 세션을 종료 시점에 정확히 1회 붙잡는다.
// 자가 게이팅(D4): user-level 훅이라 모든 레포에서 뜨므로, 'lively work' 세션에서만 게이트가 작동한다.
//   isLivelyWork = (cwd 가 등록 work-root prefix 아래) OR (<sid>.lively 신호 — 이 세션에서 lively MCP 툴 사용).
//   cwd = stdin JSON 의 cwd 필드 우선(하네스 무관), 없으면 process.cwd() 폴백.
//   아니면 exit 0 silent — 개인/타 레포에서 절대 너지하지 않는다(fail-closed for the nag).
//   work-root 레지스트리: ~/.lively/work-roots (줄당 절대경로 prefix; # 주석·빈줄 무시) + env LIVELY_WORK_ROOTS(path-delim).
// 결정표(전부 결정적, LLM/모델 API 호출 0 — 판단은 살아있는 세션이 인-컨텍스트로):
//   LIVELY_OFF                   → exit 0 (incognito — 구 LIVELY_HOOKS_OFF alias)
//   stop_hook_active===true     → exit 0 (필수 루프가드 — 공식 계약)
//   !isLivelyWork                → exit 0 (자가 게이팅 — lively work 세션 아님)
//   <sid>.writeback 존재         → exit 0 (이미 기록함)
//   <sid>.worked 부재            → exit 0 (의미있는 작업 없음)
//   <sid>.blocked 존재           → exit 0 (이미 1회 너지함 — 세션당 1회)
//   그 외                        → .blocked touch + {"decision":"block","reason":…} 출력, exit 0
// 페일오픈: 어떤 실패든 무출력 exit 0. 비활성화(incognito): LIVELY_OFF=1 (구 LIVELY_HOOKS_OFF — alias)
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve, sep, delimiter } from "node:path";

const SID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const FLAG_DIR = join(tmpdir(), "lively-hooks"); // 전 플랫폼 per-user tmp(work-flag.mjs 와 동일) — 공유 /tmp 미사용

// work-root 레지스트리 로드: ~/.lively/work-roots (줄 단위) + env LIVELY_WORK_ROOTS (path-delim 또는 ':').
function loadWorkRoots() {
  const roots = [];
  try {
    const txt = readFileSync(join(homedir(), ".lively", "work-roots"), "utf8");
    for (const line of txt.split(/\r?\n/)) {
      const t = line.trim();
      if (t && !t.startsWith("#")) roots.push(t);
    }
  } catch { /* 없으면 무시 */ }
  const env = (process.env.LIVELY_WORK_ROOTS || "").trim();
  if (env) {
    for (const p of env.split(env.includes(delimiter) ? delimiter : ":")) {
      const t = p.trim();
      if (t) roots.push(t);
    }
  }
  return roots.map((r) => resolve(r));
}

// cwd 가 어느 work-root prefix 아래인가 (경계는 sep 또는 정확히 같은 경로 — /foo 가 /foobar 를 매치 않게).
function cwdUnderRoot(cwd, roots) {
  const c = resolve(cwd);
  return roots.some((r) => c === r || c.startsWith(r.endsWith(sep) ? r : r + sep));
}

function readStdin(ms = 2000) {
  return new Promise((resolve) => {
    let buf = "";
    const t = setTimeout(() => resolve(buf), ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => { buf += c; });
    process.stdin.on("end", () => { clearTimeout(t); resolve(buf); });
    process.stdin.on("error", () => { clearTimeout(t); resolve(buf); });
  });
}

// 어드민 런타임 설정(~/.lively/hooks-config.json) — 비활성 토글 + 커스텀 너지 문구. fail-open(못 읽으면 기본).
function readHooksConfig() {
  try { return JSON.parse(readFileSync(join(homedir(), ".lively", "hooks-config.json"), "utf8")); }
  catch { return null; }
}

const REASON =
  "이 세션에서 파일 작업을 했지만 컨텍스트 스토어 기록이 없습니다. 마무리 전에 확인: " +
  "① 한 일을 작업(activity)으로 기록 — type 은 그 작업의 성격(feature·fix·decision·docs·research·review·chore·other). " +
  "이번 세션에 커밋했으면 그 일의 성격을 type 으로 두고(예 type='feature'|'fix') commit_sha·repo·touches(건드린 code_unit/data_entity)를 함께 넘긴다 " +
  "— 커밋은 유형이 아니라 commit_sha 로 표현된다. author_agent 는 게이트웨이가 접속 신원으로 자동 식별하니 넘기지 않아도 된다. " +
  "② should/is 재조정 — 커밋한 작업이면 그 코드가 제품 카테고리(도메인)의 구조(is)를 바꿨는지 보고, 도메인 의도(should)가 " +
  "이번에 주입된 기획·대화 맥락으로 바뀌었으면 category_update(should=…)로 갱신(도메인間 새 의도 의존이 생겼으면 " +
  "category_edge_set). 바뀐 게 없으면 activity_log 의 should_review/is_review='checked_no_change' 로 '점검함·변화없음'을 " +
  "명시 기록(안 한 것과 구분). " +
  "③ 지속될 지식·결정·설계·런북은 knowledge_save 로 전문 기록 — injection(always=세션마다 항상 주입되는 규칙·페르소나 / " +
  "recalled=검색으로 소환) + provenance(authored=직접 저작 / observed=외부 관찰), 카테고리 연결은 knowledge_link_category, " +
  "대체된 옛 지식은 knowledge_set_lifecycle(superseded). 작업과는 activity_log 의 ku_refs(produced/references/decided)로 연결. " +
  "외부 원본은 복제 말고 미러+파생만. " +
  "진행한 태스크는 task_set_status_v6, 새 카테고리(도메인) 후보는 category_create(근거 포함). " +
  "④ 기록할 것이 없으면 그대로 다시 종료하면 됩니다(이 알림은 세션당 1회).";

try {
  if (process.env.LIVELY_OFF === "1" || process.env.LIVELY_HOOKS_OFF === "1") process.exit(0);
  if (readHooksConfig()?.hooks?.stop_writeback_gate === false) process.exit(0); // 어드민이 이 훅 비활성화
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (input?.stop_hook_active === true) process.exit(0); // 루프가드(필수)
  const sid = String(input?.session_id ?? "");
  if (!SID_RE.test(sid)) process.exit(0);

  const flag = (name) => join(FLAG_DIR, `${sid}.${name}`);

  // 자가 게이팅: cwd 가 등록 work-root 아래 OR 이 세션에서 lively MCP 툴 사용(<sid>.lively).
  // 둘 다 아니면 게이트 작동 안 함 — 개인/타 레포에서 너지 금지.
  // cwd 는 stdin JSON 의 cwd 우선(하네스 무관 계약 — Codex R2 가 다른 작업디렉로 spawn 해도 정확).
  //   없으면 process.cwd() 폴백(Claude Code 는 프로젝트 디렉에서 훅 실행).
  const cwd = (typeof input?.cwd === "string" && input.cwd) || process.cwd();
  const isLivelyWork = cwdUnderRoot(cwd, loadWorkRoots()) || existsSync(flag("lively"));
  if (!isLivelyWork) process.exit(0);

  if (existsSync(flag("writeback"))) process.exit(0); // 이미 기록함
  if (!existsSync(flag("worked"))) process.exit(0);   // 의미있는 작업 없음
  if (existsSync(flag("blocked"))) process.exit(0);   // 이미 1회 너지함

  mkdirSync(FLAG_DIR, { recursive: true, mode: 0o700 });
  writeFileSync(flag("blocked"), "");
  const reason = readHooksConfig()?.writeback_notice || REASON; // 어드민 커스텀 너지 우선
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
} catch { /* fail-open */ }
process.exit(0);
