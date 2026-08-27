// 중앙 박스 — tmux 세션 매니저(목록·생성·수정·삭제·초대·입장 판정). terminal-sessions.ts 분할(#1313 R15).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 **두 축**이다: desired(누가·무슨 하네스·어디서·누구에게 — DB org_session_state) / observed(붙어 있나·
//  지금 뭘 돌리나 — tmux). 읽기는 session-desired.resolveDesired 가 단일 창구이고 **DB 가 기본, tmux 가 폴백**이다.
//  쓰기는 아직 양쪽에 한다(tmux @box_* + DB upsert) — 폴백이 살아 있어야 자가호스팅 업그레이드가 안 깨진다.
// 접근 모델: 소유자 + 초대된 멤버(invites). 기본 비공개(초대 없음 = 소유자만). 공개/팀 개념 없음.
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import { codexChatMode } from "./codex-chat-mode.js";
import { rememberCodexThread } from "./codex-chat-thread.js";   // #2055 — 첫 지시도 대화 좌표를 남겨야 화면이 읽는다
import { HttpError } from "../http-error.js";
import { dirToProjectFolder } from "../project/project-fs.js";
import { hiddenProjects, type HiddenProjects } from "../v6/visibility.js";
import { markExecutionSessionApplied, setExecutionSessionProject } from "../v6/execution-session-store.js";
import { listMembers, getRuntimeConfig } from "../org/store.js";
// 공유 빌드 캐시(#813 T3) — 세션이 의존성을 워크트리마다 새로 받지 않게 박스 전역 캐시를 가리킨다.
import { sessionCacheEnv } from "../ops/build-cache.js";
import { effectiveStoragePolicy } from "../org/policies/storage-policy.js";
import { loadStoragePolicy } from "../org/policies/runtime-loaders.js"; // #1313 R46 — 인라인 람다 복붙 제거(로더 정의 단일화)
// 디스크 가드(#813 T5) — 세션은 워크트리·의존성으로 디스크를 크게 먹는다. 꽉 찬 뒤엔 DB 가 죽어 복구가 수동이라,
//  차기 **전에** 신규 세션을 막는다(기존 세션·읽기는 안 막는다).
import { assertDiskWritable } from "../ops/disk-guard.js";
import { orgTimezone } from "../org/timezone.js"; // #778 pane TZ = 조직 시간대
import { SESSION_ID_RE } from "../org/auth/agent-identity.js"; // #852 세션 id 형식 — 게이트웨이 헤더 판정과 같은 자
import { wrapAsMember, type CgroupLimit } from "./terminal-isolation.js";
import { effectiveSessionMemoryPolicy } from "../sessions/session-memory-policy.js"; // #1059 D — per-session cgroup 메모리 캡
import { upsertSessionState, updateSessionStateMeta, deleteSessionState, touchSessionBusy, listAllSessionStates, getSessionState } from "../sessions/session-state.js"; // #1059 E — 세션 desired-state DB 미러(재부팅 복원)
import { memberMkdir, memberWriteFile } from "./terminal-member-fs.js";
import { autoTrustWorkspace } from "./session-create-guards.js";
import { ensureGitSafeDirectory } from "../org/credentials/git-credential-materialize.js";
import { gatewayCapability } from "../sessions/gateway-capabilities.js";   // #2165 — DB 를 타는 자격 주입은 게이트웨이 능력이다
// #1780 D3·D4 — 앱 세션: 앱 토큰 발급 + 세션 폴더에 앱 홈·앱 하네스 자산 물질화.
import { appPluginArgs, writeAppHome, materializePreparedAppAssets, directFsWriter, type AppFsWriter } from "../apps/session-assets.js";
//  #2165 — DB 를 타는 둘(mintAppToken·materializeAppAssets)은 게이트웨이 능력이다. 노드는 게이트웨이가
//   미리 발급·추출해 실어 보낸 것(input.appSession)을 쓰므로 이 경로에 오지 않는다.
import { gatewayUrl } from "../gateway-url.js";
import { roots, sharedRoot, tenantSlug, HARNESSES, PANE_LOCALE, RESUME_ID_RE, modeEnvArgs, themeEnvArgs, harnessThemeArgv, harnessThemeEnvArgs, harnessLaunchArgv, harnessLoginArgv, type SessionInfo, type CreateInput, codexAppServerPaneArgv } from "./catalog.js";
import { codexChatPhase } from "./harness-io/codex-chat-runtime.js";   // #2055 — app-server 세션의 AI 는 pane 이 아니라 런타임이다
import { tmux, tmuxQuiet, getOpt, LIST_FMT, getLastBusy, setLastBusy, sessionDir, encodeOptJson, decodeOptJson, isSessionGoneError } from "./tmux-exec.js";
import {
  sessionActivityTitle, SHELL_CMDS, isSpinning, r_harnessIsAgent, isAgentOffline,
  paneAwaitingInput, parseReportedPhase, isPhaseFresh, resolveAgentPhase,
} from "./phase.js";
import { userSlug, ownerId, resolveRootPath, ensureMemberOsUser, profileConfigDir, mintSessionHookToken, revokeSessionHookToken } from "./profiles.js";
import { ensureMemberKitSeeded } from "./member-kit-seed.js";
import { logger } from "../log.js";
import { canSeeSession } from "./write-cap.js";
import { loadDesiredMap, loadDesiredOne, resolveDesired, resolveSessionDir } from "../sessions/session-desired.js";
import { sessionNameFromPrompt } from "./session-name.js";
import { type LabelSource, canRelabel } from "../sessions/session-label-source.js";   // #1979 — 세션 이름 걸쇠

export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
const ID_RE = SESSION_ID_RE;   // 세션 id 형식의 단일 진실원천 — 게이트웨이가 헤더로 받은 세션도 같은 자로 잰다(#852)
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/;
const cleanLabel = (s: string): string => (s || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80);
const SESSION_HOME_SUBDIR = "sessions"; // 앱 자격·하네스 자산용 private home. cwd와 프로젝트 소속을 표현하지 않는다.

// @box_invites → 멤버 id 배열. 깨진 값·구버전 메타는 빈 배열(=비공개로 안전 폴백).
//  값 표현은 decodeOptJson 이 흡수한다(신=base64 · 구=평문 JSON — #1541 psmux 따옴표 소실 대응).
function parseInvites(raw: string): string[] {
  const a = decodeOptJson<unknown>(raw, []);
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [];
}
// 초대 멤버 검증 — 실제 구성원 id 만, 소유자 제외, 중복 제거(위조·중복 초대 차단).
async function validInvites(ids: unknown, ownerUid: string): Promise<string[]> {
  if (!Array.isArray(ids)) return [];
  const valid = new Set((await listMembers().catch(() => [])).map((m) => m.id));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of ids) if (typeof x === "string" && x !== ownerUid && valid.has(x) && !seen.has(x)) { seen.add(x); out.push(x); }
  return out;
}

export async function listSessions(user: LivelyUser, opts?: { strict?: boolean }): Promise<SessionInfo[]> {
  return collectSessions(ownerId(user), opts?.strict === true);
}

// 복원 가능(restorable) 세션(#1059 E) — DB desired-state 에는 있으나 지금 tmux 에 **없는** 이 사용자 소유 세션.
//  = 재부팅으로 tmux 서버가 죽었거나 F(reaper)가 회수한 세션. 라이브 목록(liveIds)에 있는 건 제외(tmux 우선 — 이중표기 방지).
//  호출자(routes.ts GET /terminal/sessions)가 라이브 tmux + 노드 세션에 이걸 병합한다(노드 병합과 같은 패턴).
//  ⚠ owner-scoped: 소유자만 자기 restorable 세션을 본다(초대·프로젝트 공유 복원목록은 후속 — 재부팅 생존의 핵심은 owner).
//  DB 다운/오류면 빈 배열(복원목록은 최적화지 필수 기능이 아니다 — 라이브 세션 표시를 막지 않는다).
export async function listRestorableSessions(user: LivelyUser, liveIds: Set<string>): Promise<SessionInfo[]> {
  const me = ownerId(user);
  if (!me) return [];
  // ⚠ 가시성은 **라이브 세션과 같은 규칙**이어야 한다 — 프로젝트 폴더 세션은 로그인한 전원(#452), 개인 세션은
  //  소유자·초대자. 종전엔 내 것만(listSessionStatesForOwner) 돌려줘서, 회수·재부팅으로 tmux 에서 사라진 순간
  //  **남의 프로젝트 세션이 목록에서 통째로 없어졌다** — 2026-07-28 실측: F 를 켜자 마이크의 프로젝트 714 세션이
  //  다른 팀원 화면에서 사라져 '삭제된 줄' 알았다(데이터는 그대로 있었다). 라이브일 때 보이던 게 회수되면
  //  안 보이는 건 그 자체로 버그다.
  let states;
  try { states = await listAllSessionStates(); } catch { return []; }
  // 라이브 목록과 **같은 재료**로 판정한다(#1291) — 여기서 hidden 을 안 넘기면 죽은 세션만 공개범위를 안 타서,
  //  잠긴 프로젝트의 세션이 회수되는 순간 전원에게 다시 보이게 된다(이 목록은 라이브 목록과 한 응답에 합쳐진다).
  let hidden: HiddenProjects | undefined;
  let hiddenUnknown = false;
  try { hidden = await hiddenProjects(me); }
  catch { hiddenUnknown = true; }
  const out: SessionInfo[] = [];
  for (const s of states) {
    if (liveIds.has(s.id)) continue; // tmux 에 살아있음 → 라이브가 SoT
    // 라이브(collectSessions)와 동일 술어: 프로젝트 폴더가 아니고, 내 것도 아니고, 초대도 안 됐으면 안 보인다.
    if (hiddenUnknown && dirToProjectFolder(s.dir || "")) continue;   // 판정 불가 → 프로젝트 세션은 감춘다
    if (!canSeeSession(s, me, hidden)) continue;
    out.push({
      id: s.id, label: s.label || s.id, harness: s.harness || "shell", dir: s.dir || "",
      autoApprove: s.auto_approve, owner: s.owner, owned: s.owner === me,
      created: s.created || 0, attached: false, invites: s.invites, flags: s.flags,
      projectId: s.project_id || 0, appId: s.app_id || undefined,
      agentState: "offline", title: "",
      lastActive: s.last_busy || undefined,
      // #2022 — 게이트웨이가 노드 스냅샷에서 **발견한** 행은 workspace 좌표를 모른다 → 되살릴 수 없다.
      //  여기서 true 로 내보내면 화면이 "열면 되살아난다"(#1820)고 약속한 뒤 409 를 받는다. 약속을 하지 않는다.
      restorable: !(s.discovered && !s.root_key),
      discovered: !!s.discovered,
      exitedByUser: !!s.exited_at, // #1059 — 사용자 정상 종료 표시가 찍혔으면 '종료됨', 아니면 '복원 가능(중단됨)'.
      // #1251 — 사용자 종료가 아닌데 사유가 'oom' 이면 earlyoom 이 죽인 것. 둘이 겹치면 사용자 종료가 이긴다(더 확실한 사실).
      oomKilled: !s.exited_at && s.exit_reason === "oom",
      claudeSessionId: s.claude_session_id || undefined,   // #1719 — 죽은 세션도 대화 uuid 를 알면 기록을 잇는다
      // #1791 — 노드 세션의 desired-state. 여기선 id 만 안다(이 모듈은 노드 에이전트 번들에도 들어가 node/registry 를
      //  import 할 수 없다) — 이름·온라인 여부는 routes 가 레지스트리로 보강한다(decorateNodeRows). 프론트는 이 값으로 &node= 를 릴레이.
      ...(s.node_id ? { node: { id: s.node_id, name: s.node_id, online: false } } : {}),
    });
  }
  return out;
}

