// 위탁 태스크 러너(P2 #869) — 중앙(게이트웨이=내장 노드)과 원격 노드 에이전트가 **공유**하는 실행 헬퍼.
// 태스크 = 워커 세션(tmux) 1개: 프롬프트 파일 → `claude -p "$(cat prompt)" > result.json; echo $? > exit; exec $SHELL`.
//  - 프롬프트는 파일로만 전달(셸 문자열에 사용자 텍스트 미포함 = 인젝션 차단, 경로는 숫자 taskId 로만 구성).
//  - 세션은 완료 후에도 셸로 남아(웹터미널로 사후 검시 가능) — 성공 수집 후 스케줄러가 종료, 실패는 보존.
//  - 완료 감지 = exit 파일 등장(폴링) — 화면 파싱보다 견고(F5).
//  - v1 제약: 워크스페이스는 공유 루트(rootKey=shared)만 — 격리(700) 개인 홈엔 게이트웨이/에이전트가 파일을 못 쓴다.
import { SESSION_KIND_ENV } from "../sessions/session-kind.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import {
  TMUX_BIN, PANE_LOCALE, HARNESSES, resolveRootPath, resolveProfileConfigDir, profileConfigDir, sessionPrefix, ensureMemberOsUser,
} from "../terminal/terminal-sessions.js";
import { wrapAsMember, isolationInfraReady } from "../terminal/terminal-isolation.js";
import { envKeepPolicy } from "../terminal/session-env-contract.js";
import { provisionTaskRepo, type RepoProvisionAuth } from "../project/project-provision.js";
// 공유폴더 그룹쓰기 계약(2770/660) — 위탁 작업 폴더도 격리 워커(box_<멤버>)가 써야 하므로 같은 계약을 적용한다.
import { grantSharedGroupWrite, SHARED_FILE_MODE } from "../project/project-fs.js";
import type { NodeResources } from "./protocol.js";
import { deriveWriteCap } from "../terminal/terminal-sessions.js";
import { memAvailableMb } from "../ops/host-mem.js"; // #1059 공용 메모리 지표(백필 게이트와 단일 소스)

const execFileAsync = promisify(execFile);

// tmux CLI 호출 — terminal-sessions 의 TMUX_ENV 와 동일한 UTF-8 강제(로케일 사고 방지, 런북 불변식).
const TMUX_ENV: NodeJS.ProcessEnv = (() => {
  const env = { ...process.env };
  if (!/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || "")) {
    env.LANG = "en_US.UTF-8";
    env.LC_CTYPE = "en_US.UTF-8";
  }
  return env;
})();
async function tmux(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(TMUX_BIN, args, { timeout: 8000, env: TMUX_ENV });
  return stdout;
}

// 가용 메모리(MB) 산출은 host-mem.ts 로 추출됨(#1059 — 임베딩 백필 pre-flight 게이트와 공용, 로직 단일화). memAvailableMb import.

// ── 리소스 스냅샷(§10) — 상태 push 동봉용. disk 는 주어진 루트(공유 워크스페이스) 기준. ──
export async function sampleResources(diskRoot: string): Promise<NodeResources> {
  let disk = { total: 0, free: 0 };
  try {
    const s = await fsp.statfs(diskRoot);
    disk = { total: (s.blocks * s.bsize) / 1048576, free: (s.bavail * s.bsize) / 1048576 };
  } catch { /* 루트 미존재 등 — 0 으로(스케줄러가 disk 요구 태스크를 안 보냄) */ }
  return {
    cpus: os.cpus().length || 1,
    load1: Math.round((os.loadavg()[0] || 0) * 100) / 100,
    mem_total_mb: Math.round(os.totalmem() / 1048576),
    mem_free_mb: await memAvailableMb(),
    disk_total_mb: Math.round(disk.total),
    disk_free_mb: Math.round(disk.free),
  };
}

export async function detectDocker(): Promise<boolean> {
  try { await execFileAsync("docker", ["--version"], { timeout: 3000 }); return true; }
  catch { return false; }
}

// 이 PC 에서 **실제로 세션을 띄울 수 있는** 하네스(#1713) — 이 번들의 카탈로그 ∩ PATH 에 있는 실행 파일.
//  게이트웨이는 남의 PC 에 무엇이 깔렸는지 알 방법이 없다. 그래서 노드가 hello 로 직접 답하고, 세션 폼이 그걸로
//  선택지를 거른다 — 종전엔 사용자가 [생성하기]를 누른 **뒤에야** 알았다(옛 번들이면 502 "허용되지 않은 하네스",
//  바이너리가 없으면 세션이 뜨자마자 즉사).
//  ⚠ 판정은 `--version` 1회(네 하네스 모두 무부작용). 노드 기동 시 한 번만 도는 자리다.
//  ⚠ Windows 는 claude·codex 가 .cmd 셰임이라 shell 없이는 ENOENT 다(work.mjs 가 같은 이유로 shell:true 를 쓴다).
export async function detectHarnesses(): Promise<string[]> {
  const out: string[] = [];
  for (const h of HARNESSES) {
    if (!h.bin) { out.push(h.key); continue; }   // 셸 — 실행 파일이 필요 없다(어느 PC 에서나 열린다)
    try {
      await execFileAsync(h.bin, ["--version"], { timeout: 5000, shell: process.platform === "win32" });
      out.push(h.key);
    } catch { /* 없거나 못 뜬다 → 이 노드에선 못 연다. 목록에서 빠지는 것이 곧 사실이다(추측해서 넣지 않는다) */ }
  }
  return out;
}

