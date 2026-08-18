// 자동 업데이트 정책 (#1541 T6) — **언제 확인할지**의 판단만. Electron·electron-updater 를 안 쓴다(순수).
//
// 왜 갈라놓나: 이 판단이 틀리면 증상이 조용하다 — 개발 중에 GitHub 를 두드리거나(로컬 빌드가 남의 릴리스로
//  덮이려 한다), 서명 안 된 mac 빌드가 매번 실패하며 오류 팝업을 반복하거나(Squirrel.Mac 은 서명을 요구한다),
//  꺼 뒀는데도 계속 확인한다. 전부 "동작은 하는데 이상한" 부류라 로그를 봐야 알 수 있다.
//  그래서 조건을 순수함수로 빼서 표로 못박는다.

/** 앱 자신의 갱신 — 키트 자동 업데이트(#858)와 **다른 축**이다(그건 CLI 가 자기 키트를 갱신하는 것). */
export const UPDATE_OPT_OUT_ENV = "LIVELY_DESKTOP_NO_UPDATE";

/**
 * 지금 업데이트를 확인해도 되나.
 *
 * @param {object} o
 * @param {boolean} o.packaged        app.isPackaged — 개발 실행(electron .)에서는 확인하지 않는다.
 * @param {string}  o.platform
 * @param {boolean} o.hasPublishConfig 빌드에 배포처(publish) 설정이 박혀 있나. 없으면 확인할 곳이 없다.
 * @param {boolean} o.macSigned       mac 은 **서명 없으면 자동 업데이트가 원리적으로 불가**하다(Squirrel.Mac).
 * @param {string}  [o.optOut]        UPDATE_OPT_OUT_ENV 값
 * @param {boolean} [o.failedBefore]  이번 세션에 이미 실패했나 — 반복 팝업을 만들지 않는다.
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldCheckForUpdates(o) {
  const s = o || {};
  if (String(s.optOut || "").trim() && String(s.optOut) !== "0") return { ok: false, reason: "opt-out" };
  if (!s.packaged) return { ok: false, reason: "dev-run" };
  if (!s.hasPublishConfig) return { ok: false, reason: "no-publish-config" };
  if (s.failedBefore) return { ok: false, reason: "failed-before" };
  // ⚠ mac 미서명은 '실패' 가 아니라 **구조적 불가**다. 시도하면 매번 같은 오류가 난다 — 아예 묻지 않는다.
  if (s.platform === "darwin" && !s.macSigned) return { ok: false, reason: "mac-unsigned" };
  return { ok: true, reason: "ok" };
}

/** 재확인 간격 — 너무 잦으면 레이트리밋, 너무 뜸하면 보안 픽스가 안 퍼진다. 6시간. */
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * 왜 확인하지 않(았)나 — **사람에게 보여줄 문구**.
 *
 * 판정(shouldCheckForUpdates)은 reason 을 기계용 토큰으로 돌려준다. 화면에 그 토큰을 그대로 쓰면
 * ("mac-unsigned") 사용자는 고장인지 정책인지 알 수 없다. 특히 '구조적 불가'(미서명 mac)와
 * '지금은 안 함'(개발 실행)은 사람에게 전혀 다른 뜻이라 반드시 갈라 말해야 한다.
 */
export function updateStatusNote(reason) {
  switch (reason) {
    case "ok": return "업데이트를 확인합니다.";
    case "opt-out": return `자동 업데이트가 꺼져 있습니다(${UPDATE_OPT_OUT_ENV}).`;
    case "dev-run": return "개발 실행 중이라 업데이트를 확인하지 않습니다.";
    case "no-publish-config": return "이 빌드에는 업데이트 받을 곳이 없습니다(설치기로 깐 버전이 아닙니다).";
    case "failed-before": return "이번 실행에서 이미 실패해 다시 시도하지 않습니다. 앱을 다시 켜면 재시도합니다.";
    case "mac-unsigned": return "서명되지 않은 빌드라 자동 업데이트를 쓸 수 없습니다. 새 버전은 받아서 덮어써 주세요.";
    default: return "업데이트를 확인하지 않습니다.";
  }
}

