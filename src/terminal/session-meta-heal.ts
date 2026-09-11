// 세션 표식(@box_*) — **한 벌의 목록**, 그리고 표식이 빠진 채 살아 있는 세션을 DB 행으로 되채우는 판정 (#3892).
//
// ── 왜 필요한가 ─────────────────────────────────────────────────────────────
// createSession 은 «판(new-session)» 과 «표식(@box_* 묶음)» 을 **두 왕복**으로 보낸다(#3537). 그 사이에서 요청이
//  끊기면 판은 살아 AI 가 도는데 표식은 하나도 없는 세션이 남는다.
//  실측(2026-09-11, 매니지드): 테넌트 이미지 롤이 옛 게이트웨이를 내리는 순간(08:45:00.625Z SIGTERM) 되살리기 중이던
//  box-sangmin-yoon-d78e541c 의 표식 묶음이 15ms 뒤 relay «Command failed» 로 죽었다(게이트웨이 로그 — #3891 세션 실측).
//  그 세션은 이후 표식이 영영 비어 있었다 — 다시 채우는 자리가 어디에도 없었다. 원준님 box-wonjoon-jang-39d499af(09-09)도
//  같은 모양이다(둘 다 DB 행은 있고 session_project 기록·옛 행 이정표가 없다 = 생성이 표식 묶음에서 멈췄다). 겪은 것:
//   · 목록 관측이 빈 @box_harness 를 «셸» 로 읽어 «AI 종료 + 셸 작업» 을 함께 냈다 → 사이드바 회색 «셸», 「지금 볼 것」 제외
//     (관측 쪽 고침은 phase.ts observeAgentRun — 표식이 없어도 화면이 맞게)
//   · tmux @box_owner 를 보는 입구(세션 프로젝트 바꾸기 등)가 «세션을 찾을 수 없습니다» · 마우스 휠 등 창 옵션 없음
//
// ── 무엇을 하나 ─────────────────────────────────────────────────────────────
//  ① sessionMetaCmds·sessionWindowCmds — createSession 과 되채우기가 **같은 목록**을 쓴다
//     (한쪽에만 새 표식을 더하면 되채운 세션이 그 표식만 없는 채로 남는다).
//  ② metaHealCmds — DB desired 행(정본)으로 그 목록을 다시 만든다. DB 에 없는 값(@box_runtime)은 짓지 않는다.
//  ③ needsMetaHeal — «DB 행이 있는데 tmux @box_harness 가 비었다» 일 때만 참. 표식을 박는 생성 경로는 전부 @box_harness 를
//     박으므로(createSession · node/tasks) 그 빈 값은 «표식 묶음이 안 돌았다» 의 표지다. 상시세션은 DB 행이 없어 해당 없다.
//  ④ makeMetaHealGate — 세션당 쿨다운. 목록 폴링은 뷰어 수만큼 돌므로 되채우기가 폴링마다 나가지 않게.
//
// ⚠ 순수 모듈이다(tmux·DB 호출 없음) — 부르는 쪽(sessions.ts)이 보낸다. 노드 번들 허용목록에 올라 있다
//  (sessions.ts 가 import 한다 — scripts/node-agent-allowed-modules.json).
import { encodeOptJson, type TmuxCmd } from "./tmux-exec.js";
import { normalizeSessionKind } from "../sessions/session-kind.js";
import type { SessionState } from "../sessions/session-state.js";

/** 세션 표식의 값 — createSession 이 태어날 때 정한 것, 또는 DB desired 행이 기억하는 것. */
export interface SessionMetaValues {
  owner: string;
  label: string;
  harness: string;
  /** 대화 런타임으로 떴나(#2439). **DB 에 없는 값**이라 되채우기는 넘기지 않는다 — 모르는 것을 짓지 않는다. */
  runtimeChat?: boolean;
  kind: string;
  /** 실행 폴더 — 비면 표식을 안 박는다(빈 값으로 덮지 않는다). createSession 은 늘 준다. */
  dir?: string | null;
  autoApprove: boolean;
  flags: Record<string, string>;
  invites: string[];
  appId?: string | null;
  projectId?: number | null;
  projectSrc?: string | null;
}

