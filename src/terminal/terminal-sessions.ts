// 중앙 박스 — tmux 세션 매니저 + 큐레이트 설정(허용 루트·하네스 플래그 카탈로그).
// 모든 tmux 호출은 execFile argv(셸 미경유) — 인젝션 차단. 세션은 box-<userSlug>-* 네임스페이스.
// 메타는 tmux @box_* user-option 에 저장(재기동 생존, tmux SoT — DB 미사용).
// 접근 모델: 소유자 + 초대된 멤버(@box_invites). 기본 비공개(초대 없음 = 소유자만). 공개/팀 개념 없음.
//
// #1313 R15 — 1,293줄 단일 파일을 관심사 6모듈로 분할하고, 이 파일은 **배럴**(기존 20개 importer 무수정)로 남긴다.
//  방향(단방향): catalog ← tmux-exec ← (phase | profiles | write-cap) ← sessions. 역방향 import 금지.
//   · catalog.ts   — 큐레이트 상수·타입(TMUX_BIN·PANE_LOCALE·ROOTS·HARNESSES·SessionInfo·CreateInput·modeEnvArgs)
//   · tmux-exec.ts — tmux 실행 프리미티브(tmux/getOpt/LIST_FMT)·뮤터블 관측 상태·세션 메타 저수준 헬퍼
//   · profiles.ts  — 멤버 신원 파생(slug)·멀티프로필(#346)·OS 유저 프로비저닝(#524)·AI 계정(#1085)
//   · phase.ts     — 실행 단계 관측·판정(detectAwaiting·resolveAgentPhase·markSessionActive, #1221)
//   · write-cap.ts — 세션 기록 범위(#1291 v2)·가시성 술어(canSeeSession)
//   · sessions.ts  — 세션 목록·생성·수정·삭제·초대·입장 판정(CRUD 코어)
//  ⚠ 재수출 집합은 분할 전과 동일해야 한다(export 집합 diff 0 이 이 리팩토링의 계약). 새 심볼을 여기 늘리지 말 것 —
//   내부 공유용 승격 export(tmux()·paneAwaitingInput 등)는 각 모듈에서 직접 import 한다(배럴 비노출).
export {
  TMUX_BIN, PANE_LOCALE, roots, sharedRoot, HARNESSES, modeEnvArgs, themeEnvArgs, normalizeTheme,
  type Root, type FlagDef, type Harness, type SessionInfo, type CreateInput,
} from "./catalog.js";
export {
  listSessionPanePids, isSessionGoneError, sessionGone, tidyHistory,
  sessionDir, getSessionLabel, getSessionProject, ensureSessionOpts,
} from "./tmux-exec.js";
export {
  memberOsUser, resolveRootPath, rootRelOf, profileConfigDir, resolveProfileConfigDir, profileStatus, profileStatusFor,
  provisionProfile, provisionMemberOs, memberOsStatus, aiAccountStatus, aiAccountLogout, ensureMemberOsUser,
  sessionOsUser, userOsUser, type AiAccountStatus,
} from "./profiles.js";
export {
  detectAwaiting, isReportedPhase, PHASE_TTL_SEC, parseReportedPhase, isPhaseFresh, resolveAgentPhase,
  isActivityProgress, markSessionActive, type ReportedPhase,
} from "./phase.js";
export {
  invalidateWriteCap, normalizeCap, sessionWriteCap, deriveWriteCap, canSeeSession, type WriteCap,
} from "./write-cap.js";
export {
  sessionPrefix, listSessions, listRestorableSessions, listSessionsRaw, killEmptyTmuxServer,
  createSession, canAttach, reapCentralSession, killSession, editSession, applyValidatedInvites, validateInvites,
} from "./sessions.js";
