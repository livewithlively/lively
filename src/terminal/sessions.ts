// 중앙 박스 — tmux 세션 매니저(목록·생성·수정·삭제·초대·입장 판정). terminal-sessions.ts 분할(#1313 R15).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 tmux @box_* user-option 에 저장(재기동 생존, tmux SoT — DB 미사용).
// 접근 모델: 소유자 + 초대된 멤버(@box_invites). 기본 비공개(초대 없음 = 소유자만). 공개/팀 개념 없음.
import fsp from "node:fs/promises";
import crypto from "node:crypto";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { dirToProjectFolder } from "../project/project-fs.js";
import { hiddenProjects, type HiddenProjects } from "../v6/visibility.js";
import { recordSessionProject } from "../v6/project-session-store.js";   // #1313 R21 — 세션 바인딩만(PM 스토어 전체 미적재)
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
import { upsertSessionState, updateSessionStateMeta, deleteSessionState, touchSessionBusy, listAllSessionStates } from "../sessions/session-state.js"; // #1059 E — 세션 desired-state DB 미러(재부팅 복원)
import { memberMkdir } from "./terminal-member-fs.js";
import { materializeMemberGit, ensureGitSafeDirectory } from "../org/credentials/git-credential-materialize.js";
import { ROOTS, SHARED_ROOT, HARNESSES, PANE_LOCALE, modeEnvArgs, harnessLaunchArgv, harnessLoginArgv, type SessionInfo, type CreateInput } from "./catalog.js";
import { tmux, tmuxQuiet, getOpt, LIST_FMT, getLastBusy, setLastBusy, sessionDir, encodeOptJson, decodeOptJson } from "./tmux-exec.js";
import {
  sessionActivityTitle, SHELL_CMDS, isSpinning, r_harnessIsAgent, isAgentOffline,
  paneAwaitingInput, parseReportedPhase, isPhaseFresh, resolveAgentPhase,
} from "./phase.js";
import { userSlug, ownerId, resolveRootPath, ensureMemberOsUser, profileConfigDir } from "./profiles.js";
import { canSeeSession } from "./write-cap.js";

export const sessionPrefix = (u: LivelyUser): string => `box-${userSlug(u)}-`;
const ID_RE = SESSION_ID_RE;   // 세션 id 형식의 단일 진실원천 — 게이트웨이가 헤더로 받은 세션도 같은 자로 잰다(#852)
const SAFE_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._\-:/]*$/;
const cleanLabel = (s: string): string => (s || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80);

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

export async function listSessions(user: LivelyUser): Promise<SessionInfo[]> {
  return collectSessions(ownerId(user));
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
      projectId: s.project_id || 0,
      agentState: "offline", title: "",
      lastActive: s.last_busy || undefined,
      restorable: true,
      exitedByUser: !!s.exited_at, // #1059 — 사용자 정상 종료 표시가 찍혔으면 '종료됨', 아니면 '복원 가능(중단됨)'.
      // #1251 — 사용자 종료가 아닌데 사유가 'oom' 이면 earlyoom 이 죽인 것. 둘이 겹치면 사용자 종료가 이긴다(더 확실한 사실).
      oomKilled: !s.exited_at && s.exit_reason === "oom",
    });
  }
  return out;
}

// 노드 에이전트용(#869) — 뷰어 필터 없이 이 호스트의 전 box-* 세션+메타를 반환한다. 가시성 판정(정책)은
//  게이트웨이가 소유하므로(F7 정책/실행 분리) 노드는 원자료만 상태 push 하고, 게이트웨이가 뷰어별로 거른다.
//  게이트웨이 로컬 경로에선 쓰지 말 것 — listSessions(user)가 정문.
export async function listSessionsRaw(): Promise<SessionInfo[]> {
  return collectSessions(null);
}

// 빈 tmux 서버 정리(#869 노드 자가치유) — 세션이 0개면 서버를 죽인다. 노드 데몬(launchd/systemd)이 과거 최소 PATH 로
//  띄운 tmux 서버가 남아 있으면 새 세션 pane 이 harness(claude 등)를 못 찾아 즉사한다(tmux 는 서버 프로세스의 PATH 로만
//  명령을 해석 — set-environment/-e 로 안 고쳐진다, 실측). 빈 서버를 죽여 다음 new-session 이 데몬의 현재 PATH(로그인 PATH
//  baked)로 새 서버를 띄우게 한다. 세션이 있으면 보존(무손실 — 데몬 재시작 간 세션 지속 불변식).
export async function killEmptyTmuxServer(): Promise<void> {
  try {
    if ((await listSessionsRaw()).length === 0) await tmuxQuiet(["kill-server"]);
  } catch { /* 서버 없음 등 — 무시 */ }
}

