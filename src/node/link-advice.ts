// 노드가 안 붙어 있을 때 **사람에게 할 말**을 만든다 (#1849 ②).
//
// 왜 서버가 문구를 만드나: 같은 사실을 말하는 자리가 넷이다 — 세션 복원 오류(REST 409), 노드 목록 화면,
//  세션 목록 배지, CLI(`lively status`). 각자 문장을 지어내면 넷이 조금씩 다른 말을 하게 되고, 그중 하나가
//  낡으면 사용자는 상충하는 안내를 본다. 판정(sleep-pattern.ts)과 문구를 한 곳에 두고 **그 결과를 흘린다**.
//  (CLI 는 kit/cli 번들이라 src/ 를 import 하지 못한다 — API 가 준 문구를 그대로 찍는 것이 유일한 길이기도 하다.)
//
// 원칙: **추정은 추정으로 말한다.** "~로 보입니다"를 쓰고 근거 수치를 함께 낸다. 단정하면, 원인이 다른 경우
//  (네트워크·게이트웨이 재배포) 사용자를 엉뚱한 조치로 보낸다.
import type { KeepAwakeStatus, KeepAwakeGap } from "./keep-awake.js";
import type { LinkDiagnosis } from "./sleep-pattern.js";

/** 초를 사람이 읽는 단위로 — "62초" · "1시간 0분". 진단 근거를 문장에 넣기 위한 것. */
export function humanDur(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "0초";
  if (sec < 90) return `${Math.round(sec)}초`;
  const min = Math.round(sec / 60);
  if (min < 90) return `${min}분`;
  const h = Math.floor(min / 60);
  return `${h}시간 ${min % 60}분`;
}

/** 자동으로 못 막는 구멍 → 사람이 읽는 한 조각. 표시 순서는 호출부가 정한다. */
export function gapNote(gap: KeepAwakeGap, platform: string | null): string {
  switch (gap) {
    case "clamshell": return "뚜껑을 닫으면 잠자기를 막을 수 없습니다";
    case "battery":   return "배터리로 쓰는 동안에는 (배터리 보호를 위해) 막지 않습니다";
    case "modern-standby": return "이 PC 가 최신 대기(modern standby) 방식이면 막히지 않을 수 있습니다";
    default: return platform ? `알 수 없는 제약(${gap})` : `알 수 없는 제약(${gap})`;
  }
}

/** 사용자가 **직접** 잠자기를 끄는 명령(권한 1회 필요). 데스크톱 앱·CLI 의 '원클릭'이 이걸 실행한다. */
export function forceAwakeCommand(platform: string | null): string {
  if (platform === "darwin") return "sudo pmset -a disablesleep 1";
  if (platform === "win32") return "powercfg /change standby-timeout-ac 0";
  return "";
}

/** 잠자기 억제 상태 한 줄 — "무엇이 걸려 있고 무엇이 안 걸리나". null(구 번들)과 false(못 검)를 구분한다. */
export function keepAwakeLine(keepAwake: KeepAwakeStatus | null | undefined, platform: string | null): string {
  if (!keepAwake) {
    // ⚠ '모름'을 '안 걸림'으로 말하면 안 된다 — 구 번들이라 보고를 안 했을 뿐일 수 있다.
    return "이 노드의 에이전트가 잠자기 억제를 보고하지 않습니다(옛 버전일 수 있습니다 — 노드를 다시 시작하면 자동으로 갱신됩니다).";
  }
  if (!keepAwake.active) {
    const why = keepAwake.reason === "unsupported-platform" ? "이 운영체제는 아직 자동 억제를 지원하지 않습니다"
      : keepAwake.reason === "tool-missing" ? "억제에 쓸 시스템 도구를 찾지 못했습니다"
        : "억제를 시작하지 못했습니다";
    return `잠자기 억제가 걸려 있지 않습니다 — ${why}.`;
  }
  const gaps = (keepAwake.gaps ?? []).map((g) => gapNote(g, platform));
  const tail = gaps.length ? ` 다만 ${gaps.join("이고, ")}.` : "";
  return `라이블리가 전원 연결 상태에서 이 PC 가 자지 않도록 붙잡고 있습니다.${tail}`;
}

/**
 * 노드가 오프라인/불안정할 때 화면·오류에 붙일 설명. 판정이 없으면 null 을 돌려 **아무 말도 하지 않는다**
 *  (모르면 조용한 편이, 근거 없이 원인을 지목하는 것보다 낫다).
 */
export function linkDiagMessage(
  diag: LinkDiagnosis | null | undefined,
  opts: { platform?: string | null; keepAwake?: KeepAwakeStatus | null } = {},
): string | null {
  if (!diag || diag.suspected !== "sleep") return null;
  const platform = opts.platform ?? null;
  const cmd = forceAwakeCommand(platform);
  const evidence = `최근 24시간 동안 ${diag.cycles}번 붙었는데 한 번에 평균 ${humanDur(diag.medianUpSec)}만 연결되고 ${humanDur(diag.medianGapSec)}씩 끊겼습니다`;
  const cause = "이 컴퓨터가 잠자기에 든 것으로 보입니다";
  const fix = platform === "darwin"
    ? `전원을 연결한 채 뚜껑을 열어 두시거나, 그 맥에서 \`${cmd}\` 를 실행하면 잠자기를 끌 수 있습니다.`
    : platform === "win32"
      ? `그 PC 에서 \`${cmd}\` 를 실행하면 전원 연결 시 절전을 끌 수 있습니다.`
      : "그 컴퓨터의 절전 설정을 확인해 주세요.";
  const ka = keepAwakeLine(opts.keepAwake, platform);
  return `${evidence} — ${cause}. ${ka} ${fix}`;
}