// ── 태스크 스폰 ──
export interface RunTaskInput {
  user: LivelyUser;            // 의뢰자(과금·귀속 신원 — D1: 의뢰자 시트)
  // 작업 폴더 이름이 되는 id. 위탁은 org_task 의 숫자 id, 리브 대화 턴(#1631)은 문자열 턴 id 다
  //  (턴은 org_task 행을 만들지 않는다 — 배치 의미(재시도·용량·타임아웃)가 채팅 한 턴에 안 맞는다).
  taskId: number | string;
  rootKey: string;             // v1: 'shared' 만 허용(검증은 호출부)
  subpath: string;             // 공유 루트 하위 작업 폴더(비우면 delegated/<id>)
  prompt: string;
  harness: string;             // v1: 'claude' 만
  repo?: string | null;        // 지정 시 게이트웨이가 공유 base clone→worktree 자동 provision, cwd=worktree(#458 재사용)
  gitRef?: string | null;      // worktree 분기 기준 브랜치(origin/<ref>) — 없으면 base HEAD
  flags?: Record<string, string>;  // 화이트리스트(--model/--effort)만 적용
  // 리브 대화 턴(#1631) 전용 축 — **사람이 준 값이 아니라 코드가 만든 인자**를 화이트리스트 밖으로 싣는다
  //  (--disallowedTools 거부 목록 · --session-id/--resume). 위탁은 안 쓴다(undefined).
  //  ⚠ 여기 사람 텍스트를 넣지 마라 — 이 배열은 셸 명령줄에 그대로 펼쳐진다. 사람 텍스트는 프롬프트 파일뿐이다.
  extraFlags?: string[];
  // 승인 우회(기본 true = 위탁). 리브는 false — 사람이 화면에서 보고 있다(taskScript 주석 참조).
  bypassPermissions?: boolean;
  // 세션 목록에 보일 이름(@box_label). 없으면 `위탁 #<taskId>`. 프로젝트 화면의 리브 대화(#1757)는 턴이 도는 몇 초 동안
  //  사이드바에 그 프로젝트의 세션으로 잠깐 보이므로 사람 말로 이름을 준다("리브 · 프로젝트 대화").
  label?: string;
  // 시스템 프롬프트에 **덧붙일** 지문(#1757 프로젝트 도우미 역할). 코드가 만든 텍스트만 — 사람 텍스트 금지(프롬프트 파일로).
  //  구현: 턴 폴더에 system.md 로 쓰고 `--append-system-prompt-file <path>` 로 싣는다(셸 인용 없음 — 경로만 인자에 간다).
  //  claude 만 안다(다른 하네스는 무시 — 실측하지 않은 플래그를 추측해 넣지 않는다).
  systemPrompt?: string;
  env?: Record<string, string>;    // 자격 리스(CLAUDE_CODE_OAUTH_TOKEN 등) — 값은 세션 env 로만
  // 레포 provision 주입(#905 C4) — **노드엔 DB 가 없다**. 게이트웨이가 레지스트리 git_url + (의뢰자 본인) git 자격을
  //  조회해 실어 보낸다. 없으면 노드는 종전대로 DB 를 읽으려다 실패하고 "레지스트리에 없다"는 오진을 낸다.
  //  중앙(게이트웨이 내장 노드) 실행 시엔 미설정 — 거기선 DB 를 직접 읽는 게 정상이다.
  repoAuth?: RepoProvisionAuth;
}
export interface RunTaskResult { sessionId: string; taskDir: string; workspace: string }

// 플래그 화이트리스트는 **그 하네스의 것**이다(#1710) — 종전엔 claude 것 하나로 모든 위탁을 검사해,
//  다른 하네스의 유효한 값이 거부되거나 그 하네스에 없는 플래그가 통과할 수 있었다.
const flagWhitelist = (key: string): Map<string, { name: string; type: string; choices?: string[]; label: string }> =>
  new Map((HARNESSES.find((h) => h.key === key)?.flags ?? []).map((f) => [f.name, f]));

/** 플래그 맵(--model/--effort) → 그 하네스의 argv 조각. 순수 함수 — 엣지 표로 검증한다(task-flags.test).
 *
 *  ⚠ **하네스마다 argv 문법이 다르다.** codex 는 추론강도를 일반 플래그로 받지 않는다 — 실측
 *   (`codex exec --help`, CLI 0.149.1): `-m/--model <MODEL>` 은 있고 `--effort` 는 **없다**. 대신
 *   `-c/--config key=value` 로 `model_reasoning_effort` 를 준다. 세션 경로는 이 번역을 이미 하고 있었는데
 *   (terminal/sessions.ts — "Codex는 추론강도를 일반 CLI 플래그로 받지 않는다") **위탁 경로에만 빠져 있었다.**
 *   그래서 codex 로 뜬 위탁은 `codex exec --json --effort high` 로 실행돼 `unexpected argument '--effort'`
 *   로 즉사한다 — 그것도 고약한 방식으로: 하네스가 실행조차 안 되니 stream.jsonl 이 0줄이고, 배치 seen
 *   롤백 때문에 같은 프롬프트가 영원히 재시도된다(#1289 와 같은 실패 모양). 증류기·분류기에 effort 를
 *   박은 뒤부터는 codex 로그인 의뢰자의 배치가 전부 이 자리에서 죽는다.
 *   저장 상태(org_task.flags)는 다른 하네스와 같은 `--effort` 키를 유지한다 — 번역은 여기 한 곳에서만 한다.
 */
