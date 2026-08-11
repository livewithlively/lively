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