// 노드 에이전트용(#869) — 뷰어 필터 없이 이 호스트의 전 box-* 세션+메타를 반환한다. 가시성 판정(정책)은
//  게이트웨이가 소유하므로(F7 정책/실행 분리) 노드는 원자료만 상태 push 하고, 게이트웨이가 뷰어별로 거른다.
//  게이트웨이 로컬 경로에선 쓰지 말 것 — listSessions(user)가 정문.
/**
 * @param strict listSessions 와 같은 의미 — **tmux 를 못 본 것**을 삼키지 않고 throw 한다.
 *  "없음"과 "모름"을 구분해야 하는 읽기(예: 중복 세션 수 보고)는 반드시 strict 여야 한다.
 */
export async function listSessionsRaw(opts?: { strict?: boolean }): Promise<SessionInfo[]> {
  return collectSessions(null, opts?.strict === true);
}

// 빈 tmux 서버 정리(#869 노드 자가치유) — 세션이 0개면 서버를 죽인다. 노드 데몬(launchd/systemd)이 과거 최소 PATH 로
//  띄운 tmux 서버가 남아 있으면 새 세션 pane 이 harness(claude 등)를 못 찾아 즉사한다(tmux 는 서버 프로세스의 PATH 로만
//  명령을 해석 — set-environment/-e 로 안 고쳐진다, 실측). 빈 서버를 죽여 다음 new-session 이 데몬의 현재 PATH(로그인 PATH
//  baked)로 새 서버를 띄우게 한다. 세션이 있으면 보존(무손실 — 데몬 재시작 간 세션 지속 불변식).
//  ⚠ '비었다'는 **tmux 가 답해서 세션이 하나도 없다고 말할 때만** 참이다(#1251 의 `ok` 교리와 같다):
//   ① 조회 실패(타임아웃·과부하·서버 없음)는 0개가 아니다 — 종전 collectSessions 폴백은 실패를 빈 배열로 접어
//      `kill-server` 로 이어졌다. 그 판정이 틀리면 **살아있는 세션이 전부 죽는다**(kill-server 는 그 서버의 모든 세션 종료).
//      실패면 죽일 것도 못 본 것이니 그냥 돌아간다 — 서버가 정말 없으면 다음 new-session 이 어차피 새 서버를 띄운다.
//   ② box-* 만이 아니라 **어떤 세션이든** 있으면 빈 서버가 아니다. 사용자의 개인 tmux 세션이 같은 서버에 있으면
//      그건 무손실이 아니고, Windows psmux 는 소켓 격리가 없어 kill-server 가 곧 'PC 의 모든 세션 종료'다
//      (2026-08-18 실측 — 테스트 한 줄의 kill-server 로 그 PC 의 라이블리 세션 5개가 한 번에 죽었다).
/**
 * tmux 실패가 **'서버가 없다'(정상 — 세션 0개)** 인가, **'못 봤다'(장애)** 인가.
 *  이 구분이 곧 "없다"와 "모른다"의 구분이다. 섞으면 모르는 상태를 '없음'으로 단정해 파괴적 결정을 내린다
 *  (#1675 ⑥ 실측: 상시세션 ensure 가 조회 실패를 '세션 없음'으로 읽고 2분마다 새 세션을 만들어 30개까지 쌓였다).
 */
export function isNoTmuxServer(e: unknown): boolean {
  const stderr = String((e as { stderr?: unknown })?.stderr ?? "");
  return /no server running|error connecting/i.test(stderr);
}

export async function killEmptyTmuxServer(): Promise<void> {
  let raw: string;
  try { raw = await tmux(["list-sessions", "-F", "#{session_name}"]); }
  catch (e) {   // 못 봤다 ≠ 비었다
    // 서버가 없는 건 정상(부팅 직후 대부분) — 조용히. 그 밖의 실패(타임아웃·과부하)는 '왜 자가치유가 안 됐나'의 단서라 남긴다.
    if (!isNoTmuxServer(e)) console.warn(`[terminal] 빈 tmux 서버 판정 보류 — list-sessions 실패(죽이지 않는다): ${(e as Error)?.message}`);
    return;
  }
  if (raw.split("\n").some((line) => line.trim() !== "")) return;   // 무엇이든 살아 있으면 보존
  await tmuxQuiet(["kill-server"]);
}

// me=null 이면 필터 없이 전부(owned=false 고정 — 뷰어별 owned 는 소비자가 재계산).
/**
 * @param strict true 면 **tmux 를 못 본 것**(서버 없음이 아닌 실패)을 삼키지 않고 throw 한다.
 *  기본(false)은 종전 동작 — 화면 목록은 빈 목록으로 떨어지는 편이 낫다. 반면 "없으면 만든다" 류의
 *  **파괴적/생성적 결정**을 내리는 호출부는 반드시 strict 여야 한다(모르는 상태를 '없음'으로 읽으면 안 된다).
 */