export function harnessFlagArgs(harnessKey: string, flags?: Record<string, string>): string[] {
  const whitelist = flagWhitelist(harnessKey);
  const out: string[] = [];
  for (const [name, raw] of Object.entries(flags ?? {})) {
    const def = whitelist.get(name);
    const v = String(raw ?? "");
    if (!def || !v || (def.choices && !def.choices.includes(v))) continue;
    if (harnessKey === "codex" && name === "--effort") out.push("--config", `model_reasoning_effort=${v}`);
    else out.push(name, v);
  }
  return out;
}

// ── 위탁 헤드리스 규약(#1710) ────────────────────────────────────────────────────────
// 위탁은 대화형 세션이 아니라 **한 번의 헤드리스 실행**이라, 세션 카탈로그(catalog.ts)의 축과 다른 것이 필요하다:
//  ① 프롬프트를 어떻게 넣나(stdin ↔ argv) ② 진행 스트림을 어떤 형식으로 뱉나 ③ 최종 텍스트를 어디서 뽑나.
// 종전엔 이 셋이 전부 claude 규약으로 스크립트 한 줄에 박혀 있었고, 그래서 `harness.key !== "claude"` 로
// 위탁 자체를 막고 있었다(v1). 아래 값은 전부 실측이다(2026-08-14, 각 하네스 --help + 실제 1회 실행):
//
//  claude       `claude -p … --output-format stream-json --verbose` · stdin ○ · `{type:"result", result:"…"}`
//  codex        `codex exec --json …`                                · stdin ○ · `{type:"item.completed", item:{type:"agent_message", text}}`
//  antigravity  `agy --print "<프롬프트>" --output-format stream-json` · stdin **✗**(flag needs an argument) · `{event:"result", result:{response}}`
//  grok         `grok --prompt-file <p> --output-format streaming-messages-json` · stdin ✗ 대신 **--prompt-file**(argv 상한 무관) · `{type:"result", result:"…"}`
//  opencode     `opencode run --format json "<메시지>"`                · **표에 없다** — 아래 참조
//
// ⚠ opencode 를 넣지 않은 이유(정직 표기): 규약(`run` 서브커맨드 · `--format json`)은 --help 로 알지만,
//  이 머신에서 실제로 돌려 보니 **25분 넘게 stdout·stderr 한 바이트도 없이 매달렸다**(자격·모델 미설정 추정).
//  그 상태로 위탁을 열면 워커가 조용히 매달려 타임아웃(1h)까지 '실행 중'이 된다 — 위탁에서 가장 나쁜 실패다.
//  스키마를 실측하고 응답을 받아 본 뒤에 한 줄 추가하면 열린다(그때 task-script.test 의 S4·S5·S10 도 함께).
//
// ⚠ stdin 을 못 받는 하네스는 프롬프트가 argv 로 간다 → 리눅스 MAX_ARG_STRLEN(131,072B) 상한에 걸린다.
//  그 실패는 **하네스가 실행조차 안 되는** 형태라 조용하다(stream 0줄·배치 무한 재시도, #1289 사고와 동형).
//  그래서 그런 하네스는 접수 시점에 크기를 재서 **미리 거부**한다(spawnTaskSession) — 뒤늦게 죽게 두지 않는다.
export interface HeadlessSpec {
  /** 하네스 실행 부분(리다이렉션 앞까지). promptPath 는 숫자 taskId 로만 구성된 화이트리스트 경로다.
   *  bypass = 승인 우회 플래그 조각(**앞 공백 포함**, 또는 빈 문자열) — taskScript 가 만들어 넣는다. */
  run: (bin: string, flags: string, promptPath: string, bypass: string) => string;
  /** 사람이 안 보는 배치에서 승인을 우회하는 플래그 — **하네스마다 이름이 다르다.**
   *  종전엔 이 플래그가 각 run 문자열에 박혀 있어 "우회는 항상 켜짐"이 구조였다. 위탁(배치)에는 맞지만
   *  **리브(#1631)처럼 사람이 화면에서 보고 있는 대화형**에는 그대로 쓰면 안 된다 — 승인 없이 셸·파일을
   *  만지는 에이전트를 사람 앞에 앉히는 꼴이다. 그래서 우회 여부를 **호출자가 정하게** 축으로 세웠다
   *  (taskScript 의 bypassPermissions). 우회를 끄는 쪽은 대신 허용 도구를 좁혀서 위험을 줄인다. */
  bypassFlag: string;
  /** 진행 스트림(JSONL)에서 최종 응답 텍스트를 뽑는다 — 스키마가 하네스마다 다르다. */
  extract: (jsonl: string) => string;
  /** 프롬프트가 argv 로 가는 하네스인가(=크기 상한이 걸린다). */
  promptViaArgv?: boolean;
}
// 뒤에서부터 첫 매치를 찾는다 — 최종 결과는 항상 스트림 끝에 있고, 중간에 같은 모양이 반복될 수 있다.
const lastMatch = (jsonl: string, pick: (ev: Record<string, unknown>) => string | null): string => {
  const lines = jsonl.split("\n").filter((l) => l.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const got = pick(JSON.parse(lines[i]) as Record<string, unknown>);
      if (got != null) return got;
    } catch { /* 부분 줄·비JSON 무시 */ }
  }
  return "";
};
export const HEADLESS: Record<string, HeadlessSpec> = {
  claude: {
    run: (bin, f, p, bypass) => `${bin} -p ${f} --output-format stream-json --verbose${bypass} < "${p}"`,
    bypassFlag: "--dangerously-skip-permissions",
    extract: (j) => lastMatch(j, (ev) => (ev.type === "result" ? (typeof ev.result === "string" ? ev.result : JSON.stringify(ev)) : null)),
  },
  codex: {
    // exec = codex 의 헤드리스 서브커맨드. `--json` 이 진행 이벤트를 JSONL 로 뱉고, 프롬프트는 stdin 으로 받는다
    //  ("instructions are read from stdin" — --help). 승인 우회는 세션의 --yolo 가 아니라 이 플래그다.
    run: (bin, f, p, bypass) => `${bin} exec --json${bypass} ${f} < "${p}"`,
    bypassFlag: "--dangerously-bypass-approvals-and-sandbox",
    extract: (j) => lastMatch(j, (ev) => {
      const it = ev.item as { type?: string; text?: string } | undefined;
      return ev.type === "item.completed" && it?.type === "agent_message" && typeof it.text === "string" ? it.text : null;
    }),
  },
  antigravity: {
    // ⚠ agy 는 `--print` 가 **값을 요구**한다(`--print < file` 은 "flag needs an argument" 로 exit 2). 그래서
    //  프롬프트를 명령치환으로 넣는다 — 큰따옴표 안이라 셸이 내용을 재해석하지 않는다(단어분할·글롭 없음).
    //  ⚠ `[ -s ]` 가드는 장식이 아니다: stdin 리다이렉션(`< file`)은 파일이 없으면 **셸이 그 자리에서 실패**시키는데,
    //   명령치환은 cat 이 실패해도 **빈 프롬프트로 하네스가 그냥 돌아** exit 0 이 된다 → 빈 배치가 '성공'으로 집계된다.
    //   그 무증상 성공은 실패보다 나쁘다(#1289 의 교훈: 실패는 반드시 exit 에 남아야 한다).
    run: (bin, f, p, bypass) => `[ -s "${p}" ] && ${bin} --print "$(cat "${p}")" ${f} --output-format stream-json${bypass}`,
    bypassFlag: "--dangerously-skip-permissions",
    extract: (j) => lastMatch(j, (ev) => {
      const r = ev.result as { response?: string } | undefined;
      return ev.event === "result" && typeof r?.response === "string" ? r.response : null;
    }),
    promptViaArgv: true,
  },
  grok: {
    // grok 헤드리스는 **stdin 프롬프트를 읽지 않지만**(문서·#1701 실측) `--prompt-file` 이 있어 argv 상한도
    //  안 걸린다(경로만 argv 로 간다). streaming-messages-json 은 Messages 호환 JSONL 로 진행을 뱉고 마지막 줄이
    //  `{type:"result", subtype:"success", result:"…"}` — claude 의 stream-json 과 같은 추출 스키마다
    //  (실측 2026-08-14, grok 1.0.3 실계정 1회 실행). `[ -s ]` 가드는 antigravity 와 같은 이유: 빈/부재 프롬프트로
    //  하네스가 그냥 돌아 exit 0 이 되는 무증상 성공을 막는다(실패는 반드시 exit 에 남아야 한다 — #1289).
    run: (bin, f, p, bypass) => `[ -s "${p}" ] && ${bin} --prompt-file "${p}" ${f} --output-format streaming-messages-json${bypass}`,
    bypassFlag: "--always-approve",
    extract: (j) => lastMatch(j, (ev) => (ev.type === "result" ? (typeof ev.result === "string" ? ev.result : JSON.stringify(ev)) : null)),
  },
};
// argv 로 프롬프트를 넘기는 하네스의 상한 — 실측 상한(131,072B)에서 인자·환경 몫을 빼고 여유를 둔다.
export const ARGV_PROMPT_MAX = 100_000;

