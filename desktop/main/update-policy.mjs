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
 * @returns {{ok:boolean, reason:string}}
 */
export function shouldCheckForUpdates(o) {
  const s = o || {};
  if (String(s.optOut || "").trim() && String(s.optOut) !== "0") return { ok: false, reason: "opt-out" };
  if (!s.packaged) return { ok: false, reason: "dev-run" };
  if (!s.hasPublishConfig) return { ok: false, reason: "no-publish-config" };
  // ⚠ mac 미서명은 '실패' 가 아니라 **구조적 불가**다. 시도하면 매번 같은 오류가 난다 — 아예 묻지 않는다.
  if (s.platform === "darwin" && !s.macSigned) return { ok: false, reason: "mac-unsigned" };
  return { ok: true, reason: "ok" };
}

/** 정상 재확인 간격 — 공개 GitHub 릴리스 메타데이터만 읽으며, 설치기는 새 버전이 있을 때 한 번만 받는다. */
export const UPDATE_INTERVAL_MS = 5 * 60 * 1000;
/** 연속 실패 횟수 1·2·3+ 에 대응하는 재시도 간격. 순간 장애가 영구 중단으로 굳지 않게 하되 오프라인 때 두드리지 않는다. */
export const UPDATE_RETRY_DELAYS_MS = Object.freeze([5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000]);
/** 로그인 시각이 비슷한 PC가 GitHub 를 같은 순간에 두드리지 않도록 다음 예약에 더하는 최대 지터. */
export const UPDATE_CHECK_JITTER_MS = 30_000;

/**
 * 다음 자동 확인까지 기다릴 시간. 정상·첫 실패는 5분, 이후 15분·60분(상한)으로 물러난다.
 * @param {number} consecutiveFailures 연속 실패 횟수
 * @param {number} jitterUnit 테스트 가능한 0~1 난수(Math.random())
 */
export function updateCheckDelayMs(consecutiveFailures = 0, jitterUnit = 0) {
  const failures = Math.max(0, Math.floor(Number(consecutiveFailures) || 0));
  const retryIndex = Math.min(Math.max(0, failures - 1), UPDATE_RETRY_DELAYS_MS.length - 1);
  const base = failures === 0 ? UPDATE_INTERVAL_MS : UPDATE_RETRY_DELAYS_MS[retryIndex];
  const n = Number(jitterUnit);
  const jitter = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
  return base + Math.floor(jitter * UPDATE_CHECK_JITTER_MS);
}

/**
 * 왜 확인하지 않(았)나 — **사람에게 보여줄 문구**.
 *
 * 판정(shouldCheckForUpdates)은 reason 을 기계용 토큰으로 돌려준다. 화면에 그 토큰을 그대로 쓰면
 * ("mac-unsigned") 사용자는 고장인지 정책인지 알 수 없다. 특히 '구조적 불가'(미서명 mac)와
 * '지금은 안 함'(개발 실행)은 사람에게 전혀 다른 뜻이라 반드시 갈라 말해야 한다.
 */