/**
 * 사람에게 보여줄 실패 문구 — 자동 업데이트 실패는 **치명이 아니다**(앱은 그대로 쓴다).
 * 그래서 오류 팝업이 아니라 로그·상태 한 줄로 남긴다.
 */
export function updateFailureNote(err) {
  const m = String(err?.message || err || "");
  if (/code signature|not signed|Could not get code signature/i.test(m)) {
    return "자동 업데이트를 쓸 수 없습니다(이 빌드는 서명되지 않았습니다). 새 버전은 수동으로 받아 주세요.";
  }
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|network/i.test(m)) return "업데이트 확인 실패(네트워크). 앱 사용에는 지장 없습니다.";
  return `업데이트 확인 실패: ${m.slice(0, 200)}`;
}

// ── 받은 업데이트를 **언제·어떻게 적용하나** (#1541) ────────────────────────────────────
//
// ★ 실측(2026-08-18, 사용자 Windows · 0.1.320 → 0.1.324): "앱을 두 번 재시작해야 했고, 바로가기가 사라졌다고
//  나왔고, 트레이에서 껐다 켜는 것도 불편하다." 셋 다 **한 원인**이다 — 종전 안내("앱을 다시 켜면 적용됩니다")는
//  electron-updater 의 '종료 시 설치'에 기댔는데, 그 설치기는 사람과 **경쟁**한다:
//   · 앱을 끄면 설치기가 뒤에서 돌기 시작한다(옛 버전 제거 → 새 파일 복사, 수 초~수십 초).
//   · 그 사이 사람이 바로가기를 누르면 파일이 잠깐 없어서 Windows 가 "항목이 이동/삭제됨"을 띄우고(=바로가기 사라짐),
//   · 다시 켜진 앱을 설치기(--updated)가 **묻지 않고 죽인다**(app-builder-lib CHECK_APP_RUNNING: isUpdated 면
//     MessageBox 없이 KILL_PROCESS) — 사용자에겐 '켰는데 또 꺼짐' = 두 번 재시작.
//   · 조용한(/S) 설치는 `--force-run` 이 없으면 앱을 다시 띄우지 않는다 → 사람이 트레이에서 손으로 켠다.
//  → 앱이 **스스로** 끝낸다: quitAndInstall(isSilent=true, isForceRunAfter=true) — 설치기가 앱을 닫고·설치하고·
//    다시 띄운다. 사람은 버튼 하나(또는 아무것도) 누르지 않는다.
//
// 언제 자동으로 할까 — 창이 **안 보일 때만**(트레이 상주 상태). 앱은 노드의 리모컨이라 재시작해도 노드·세션은
//  그대로다(상시성은 OS 데몬이 진다). 창을 보고 있는 사람 앞에서 앱이 사라지면 그건 고장으로 읽히므로, 창이
//  보이면 버튼을 주고 사람이 누른다. CLI 작업 중·질문 대기 중엔 절대 안 한다(작업이 끊긴다).

/** 사람에게 보여줄 '받았다' 문구 — 종전 "다시 켜면 적용" 은 함정이었다(위 머리말). */
export function updateReadyNote(version) {
  const v = String(version || "").trim();
  return `새 버전 ${v ? v + " " : ""}준비됨 — 다시 시작하면 적용됩니다.`;
}

/** 자동 적용까지 기다리는 시간 — 방금 창을 닫은 사람이 곧바로 다시 여는 경우를 흡수한다. */
export const AUTO_APPLY_DELAY_MS = 5_000;

/**
 * 지금 자동으로 적용(재시작)해도 되나 — 순수.
 * @param {object} o
 * @param {boolean} o.ready           받아 둔 업데이트가 있나
 * @param {boolean} o.busy            CLI 작업 중
 * @param {boolean} o.windowVisible   창이 보이나(사람이 보고 있나)
 * @param {number}  [o.promptsPending] 사람의 답을 기다리는 질문 수
 */
export function shouldAutoApplyUpdate(o) {
  const s = o || {};
  if (!s.ready) return false;
  if (s.busy) return false;
  if ((s.promptsPending || 0) > 0) return false;
  if (s.windowVisible) return false;
  return true;
}