export interface TaskScriptOpts {
  /** 승인을 우회할까. **기본 true = 종전 위탁 동작**(사람이 안 보는 배치라 우회가 맞다).
   *  false 는 사람이 화면에서 보고 있는 대화형(리브 #1631) — 우회 없이 돌고, 허용 도구를 좁혀 위험을 줄인다. */
  bypassPermissions?: boolean;
}

export function taskScript(harnessKey: string, bin: string, flags: string[], taskDir: string, opts?: TaskScriptOpts): string {
  // 사용자 텍스트는 프롬프트 파일 안에만 있다 — 이 문자열의 가변부는 숫자/화이트리스트 경로뿐.
  //  stream-json = 진행 이벤트를 stream.jsonl 에 줄단위 append → logs tail(파일 오프셋)로 실시간 미러(§11).
  //  최종 결과(type=result)도 그 마지막 줄에 온다. exec $SHELL 로 세션 잔존(실패 시 사후 검시).
  //
  // ⚠ 프롬프트는 **stdin 리다이렉션**으로 넣는다(`< prompt.txt`). 종전엔 `-p "$(cat prompt.txt)"` 로 argv 에
  //  펼쳤는데, 리눅스는 인자 하나가 MAX_ARG_STRLEN(32×4096 = 131,072B)을 넘으면 exec 이 E2BIG 으로 죽는다
  //  (실측 2026-07-31: 130,998B exit=0 / 135,000B exit=126 "Argument list too long"). 그 실패는 특히 고약하다 —
  //  claude 가 **실행조차 안 되므로** stream.jsonl 이 0줄이고, 위탁은 exit≠0 으로 실패하며, 배치 롤백 때문에
  //  같은 프롬프트가 영원히 재시도된다(진행 0). 프롬프트에 자료 본문을 싣기 시작하면서(#1289) 현실적 위험이 됐다.
  //  파이프(`cat … | bin`)가 아니라 리다이렉션인 이유: 파이프라인의 $? 는 마지막 명령의 것이라 cat 실패가
  //  통째로 가려진다. `< file` 은 파일이 없으면 셸이 그 자리에서 실패시키고 그 코드가 그대로 exit 에 남는다.
  const f = flags.join(" ");
  const spec = HEADLESS[harnessKey];
  if (!spec) throw new Error(`위탁을 지원하지 않는 하네스입니다: ${harnessKey}`);
  // 우회 조각은 **앞 공백을 여기서 붙인다** — 끄면 빈 문자열이라 이중 공백이 안 생기고,
  //  켜면 종전 스크립트와 바이트 동일하다(위탁의 기존 동작을 한 글자도 안 바꾼다는 것이 이 리팩터의 계약).
  const bypass = opts?.bypassPermissions === false ? "" : ` ${spec.bypassFlag}`;
  return `cd "$LIVELY_TASK_WS" && ${spec.run(bin, f, `${taskDir}/prompt.txt`, bypass)} > "${taskDir}/stream.jsonl" 2> "${taskDir}/stderr.log"; echo $? > "${taskDir}/exit"; exec "\${SHELL:-sh}"`;
}