async function collectSessions(me: string | null, strict = false): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", LIST_FMT]); }
  catch (e) {
    if (strict && !isNoTmuxServer(e)) throw e;   // 못 봤다 — 호출부가 '없음'으로 오해하면 안 된다
    return [];
  }
  // 가려진 프로젝트 집합을 **한 번** 조회(#1291) — 세션 수와 무관하게 쿼리 1회, 15초 캐시.
  //  조회조차 실패하면(DB 다운) 프로젝트 세션을 통째로 감춘다(fail-closed): 개인 세션은 tmux 만으로 판정되므로 그대로 뜬다.
  let hidden: HiddenProjects | undefined;
  let hiddenUnknown = false;
  if (me !== null) {
    try { hidden = await hiddenProjects(me); }
    catch (e) { hiddenUnknown = true; console.warn(`[visibility] 프로젝트 공개범위 판정 실패 — 프로젝트 세션을 숨깁니다: ${(e as Error)?.message}`); }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // 1차: 파싱 + 전역 lastBusy 갱신(스피너 기반, 뷰어 무관 — 정렬 recency 일관성).
  const parsed: Array<Record<string, any>> = [];
  // 2차 산출: desired 해소 + 가시성 필터를 통과한 것만.
  const rows: Array<Record<string, any>> = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("box-")) continue;
    const [name, created, attached, owner, harness, dir, auto, flagsRaw, invitesRaw, projectRaw, appRaw, paneCmdRaw, lastAttachedRaw, lastBusyRaw, stateRaw, lastSeenRaw, paneTitleRaw, ...labelParts] = line.split("\t");
    const invites = parseInvites(invitesRaw);
    const offline = isAgentOffline(harness, paneCmdRaw);
    const busy = !offline && isSpinning(paneTitleRaw);
    // #1221 하네스 보고(@box_state). 신선하면 이게 스크래핑보다 우선한다(resolveAgentPhase 우선순위표).
    const reported = offline ? null : parseReportedPhase(stateRaw);
    const reportedFresh = isPhaseFresh(reported, nowSec) ? reported : null;
    // #1059 — **셸 세션에서 뭔가 돌고 있는가**. 셸 하네스는 스피너 관측 대상이 아니라 lastActive 가 영원히 안 생기고,
    //  그러면 F(idle 회수)의 유일한 보호 신호가 '마지막 열람' 하나뿐이 된다 → **셸에서 `lively run` 으로 AI 를
    //  돌리거나 긴 빌드를 걸어 둔 채 탭을 닫으면 회수된다**(상민님 지적). pane 포그라운드가 셸이 아니면 사용자가
    //  무언가 실행 중이라는 뜻이므로 그것도 '활동'으로 인정해 시각을 갱신한다.
    //  ⚠ 상태 표시는 '셸' 그대로 둔다 — vim 을 열어 둔 것까지 '작업 중'으로 부르면 그건 과장이다. 여기서 쓰는 건
    //   **회수 판정용 활동 시각**뿐이다.
    const shellWorking = (!r_harnessIsAgent(harness)) && !SHELL_CMDS.has((paneCmdRaw || "").trim());
    // 마지막 작업 시각 = max(이번 프로세스 관측, tmux 에 영속된 값). busy(또는 셸에서 실행 중)면 지금으로 갱신.
    const persisted = Number(lastBusyRaw) || 0;
    let lastBusy = Math.max(getLastBusy(name), persisted);
    if (busy || shellWorking) {
      lastBusy = nowSec;
      setLastBusy(name, nowSec);
      if (nowSec - persisted >= 30) {
        void tmuxQuiet(["set-option", "-t", name, "@box_last_busy", String(nowSec)]); // 30초 스로틀 — 폴링마다 쓰지 않는다
        void touchSessionBusy(name, nowSec).catch(() => { /* 비치명 — desired-state 없음(구 세션·노드)·DB 다운 */ }); // #1059 E — restorable 카드 시간표시 미러(같은 스로틀)
      }
    }
    // ⚠ 가시성 판정은 여기서 하지 않는다 — desired(소유자·초대·프로젝트)를 **DB 로 해소한 뒤**여야 한다.
    //  tmux 값으로 먼저 거르면 DB 에서 초대가 추가된 세션이 목록에 아예 안 올라온다(2차 패스로 미룬다).
    parsed.push({
      name, created, attached, paneTitleRaw, offline, busy, shellWorking, lastBusy, reportedFresh,
      lastAttached: Number(lastAttachedRaw) || 0,
      // #1954 3차 — 화면이 직접 찍은 열람 시각(@box_last_seen). attach 이벤트와 **다른 축**이라 max 로 합치지 않고
      //  그대로 올린다 — 합치는 자리는 프론트 판정 한 곳(web/session-status.ts isUnreadDone)이다.
      lastViewed: Number(lastSeenRaw) || 0,
      tmuxDesired: {
        owner: owner || "",
        label: labelParts.join("\t") || null,
        harness: harness || "shell",
        dir: dir || null,
        autoApprove: auto === "1",
        // 적용 플래그 메타 — 신=base64 · 구=평문 JSON, 못 읽으면 빈 객체(구버전 세션) (#1541)
        flags: decodeOptJson<Record<string, string>>(flagsRaw, {} as Record<string, string>),
        invites,
        projectId: Number(projectRaw) || null,
        appId: appRaw || null,
      },
    });
  }

  // ── desired 해소: DB 가 기본, tmux 는 폴백 ──────────────────────────────────
  // 한 쿼리로 전부 가져온다(폴링 경로라 세션 수만큼 쿼리를 치면 안 된다). DB 가 죽으면 빈 맵이 와서
  //  전부 tmux 폴백으로 흐른다 — 목록은 장애 중에도 보여야 한다(그게 복구를 하는 자리다).
  const desiredMap = await loadDesiredMap(parsed.map((p) => p.name));
  for (const p of parsed) {
    const d = resolveDesired(desiredMap.get(p.name), p.tmuxDesired);
    const owned = me !== null && !!d.owner && d.owner === me;
    // 가시성 판정은 canSeeSession 단일 술어로(#1291) — 예전엔 여기 인라인 사본이 있어 라이브 목록과 복원 목록이
    //  갈릴 수 있었다(위 주석이 경계하던 바로 그 이중구현).
    //  me=null(노드 raw 수집 #869)은 필터 없이 전부 — 가시성은 게이트웨이가 판정.
    if (me !== null && hiddenUnknown && dirToProjectFolder(d.dir || "")) continue;
    if (me !== null && !canSeeSession({ dir: d.dir ?? "", owner: d.owner, invites: d.invites, projectId: d.projectId ?? 0 }, me, hidden)) continue;
    rows.push({
      name: p.name, created: p.created, attached: p.attached, paneTitleRaw: p.paneTitleRaw,
      offline: p.offline, busy: p.busy, shellWorking: p.shellWorking, lastBusy: p.lastBusy,
      reportedFresh: p.reportedFresh, lastAttached: p.lastAttached, lastViewed: p.lastViewed,
      owner: d.owner, owned, harness: d.harness, dir: d.dir ?? "", autoApprove: d.autoApprove,
      flags: d.flags, invites: d.invites, projectId: d.projectId ?? 0, appId: d.appId || undefined, label: d.label,
    });
  }
  // 2차: '확인 필요' 감지 — 비offline & 비busy 세션 전부 capture-pane(병렬). #req 접속 안 해도 떠야 하므로 접속 게이트 제거(알림 성격).
  //  #1221 — **하네스가 이미 답을 준 세션은 화면을 안 본다.** 신선한 busy·waiting 보고는 우선순위표에서 스크래핑
  //   결과보다 위에 있어(1·2번) 어차피 결과를 못 바꾼다 → 그 세션의 capture-pane 은 순수 낭비다. 훅 배선이 퍼질수록
  //   폴링당 tmux 호출이 줄어든다(스크래핑 은퇴의 실질적 첫 단계).
  const waitingIds = new Set<string>();
  const needScrape = rows.filter((r) => !r.offline && !r.busy && r.reportedFresh?.phase !== "busy" && r.reportedFresh?.phase !== "waiting");
  await Promise.all(needScrape.map(async (r) => { if (await paneAwaitingInput(r.name)) waitingIds.add(r.name); }));
  const sessions: SessionInfo[] = [];
  for (const r of rows) {
    const flags = r.flags as Record<string, string>;   // desired 해소 단계에서 이미 디코드됐다
    // 온라인/오프라인 판정 = **지금 브라우저 탭에 열려 있나**(attached). 상민님 확정(2026-07-23):
    //  "나·누군가의 PC 어딘가에 탭으로 열려 있는 세션만 온라인, 나머지는 다 오프라인(회색)".
    //  attached 는 그 뜻을 정확히 준다 — 탭이 WS 로 tmux 클라이언트를 붙이고(terminal-pty), 탭을 닫으면
    //  그 클라이언트가 죽는다(cleanup). 반쯤 끊긴 소켓은 #687 heartbeat 가 정리한다. 배경 탭이 살아 있으면
    //  '누군가 어딘가에 열어 둔' 것이므로 온라인이 맞다(사용자 정의와 일치). 이전엔 마지막 작업 경과(48h)로
    //  판정했으나, 재부팅으로 탭을 다 닫았는데도 예전 세션이 온라인으로 남던 문제로 이 규칙으로 되돌린다.
    //  ⚠ 결과: 탭 없이 백그라운드로 도는(busy) 세션이나 승인 대기(waiting) 세션도 탭이 없으면 오프라인이다.
    //   그 세부 상태는 탭이 붙어 있을 때만 색으로 구분한다(busy=작업중·waiting=확인필요·그 외 idle=대기중).
    //  하네스가 끝나 셸만 남은 건(exited) 탭 유무와 무관하게 '종료됨'(AI 가 아예 없음).
    //  ⚠ 셸 하네스는 exited 가 아니다(#1059 P1) — AI 가 없는 게 그 세션의 정상 상태다. exited 는 'AI 가 있었는데
    //   끝났다'만 뜻해야 한다(그래야 카드의 '정리 대상' 뉘앙스가 사실과 맞는다).
    const shellHarness = !r.harness || r.harness === "shell";
    // ★ app-server 세션(#2055): pane 이 **셸**인 것이 정상이다(대화는 app-server 가 돈다). 그런데 종전 판정은
    //  "pane 에 하네스 프로세스가 도나"로 살아있음을 봤다 — 그래서 이 세션들이 전부 **'종료됨'** 으로 잡혔고,
    //  화면은 입력칸 대신 '이어서 대화하기' 바를 띄웠다(=말을 걸 수 없다). 탭 유무(attached)도 무의미하다:
    //  이 세션의 기본 화면은 터미널이 아니라 대화창이라 아무도 pane 에 붙지 않는다.
    //  그래서 이 갈래만 **런타임에게 직접 묻는다** — 그게 그 세션의 AI 다. 실측 2026-08-26(사용자 신고).
    const appServer = codexChatMode({ harness: r.harness }) === "app-server";
    const asPhase = appServer ? codexChatPhase(r.name) : null;
    // #1221 — AI 실행 단계(busy·waiting·idle)는 이제 **한 곳에서** 판정한다(하네스 보고 우선, 화면 스크래핑 폴백).
    //  그 위의 세 갈래(셸 하네스 · AI 종료 · 탭 없음)는 실행 단계와 다른 축이라 종전 순서 그대로다.
    const phase = resolveAgentPhase({ reported: r.reportedFresh, nowSec, spinning: r.busy, scrapedWaiting: waitingIds.has(r.name) });
    const state: SessionInfo["agentState"] = shellHarness ? "shell"
      // 런타임이 살아 있으면 그 말이 정본. 아직 안 열렸으면(첫 프롬프트 전) idle — '종료됨'이 아니다.
      : appServer ? (asPhase ?? (r.reportedFresh?.phase === "waiting" ? "waiting" : "idle"))
      : r.offline ? "exited"
      : Number(r.attached) <= 0 ? "offline"
      : phase;
    sessions.push({
      id: r.name, label: (r.label || r.name), harness: r.harness || "shell", dir: r.dir || "",
      autoApprove: r.autoApprove, owner: r.owner || "", owned: r.owned,
      created: Number(r.created) || 0, attached: Number(r.attached) > 0, invites: r.invites, flags,
      projectId: r.projectId || 0, appId: r.appId || undefined,
      agentState: state,
      // 회수(F)가 보는 두 신호는 **접속과 무관**해야 하고(탭=온라인 규칙이 busy·waiting 을 offline 으로 덮으므로),
      //  두 출처를 **합집합**으로 본다 — 죽이면 되돌릴 수 없는 판정이라 과보호가 옳은 실패 방향이다.
      // app-server 세션의 '일하는 중'은 pane 스피너가 아니라 **턴이 도나**다(pane 은 셸이라 스피너가 없다).
      working: appServer ? asPhase === "busy" : !!(r.busy || r.shellWorking || r.reportedFresh?.phase === "busy"),
      // 승인 대기도 마찬가지 — 화면 스크래핑이 아니라 우리가 들고 있는 승인 목록이 사실이다.
      awaiting: appServer ? asPhase === "waiting" : !!(r.reportedFresh?.phase === "waiting" || waitingIds.has(r.name)),
      title: sessionActivityTitle(r.paneTitleRaw, r.harness),
      lastActive: r.lastBusy || undefined, // 마지막 작업 시각. 한 번도 작업 안 했으면 undefined → 프론트가 created 로 폴백.
      lastAttached: r.lastAttached || undefined, // #1098 마지막 열람(탭 붙음) 시각 — '안 본 작업 완료' 판정용.
      lastViewed: r.lastViewed || undefined,      // #1954 3차 마지막 열람(화면이 직접 찍음) — 위와 같은 판정의 두 번째 신호.
    });
  }
  sessions.sort((a, b) => (a.owned === b.owned ? b.created - a.created : a.owned ? -1 : 1));
  return sessions;
}

