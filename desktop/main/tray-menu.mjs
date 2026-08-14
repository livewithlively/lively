// 트레이 메뉴 모델 (#1541 T2) — **상태 → 메뉴 항목**의 순수 변환. Electron 의 Menu 는 이 모델을 그리기만 한다.
//
// 왜 갈라놓나: 트레이는 이 앱의 주 표면이다(창은 닫혀 있는 게 기본). 그런데 Electron 메뉴는 띄우지 않으면
//  검증할 수 없어서, 로직이 그 안에 있으면 "노드가 도는데 '노드 시작' 이 보인다" 같은 결함이 조용히 남는다.
//
// ⚠ 이 앱은 **상시성의 주체가 아니다.** 노드를 살려 두는 건 OS 데몬(launchd·systemd·작업 스케줄러)이고
//  앱은 그 데몬을 켜고 끄는 리모컨이다 — 그래서 '앱 종료' 가 노드를 끄지 않는다는 걸 메뉴가 말해 준다.

/** 상태 뱃지 문구 — 사람이 한 줄로 이해하는 축은 '노드가 지금 도는가' 다. */
export function statusLabel(st) {
  const s = st || {};
  if (!s.cliFound) return "라이블리 CLI 없음";
  // ⚠ '있다'와 '쓸 수 있다'는 다르다. 앱보다 먼저 깔아 둔 구 CLI 는 `--json-events` 를 조용히 무시해
  //  앱이 아무 말도 못 듣는다 — 그걸 '설치 완료' 로 그리면 화면이 거짓말을 한다.
  if (s.cliOutdated) return "라이블리 CLI 업데이트 필요";
  // 못 띄우는 CLI 는 **없는 것보다 나쁘다** — 있는 줄 알고 화면이 아무 말도 안 하게 된다.
  if (s.cliBroken) return "라이블리 CLI 를 실행할 수 없음";
  if (!s.loggedIn) return "로그인 필요";
  if (!s.kitInstalled) return "키트 설치 필요";
  if (s.nodeRunning) return s.nodeDaemon ? "노드 실행 중 (자동 시작 켜짐)" : "노드 실행 중 (이 세션만)";
  return s.nodeRegistered ? "노드 정지됨" : "노드 미등록";
}

/** 버전 한 줄 — 앱과 키트를 **따로** 적는다(갱신 주기가 다르다). 못 읽은 축은 '알 수 없음'으로 남긴다. */
export function versionLabel(st) {
  const s = st || {};
  const kit = s.kitVersion ? `키트 ${s.kitVersion}` : "키트 미설치";
  return `앱 ${s.appVersion || "알 수 없음"} · ${kit}`;
}

/**
 * 트레이 메뉴 항목 모델. `{id, label, enabled, type?, checked?}`.
 * 실행 중(busy)이면 상태를 바꾸는 항목을 전부 잠근다 — 설치 도중 '노드 시작' 을 누르면 CLI 두 개가 겹친다.
 */
export function trayMenuModel(st) {
  const s = st || {};
  const busy = !!s.busy;
  const items = [{ id: "status", label: statusLabel(s), enabled: false }, { type: "separator" }];

  if (!s.cliFound || s.cliOutdated || s.cliBroken || !s.loggedIn || !s.kitInstalled) {
    items.push({
      id: "setup",
      // 문구가 곧 진단이다 — '오래됨'과 '못 띄움'은 사람이 할 일이 다르다(전자는 갱신, 후자는 재설치).
      label: s.cliBroken ? "라이블리 다시 설치…"
        : s.cliOutdated ? "라이블리 업데이트…"
          : s.cliFound ? "설치 계속하기…" : "라이블리 설치…",
      enabled: !busy,
    });
  } else if (s.nodeRunning) {
    items.push({ id: "node-stop", label: "노드 정지", enabled: !busy });
  } else {
    items.push({ id: "node-start", label: "노드 시작", enabled: !busy });
  }
  // 자동 시작은 **노드가 등록된 뒤에만** 의미가 있다(등록 전엔 켤 대상이 없다).
  items.push({ id: "node-autostart", label: "노드를 PC 켤 때 자동 시작", type: "checkbox", checked: !!s.nodeDaemon, enabled: !busy && !!s.nodeRegistered });
  // ⚠ 위와 **다른 축**이다. 노드는 OS 데몬이 살리므로 앱이 없어도 돈다 — 이건 리모컨(앱)을 띄울지다.
  //  Linux 는 Electron 이 로그인 항목을 지원하지 않는다 → null 이면 항목 자체를 안 보여준다(있는 척 금지).
  if (s.appAutoLaunch !== null && s.appAutoLaunch !== undefined) {
    items.push({ id: "app-autolaunch", label: "이 앱도 로그인할 때 시작", type: "checkbox", checked: !!s.appAutoLaunch, enabled: !busy });
  }
  items.push({ type: "separator" });
  items.push({ id: "open", label: "창 열기" });
  items.push({ id: "open-web", label: "웹에서 보기", enabled: !!s.gatewayUrl });
  items.push({ id: "logs", label: "로그 폴더 열기" });
  items.push({ type: "separator" });
  // 버전은 **누를 수 없는 정보 항목**이다 — 제보할 때 가장 먼저 묻는 값인데 어디에도 안 보였다.
  //  앱과 키트는 갱신 주기가 달라 따로 적는다(하나로 합치면 어느 쪽이 낡았는지 못 가린다).
  items.push({ id: "version", label: versionLabel(s), enabled: false });
  items.push({ type: "separator" });
  // 문구가 곧 계약이다 — 앱을 꺼도 노드는 산다(상시성은 OS 데몬이 갖는다).
  items.push({ id: "quit", label: s.nodeDaemon ? "앱 종료 (노드는 계속 실행)" : "앱 종료" });
  return items;
}