// 위탁 작업 폴더(.lively-task/<id>) 준비 — 워커가 결과를 쓸 수 있는 상태로 만든다. 테스트 seam(tasks.test).
//
// ⚠ 이 함수의 존재 이유는 **권한**이다. `mkdir` 의 mode 는 umask 에 깎인다(중앙 박스 umask 022 → 0o770 이 0750).
//  워커는 box_<멤버> uid 로 돌고 이 폴더는 게이트웨이(lively) 소유라, 그룹 쓰기가 빠지면 taskScript 의 리다이렉트가
//  전부 EACCES 로 죽는다:
//   · `> stream.jsonl` 실패 → **claude 가 아예 실행되지 않는다**
//   · `2> stderr.log` 도 같은 폴더 → **그 실패조차 어디에도 안 남는다**
//   · `echo $? > exit` 실패 → 종결 신호가 없어 작업이 **타임아웃(1h)까지 '실행 중'으로 매달린다**(무증상 무한대기)
//  실측(고객사 A 실박스, 2026-07-30): 그 박스의 위탁 태스크 2건 모두 stream.jsonl·exit 부재로 이 상태였다 —
//  헤드리스 위탁이 **한 번도 성공한 적이 없었다**. 크론 요약의 status=ok 는 '접수 성공'이라 실패가 조용히 묻혔다.
//  공유폴더(createProjectFolder)·프로젝트 경로는 이미 같은 이유로 2770 을 별도 chmod 로 보장하는데
//  (project-fs.ts — "chmod 는 umask 에 안 깎이게 별도") 위탁 경로만 그 계약에서 빠져 있었다.
export async function prepareTaskDir(baseWs: string, sharedBase: string, taskId: number | string, prompt: string): Promise<string> {
  const taskDir = path.join(baseWs, ".lively-task", String(taskId));
  await fsp.mkdir(taskDir, { recursive: true, mode: 0o770 });
  // chmod 는 umask 와 무관 — mkdir 이 깎인 만큼을 여기서 되돌린다. 체인 전체(sharedBase 미포함)를 훑으므로
  //  이전 배포가 남긴 750 폴더도 다음 실행에서 자가 복구된다(멱등·best-effort).
  await grantSharedGroupWrite(taskDir, sharedBase, "dir");
  // 재시도(같은 taskId 재큐) 대비 — 이전 시도의 종결 파일이 남아 있으면 즉시 '가짜 완료'로 오감지된다.
  for (const f of ["exit", "stream.jsonl", "stderr.log"]) await fsp.rm(path.join(taskDir, f), { force: true }).catch(() => { /* noop */ });
  await fsp.writeFile(path.join(taskDir, "prompt.txt"), prompt, { mode: 0o660 });
  await fsp.chmod(path.join(taskDir, "prompt.txt"), SHARED_FILE_MODE).catch(() => { /* best-effort */ });
  return taskDir;
}