/**
 * (순수) 세션 표식 목록 — 한 묶음으로 보낼 set-option 들. **전부 같은 세션을 지목한다**(묶음 라우팅 불변식, tmux-exec.ts #3668).
 *  순서·값은 #3537 이 createSession 에 인라인으로 두던 목록 그대로다(값 표현은 encodeOptJson — #1541).
 */
export function sessionMetaCmds(id: string, v: SessionMetaValues): TmuxCmd[] {
  return [
    ["set-option", "-t", id, "@box_owner", v.owner],
    ["set-option", "-t", id, "@box_label", v.label],
    ["set-option", "-t", id, "@box_harness", v.harness],
    //  ★ #2439 — 이 세션이 **어느 모드로 떴나**. 배달·화면이 같은 값을 봐야 판정이 갈리지 않는다.
    ...(v.runtimeChat ? [["set-option", "-t", id, "@box_runtime", "chat"] as TmuxCmd] : []),
    ["set-option", "-t", id, "@box_kind", v.kind],   // #2162 — 종류(@box_* 와 같은 자리·같은 규약)
    ...(v.dir ? [["set-option", "-t", id, "@box_dir", v.dir] as TmuxCmd] : []),
    ["set-option", "-t", id, "@box_auto", v.autoApprove ? "1" : "0"],
    ["set-option", "-t", id, "@box_flags", encodeOptJson(v.flags)],
    ["set-option", "-t", id, "@box_invites", encodeOptJson(v.invites)],
    // 앱 세션이면 앱 id(#1780 D4) — 관측·귀속용.
    ...(v.appId ? [["set-option", "-t", id, "@box_app", String(v.appId)] as TmuxCmd] : []),
    // 프로젝트 세션이면 프로젝트 id — listSessions 의 projectId(tmux 폴백) + 작업 타임라인 귀속용.
    ...(v.projectId ? [
      ["set-option", "-t", id, "@box_project", String(v.projectId)] as TmuxCmd,
      ["set-option", "-t", id, "@box_project_src", v.projectSrc === "org" ? "org" : "v6"] as TmuxCmd,
    ] : []),
  ];
}

/**
 * (순수) 창·기록 범위 옵션 — createSession 이 표식 뒤에 **삼키는 묶음**으로 보내는 것(#1291 v2 · #252).
 *  기록 범위(@box_write_vis·@box_restrict)는 tmux 가 권위라 미지정이면 안 박는다(실행 폴더에서 재파생).
 */
export function sessionWindowCmds(id: string, v: { writeVis?: string | null; restrictRead?: boolean }): TmuxCmd[] {
  return [
    ...(v.writeVis ? [["set-option", "-t", id, "@box_write_vis", String(v.writeVis)] as TmuxCmd] : []),
    ...(v.restrictRead ? [["set-option", "-t", id, "@box_restrict", "1"] as TmuxCmd] : []),
    ["set-option", "-t", id, "mouse", "on"],
    ["set-window-option", "-t", id, "aggressive-resize", "off"],
    ["set-window-option", "-t", id, "window-size", "latest"],
  ];
}

/** 되채우기에 쓰는 DB 행의 칸 — `SessionState` 의 부분집합. */
export type HealRow = Pick<SessionState, "owner" | "label" | "harness" | "kind" | "dir" | "auto_approve" | "flags" | "invites" | "app_id" | "project_id" | "project_src" | "write_vis" | "restrict_read">;

/**
 * (순수) DB desired 행 → 되채울 명령. 표식 목록 + 창·기록 범위 옵션.
 *  · 이름은 목록 파싱이 줄·탭으로 가르므로 createSession 의 cleanLabel 과 같은 규칙으로 다듬는다(비면 id).
 *  · @box_runtime 은 싣지 않는다(DB 에 없다 — 모르면 배포 기본을 따르는 것이 종전 규약이다, deliver-prompt.ts).
 */