// 세션 워크트리(#675)는 #918 에서 제거됐다 — '고른 폴더가 git 저장소면 격리 워크트리에서 돌린다'는 기능이었으나
//  생성 조건(`input.worktree && !osUser && !projectId`)이 이 조직에선 영영 거짓이었다: 멤버는 전원 OS 격리(box_)라
//  osUser 가 항상 있고, 프로젝트 세션은 'project-provision 이 따로 준다'는 이유로 제외였다(그 provision 도 #918 에서
//  제거). 실측 49세션 중 0건 · <repo>-worktrees/ 가 생긴 적 없음. 그런데 UI 는 '기본 켜짐·권장'으로 약속하고 미적용을
//  "폴더가 git 저장소가 아니라서"로 **오진**했다(진짜 이유는 격리). 코드 작업면은 lively_local_repo_worktree
//  셀프서비스가 환경·격리 무관하게 만든다 — 세션 생성은 워크트리를 만들지 않는다.

export async function createSession(user: LivelyUser, input: CreateInput): Promise<SessionInfo> {
  // 디스크 가드(#813 T5) — **맨 앞**에서 막는다. 세션은 워크트리 체크아웃 + 의존성 설치로 디스크를 크게 먹는데,
  //  꽉 차면 Postgres 가 죽어 전 기능이 500 이 되고 공간을 비워도 수동 재시작이 필요하다(2026-07-13 실증).
  //  기존 세션·읽기는 막지 않는다 — 더 붓지만 못하게 할 뿐이다. 임계치는 관리탭 저장소 정책.
  {
    const sp = await effectiveStoragePolicy(loadStoragePolicy).catch(() => null);
    await assertDiskWritable(
      "새 세션",
      roots().map((r) => r.base),
      sp ? { warnPct: sp.disk_warn_pct, criticalPct: sp.disk_critical_pct } : undefined,
    );
  }
  // 격리 게이트(#524) — spawn·cwd·mkdir 전부 이 값으로 분기(한 번만). 프로젝트 세션도 개인 세션과 '동일하게'
  //  생성자 box_<멤버> 로 격리 실행한다(#524 인증 프로필 단위화): claude 자격증명이 각 box_ 홈(700)에 커널 격리
  //  → 공유 lively 로 띄우면 멤버 간 인증이 안 갈리고 재로그인을 요구했다. 공유 프로젝트 폴더는 lively-shared 그룹으로
  //  box_ 가 접근(project 폴더 2770 group rwx). 입장(초대·프로젝트멤버십)은 터미널탭 초대와 '완전히 동일' —
  //  게이트웨이 중계 attach 라 pane uid 와 무관(그래서 공동 입장은 그대로 됨). 과거 '폴더 접근 불가→500' 이유는
  //  폴더를 그룹접근가능으로 만들며 해소. 미프로비저닝 멤버는 여기서 '첫 세션 lazy provision'(ensureMemberOsUser) →
  //  자동 격리(수동 버튼 불요). 인프라미설치/off/비멤버 = null 반환 = 비격리 폴백(무회귀).
  const osUser = await ensureMemberOsUser(user);
  // 중계 배포 멤버 홈 키트(#1437 §21-3) — 로컬 격리의 provision-member 가 심는 훅·토큰·MCP 배선을 첫 세션에서
  //  memberSpawn seam 으로 심는다(멱등·마커 1-stat 빠른 경로·중계 미설정이면 no-op). best-effort — 실패해도 세션은
  //  뜬다(git materialize 규율). 키트가 없으면 work-flag 훅이 없어 대화창 매핑(claude-uuid)이 영영 안 생긴다.
  if (osUser) {
    await ensureMemberKitSeeded(user, osUser).catch((e) =>
      logger.warn({ err: e, osUser }, "멤버 홈 키트 시딩 실패(비치명) — 세션은 뜨나 훅·대화창 매핑이 비어 있을 수 있다"));
  }
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  // cwd는 사용자가 고른 workspace 좌표 그대로다. 미지정이면 personal workspace 루트이며,
  // 세션 id 폴더나 프로젝트 표현 파일을 만들지 않는다.
  const rootKeyUsed = input.rootKey || "personal";
  const subpathUsed = input.subpath || "";
  let { abs: target } = await resolveRootPath(user, rootKeyUsed, subpathUsed, osUser);
  // 작업 디렉터리 확보. 격리면 멤버 uid 로 만든다 — 게이트웨이(비-멤버)는 멤버 700 홈 안에 mkdir 못 함(개인 폴더 세션 버그).
  if (osUser) await memberMkdir(osUser, target);
  else await fsp.mkdir(target, { recursive: true, mode: 0o700 });

  // git 자격 materialize(#540, Slice 2) — 격리 세션이면 그 멤버의 등록 git 자격을 홈(~/.ssh·~/.lively)에 뿌려
  //  세션 안 shell/Claude 의 git 이 멤버 자격으로 되게 한다. best-effort·비파괴(실패해도 세션 생성 안 막음). DB 미등록이면 no-op.
  if (osUser) {
    // 공유 레포 dubious-ownership 방지(#522) — 자격 유무와 무관하게 항상(게이트웨이-소유 클론을 멤버 git 이 거부 않게). best-effort.
    await ensureGitSafeDirectory(osUser).catch((e) => console.warn("[terminal] safe.directory 설정 실패 — 세션은 계속:", (e as Error)?.message ?? e));
    const mid = ownerId(user);
    //  #2165 — 노드엔 DB 가 없어 이 호출은 원래도 실패하고 아래 catch 로 넘어갔다(= 노드에선 죽은 코드).
    //   그런데 정적 import 라 자격 금고·GitHub App 코드가 노드 번들에 실렸다. 이제 능력이 없으면 그냥 건너뛴다.
    const materializeMemberGit = gatewayCapability("materializeMemberGit");
    if (mid && materializeMemberGit) await materializeMemberGit(osUser, mid).catch((e) => console.warn(`[terminal] git 자격 materialize 실패(${mid}) — 세션은 계속:`, (e as Error)?.message ?? e));
  }

  // ── 앱 세션(#1780 D3·D4) — appId가 있으면 grant 검사 → 앱 토큰 발급 → cwd와 분리된 private app home에 자산 물질화. ──
  //  일반 세션(appId 미설정)은 이 블록을 통째로 건너뛴다 → 종전 경로 무변경(핫패스 무회귀).
  //  ⚠ hard-fail: grant 없음(403/409)·토큰 발급 실패·자산 물질화 실패는 **세션 생성을 중단**한다 — 스킬·토큰 없는
  //   앱 세션은 틀린 상태다(일반 세션이라면 best-effort 인 자리들과 대비). 실패해도 tmux new-session 은 아직 안 돌았다.
  //  격리(멤버 700 홈) 세션은 게이트웨이가 그 안에 직접 못 쓰므로 멤버 uid 백엔드 writer 를 넘긴다(비격리는 직접 fs).
  let appEnv: string[] = [];
  let appSessionHome: string | null = null;
  if (input.appId) {
    const appId = input.appId;
    const writer: AppFsWriter = osUser ? { mkdirp: (d) => memberMkdir(osUser, d), writeFile: (p, data, mode) => memberWriteFile(osUser, p, data, mode) } : directFsWriter;
    // 앱 홈·자산은 cwd 가 아니라 세션별 private home(<personal>/sessions/<id>)에 둔다(#1867) — 같은 cwd 를 쓰는 다른 세션과
    //  토큰·자산이 섞이지 않고, 사용자가 고른 workspace 에는 파일을 만들지 않는다. Claude 에는 --plugin-dir 로만 싣는다.
    const { abs: sessionHome } = await resolveRootPath(user, "personal", `${SESSION_HOME_SUBDIR}/${id}`, osUser);
    appSessionHome = sessionHome;
    if (osUser) await memberMkdir(osUser, sessionHome); else await fsp.mkdir(sessionHome, { recursive: true, mode: 0o700 });
    if (input.appSession) {
      // 원격 노드에는 DB가 없다. 게이트웨이가 grant 재검·토큰 발급·자산 수집을 끝낸 봉투만 기계적으로 쓴다.
      if (input.appSession.appId !== appId) throw new HttpError(400, "앱 세션 준비 봉투의 appId가 요청과 다릅니다");
      await writeAppHome(sessionHome, input.appSession.token, input.appSession.gatewayUrl, writer);
      await materializePreparedAppAssets(sessionHome, input.appSession.assets, writer);
    } else {
      const memberId = ownerId(user);
      // 중앙 실행은 종전대로 이 호스트에서 grant 를 재검하고 토큰·자산을 준비한다.
      const mintAppToken = gatewayCapability("mintAppToken");
      const materializeAppAssets = gatewayCapability("materializeAppAssets");
      if (!mintAppToken || !materializeAppAssets) throw new HttpError(503, "앱 세션은 게이트웨이에서만 새로 띄울 수 있습니다");
      const { token } = await mintAppToken(memberId, appId, "app-spawn");
      const gwUrl = await gatewayUrl();
      await writeAppHome(sessionHome, token, gwUrl, writer);
      await materializeAppAssets(sessionHome, appId, writer);
    }
    // pane env — 다른 세션스코프 -e 와 같은 통로(아래 args 에 합류). LIVELY_HOME 은 프록시가 앱 토큰 파일을 찾는 뿌리,
    //  LIVELY_APP_ID 는 귀속(x-lively-app → mcp_call_log.app). ⚠ 격리 분기는 sudoers env_keep 이 두 값을 통과시켜야 실효한다
    //  (deploy/linux/sudoers-lively — 별도 PR3d, 이 커밋 범위 밖).
    appEnv = ["-e", `LIVELY_HOME=${sessionHome}`, "-e", `LIVELY_APP_ID=${appId}`];
  }

  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness) throw new HttpError(400, "허용되지 않은 하네스입니다");
  const cmd: string[] = [];
  const appliedFlags: Record<string, string> = {}; // 생성 시 적용한 플래그 — @box_flags 로 저장(수정 팝업 표시용).
  if (harness.bin) {
    // 모델을 명시해서 띄울 때는 그 모델이 받는 추론강도 조합까지 검증한다. 화면은 모델 변경 때 목록을 좁히지만,
    // API 직접 호출·오래 열린 브라우저도 있으므로 서버가 마지막 경계다(예: Luna + Ultra 는 Codex 카탈로그상 불가).
    const selectedModel = String(input.flags?.["--model"] ?? "");
    const selectedEffort = String(input.flags?.["--effort"] ?? "");
    const modelEfforts = selectedModel ? harness.effortsByModel?.[selectedModel] : undefined;
    if (selectedEffort && modelEfforts && !modelEfforts.includes(selectedEffort)) {
      throw new HttpError(400, `${selectedModel} 모델은 ${selectedEffort} 추론강도를 지원하지 않습니다`);
    }
    cmd.push(harness.bin);
    if (appSessionHome) cmd.push(...appPluginArgs(harness.key, appSessionHome));
    // 이어받기(#905 C1 · #1711 표 구동) — 그 하네스의 이어받기 수단을 **카탈로그에서** 만든다.
    //  ⚠ 여기의 <sid> 는 **그 하네스 자신의 대화 id** 여야 한다(claude UUID · agy conversationId · opencode sessionID).
    //   세션이력 캡처도 같은 id 로 키잉된다(#905). tmux box-id 를 주면 하네스가 못 찾아 "검색 결과 없음"이 된다
    //   (#1059 사용자 신고) — 그 경우엔 resumePick(피커·최근 대화)으로 폴백한다.
    //  ⚠ 종전엔 이 두 분기가 `harness.key === "claude"` 로 잠겨 있어, **claude 아닌 세션은 복원해도 늘 새 대화**로
    //   시작했다(2026-08-14 상민님 신고 — antigravity 세션을 /exit 로 닫고 '이어서 열기' 해도 대화가 없다).
    if (input.resume) {
      if (!RESUME_ID_RE.test(input.resume)) throw new HttpError(400, "resume 세션 id 형식이 잘못되었습니다");
      cmd.push(...(harness.resumeArgv?.(input.resume) ?? []));
    } else if (input.resumePick) {
      cmd.push(...(harness.resumeArgv?.() ?? []));
    }
    for (const def of harness.flags) {
      const raw = input.flags?.[def.name];
      if (raw === undefined || raw === null || raw === "") continue;
      if (def.type === "bool") { if (raw) { cmd.push(def.name); appliedFlags[def.name] = "1"; } continue; }
      const v = String(raw);
      if (def.type === "select") {
        if (!def.choices?.includes(v)) throw new HttpError(400, `${def.label} 값이 허용 목록에 없습니다`);
        // Codex는 추론강도를 일반 CLI 플래그로 받지 않는다. CLI 0.149.1이 보장하는
        // `--config key=value` 경로로 바꾸되, 화면·저장 상태는 다른 하네스와 같은
        // --effort 키를 유지한다. 따라서 생성폼/상단 제어가 하네스별 argv 문법을 알 필요가 없다.
        if (harness.key === "codex" && def.name === "--effort") cmd.push("--config", `model_reasoning_effort=${v}`);
        else cmd.push(def.name, v);
        appliedFlags[def.name] = v;
        continue;
      }
      if (!SAFE_VALUE_RE.test(v) || v.length > 64) throw new HttpError(400, `${def.label} 값 형식이 잘못되었습니다`);
      cmd.push(def.name, v); appliedFlags[def.name] = v;
    }
    if (input.autoApprove && harness.autoApproveFlag) cmd.push(harness.autoApproveFlag);
    // 화면 테마(#1683 후속) — 이 하네스가 실행 시점 주입을 지원하면 그 인자를 얹는다(사람의 설정 파일은
    //  건드리지 않는다 — harnessThemeArgv 주석). 지원 안 하는 하네스면 빈 배열이라 종전 그대로다.
    cmd.push(...harnessThemeArgv(harness.key, input.theme));
  }
  // pane 이 실제로 실행할 argv(#1516). 세 갈래:
  //  · 로그인 세션(loginFor) — 하네스 TUI 대신 그 하네스의 **로그인 명령**을 셸에서 돌린다(만료 자격으로는
  //    하네스가 즉사해 로그인 화면조차 못 보던 데드락을 끊는다). 모르는 하네스면 무시하고 평범한 셸 세션.
  //  · AI 하네스 — 런처로 감싼다(비정상 종료 시 세션 보존 + 한국어 안내). harnessLaunchArgv 주석 참조.
  //  · 셸 하네스 — 그대로(감쌀 하네스가 없다).
  //  · codex app-server 모드(#2055) — pane 은 **셸**이다. 대화는 대화창(app-server)이 전담하고, TUI 를 띄우면
  //    스레드 writer 가 둘이 돼 대화가 갈린다(codex 는 스레드당 writer 를 하나만 허용한다 — 실측).
  const chatMode = codexChatMode({ harness: harness.key, loginFor: input.loginFor });
  const launch = input.loginFor
    ? (harnessLoginArgv(input.loginFor) ?? cmd)
    : chatMode === "app-server"
      ? codexAppServerPaneArgv()
      : harnessLaunchArgv(harness.key, cmd);

  const invites = await validInvites(input.invites, ownerId(user));
  const args = ["new-session", "-d", "-s", id];
  // 한글(멀티바이트) 편집 정상화 — pane 에 UTF-8 로케일 주입(#633). 세션스코프 -e 라 전역/타세션 누수 없음.
  //  격리(box-spawn=sudo)·비격리 두 분기 공통으로 먼저 넣는다(sudo 기본 env_keep 이 LANG/LC_* 를 보존). 근거는 PANE_LOCALE 주석.
  args.push("-e", `LANG=${PANE_LOCALE}`, "-e", `LC_CTYPE=${PANE_LOCALE}`, "-e", `LC_ALL=${PANE_LOCALE}`);
  // 시간대(#778) — pane(셸·클로드코드 등)이 **조직 시간대**의 로컬 시각을 보게 한다. 박스 OS TZ 는 대개 UTC 라
  //  안 주면 클로드코드의 크레딧 리셋 안내 등이 UTC 로 뜬다(클로드코드는 Intl.DateTimeFormat().resolvedOptions()
  //  .timeZone = TZ env 를 읽는다 — 바이너리 실측). OS 전역 TZ(timedatectl)를 바꾸지 않고 세션스코프로만 푼다:
  //  게이트웨이는 비-root 서비스 유저고, 박스의 OS 전역 상태는 고객 소유라 침습하지 않는다.
  //  ⚠ 격리(sudo → box-spawn) 분기는 sudo 의 env_reset 이 env 를 털 수 있어 sudoers 가 TZ 를 명시 보존한다
  //   (deploy/linux/sudoers-lively). 구 sudoers 면 미보존 → 시스템 TZ 폴백 = 종전 동작(무회귀).
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션**부터 적용(#633 과 동일 — 옛 세션은 재생성 시 정상화).
  args.push("-e", `TZ=${await orgTimezone()}`);
  // 세션 신원(#852) — 이 pane 안에서 도는 AI 가 작업(activity)을 기록할 때 **어느 세션에서 한 일인지**를
  //  게이트웨이가 스스로 알게 한다. 지금까진 session_id 를 AI 자기보고에만 맡겨 아무도 안 넘겼고(전 기간 box- 형식 1건),
  //  그래서 "그 작업을 한 터미널에 바로 들어가기"도 "프로젝트 타임라인의 세션 추론"(org/store.ts)도 죽어 있었다.
  //  경로: 이 env → 하네스 MCP 설정 헤더 `x-lively-session: ${LIVELY_SESSION_ID}` → org/auth/agent-identity.sessionFromHeaders.
  //  author_agent 를 접속 헤더로 식별하는 것(#182)과 같은 자리·같은 원리 — 자기보고가 아니라 게이트웨이 권위.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778 과 동일 성질. 옛 세션은 재생성 시 정상화).
  //  ⚠ 격리(sudo → box-spawn) 분기는 env_reset 이 털어가므로 sudoers 가 명시 보존해야 한다(deploy/linux/sudoers-lively).
  //   구 sudoers 면 미보존 → 헤더 빈 값 → 미기록 = 종전 동작(무회귀).
  args.push("-e", `LIVELY_SESSION_ID=${id}`);
  // 화면 테마(#1683) — 이 pane 안에서 도는 하네스·TUI 가 **배경에 맞는 색**을 고르게 한다.
  //  두 경로로 알린다(둘 다 터미널이 앱에게 알려주는 표준 방식이고, 어느 쪽을 읽는지는 도구마다 다르다):
  //   · COLORFGBG — 오래된 관습(vim/neovim 의 background 자동판정, less 등). "<fg>;<bg>" ANSI 번호.
  //   · LIVELY_THEME — 우리 훅·스킬이 읽는 명시 값(위 관습은 값이 모호해 해석이 갈린다).
  //  ⚠ 하네스의 설정 파일(theme 키)은 고치지 않는다 — 그건 사람의 선택이고 킷이 보존하는 값이다(CreateInput.theme 주석).
  //   대신 xterm 이 OSC 11 질의에 실제 배경색을 답하므로(터미널 화면이 그 색을 싣는다) 배경을 물어보는 TUI 는
  //   이 env 없이도 맞게 고른다 — env 는 '물어보지 않는' 도구를 위한 보강이다.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778·SESSION_ID #852 와 같은 성질).
  //   즉 이미 떠 있는 세션의 하네스는 테마를 바꿔도 그대로다 — 그 세션을 다시 만들어야 바뀐다.
  args.push(...themeEnvArgs(input.theme));
  args.push(...harnessThemeEnvArgs(harness.key, input.theme));   // 하네스가 env 로 테마를 받는 경우(#1683 후속)
  // 테넌트 소속(#1437 v1 5단계) — 게이트웨이 하나가 여러 워크스페이스를 서비스할 때, **세션 spawn 훅이
  //  어느 테넌트의 브로커 소켓에 붙어야 하는지**를 알려준다. 훅은 게이트웨이 프로세스의 env 를 물려받는데
  //  공유 게이트웨이에서는 그 env 가 전역이라 테넌트를 구분할 수 없다 — 세션스코프 -e 가 유일한 통로다.
  //  단일 테넌트 배포에서는 컨텍스트가 없어 **아무것도 안 넣는다**(무회귀).
  //  ⚠ 이 값이 없는데 훅이 테넌트별 소켓을 기대하면 훅이 실패해야 한다(조용한 폴백 금지) — 그건 훅 쪽 계약이다.
  {
    const slug = tenantSlug();
    if (slug) args.push("-e", `LVLY_TENANT_SLUG=${slug}`);
  }
  // 실행 모드 세션(#1007+) — 이 pane 의 하네스만 그 모드로. MCP 헤더 `x-lively-mode: ${LIVELY_MODE:-}` 가 이 env 를 확장해
  //  게이트웨이가 이 세션의 요청에만 모드를 강제한다(readonly=쓰기 툴 소거 · incognito=lively 전체 차단). **per-session env 라 동시 실행 세션 중 이것만, 나머지는 정상**(사용자 요구).
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778·SESSION_ID #852 와 동일 성질).
  //  ⚠ 격리(sudo → box-spawn) 분기는 env_reset 이 털어가므로 sudoers 가 LIVELY_MODE(+전이기 구 LIVELY_READONLY/INCOGNITO)를 명시 보존해야 한다(deploy/linux/sudoers-lively).
  args.push(...modeEnvArgs(input)); // 분기·전이기 dual-env 는 modeEnvArgs(순수·단위테스트됨)에
  // #1780 D3 — 앱 세션이면 LIVELY_HOME=<private app home>·LIVELY_APP_ID=<id>(위 앱 블록에서 조립). 일반 세션은 빈 배열=무변경.
  //  ⚠ LANG·TZ·SESSION_ID 와 같은 세션스코프 -e 성질(exec 시점 고정, 새 세션부터 적용). 격리 분기 env_keep 는 별도 PR3d.
  args.push(...appEnv);
  // 공유 빌드 캐시(#813 T3) — 생태계별 다운로드/의존성 캐시를 박스 전역 한 곳으로. LANG/TZ 와 같은 세션스코프 -e
  //  (전역/타세션 누수 없음). 목적은 부피 감소가 아니라 **회수를 싸게 만드는 것**: 워크트리 파생물을 회수해도
  //  캐시가 warm 이라 재설치가 금방 끝난다. 부수로 멤버 격리(#524)로 갈린 홈들의 캐시 중복도 하나로 접는다.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션**부터 적용(LANG·TZ 와 같은 성질).
  //  ⚠ 셸 rc 가 같은 변수를 다시 설정하면 rc 가 이긴다 = 고객의 명시 설정이 우선(비파괴).
  //  관리탭에서 끌 수 있다(저장소·로그 → 공유 빌드 캐시). 꺼져 있으면 빈 객체 = 아무것도 안 바꾼다(무회귀).
  try {
    const sp = await effectiveStoragePolicy(loadStoragePolicy);
    const cacheEnv = sessionCacheEnv(sharedRoot().base, {
      enabled: sp.shared_cache_enabled,
      relocateHome: sp.shared_cache_relocate_home,
    });
    for (const [k, v] of Object.entries(cacheEnv)) args.push("-e", `${k}=${v}`);
  } catch (err) {
    // 정책을 못 읽어도 세션 생성을 막지 않는다 — 캐시 공유는 최적화지 필수 기능이 아니다.
    console.warn(`[terminal] 공유 캐시 env 주입 생략(비치명): ${err instanceof Error ? err.message : String(err)}`);
  }
  // 구성원 격리(#524): 프로비저닝된 멤버면 셸/하네스를 그 멤버 OS 계정으로 내린다(drop-priv, osUser 는 위에서 구함).
  //  → 자격증명이 멤버 홈(700)에 uid 경계로 격리. CLAUDE_CONFIG_DIR 주입 불요(멤버 자기 $HOME/.claude 로 네이티브 격리 — #346 흡수).
  //  미프로비저닝/off = 아래 else(기존 단일-유저 + #346 멀티프로필). seam 한 곳에서만 분기(무회귀).
  if (osUser) {
    // ⚠ tmux -c 를 안 쓴다: -c 는 게이트웨이 권한으로 chdir 해 멤버 700 홈에 못 들어간다('chdir(2) failed: Permission denied' 반복).
    //  대신 box-spawn 이 --cwd 로 멤버 uid 에서 cd 한다. cmd 빈 배열(셸)이어도 wrapper 가 로그인 셸을 띄운다.
    // #1059 D — per-session cgroup 메모리 캡: 관리탭/env 로 캡이 설정된 경우에만 cg 를 넘긴다(→ wrapAsMember 가
    //  box-cgspawn 경유로 systemd-run --scope 격리). 미설정(0/0)=cg undefined → 종전 sudo -u 경로(무회귀, cap-gated).
    //  정책을 못 읽어도 세션 생성을 막지 않는다 — 메모리 캡은 방어책이지 세션 생성의 필수 전제가 아니다.
    let cg: CgroupLimit | undefined;
    try {
      const mp = await effectiveSessionMemoryPolicy(() => getRuntimeConfig().then((c) => c.session_memory_policy));
      if (mp.per_session_high_mb > 0 || mp.per_session_max_mb > 0 || mp.per_session_request_mb > 0) {
        // #2120 — 예약치는 캡과 별개로 실린다(설정 시에만 argv 에 끼어 구버전 훅과 호환된다).
        cg = { highMb: mp.per_session_high_mb, maxMb: mp.per_session_max_mb, requestMb: mp.per_session_request_mb };
      }
    } catch (err) {
      console.warn(`[terminal] 세션 메모리 정책 조회 생략(비치명): ${err instanceof Error ? err.message : String(err)}`);
    }
    // ★ session: true — 여기가 **유일한 세션 spawn** 이다. 파일 브리지 호출들과 구별되어야
    //  세션 spawn 훅(LIVELY_SESSION_SPAWN)이 그쪽까지 가로채지 않는다(terminal-isolation 헤더 참조).
    args.push(...wrapAsMember(osUser, launch, target, cg, { session: true }));
  } else {
    args.push("-c", target);
    // 멀티프로필(#346·#1014): 비격리 경로에서도 **항상 이 멤버 전용 CLAUDE_CONFIG_DIR** 을 준다(공유 폴백 폐기).
    //  왜(#1014): CLAUDE_CONFIG_DIR 을 안 주면 claude 는 호스트 공유 $HOME/.claude.json 을 읽고, 거기 설치 때
    //   구워진 **남의 lively 토큰으로 인증**된다 — 신규/미로그인 프로필이 조용히 타인 계정이 되는 fail-open 구멍.
    //  이제 로그인 전이어도 자기 dir 을 가리킨다: 그 안에서 claude /login 하면 자격이 이 멤버 dir 에만 떨어지고
    //   (닭-달걀 없음), lively MCP(멤버 토큰)는 provisionProfile 이 이 dir 에 굽는다. 절대 남의 신원으로 안 샌다.
    //  ⚠ 세션스코프 -e 만(persistent tmux 서버라 global set-environment 는 세션 간 누수).
    //  유일한 예외 = 단일-유저 kill-switch(LIVELY_MULTIPROFILE=0): 그 박스는 계정이 하나라 공유 config 가 곧 본인이다.
    //  (input.loginProfile 은 이제 기본 동작에 흡수됨 — 항상 dir 을 만들어 주므로 별도 강제 분기 불요.)
    //  #1541 hostProfile — member 노드에서 주인이 여는 세션은 주입하지 않는다(그 PC 의 ~/.claude 가 곧 본인 신원 —
    //   주입하면 빈 프로필이 돼 MCP·훅·로그인이 전부 사라진다). 판정은 게이트웨이가 했다(CreateInput 주석).
    if (process.env.LIVELY_MULTIPROFILE !== "0" && !input.hostProfile) {
      const profileDir = profileConfigDir(user);
      await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
      args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    }
    // 훅 신원(#1719 후속) — 이 pane 의 훅이 **그 세션 주인**으로 보고하게 한다(대화 uuid 매핑·활동/단계·정상종료).
    //  왜 여기만인지·왜 MCP 신원은 안 바뀌는지는 profiles.mintSessionHookToken 주석. 격리 경로는 멤버 홈의
    //  ~/.lively/token 이 이미 그 멤버 것이고 sudo env_reset 도 지나야 해서 넣지 않는다.
    //  best-effort — 못 구우면 종전대로 공유 토큰으로 떨어진다(무회귀).
    const hookToken = await mintSessionHookToken(ownerId(user), id).catch(() => null);
    if (hookToken) args.push("-e", `LIVELY_TOKEN=${hookToken}`);
    if (launch.length) args.push(...launch);
  }
  // 웹터미널은 xterm.js 로 렌더된다 — pane TERM 을 xterm-256color 로 통일(색 일관성: 격리 세션은 box-spawn 이
  //  강제, 비격리(프로젝트·managed)는 여기 default-terminal 로. 서버 전역이나 '새 pane' 에만 적용=기존 세션 무영향, 멱등).
  await tmuxQuiet(["set-option", "-g", "default-terminal", "xterm-256color"]);
  await tmux(args);
  // 이름(#1808) — ① 사람이 준 이름 ② 없으면 **첫 지시**로 짓는다 ③ 그것도 없으면 id(= '아직 이름 없음' 표식.
  //  화면은 그때 pane 제목·중앙 기록 첫 지시로 이름 자리를 채우고, 대화가 시작되면 session-autoname 이 진짜 이름을 박는다).
  //  ⚠ 여기에 '프로젝트명'은 없다 — 한 프로젝트 아래 세션이 전부 같은 이름이 되던 뿌리였다(실측 71%).
  const label = cleanLabel(input.label) || cleanLabel(sessionNameFromPrompt(input.initialPrompt || "")) || id;
  // #1979 — 이름 옆에 **누가 지었나**를 같이 남긴다. 이게 "한 번만 짓고 고정"의 걸쇠다(session-label-source.ts).
  //  사람이 준 이름 = human(에이전트가 못 덮는다) · 첫 지시 규칙 이름 = rule(에이전트가 한 번 다듬는다) · id = 아직 이름 없음.
  //  ⚠ 복원(restore)도 이 함수를 타지만 그때는 이 값이 무시된다 — upsert 의 ON CONFLICT 가 label_source 를
  //   손대지 않는다(안 그러면 복원 한 번에 걸쇠가 풀린다. 근거는 session-state.ts 의 그 주석).
  const labelSource: LabelSource = cleanLabel(input.label) ? "human" : (label === id ? "id" : "rule");
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  await tmux(["set-option", "-t", id, "@box_flags", encodeOptJson(appliedFlags)]);
  await tmux(["set-option", "-t", id, "@box_invites", encodeOptJson(invites)]);
  // 앱 세션이면 앱 id 를 박아둔다(#1780 D4) — @box_project 등과 같은 자리·같은 규약(desired 미러는 app_id 컬럼). 관측·귀속용.
  if (input.appId) await tmux(["set-option", "-t", id, "@box_app", String(input.appId)]);
  // 프로젝트 세션엔 프로젝트 id 를 박아둔다 — listSessions 의 projectId(프론트 세션 귀속·카운트) + 작업 타임라인 귀속용.
  //  (#452 이후 입장 게이트 canAttach 는 멤버십을 안 봄 — 이 id 는 표시·귀속 목적으로만 남는다.)
  if (input.projectId) {
    await tmux(["set-option", "-t", id, "@box_project", String(input.projectId)]);
    await tmux(["set-option", "-t", id, "@box_project_src", input.projectSrc === "org" ? "org" : "v6"]);
    // v6 프로젝트 세션은 실행 전에 DB current가 반드시 존재해야 한다. DB가 SoT인데 이 기록을 best-effort로
    // 삼키면 첫 훅이 미연결로 보고 새 프로젝트를 중복 생성한다. 노드는 DB가 없으므로 게이트웨이 릴레이가 기록한다.
    if (input.projectSrc !== "org" && !process.env.LIVELY_NODE_TOKEN) {
      try {
        const cur = await setExecutionSessionProject({ id, owner: ownerId(user), harness: harness.key, projectId: input.projectId });
        if (!cur) throw new Error("execution session owner claim failed");
        await markExecutionSessionApplied(id, ownerId(user), cur.desired_revision).catch(() => { /* desired가 정본이고 applied는 진단값 */ });
      } catch (e) {
        // 방금 만든 세션만 롤백한다. 사용자 작업이 시작되기 전이며 첫 지시도 아직 큐에 넣지 않았다.
        await tmuxQuiet(["kill-session", "-t", id]);
        throw new HttpError(503, `프로젝트 소속을 기록하지 못해 세션 생성을 취소했습니다: ${(e as Error)?.message ?? e}`);
      }
    }
  }
  // #1291 v2 — 기록 범위(write cap)·read 축소를 세션에 박는다. tmux user-option 이 권위(모드와 같은 자리).
  //  미지정이면 아무것도 안 박는다 → 판정이 실행 폴더에서 파생한다(신규·복원이 같은 규칙을 타게).
  if (input.writeVis) await tmuxQuiet(["set-option", "-t", id, "@box_write_vis", String(input.writeVis)]);
  if (input.restrictRead) await tmuxQuiet(["set-option", "-t", id, "@box_restrict", "1"]);
  // 마우스 휠 스크롤 + window-size latest(상세 근거는 tmux-exec.ts ensureSessionOpts 주석 — #252 깨짐 수정).
  await tmuxQuiet(["set-option", "-t", id, "mouse", "on"]);
  await tmuxQuiet(["set-window-option", "-t", id, "aggressive-resize", "off"]);
  await tmuxQuiet(["set-window-option", "-t", id, "window-size", "latest"]);
  const createdSec = Math.floor(Date.now() / 1000);
  // 세션 desired-state DB 미러(#1059 E) — 재부팅(tmux 사망)에도 복원 가능한 목록으로 남긴다. tmux @box_* 와 같은 값을 미러.
  //  ⚠ best-effort: DB 가 죽어도 세션 생성은 이미 끝났다(위 tmux new-session) — upsert 실패로 세션을 되돌리지 않는다.
  //  managed(상시) 세션은 skip — keep-alive(ensureAllManagedSessions)가 그 영속을 소유하므로 restorable 로 이중화하면
  //   재부팅 후 keep-alive 재생성과 사용자 수동복원이 충돌한다(#1059 E 설계).
  if (!input.managed) {
    try {
      await upsertSessionState({
        id, owner: ownerId(user), label, harness: harness.key, dir: target,
        root_key: rootKeyUsed || null, subpath: subpathUsed || null,   // 복원은 사용자가 고른 같은 workspace 좌표로 돌아간다.
        flags: appliedFlags, auto_approve: !!input.autoApprove, invites,
        project_id: input.projectId || null, project_src: input.projectId ? (input.projectSrc === "org" ? "org" : "v6") : null,
        read_only: !!input.readOnly, incognito: !!input.incognito,
        write_vis: input.writeVis ?? null, restrict_read: !!input.restrictRead,
        app_id: input.appId || null,   // #1780 D4 — 앱 세션 desired-state 미러(복원이 앱 축을 잃지 않게)
        label_source: labelSource,     // #1979 — 이름 걸쇠. INSERT 때만 정해진다(복원은 저장된 출처를 유지)
        created: createdSec, last_busy: null,
      });
    } catch (e) { console.warn(`[terminal] 세션 desired-state 미러 실패(${id}) — 세션은 계속:`, (e as Error)?.message ?? e); }
  }
  // 이름을 **AI 가 다시 짓는 일은 여기서 하지 않는다**(#1979 — 발의 윤상민 2026-08-25).
  //  종전(#1719)엔 여기서 하네스를 **헤드리스로 따로 스폰**해 이름을 지었다(구 src/terminal/session-name-ai.ts).
  //  그 스폰이 `{ ...process.env }` 로 부모 세션의 LIVELY_SESSION_ID·LIVELY_TOKEN·훅 배선을 통째로 상속해서,
  //  시드 훅 project-auto-bind 가 **이름짓기 프롬프트를 '첫 실질 지시'로 오인** → 프로젝트를 만들어 이 세션에 붙였다.
  //  프로덕션 실측 2026-08-25: 쓰레기 프로젝트 #1946·#1957(제목이 이름짓기 프롬프트 첫 줄 그대로), 그 중 하나는
  //  실사용자 세션. 즉 **세션이 자기 이름을 짓는 행위가 자기를 엉뚱한 프로젝트에 바인딩했다.**
  //  이제 이름은 **이미 도는 그 세션 자신**이 짓는다 — 첫 지시 턴에 훅(session-name-ask)이 지시를 주입하고
  //  세션이 `session_rename` 으로 등록한다(capabilities/session-rename.ts). 스폰이 0이면 그 오염 경로는
  //  완화가 아니라 **구조적으로 없다**. 여기 남는 이름은 규칙 이름(label)뿐이고 그게 바닥값이다.
  // 첫 지시(#1719 홈 입력창) — 응답을 막지 않고 백그라운드에서 하네스 입력창이 뜨길 기다렸다 넣는다.
  //  ⚠ 응답을 기다리게 하면 안 된다: 하네스 부팅(수 초)+신뢰 대화상자 동안 화면이 멈추고, 실패해도 세션은 이미 살아 있다.
  //  동적 import — 정적으로 걸면 sessions → session-first-prompt → send-keys → terminal-pty → terminal-sessions → sessions 순환(check-imports).
  if (input.initialPrompt && String(input.initialPrompt).trim() && harness.key !== "shell" && !input.loginFor) {
    const prompt = String(input.initialPrompt);
    // ⚠ 노드(멤버 PC) 세션은 이 함수가 **노드 에이전트 프로세스**에서 돈다 — 거기엔 게이트웨이 DB(itemsPool)가 없다.
    //  아웃박스(org_session_outbox)는 DB 큐라 노드에선 INSERT 가 조용히 실패해 **첫 지시가 통째로 유실**됐다(홈 입력창에서
    //  노드를 골라 연 세션의 첫 지시가 안 들어가던 원인, #1744). 노드에선 DB 없이 로컬 tmux 로 바로 넣는 injectFirstPrompt 를
    //  쓴다 — 입력창·신뢰 대화상자 판정이 그 안에 있고(session-first-prompt.ts), 파일·tmux 가 그 컴퓨터에 있어 로컬이 맞다.
    //  게이트웨이(중앙 박스) 세션은 종전대로 아웃박스: 로그인 화면이면 큐가 들고 있다가 입력창이 뜨면 넣고, 못 넣으면 failed
    //  로 남아 화면이 재시도를 준다. 동적 import — 정적이면 순환(check-imports).
    //  신뢰 대화상자 자동 수락은 **라이블리가 만든 자리에서만**(#1867) — 루트 그 자체이거나 그 프로젝트의 canonical 폴더.
    //   사람이 고른 임의 폴더면 사람이 답한다(autoTrustWorkspace). 이 판정을 빼면 프로젝트 세션의 첫 지시가 대화상자에 막힌다(실측).
    const trustOk = autoTrustWorkspace({ projectId: input.projectId, subpath: subpathUsed });
    const onNode = !!process.env.LIVELY_NODE_TOKEN;   // 노드 에이전트 프로세스에만 있는 값(게이트웨이엔 없다 — 안전한 판별자)
    if (chatMode === "app-server") {
      // ★ app-server 세션의 pane 은 **셸**이다. 그런데 아웃박스 배달자는 "입력창이 뜨면 send-keys" 로 넣는다 —
      //  그 세션에서는 사람의 첫 문장이 **zsh 프롬프트에 타이핑**된다(명령으로 실행되거나 그냥 사라진다).
      //  실측 2026-08-26(사용자 신고 "첫 프롬프트도 씹히고"). 여기서는 프로토콜로 보낸다 — 답이 값으로 온다.
      //  실패하면 아웃박스로 내려간다: 그래야 로그인 전이라 서버를 못 여는 경우에도 지시가 큐에 남는다.
      void (async () => {
        const { sendCodexChat } = await import("./harness-io/codex-chat-runtime.js");
        try {
          const r = await sendCodexChat({ sessionId: id, text: prompt, cwd: target, osUser });
          // ★ 스레드 좌표를 남긴다 — 안 남기면 답은 파일에 멀쩡히 있는데 **화면이 그 파일을 못 찾는다**
          //  (프롬프트 경로에서 이미 한 번 밟은 함정이라 한 함수로 묶어 둘 다 부른다).
          await rememberCodexThread({ sessionId: id, threadId: r.threadId, owner: ownerId(user), osUser });
        }
        catch (e) {
          console.warn(`[terminal] 첫 지시 app-server 전송 실패(${id}) — 아웃박스로 폴백:`, (e as Error)?.message ?? e);
          const { enqueuePrompt } = await import("../sessions/session-outbox.js");
          await enqueuePrompt(id, prompt, { trustOk }).catch(() => undefined);
        }
      })();
    } else if (onNode) {
      void import("./session-first-prompt.js")
        .then(({ injectFirstPrompt }) => injectFirstPrompt(id, harness.key, prompt, { trustOk }))
        .catch((e) => { console.warn(`[terminal] 노드 첫 지시 주입 실패(${id}) — 세션은 살아 있다:`, (e as Error)?.message ?? e); });
    } else {
      void import("../sessions/session-outbox.js")
        .then(({ enqueuePrompt }) => enqueuePrompt(id, prompt, { trustOk }))
        .catch((e) => { console.warn(`[terminal] 첫 지시 큐 등록 실패(${id}) — 세션은 살아 있다:`, (e as Error)?.message ?? e); });
    }
  }
  //  ⚠ 앱 인스턴스 등록은 여기가 아니라 **게이트웨이 라우트**가 한다(routes.ts afterSessionCreated).
  //   이 파일은 노드 에이전트 번들에 실리고 노드엔 DB 가 없다('DB 없음' 계약, scripts/build-node-agent.mjs 화이트리스트).
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, owner: ownerId(user), owned: true, created: createdSec, attached: false, invites, flags: appliedFlags };
}