export function updateStatusNote(reason) {
  switch (reason) {
    case "ok": return "업데이트 확인 중…";   // 확인이 끝나면 이벤트가 결과 문구로 덮는다(update-policy 아래 진행률 절)
    case "opt-out": return `자동 업데이트가 꺼져 있습니다(${UPDATE_OPT_OUT_ENV}).`;
    case "dev-run": return "개발 실행 중이라 업데이트를 확인하지 않습니다.";
    case "no-publish-config": return "이 빌드에는 업데이트 받을 곳이 없습니다(설치기로 깐 버전이 아닙니다).";
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

// ── ⚠ mac: '파일을 받았다' 와 '지금 누르면 재시작된다' 는 다른 시점이다 (#2203) ──────────────
// ★ 실측(2026-08-27 원준): "다시 시작하여 반영하기를 사이드바 아래에서 수십 번 눌렀는데 사라지질 않는다."
//  서버도 릴리스도 정상이었다. 맥의 업데이트가 **두 단계**인데 우리가 한 단계로 다뤘던 것이다:
//   ① 우리(electron-updater)가 GitHub 에서 zip 을 받는다 → 여기서 `update-downloaded` 가 온다.
//   ② 애플 설치기(Squirrel.Mac)가 그 zip 을 로컬 프록시로 **다시 통째로 가져간다**(217MB · 수 분).
//  재시작은 ②가 끝나야 된다. 그전에 quitAndInstall 을 부르면 electron-updater(MacUpdater)는
//  `squirrelDownloadedUpdate` 가 false 라 **리스너만 걸고 조용히 리턴한다** — 예외도, 오류 이벤트도 없다.
//  그런데 우리는 ①에서 '준비 완료' 배너를 띄웠으니, 사람은 아무 일도 일어나지 않는 버튼을 몇 분간 계속 누른다.
//  실측 시간축: 배너 노출 → 클릭 → **6분 무반응** → ②완료 → 그제서야 앱이 닫히고 설치·재시작.
//  → 배너는 ②까지 끝난 뒤에 띄운다. 그래야 "뜬 순간 = 누르면 되는 순간" 이 된다.
//  (win·linux 는 ②가 없다 — 받으면 곧바로 적용 가능하다.)

/**
 * 지금 '다시 시작하여 반영' 을 눌러도 되나 — 순수.
 * @param {object} o
 * @param {string|null} o.downloadedVersion 우리가 받아 둔 버전(없으면 아직 받는 중이거나 없음)
 * @param {boolean} o.squirrelReady        mac 설치기가 그 파일을 넘겨받았나(mac 외에는 무의미)
 * @param {string}  o.platform
 */
export function updateApplyReady(o) {
  const s = o || {};
  if (!String(s.downloadedVersion || "").trim()) return false;
  if (s.platform === "darwin") return !!s.squirrelReady;
  return true;
}

/**
 * ①은 끝났고 ②가 도는 동안의 문구 — **사람이 할 일이 없는 구간**이라 배너는 안 띄우지만,
 *  트레이·마법사는 "받다 만 게 아니라 마무리 중" 임을 말해야 한다(침묵하면 그게 곧 고장으로 읽힌다).
 */
export function updateStagingNote(version) {
  const v = String(version || "").trim();
  return `새 버전 ${v ? v + " " : ""}설치 준비 중… (맥은 설치기가 파일을 넘겨받는 데 몇 분 걸립니다.)`;
}

/** ②가 끝나기 전에 누른 사람에게 — '실패' 가 아니라 '아직' 이라고 말한다(다시 눌러도 소용없다는 뜻까지). */
export function updateNotStagedNote(version) {
  const v = String(version || "").trim();
  return `새 버전 ${v ? v + " " : ""}설치 준비가 아직 끝나지 않았습니다. 끝나면 이 자리에서 바로 반영할 수 있습니다.`;
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

// ── 메인 화면(웹 UI)에 알리기 (#1838) ────────────────────────────────────────────────
// ★ 실측(2026-08-20 상민님): "트레이에서 설치 노드 설정 들어가서 업데이트 확인을 눌러야 되는데, 유저가 명시적으로
//  업데이트해야 하는 게 너무 복잡하고 현실성 낮다." — 받기는 이미 자동이었다(6시간마다 확인 + autoDownload).
//  빠진 것은 **알리는 자리**였다: 받아 둔 업데이트의 입구가 트레이와 마법사뿐이라, 라이블리 화면을 띄워 두고
//  일하는 사람에게는 아무 신호도 가지 않았다. 게다가 창이 보이는 동안엔 자동 적용을 하지 않으므로
//  (shouldAutoApplyUpdate — 창 앞에서 앱이 사라지면 고장으로 읽힌다) 업데이트는 그 창이 닫힐 때까지 앉아 있었다.
//  → 웹 UI 에 같은 사실을 그대로 넘겨, 사람이 보고 있는 화면에서 "준비됐습니다 · 다시 시작하여 반영하기" 를 준다.

/**
 * 웹 UI 에 넘기는 업데이트 상태 — **세 값뿐**(순수).
 *  version 은 준비됐을 때만 채운다: 받는 중인 버전을 흘리면 화면이 '준비됨' 으로 앞서 말하게 된다.
 *  busy 는 '지금은 못 누른다'(CLI 작업 중 — applyUpdate 가 거절한다)를 화면이 미리 알기 위한 것이다.
 * @param {{ready?:any, version?:any, busy?:any}} o
 * @returns {{ready:boolean, version:string, busy:boolean}}
 */
export function webUpdateState(o) {
  const s = o || {};
  const ready = !!s.ready;
  return { ready, version: ready ? String(s.version || "").trim() : "", busy: !!s.busy };
}

// ── 받는 동안의 문구 — "확인합니다"에 멈춰 보이던 자리 (#1541) ──────────────────────────
// ★ 실측(2026-08-18, 사용자 Windows 0.1.324): "업데이트 확인 누르면 '확인 중…' 잠깐 뜨다가 '업데이트를 확인합니다.'
//  가 뜨고, 5번 눌러 3분을 기다려도 그대로." — 확인은 1초 만에 끝났고 그 뒤 **100MB 설치기를 받는 중**이었다.
//  진행률 이벤트를 안 받아 화면이 그 사실을 말하지 못했다(사람은 '확인이 오래 걸린다'고 읽는다).
//  같은 CDN 에서 이 맥은 8초, 그 PC 는 3분+ — 회선에 따라 다르므로 **속도와 남은 양**을 보여줘야 사람이 판단한다.

const mb = (n) => (Number(n || 0) / 1048576).toFixed(1);

/**
 * download-progress 이벤트 → 사람용 한 줄. electron-updater 페이로드 { percent, transferred, total, bytesPerSecond }.
 * 필드가 비어도(초기 이벤트·구버전) 크래시하지 않고 아는 만큼만 적는다.
 */
export function downloadProgressNote(version, p) {
  const v = String(version || "").trim();
  const i = p || {};
  const pct = Number.isFinite(i.percent) ? `${Math.max(0, Math.min(100, Math.floor(i.percent)))}%` : "";
  const size = Number.isFinite(i.total) && i.total > 0 ? `${mb(i.transferred)}/${mb(i.total)}MB` : "";
  const speed = Number.isFinite(i.bytesPerSecond) && i.bytesPerSecond > 0 ? `${mb(i.bytesPerSecond)}MB/s` : "";
  const parts = [pct, size, speed].filter(Boolean).join(" · ");
  return `새 버전 ${v ? v + " " : ""}받는 중…${parts ? " " + parts : ""}`;
}

/** 진행률 화면 갱신 최소 간격 — 이벤트는 초당 수십 번 온다. 트레이·렌더러를 그 속도로 다시 그리지 않는다. */
export const PROGRESS_NOTE_MIN_MS = 500;