export async function spawnTaskSession(input: RunTaskInput): Promise<RunTaskResult> {
  // 루트 축 — 위탁(delegate)은 **공유 루트**다: 결과물이 남고 팀이 본다.
  //  리브 대화 턴(#1631)만 **개인 루트**다. 두 가지 이유이고 둘 다 축소하면 안 된다:
  //   ① 세션 시작 훅의 리브 게이트가 `basename(cwd) === "liv"` 라, 그 폴더에서 돌아야 리브가 리브가 된다.
  //   ② 웹터미널 리브 세션과 **같은 자리**를 써야 두 표면이 한 대화로 보인다.
  //  그 외 값은 계속 막는다 — 임의 루트를 여는 순간 이 함수가 범용 실행기가 된다.
  if (input.rootKey !== "shared" && input.rootKey !== "personal") {
    throw new Error(`위탁 워크스페이스 루트는 shared·personal 만 지원합니다: ${input.rootKey}`);
  }
  const harness = HARNESSES.find((h) => h.key === input.harness);
  // #1710 — 위탁 가능 여부는 '헤드리스 규약을 아는가'(HEADLESS 표)로 판정한다. 종전엔 `!== "claude"` 로 잠겨 있어,
  //  세션은 네 하네스로 열리는데 **위탁만 claude 전용**이었다. 표에 없는 하네스는 규약을 실측하지 않은 것이므로
  //  추측해서 열지 않는다 — 무엇을 지원하는지 이름으로 알려준다.
  const spec = harness ? HEADLESS[harness.key] : undefined;
  if (!harness || !spec) {
    throw new Error(`위탁을 지원하지 않는 하네스입니다: ${input.harness}(지원: ${Object.keys(HEADLESS).join(", ")})`);
  }
  // ⚠ 프롬프트가 argv 로 가는 하네스(agy 등)는 exec 인자 상한에 걸린다. 그 실패는 **하네스가 실행조차 안 되는**
  //  형태라 조용하다(stream 0줄 → 배치가 같은 프롬프트를 영원히 재시도). 접수 시점에 재서 미리 거절한다.
  if (spec.promptViaArgv) {
    const bytes = Buffer.byteLength(input.prompt ?? "", "utf8");
    if (bytes > ARGV_PROMPT_MAX) {
      throw new Error(`프롬프트가 ${harness.label} 위탁 상한을 넘습니다(${bytes.toLocaleString()}B > ${ARGV_PROMPT_MAX.toLocaleString()}B) — 이 하네스는 프롬프트를 실행 인자로만 받습니다(stdin 미지원). 프롬프트를 줄이거나 claude·codex 로 위탁하세요.`);
    }
  }
  const user = input.user;
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`; // box-<slug>-hex — 세션 목록/가시성 규칙에 그대로 편입
  // 격리 게이트 — createSession 과 동일 seam(#524): Linux+인프라면 box_ 유저로 drop, 아니면 null(비격리 폴백).
  const osUser = await ensureMemberOsUser(user).catch(() => null);
  const sub = (input.subpath || "").trim() || `delegated/task-${input.taskId}`;
  const { base: sharedBase, abs: baseWs } = await resolveRootPath(user, input.rootKey, sub, osUser ?? null);
  // 레포 지정(#458 재사용) — 공유 base clone→worktree 자동 provision, 워커 cwd=worktree. .lively-task 는 worktree 밖(baseWs)에
  //  둬 레포를 오염시키지 않는다(untracked). 미지정이면 빈 워크스페이스(cwd=baseWs, 프롬프트가 알아서 준비).
  let workspace = baseWs;
  if (input.repo) {
    // 레포 준비는 **위탁 전용 경로**다(리브 대화 턴은 레포를 안 쓴다). 그쪽 id 는 org_task 의 숫자라
    //  여기서 그 계약을 명시적으로 지킨다 — 문자열 id 가 흘러들면 조용히 NaN 폴더가 생기는 대신 여기서 멈춘다.
    const numericTaskId = Number(input.taskId);
    if (!Number.isInteger(numericTaskId)) {
      throw new Error(`레포를 준비하는 작업은 숫자 taskId 가 필요합니다(위탁 전용): ${input.taskId}`);
    }
    workspace = await provisionTaskRepo(
      baseWs, numericTaskId, String(input.repo), input.gitRef ?? null, (user.userId || user.email || null),
      input.repoAuth,   // 노드 실행이면 게이트웨이가 실어 보낸 주입(없으면 중앙 실행 → DB 직접 읽기)
    );
  }
  const taskDir = await prepareTaskDir(baseWs, sharedBase, input.taskId, input.prompt);

  // 플래그 화이트리스트(--model/--effort, 카탈로그 choices 만) — createSession 과 동일 원칙. **그 하네스의 표**로
  //  검사하고(#1710), 그 하네스의 argv 문법으로 옮긴다(codex 의 --effort → --config, harnessFlagArgs 주석 참조).
  const flags = harnessFlagArgs(harness.key, input.flags);
  // 화이트리스트 밖 인자(리브 전용). ⚠ 리브의 거부 목록은 **가변인자**(<tools...>)라 뒤에 오는 첫 `--플래그`
  //  에서 끊긴다 — 목록이 배열 끝에 오면 taskScript 가 뒤에 붙이는 --output-format 까지 도구 이름으로 먹혀
  //  **안전선이 조용히 반쪽이 된다**(그래도 실행은 되고 답도 나온다 = 무증상). 그래서 livTurnArgs 가 거부 목록
  //  **다음에** --session-id/--resume 를 두어 그 자리에서 끊고, 그 순서를 liv-turn.test 가 고정한다.
  if (input.extraFlags?.length) flags.push(...input.extraFlags);
  // 시스템 프롬프트 조각(#1757) — 파일로 두고 경로만 인자에. extraFlags **뒤**에 둔다(리브 거부 목록의 가변인자를
  //  --session-id/--resume 가 이미 끊은 뒤라 안전). 파일 권한은 prompt.txt 와 같다(워커 uid 가 읽어야 한다).
  if (input.systemPrompt) {
    if (harness.key === "claude") {
      const sp = path.join(taskDir, "system.md");
      await fsp.writeFile(sp, input.systemPrompt, { mode: 0o660 });
      await fsp.chmod(sp, SHARED_FILE_MODE).catch(() => { /* best-effort */ });
      flags.push("--append-system-prompt-file", `"${sp}"`);
    } else {
      // 다른 하네스의 대응 플래그는 실측하지 않았다 — 추측해 넣지 않되 **조용히 버리지도 않는다**(#1884). 이 파일엔
      //  logger 가 없다(노드 번들 공용) — console 로 남겨 stderr 에서 보이게 한다.
      console.warn(`[tasks] systemPrompt 은 claude 만 지원 — ${harness.key} 에선 무시됨(task ${input.taskId})`);
    }
  }

  const args = ["new-session", "-d", "-s", id];
  args.push("-e", `LANG=${PANE_LOCALE}`, "-e", `LC_CTYPE=${PANE_LOCALE}`, "-e", `LC_ALL=${PANE_LOCALE}`);
  args.push("-e", `LIVELY_TASK_WS=${workspace}`, "-e", `LIVELY_TASK_ID=${input.taskId}`);
  // #2162 — 위탁 워커는 `createSession` 을 안 타는 **두 번째 문**이라, 종류를 여기서 직접 싣는다.
  //  이 한 줄이 없으면 훅이 다시 `LIVELY_TASK_WS`(작업 폴더라는 제 뜻이 따로 있는 값)를 스니핑해야 한다.
  args.push("-e", `${SESSION_KIND_ENV}=task`);
  // #1291 v2 — 위탁 세션도 세션 신원과 기록 범위를 갖는다. 지금까지 LIVELY_SESSION_ID 조차 안 실어
  //  이 경로의 AI 는 **항상 전체 공개로** 기록했다(잠긴 프로젝트를 위탁해도 마찬가지였다).
  //  세션 id 를 실어야 게이트웨이가 캡을 조회할 수 있고, 캡은 tmux 옵션(아래)이 권위다.
  args.push("-e", `LIVELY_SESSION_ID=${id}`);
  // 자격 리스(§8-3) — setup-token env. 리스가 없으면 노드 로컬 프로필/자격 폴백(중앙=box_ 홈, 멤버 PC=본인 ~/.claude).
  //  ⚠ 중앙 박스 격리(osUser)에서는 이 판이 곧 `sudo → box-spawn` 이라, sudoers 가 보존하지 않는 이름은
  //   **오류 없이** 사라진다. 이름이 런타임에 정해지는 유일한 주입 자리라 시험이 정적으로 못 덮는다 —
  //   그래서 여기서 계약(session-env-contract)에 대조해 «조용한 유실» 을 최소한 **보이게** 만든다.
  //   (막지는 않는다: 리스 표에 하네스를 더하는 사람이 배포 전에 이 줄을 로그에서 보게 하는 것이 목적이고,
  //    비격리·멤버 PC 경로는 sudo 를 안 타 정상 동작하므로 여기서 죽이면 그쪽까지 막는다.)
  for (const [k, v] of Object.entries(input.env ?? {})) {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) continue;
    //  ⚠ `sudo-default`(로케일)는 sudo 자신이 보존하므로 경고 대상이 아니다 — 그것까지 경고하면
    //   «틀린 경고» 가 섞여 진짜 유실 신호의 신뢰가 떨어진다.
    const policy = envKeepPolicy(k);
    if (osUser && policy !== "keep" && policy !== "sudo-default") {
      console.warn(
        `[tasks] ${k} 은 세션 env 계약에 keep 으로 없다 — 격리 세션에서 sudo 가 지운다(task ${input.taskId}). ` +
        "src/terminal/session-env-contract.ts 에 선언하고 `npm run gen:sudoers` 로 재생성하라",
      );
    }
    args.push("-e", `${k}=${v}`);
  }
  const script = taskScript(harness.key, harness.bin, flags, taskDir, { bypassPermissions: input.bypassPermissions });
  if (osUser) {
    args.push(...wrapAsMember(osUser, ["sh", "-lc", script], workspace));
  } else {
    // #1014: 격리 인프라가 준비된 중앙(멀티유저) 박스에서는 비격리 폴백이 공유 $HOME/.claude.json(=설치 때 구워진
    //  남의 lively 토큰)을 읽지 못하게 — 항상 이 멤버 전용 dir 로 격리(공유 폴백 폐기).
    //  ⚠ CLAUDE_CONFIG_DIR(=claude 가 lively MCP 를 읽는 위치)은 CLAUDE_CODE_OAUTH_TOKEN(Anthropic 인증)과 **직교**다.
    //   그래서 중앙 박스 분기는 리스(setup-token)가 있어도 **무조건** 자기 dir 을 박는다 — 그러지 않으면 리스를 든
    //   요청자가 'central' 로 위탁할 때 공유 config(남의 신원)로 폴백하는 구멍이 남는다(리뷰 지적).
    //  워커 노드(멤버 PC=단일유저, 인프라 미준비)만 종전 로컬 폴백 + 리스 시 CLAUDE_CONFIG_DIR 생략($HOME/.claude=본인).
    if (isolationInfraReady() && process.env.LIVELY_MULTIPROFILE !== "0") {
      const profileDir = profileConfigDir(user);
      await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
      args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    } else {
      const profileDir = await resolveProfileConfigDir(user);
      if (profileDir && !(input.env && input.env.CLAUDE_CODE_OAUTH_TOKEN)) args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    }
    args.push("-c", workspace, "sh", "-lc", script);
  }
  await tmux(args);
  const ownerId = user.userId || user.email || "";
  await tmux(["set-option", "-t", id, "@box_owner", ownerId]);
  await tmux(["set-option", "-t", id, "@box_kind", "task"]);   // #2162 — 세션 목록·화면이 «배치»를 알아본다
  await tmux(["set-option", "-t", id, "@box_label", input.label?.trim() || `위탁 #${input.taskId}`]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", workspace]);
  await tmux(["set-option", "-t", id, "@box_auto", "1"]);
  await tmux(["set-option", "-t", id, "@box_task", String(input.taskId)]);
  // 기록 범위(#1291 v2) — 작업 폴더에서 파생해 박는다. 잠긴 프로젝트를 위탁했으면 그 범위로 좁혀지고,
  //  공개 폴더면 종전대로 open 이다(비파괴). 실패해도 위탁 자체는 진행한다 — 그때는 게이트웨이가 조회 시 다시 파생한다.
  try {
    const cap = await deriveWriteCap(workspace);
    if (cap !== "open") await tmux(["set-option", "-t", id, "@box_write_vis", cap]);
  } catch { /* 비치명 — 조회 시점 파생으로 폴백 */ }
  // 위탁 세션은 초대 없음(의뢰자 전용). ⚠ 여기만 평문 "[]" 인 이유: 빈 배열엔 따옴표가 없어 psmux 에서도
  //  무손실이고(#1541), decodeOptJson 이 `[` 로 시작하는 값을 레거시 평문 경로로 정확히 읽는다. 이 한 값 때문에
  //  노드 번들에 tmux-exec 의존을 새로 들이지 않는다.
  await tmux(["set-option", "-t", id, "@box_invites", "[]"]);
  return { sessionId: id, taskDir, workspace };
}