interface OwnerMeta { owner: string; invites: string[]; }
async function ownerMeta(id: string): Promise<OwnerMeta | null> {
  if (!ID_RE.test(id)) return null;
  // desired(DB) 우선 — 공유 게이트웨이는 그 세션의 tmux 서버 문맥 밖에 있어도 이 질문에 답할 수 있어야 한다.
  //  ⚠ DB 오류는 undefined 로 와서 tmux 폴백으로 흐른다(종전 진실). 판정이 느슨해지는 방향이 아니다.
  const db = await loadDesiredOne(id);
  if (db?.owner) return { owner: db.owner, invites: db.invites };
  const owner = await getOpt(id, "@box_owner");
  if (!owner) return null; // box 세션이지만 메타 없음(우리 것 아님) → 거부
  return { owner, invites: parseInvites(await getOpt(id, "@box_invites")) };
}
// attach·파일접근 = 소유자 OR 초대된 멤버. 프로젝트 폴더 세션은 로그인한 누구나(어사이니 무관, #452). kill/edit = 소유자만.
export async function canAttach(id: string, userId: string): Promise<boolean> {
  const m = await ownerMeta(id);
  if (!m) return false;
  // 프로젝트 폴더 세션은 '공동 세션' — 어사이니/멤버십과 무관하게 로그인한 누구나 입장·조작·파일접근 가능(#452).
  //  단 공개범위가 걸린 프로젝트라면 그 대상만(#1291) — 입장하면 그 프로젝트의 파일·대화를 그대로 보게 되므로
  //  목록에서만 감추는 건 의미가 없다. 판정 불가(DB 다운)면 거부한다 — 여기서 열어주면 잠금이 뚫린다.
  const folder = dirToProjectFolder(await resolveSessionDir(id, () => sessionDir(id)));
  if (folder) {
    try {
      const hidden = await hiddenProjects(userId);
      const pid = Number(await getOpt(id, "@box_project")) || 0;
      return !(hidden.ids.has(pid) || hidden.folders.has(folder));
    } catch { return false; }
  }
  // 개인(비프로젝트) 세션: 소유자 또는 초대된 멤버만.
  return m.owner === userId || m.invites.includes(userId);
}
async function assertManage(user: LivelyUser, id: string): Promise<void> {
  const m = await ownerMeta(id);
  if (!m || m.owner !== ownerId(user)) throw new HttpError(403, "본인 세션이 아닙니다");
}
// tmux 세션만 종료(권한·DB desired-state 미터치) — 회수(reaper)·관리자 회수가 각자 정책 적용 후 부른다.
async function tmuxKill(id: string): Promise<void> {
  if (!ID_RE.test(id)) throw new HttpError(400, "세션 id 형식 오류");
  // ★이미 죽은 세션을 다시 죽이는 것은 **성공**이다(멱등). tmux 는 "can't find session" 으로 실패를 내는데,
  //  그 예외가 그대로 500 으로 새어 나가 화면에선 보관(×)이 먹지 않는 것으로 보였다 — 그리고 하필 사람들이
  //  가장 자주 보관하려는 것이 **이미 끝나 tmux 가 사라진 세션**이라, 보관이 필요한 자리에서만 실패했다
  //  (상민님 2026-08-21 실측: 끝난 세션 보관 → HTTP 500 internal_error, 로그에 can't find session).
  //  보관·회수의 목표 상태는 '그 tmux 가 없음' 이므로, 이미 없으면 목표는 이미 이뤄진 것이다.
  //  소켓 접속불가·타임아웃은 판정 불가라 isSessionGoneError 가 false 를 주고 그대로 던진다(모르면 성공이라 말하지 않는다).
  try { await tmux(["kill-session", "-t", id]); }
  catch (err) { if (!isSessionGoneError(err)) throw err; }
}
// #1059 F — reaper 전용 중앙 세션 회수: tmux 만 죽이고 **desired-state 는 보존**(org_session_state 유지 → restorable
//  로 남아 열 때 lazy resume). 노드 세션 회수는 게이트웨이 라우트의 relayNodeOp{op:'kill'} 이 담당(F 는 소스별 dispatch).
export async function reapCentralSession(id: string): Promise<void> {
  await tmuxKill(id);
}
// opts.admin: 소유자 확인을 건너뛴다(호출 라우트가 admin scope 를 이미 검증 — F4 관리자 수동 회수).
// opts.preserveState: desired-state(org_session_state)를 지운다 vs 보존한다. 기본(미지정)=지움(사용자 명시 kill=복원 안 함).
//  관리자 '회수'는 preserveState:true 로 불러 restorable 로 남긴다(reaper 와 동일 의미 — 메모리만 회수, 복원 가능).
export async function killSession(user: LivelyUser, id: string, opts?: { admin?: boolean; preserveState?: boolean }): Promise<void> {
  if (!opts?.admin) await assertManage(user, id);
  await tmuxKill(id);
  // 세션 스코프 자격 회수 — 이 box 에 실어 준 훅 토큰은 세션과 함께 죽는다(회수/삭제 둘 다. 복원은 새 box id 라 새로 굽는다).
  await revokeSessionHookToken(id).catch((e) => console.warn(`[terminal] 세션 훅 토큰 회수 실패(${id}):`, (e as Error)?.message ?? e));
  if (opts?.preserveState) return;   // 보관(회수)은 **복원 가능**하다 — desired-state 를 남긴다
  await deleteSessionState(id).catch((e) => console.warn(`[terminal] desired-state 삭제 실패(${id}):`, (e as Error)?.message ?? e));
}
/**
 * 세션 이름·초대 변경. `opts.source`(#1979) = **누가 이 이름을 지었나** — 기본 human(웹 편집·직접 호출).
 *  human 이 아니면 걸쇠(session-label-source.ts)를 먼저 본다: 지금 출처를 못 이기면 tmux 도 DB 도 안 건드린다.
 *  ⚠ 자동 이름(session-autoname, source=rule)이 기본값 human 을 쓰면 그 순간 **사람이 지은 이름으로 굳어져**
 *   에이전트가 영영 못 다듬는다 — 자동 경로는 반드시 자기 출처를 실어 보내야 한다.
 */
