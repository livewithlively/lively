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

/**
 * 자동으로 못 막는 구멍 → 사람이 읽는 **완결 문장**.
 *  ⚠ 절(어미 없는 조각)로 두고 접속사로 이으면 개수·순서에 따라 문장이 깨진다 — e2e 에서 실제로
 *   "…막을 수 없습니다이고, …" 가 나왔다. 조각을 잇지 말고 **문장을 나열**한다(조직 규칙: 어미까지 끝맺는다).
 */
export function gapNote(gap: KeepAwakeGap, _platform: string | null): string {
  switch (gap) {
    case "clamshell": return "뚜껑을 닫으면 잠자기를 막을 수 없습니다.";
    case "battery":   return "배터리로 쓰는 동안에는 배터리 보호를 위해 막지 않습니다.";
    case "modern-standby": return "이 PC 가 최신 대기(modern standby) 방식이면 막히지 않을 수 있습니다.";
    default: return `알 수 없는 제약(${gap})이 있습니다.`;
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
  const tail = gaps.length ? ` 다만 ${gaps.join(" ")}` : "";
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
  if (!diag) return null;
  // #2127 — 짧게 붙고 짧게 끊긴다. **공백이 짧으니 그 컴퓨터는 깨어 있었다** — 잠자기 안내(전원·뚜껑·powercfg)를
  //  여기에 내면 정확히 반대 방향으로 사람을 보낸다. 다만 원인은 하나가 아니다(노드 프로그램 재기동 / 네트워크
  //  플랩) 하고 타이밍만으로는 못 가른다 — 그래서 **둘 다 말하고**, 어느 쪽이든 해로울 것 없는 조치를 먼저 준다.
  if (diag.suspected === "churn") {
    return `최근 24시간 동안 ${diag.cycles}번 붙었는데 한 번에 평균 ${humanDur(diag.medianUpSec)}만 연결되고 ${humanDur(diag.medianGapSec)}씩 끊겼습니다`
      + " — 공백이 짧아 이 컴퓨터가 잔 것은 아닙니다. 노드 프로그램이 죽고 다시 뜨는 중이거나, 네트워크가 자주 끊기는 것으로 보입니다."
      + " 먼저 그 PC 에서 `lively node --daemon` 을 다시 실행해 주세요(멱등 — 낡은 인스턴스를 회수하고 새로 띄웁니다)."
      + " 그래도 같으면 그 PC 의 네트워크(VPN·무선)를 확인해 주세요.";
  }
  if (diag.suspected !== "sleep") return null;
  const platform = opts.platform ?? null;
  const cmd = forceAwakeCommand(platform);
  const evidence = `최근 24시간 동안 ${diag.cycles}번 붙었는데 한 번에 평균 ${humanDur(diag.medianUpSec)}만 연결되고 ${humanDur(diag.medianGapSec)}씩 끊겼습니다`;
  const cause = "이 컴퓨터가 잠자기에 든 것으로 보입니다";
  const fix = platform === "darwin"
    // ⚠ 명령 뒤에 조사를 바로 붙이지 않는다 — 명령이 숫자·영문으로 끝나 조사가 어색해진다(e2e 실측: "…1 를").
    ? `전원을 연결한 채 뚜껑을 열어 두시거나, 그 맥에서 \`${cmd}\` 명령을 실행하면 잠자기를 끌 수 있습니다.`
    : platform === "win32"
      ? `그 PC 에서 \`${cmd}\` 명령을 실행하면 전원 연결 시 절전을 끌 수 있습니다.`
      : "그 컴퓨터의 절전 설정을 확인해 주세요.";
  const ka = keepAwakeLine(opts.keepAwake, platform);
  return `${evidence} — ${cause}. ${ka} ${fix}`;
}

/**
 * 같은 판정의 **한 줄 요약** — 목록처럼 폭이 좁은 자리를 위한 것.
 *  ⚠ 화면 실측(프리뷰, 2026-08-23): 전문을 행 안에 넣었더니 좁은 열에 갇혀 한 줄에 서너 글자씩
 *   세로로 흘렀다. 폭을 CSS 로 억지로 넓히는 대신, **자리에 맞는 길이를 서버가 함께 준다**
 *   (문구 출처를 하나로 두는 원칙은 그대로 — 웹이 전문을 잘라 쓰면 문장이 중간에서 끊긴다).
 */
export function linkDiagSummary(diag: LinkDiagnosis | null | undefined): string | null {
  if (!diag) return null;
  const evidence = `평균 ${humanDur(diag.medianUpSec)} 연결되고 ${humanDur(diag.medianGapSec)}씩 끊깁니다`;
  if (diag.suspected === "churn") return `${evidence} — 잠자기는 아닙니다(재기동·네트워크).`;
  if (diag.suspected !== "sleep") return null;
  return `${evidence} — 잠자기로 보입니다.`;
}

/**
 * 🔴 #2127·#2128 — **온라인인데 이 노드가 잠자기 억제 상태를 한 번도 보고한 적이 없다.**
 *
 * 최신 번들의 `startKeepAwake` 는 실패해도 **반드시 객체를 돌려주고**(active:false + reason), hello 가 그걸 싣는다.
 *  저장은 COALESCE 라 한 번이라도 받았으면 값이 남는다. 그러므로 온라인 노드의 `keep_awake` 가 비어 있다는 것은
 *  **그 PC 에서 도는 인스턴스가 현행 규약대로 hello 를 못 하고 있다**는 뜻이다 — 낡은 번들이거나, 낡은 감시자
 *  프로세스가 옛 환경으로 계속 자식을 띄우고 있거나(윈도우 `.cmd` 런처 루프), hello 전에 죽고 있거나.
 *
 * 왜 굳이 말하나: 실측(hammurabi, 2026-08-26)에서 이 상태가 **며칠간 아무 신호 없이** 지속됐고, 그 동안
 *  하네스 검출이 통째로 실패해(claude 가 도는데 `['shell']` 로 보고) 웹 피커와 위탁이 그 노드를 배제했다.
 *  `agent_ver` 은 최신으로 보였다 — 그래서 '버전' 축으로는 절대 안 잡힌다. 이 값이 유일한 지문이다.
 *
 * ⚠ 원인을 단정하지 않는다(이 모듈의 원칙). 다만 **조치는 어느 원인이든 같다** — 재등록 한 번.
 */
export function staleAgentNote(o: {
  online: boolean;
  keepAwake?: KeepAwakeStatus | null;
  /** 서빙 번들과 같은가 — true 면 '버전은 최신인데 보고를 못 한다'라 더 강한 신호다. null=판정 불가. */
  agentLatest?: boolean | null;
}): string | null {
  if (!o.online) return null;        // 꺼진 노드는 다른 축이다 — 보고가 없는 게 당연하다
  if (o.keepAwake) return null;      // 받은 적이 있다 = 현행 규약대로 말하고 있다
  const head = o.agentLatest === true
    ? "이 노드는 프로그램 버전은 최신인데, 잠자기 억제 상태를 한 번도 보고하지 않았습니다"
    : "이 노드가 잠자기 억제 상태를 한 번도 보고하지 않았습니다";
  return `${head} — 그 PC 에서 도는 노드 프로그램이 낡은 채로 굳어 있을 수 있습니다.`
    + " 이 상태에서는 그 PC 에 깔린 AI 를 못 찾아 세션 목록·위탁에서 빠질 수 있습니다."
    + " 그 PC 에서 `lively node --daemon` 을 다시 실행해 주세요(멱등 — 옛 인스턴스를 회수하고 새로 띄웁니다).";
}