// ── 완료 감지·수집 — exit 파일 등장 = 종결. 결과는 상한(8KB)으로 잘라 보고(전문은 taskDir 에 남는다). ──
//  harness — 결과 스키마가 하네스마다 다르므로 **무엇으로 돌렸는지**를 함께 들고 다녀야 최종 텍스트를 뽑을 수 있다(#1710).
//  구 레코드(값 없음)는 claude 로 본다 — 그때는 claude 전용이었으므로 그게 사실이다.
export interface TaskWatch { taskId: number; sessionId: string; taskDir: string; harness?: string }
export interface TaskOutcome { taskId: number; ok: boolean; exit: number | null; summary?: string; error?: string }

const SUMMARY_CAP = 8 * 1024;

// 진행 스트림에서 최종 텍스트를 뽑는다 — **하네스별 스키마**(HEADLESS.extract)로(#1710).
//  종전엔 claude 의 `type=result` 하나만 알아서, 다른 하네스로 돌린 위탁은 요약이 통째로 빈 값이 됐다.
//  못 찾으면 마지막 비어있지 않은 줄(진행 중 크래시 등) — 요약 목적이라 근사로 충분.
function extractResult(streamJsonl: string, harnessKey?: string): string {
  const spec = HEADLESS[harnessKey || "claude"] ?? HEADLESS.claude;
  const got = spec.extract(streamJsonl);
  if (got) return got;
  const lines = streamJsonl.split("\n").filter((l) => l.trim());
  return lines.length ? lines[lines.length - 1] : "";
}