export async function editSession(user: LivelyUser, id: string, patch: { label?: string; invites?: unknown }, opts?: { source?: LabelSource }): Promise<void> {
  await assertManage(user, id);
  const source: LabelSource = opts?.source ?? "human";
  const mirror: { label?: string; label_source?: LabelSource; invites?: string[] } = {};
  if (patch.label !== undefined) {
    const clean = cleanLabel(patch.label);
    if (!clean) throw new HttpError(400, "이름이 필요합니다");
    if (source !== "human") {
      const cur = await getSessionState(id).catch(() => undefined);
      // 미러 행이 없으면(구 세션·managed) 걸쇠를 걸 근거가 없다 — 종전대로 붙인다(무회귀).
      if (cur && !canRelabel(cur.label_source, source)) return;
    }
    await tmux(["set-option", "-t", id, "@box_label", clean]);
    mirror.label = clean;
    mirror.label_source = source;
  }
  if (patch.invites !== undefined) {
    const invites = await validInvites(patch.invites, ownerId(user));
    await tmux(["set-option", "-t", id, "@box_invites", encodeOptJson(invites)]);
    mirror.invites = invites;
  }
  // desired-state 미러도 갱신(#1059 E) — 재부팅 후 복원본이 새 라벨·초대를 반영하도록. best-effort.
  await updateSessionStateMeta(id, mirror).catch((e) => console.warn(`[terminal] desired-state 메타 갱신 실패(${id}):`, (e as Error)?.message ?? e));
}

// (#869 노드 에이전트 전용) 게이트웨이가 이미 구성원 디렉터리로 검증한 초대 목록을 그대로 기록한다.
//  노드엔 DB 가 없어 validInvites(listMembers)를 못 돌리므로 검증은 게이트웨이 라우트가, 기록만 노드가.
//  게이트웨이 로컬 경로에선 쓰지 말 것 — editSession(검증 포함)이 정문. 소유자 확인은 동일하게 강제.
export async function applyValidatedInvites(user: LivelyUser, id: string, invites: unknown): Promise<void> {
  await assertManage(user, id);
  const clean = Array.isArray(invites) ? invites.filter((x): x is string => typeof x === "string" && x !== ownerId(user)) : [];
  await tmux(["set-option", "-t", id, "@box_invites", encodeOptJson(clean)]);
}

// (#869) 노드 세션 생성 전에 게이트웨이 라우트가 초대 후보를 검증할 수 있게 공개(구성원 실재·소유자 제외·중복 제거).
export async function validateInvites(ids: unknown, ownerUid: string): Promise<string[]> {
  return validInvites(ids, ownerUid);
}