// me=null 이면 필터 없이 전부(owned=false 고정 — 뷰어별 owned 는 소비자가 재계산).
async function collectSessions(me: string | null): Promise<SessionInfo[]> {
  let out = "";
  try { out = await tmux(["list-sessions", "-F", LIST_FMT]); } catch { return []; }
  // 가려진 프로젝트 집합을 **한 번** 조회(#1291) — 세션 수와 무관하게 쿼리 1회, 15초 캐시.
  //  조회조차 실패하면(DB 다운) 프로젝트 세션을 통째로 감춘다(fail-closed): 개인 세션은 tmux 만으로 판정되므로 그대로 뜬다.
  let hidden: HiddenProjects | undefined;
  let hiddenUnknown = false;
  if (me !== null) {
    try { hidden = await hiddenProjects(me); }
    catch (e) { hiddenUnknown = true; console.warn(`[visibility] 프로젝트 공개범위 판정 실패 — 프로젝트 세션을 숨깁니다: ${(e as Error)?.message}`); }
  }
  const nowSec = Math.floor(Date.now() / 1000);
  // 1차: 파싱 + 전역 lastBusy 갱신(스피너 기반, 뷰어 무관 — 정렬 recency 일관성). 보이는 세션만 rows 로.
  const rows: Array<Record<string, any>> = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("box-")) continue;
    const [name, created, attached, owner, harness, dir, auto, flagsRaw, invitesRaw, projectRaw, paneCmdRaw, lastAttachedRaw, lastBusyRaw, stateRaw, paneTitleRaw, ...labelParts] = line.split("\t");
    const owned = me !== null && !!owner && owner === me;
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
    // 가시성 판정은 canSeeSession 단일 술어로(#1291) — 예전엔 여기 인라인 사본이 있어 라이브 목록과 복원 목록이
    //  갈릴 수 있었다(위 주석이 경계하던 바로 그 이중구현).
    //  me=null(노드 raw 수집 #869)은 필터 없이 전부 — 가시성은 게이트웨이가 판정.
    if (me !== null && hiddenUnknown && dirToProjectFolder(dir || "")) continue;
    if (me !== null && !canSeeSession({ dir, owner, invites, projectId: Number(projectRaw) || 0 }, me, hidden)) continue;
    rows.push({ name, created, attached, owner, owned, harness, dir, auto, flagsRaw, invites, projectRaw, paneTitleRaw, labelParts, offline, busy, shellWorking, lastBusy, reportedFresh, lastAttached: Number(lastAttachedRaw) || 0 });
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
    // 적용 플래그 메타 — 신=base64 · 구=평문 JSON, 못 읽으면 빈 객체(구버전 세션) (#1541)
    const flags = decodeOptJson<Record<string, string>>(r.flagsRaw, {} as Record<string, string>);
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
    // #1221 — AI 실행 단계(busy·waiting·idle)는 이제 **한 곳에서** 판정한다(하네스 보고 우선, 화면 스크래핑 폴백).
    //  그 위의 세 갈래(셸 하네스 · AI 종료 · 탭 없음)는 실행 단계와 다른 축이라 종전 순서 그대로다.
    const phase = resolveAgentPhase({ reported: r.reportedFresh, nowSec, spinning: r.busy, scrapedWaiting: waitingIds.has(r.name) });
    const state: SessionInfo["agentState"] = shellHarness ? "shell"
      : r.offline ? "exited"
      : Number(r.attached) <= 0 ? "offline"
      : phase;
    sessions.push({
      id: r.name, label: (r.labelParts.join("\t") || r.name), harness: r.harness || "shell", dir: r.dir || "",
      autoApprove: r.auto === "1", owner: r.owner || "", owned: r.owned,
      created: Number(r.created) || 0, attached: Number(r.attached) > 0, invites: r.invites, flags,
      projectId: Number(r.projectRaw) || 0,
      agentState: state,
      // 회수(F)가 보는 두 신호는 **접속과 무관**해야 하고(탭=온라인 규칙이 busy·waiting 을 offline 으로 덮으므로),
      //  두 출처를 **합집합**으로 본다 — 죽이면 되돌릴 수 없는 판정이라 과보호가 옳은 실패 방향이다.
      working: !!(r.busy || r.shellWorking || r.reportedFresh?.phase === "busy"),
      awaiting: !!(r.reportedFresh?.phase === "waiting" || waitingIds.has(r.name)),
      title: sessionActivityTitle(r.paneTitleRaw, r.harness),
      lastActive: r.lastBusy || undefined, // 마지막 작업 시각. 한 번도 작업 안 했으면 undefined → 프론트가 created 로 폴백.
      lastAttached: r.lastAttached || undefined, // #1098 마지막 열람(탭 붙음) 시각 — '안 본 작업 완료' 판정용.
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
      ROOTS.map((r) => r.base),
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
  const id = `${sessionPrefix(user)}${crypto.randomBytes(4).toString("hex")}`;
  let { abs: target } = await resolveRootPath(user, input.rootKey, input.subpath, osUser);
  // 작업 디렉터리 확보. 격리면 멤버 uid 로 만든다 — 게이트웨이(비-멤버)는 멤버 700 홈 안에 mkdir 못 함(개인 폴더 세션 버그).
  if (osUser) await memberMkdir(osUser, target);
  else await fsp.mkdir(target, { recursive: true, mode: 0o700 });

  // git 자격 materialize(#540, Slice 2) — 격리 세션이면 그 멤버의 등록 git 자격을 홈(~/.ssh·~/.lively)에 뿌려
  //  세션 안 shell/Claude 의 git 이 멤버 자격으로 되게 한다. best-effort·비파괴(실패해도 세션 생성 안 막음). DB 미등록이면 no-op.
  if (osUser) {
    // 공유 레포 dubious-ownership 방지(#522) — 자격 유무와 무관하게 항상(게이트웨이-소유 클론을 멤버 git 이 거부 않게). best-effort.
    await ensureGitSafeDirectory(osUser).catch((e) => console.warn("[terminal] safe.directory 설정 실패 — 세션은 계속:", (e as Error)?.message ?? e));
    const mid = ownerId(user);
    if (mid) await materializeMemberGit(osUser, mid).catch((e) => console.warn(`[terminal] git 자격 materialize 실패(${mid}) — 세션은 계속:`, (e as Error)?.message ?? e));
  }

  const harness = HARNESSES.find((h) => h.key === input.harness);
  if (!harness) throw new HttpError(400, "허용되지 않은 하네스입니다");
  const cmd: string[] = [];
  const appliedFlags: Record<string, string> = {}; // 생성 시 적용한 플래그 — @box_flags 로 저장(수정 팝업 표시용).
  if (harness.bin) {
    cmd.push(harness.bin);
    // 이어받기(#905 C1) — claude 하네스에 한해 --resume <sid> 주입(그 세션 대화를 이어서 연다). sid 형식 검증.
    //  ⚠ 여기의 <sid> 는 **claude 자신의 세션 UUID** 여야 한다(세션이력 캡처가 claude session_id 로 키잉 — #905).
    //   tmux box-id 를 주면 claude 가 못 찾아 검색-결과없음 picker 가 뜬다(#1059 사용자 신고). 그 경우엔 resumePick 을 쓴다.
    if (input.resume && harness.key === "claude") {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(input.resume)) throw new HttpError(400, "resume 세션 id 형식이 잘못되었습니다");
      cmd.push("--resume", input.resume);
    } else if (input.resumePick && harness.key === "claude") {
      // #1059 — 정확한 claude UUID 를 모를 때(예: restorable 복원, box-id 만 있음): 인자 없는 --resume 로 **후보 picker** 를
      //  바로 띄운다. box-id 를 넘겨 "검색 결과 없음"에 빠뜨리는 대신, 이 작업폴더의 실제 대화 후보에서 사용자가 고른다.
      //  (제로클릭 정밀 복원은 box-id↔claude-UUID 매핑 저장이 선행 — 후속.)
      cmd.push("--resume");
    }
    for (const def of harness.flags) {
      const raw = input.flags?.[def.name];
      if (raw === undefined || raw === null || raw === "") continue;
      if (def.type === "bool") { if (raw) { cmd.push(def.name); appliedFlags[def.name] = "1"; } continue; }
      const v = String(raw);
      if (def.type === "select") { if (!def.choices?.includes(v)) throw new HttpError(400, `${def.label} 값이 허용 목록에 없습니다`); cmd.push(def.name, v); appliedFlags[def.name] = v; continue; }
      if (!SAFE_VALUE_RE.test(v) || v.length > 64) throw new HttpError(400, `${def.label} 값 형식이 잘못되었습니다`);
      cmd.push(def.name, v); appliedFlags[def.name] = v;
    }
    if (input.autoApprove && harness.autoApproveFlag) cmd.push(harness.autoApproveFlag);
  }
  // pane 이 실제로 실행할 argv(#1516). 세 갈래:
  //  · 로그인 세션(loginFor) — 하네스 TUI 대신 그 하네스의 **로그인 명령**을 셸에서 돌린다(만료 자격으로는
  //    하네스가 즉사해 로그인 화면조차 못 보던 데드락을 끊는다). 모르는 하네스면 무시하고 평범한 셸 세션.
  //  · AI 하네스 — 런처로 감싼다(비정상 종료 시 세션 보존 + 한국어 안내). harnessLaunchArgv 주석 참조.
  //  · 셸 하네스 — 그대로(감쌀 하네스가 없다).
  const launch = input.loginFor ? (harnessLoginArgv(input.loginFor) ?? cmd) : harnessLaunchArgv(harness.key, cmd);

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
  // 실행 모드 세션(#1007+) — 이 pane 의 하네스만 그 모드로. MCP 헤더 `x-lively-mode: ${LIVELY_MODE:-}` 가 이 env 를 확장해
  //  게이트웨이가 이 세션의 요청에만 모드를 강제한다(readonly=쓰기 툴 소거 · incognito=lively 전체 차단). **per-session env 라 동시 실행 세션 중 이것만, 나머지는 정상**(사용자 요구).
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션부터** 적용(LANG #633·TZ #778·SESSION_ID #852 와 동일 성질).
  //  ⚠ 격리(sudo → box-spawn) 분기는 env_reset 이 털어가므로 sudoers 가 LIVELY_MODE(+전이기 구 LIVELY_READONLY/INCOGNITO)를 명시 보존해야 한다(deploy/linux/sudoers-lively).
  args.push(...modeEnvArgs(input)); // 분기·전이기 dual-env 는 modeEnvArgs(순수·단위테스트됨)에
  // 공유 빌드 캐시(#813 T3) — 생태계별 다운로드/의존성 캐시를 박스 전역 한 곳으로. LANG/TZ 와 같은 세션스코프 -e
  //  (전역/타세션 누수 없음). 목적은 부피 감소가 아니라 **회수를 싸게 만드는 것**: 워크트리 파생물을 회수해도
  //  캐시가 warm 이라 재설치가 금방 끝난다. 부수로 멤버 격리(#524)로 갈린 홈들의 캐시 중복도 하나로 접는다.
  //  ⚠ pane env 는 exec 시점 고정 → **새 세션**부터 적용(LANG·TZ 와 같은 성질).
  //  ⚠ 셸 rc 가 같은 변수를 다시 설정하면 rc 가 이긴다 = 고객의 명시 설정이 우선(비파괴).
  //  관리탭에서 끌 수 있다(저장소·로그 → 공유 빌드 캐시). 꺼져 있으면 빈 객체 = 아무것도 안 바꾼다(무회귀).
  try {
    const sp = await effectiveStoragePolicy(loadStoragePolicy);
    const cacheEnv = sessionCacheEnv(SHARED_ROOT.base, {
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
      if (mp.per_session_high_mb > 0 || mp.per_session_max_mb > 0) cg = { highMb: mp.per_session_high_mb, maxMb: mp.per_session_max_mb };
    } catch (err) {
      console.warn(`[terminal] 세션 메모리 정책 조회 생략(비치명): ${err instanceof Error ? err.message : String(err)}`);
    }
    args.push(...wrapAsMember(osUser, launch, target, cg));
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
    if (process.env.LIVELY_MULTIPROFILE !== "0") {
      const profileDir = profileConfigDir(user);
      await fsp.mkdir(profileDir, { recursive: true, mode: 0o700 });
      args.push("-e", `CLAUDE_CONFIG_DIR=${profileDir}`);
    }
    if (launch.length) args.push(...launch);
  }
  // 웹터미널은 xterm.js 로 렌더된다 — pane TERM 을 xterm-256color 로 통일(색 일관성: 격리 세션은 box-spawn 이
  //  강제, 비격리(프로젝트·managed)는 여기 default-terminal 로. 서버 전역이나 '새 pane' 에만 적용=기존 세션 무영향, 멱등).
  await tmuxQuiet(["set-option", "-g", "default-terminal", "xterm-256color"]);
  await tmux(args);
  const label = cleanLabel(input.label) || id;
  await tmux(["set-option", "-t", id, "@box_owner", ownerId(user)]);
  await tmux(["set-option", "-t", id, "@box_label", label]);
  await tmux(["set-option", "-t", id, "@box_harness", harness.key]);
  await tmux(["set-option", "-t", id, "@box_dir", target]);
  await tmux(["set-option", "-t", id, "@box_auto", input.autoApprove ? "1" : "0"]);
  await tmux(["set-option", "-t", id, "@box_flags", encodeOptJson(appliedFlags)]);
  await tmux(["set-option", "-t", id, "@box_invites", encodeOptJson(invites)]);
  // 프로젝트 세션엔 프로젝트 id 를 박아둔다 — listSessions 의 projectId(프론트 세션 귀속·카운트) + 작업 타임라인 귀속용.
  //  (#452 이후 입장 게이트 canAttach 는 멤버십을 안 봄 — 이 id 는 표시·귀속 목적으로만 남는다.)
  if (input.projectId) {
    await tmux(["set-option", "-t", id, "@box_project", String(input.projectId)]);
    await tmux(["set-option", "-t", id, "@box_project_src", input.projectSrc === "org" ? "org" : "v6"]);
    // v6 프로젝트 세션이면 세션↔프로젝트를 영속 기록 — 작업 타임라인이 이 세션의 AI 작업을 프로젝트로 귀속(끝난 세션 포함).
    //  (org 프로젝트는 session_project FK 대상이 아니라 제외.) best-effort: 실패해도 세션 생성은 진행.
    if (input.projectSrc !== "org") {
      try { await recordSessionProject(id, input.projectId); } catch { /* 비치명 */ }
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
        root_key: input.rootKey || null, subpath: input.subpath || null,
        flags: appliedFlags, auto_approve: !!input.autoApprove, invites,
        project_id: input.projectId || null, project_src: input.projectId ? (input.projectSrc === "org" ? "org" : "v6") : null,
        read_only: !!input.readOnly, incognito: !!input.incognito,
        write_vis: input.writeVis ?? null, restrict_read: !!input.restrictRead,
        created: createdSec, last_busy: null,
      });
    } catch (e) { console.warn(`[terminal] 세션 desired-state 미러 실패(${id}) — 세션은 계속:`, (e as Error)?.message ?? e); }
  }
  return { id, label, harness: harness.key, dir: target, autoApprove: !!input.autoApprove, owner: ownerId(user), owned: true, created: createdSec, attached: false, invites, flags: appliedFlags };
}

interface OwnerMeta { owner: string; invites: string[]; }
async function ownerMeta(id: string): Promise<OwnerMeta | null> {
  if (!ID_RE.test(id)) return null;
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
  const folder = dirToProjectFolder(await sessionDir(id));
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
  await tmux(["kill-session", "-t", id]);
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
  if (!opts?.preserveState) await deleteSessionState(id).catch((e) => console.warn(`[terminal] desired-state 삭제 실패(${id}):`, (e as Error)?.message ?? e));
}
export async function editSession(user: LivelyUser, id: string, patch: { label?: string; invites?: unknown }): Promise<void> {
  await assertManage(user, id);
  const mirror: { label?: string; invites?: string[] } = {};
  if (patch.label !== undefined) {
    const clean = cleanLabel(patch.label);
    if (!clean) throw new HttpError(400, "이름이 필요합니다");
    await tmux(["set-option", "-t", id, "@box_label", clean]);
    mirror.label = clean;
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