export async function checkTask(w: TaskWatch): Promise<TaskOutcome | null> {
  let exitRaw: string;
  try { exitRaw = (await fsp.readFile(path.join(w.taskDir, "exit"), "utf8")).trim(); }
  catch { return null; } // 아직 실행 중
  const exit = Number.parseInt(exitRaw, 10);
  const code = Number.isFinite(exit) ? exit : null;
  let stream = "";
  try { stream = await fsp.readFile(path.join(w.taskDir, "stream.jsonl"), "utf8"); } catch { /* 결과 없음 */ }
  const summary = extractResult(stream, w.harness).slice(0, SUMMARY_CAP);
  if (code === 0) return { taskId: w.taskId, ok: true, exit: code, summary };
  let err = "";
  try { err = (await fsp.readFile(path.join(w.taskDir, "stderr.log"), "utf8")).slice(-2048); } catch { /* noop */ }
  return { taskId: w.taskId, ok: false, exit: code, summary, error: err || `exit=${exitRaw}` };
}

// 진행 로그 tail(§11) — stream.jsonl 을 from 바이트부터 읽어 청크 반환. done=exit 파일 존재.
//  중앙(로컬)·원격(노드 RPC 릴레이) 공용. 파일 미존재(claude 시작 전)면 빈 청크.
export interface TailResult { chunk: string; next: number; done: boolean; exit: number | null }
export async function tailTask(taskDir: string, from: number): Promise<TailResult> {
  const p = path.join(taskDir, "stream.jsonl");
  let chunk = "", next = from;
  try {
    const fh = await fsp.open(p, "r");
    try {
      const st = await fh.stat();
      if (st.size > from) {
        const buf = Buffer.allocUnsafe(Math.min(st.size - from, 256 * 1024)); // 청크 상한 256KB
        const { bytesRead } = await fh.read(buf, 0, buf.length, from);
        chunk = buf.subarray(0, bytesRead).toString("utf8");
        next = from + bytesRead;
      } else { next = st.size < from ? st.size : from; } // 재시도로 파일이 짧아졌으면 리셋
    } finally { await fh.close(); }
  } catch { /* 아직 파일 없음 */ }
  let exit: number | null = null, done = false;
  try { const e = (await fsp.readFile(path.join(taskDir, "exit"), "utf8")).trim(); done = true; exit = Number.isFinite(Number(e)) ? Number(e) : null; } catch { /* 실행 중 */ }
  return { chunk, next, done, exit };
}

// 세션 강제 종료(수집 후 정리·타임아웃·취소). 없는 세션은 무시.
export async function killTaskSession(sessionId: string): Promise<void> {
  try { await tmux(["kill-session", "-t", sessionId]); } catch { /* 이미 없음 */ }
}