export function metaHealCmds(id: string, row: HealRow): TmuxCmd[] {
  const label = String(row.label || "").replace(/[\t\n\r]/g, " ").trim().slice(0, 80) || id;
  return [
    ...sessionMetaCmds(id, {
      owner: row.owner, label, harness: row.harness, kind: normalizeSessionKind(row.kind),
      dir: row.dir, autoApprove: !!row.auto_approve, flags: row.flags || {}, invites: row.invites || [],
      appId: row.app_id, projectId: row.project_id, projectSrc: row.project_src,
    }),
    ...sessionWindowCmds(id, { writeVis: row.write_vis, restrictRead: row.restrict_read }),
  ];
}

/**
 * (순수) 이 라이브 세션의 표식을 되채울까.
 *  ① DB desired 행이 있고 소유자가 적혀 있다(정본이 있어야 되채운다 — 없으면 짓게 된다)
 *  ② tmux @box_harness 가 비었다(표식 묶음이 안 돈 세션의 표지)
 *  ③ 상시세션(@box_managed)이 아니다(그 표식은 keep-alive 가 소유한다 — DB 행도 원래 없다)
 */
export function needsMetaHeal(i: { harnessRaw: string; row: { owner?: string | null } | undefined; managed: string | null | undefined }): boolean {
  return !!i.row && !!String(i.row.owner || "").trim() && !String(i.harnessRaw || "").trim() && !String(i.managed || "").trim();
}

/**
 * (순수) **세션 호스트 스냅샷의 한 행**을 되채울까 (#3892 후속).
 *
 *  ── 왜 따로 있나 ──
 *  세션 목록 소유가 노드의 세션 호스트로 넘어간 테넌트에서는 게이트웨이가 `collectSessions` 를 안 돌려 위 판정이
 *   불리지 않는다. 그런데 세션 호스트는 노드 프로세스라 **DB 가 없다** — 표식이 빈 판을 스스로 못 알아보고, 소유자 표식이
 *   비어 있으니 게이트웨이 가시성 판정(`nodeSessionVisible`: 소유자·초대)에서 **주인에게도 안 보인다.** 그 사이 DB 행은
 *   «중단됨» 으로 떠서 사람은 «살아 있는 세션이 회수됐다» 로 겪는다(실측 2026-09-11 box-sangmin-yoon-d78e541c).
 *  그래서 스냅샷 쪽에서는 tmux 원시 하네스 대신 **행의 소유자 칸**을 표지로 쓴다 — 노드엔 DB 가 없어 그 칸이 곧
 *   tmux `@box_owner` 이고, 모든 생성 경로가 표식 묶음의 **첫** 명령으로 박는 값이다.
 *  ① DB 행 있음 · 소유자 있음 ② 그 행이 **박스 세션**이다(`node_id` 없음 — 멤버 PC 노드 세션의 tmux 는 게이트웨이가
 *   칠 수 없다) ③ 스냅샷 행의 소유자가 비었다 ④ 상시세션이 아니다.
 */
export function needsSnapshotMetaHeal(i: { snapshotOwner: string | null | undefined; row: { owner?: string | null; node_id?: string | null } | undefined; managed: string | null | undefined }): boolean {
  return !!i.row && !!String(i.row.owner || "").trim() && !String(i.row.node_id || "").trim()
    && !String(i.snapshotOwner || "").trim() && !String(i.managed || "").trim();
}

/** 되채우기 쿨다운 — 실패해도(중계 끊김) 이만큼 뒤에 다시 시도한다. 성공하면 다음 폴링부터 ②가 거짓이라 더 안 나간다. */
export const META_HEAL_COOLDOWN_MS = 60_000;

/**
 * 세션당 쿨다운 문지기 — 참이면 «지금 보내라». 오래된 기억은 부를 때마다 버린다(무한히 안 자란다).
 *  ⚠ 프로세스 수명이다 — 게이트웨이가 재기동하면 한 번 더 나갈 뿐이다(멱등한 set-option 이라 무해하다).
 */
export function makeMetaHealGate(cooldownMs: number = META_HEAL_COOLDOWN_MS): (id: string, nowMs: number) => boolean {
  const last = new Map<string, number>();
  return (id, nowMs) => {
    for (const [k, at] of last) if (nowMs - at >= cooldownMs) last.delete(k);
    if (last.has(id)) return false;
    last.set(id, nowMs);
    return true;
  };
}
