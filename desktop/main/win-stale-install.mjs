// Windows — **다른 자리에 남은 옛 설치본** 감지·정리 (#1541).
//
// ★ 실측(2026-08-18, 사용자 Windows): "라이블리 바로가기로 열면 0.1.325 를 설치한 뒤에도 0.1.320 이 열린다."
//  0.1.320 설치기(assisted)는 "모든 사용자/현재 사용자" 를 물었고 사용자는 '모든 사용자'(Program Files, HKLM)를 골랐다.
//  0.1.321 부터 설치기는 원클릭·**현재 사용자**(%LOCALAPPDATA%\Programs, HKCU)라, 자동 업데이트는 새 자리에 깔린다 —
//  그런데 사용자 단위 설치기는 HKLM 의 옛 설치본을 **건드릴 수 없다**(권한상승 없이는 못 지운다. app-builder-lib
//  installSection.nsh: 사용자 모드면 uninstallOldVersion 은 SHELL_CONTEXT=HKCU 만 본다). 결과:
//   · 바탕화면(공용)·시작 메뉴(모든 사용자)의 옛 바로가기 → 옛 exe 를 연다  ← 사용자가 본 것
//   · 로그인 시 자동 시작(Run 키)은 마지막으로 그걸 켠 exe 경로 → 옛 exe
//   · 설정 ▸ 앱 에 Lively 가 둘
//  새 앱이 떠 있을 땐 옛 바로가기가 단일 인스턴스 락에 걸려 새 앱 창을 띄우지만(second-instance), 새 앱을 끈 상태에서
//  누르면 옛 앱이 뜬다. **뿌리(옛 설치본)를 지워야** 끝난다 — 그리고 그건 관리자 권한(UAC 1회)이 필요하다.
//
// 그래서 앱이 (1) 옛 설치본을 **감지**해 알리고, (2) 사람이 누르면 옛 언인스톨러를 권한상승으로 조용히 돌린 뒤
//  자기 자신을 다시 띄우고(옛 언인스톨러의 CHECK_APP_RUNNING 이 **같은 이름의 우리 프로세스도 죽인다** — 그래서
//  PowerShell 이 밖에서 기다렸다가 다시 띄운다), (3) 바탕화면 바로가기·로그인 자동시작을 새 exe 로 잇는다.
//
// ⚠ 순수함수로 뺀다(#1510 §5): 이 분기는 mac/linux CI 에서 한 번도 돌지 않는다. 판정·스크립트 조립을 여기서
//  표로 못박는다. 실행(spawn)은 main.mjs 가 한다.

import { createHash } from "node:crypto";

/** 앱 식별자 — desktop/package.json build.appId 와 같아야 한다(테스트가 못박는다). 설치기의 레지스트리 키 이름이 여기서 나온다. */
export const APP_ID = "io.lvly.desktop";
/** electron-builder 가 NSIS GUID 를 만들 때 쓰는 네임스페이스(app-builder-lib NsisTarget ELECTRON_BUILDER_NS_UUID). */
// ⚠ 끝 6바이트를 틀리게 옮겨 적어(…360a5f6d0d1a) GUID 가 통째로 달랐던 적이 있다(실기기 레지스트리로 발각 —
//  감지는 언인스톨러 파일명 폴백이 살렸다). 값은 app-builder-lib NsisTarget.js 의 상수 그대로이며, 테스트가
//  그 파일에서 **직접 읽어** 대조한다(다시는 옮겨 적은 값이 정본 행세를 못 하게).
const ELECTRON_BUILDER_NS_UUID = "50e065bc-3134-11e6-9bab-38c9862bdaf3";
/** 언인스톨러 파일명 — app-builder-lib common.nsh `UNINSTALL_FILENAME "Uninstall ${PRODUCT_FILENAME}.exe"`. */
export const UNINSTALLER_NAME = "Uninstall Lively.exe";

/** RFC 4122 UUID v5 — electron-builder 가 `nsis.guid` 미지정 시 `UUID.v5(appId, NS)` 로 만드는 값과 같다(테스트가 builder-util-runtime 과 대조). */
export function uuidV5(name, nsUuid) {
  const ns = Buffer.from(String(nsUuid).replace(/-/g, ""), "hex");
  const h = createHash("sha1").update(Buffer.concat([ns, Buffer.from(String(name), "utf8")])).digest();
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20, 32)}`;
}
/** 우리 설치본의 Uninstall 레지스트리 키 이름 — per-user(HKCU)·per-machine(HKLM) 둘 다 이 GUID 아래 등록된다. */
export const APP_GUID = uuidV5(APP_ID, ELECTRON_BUILDER_NS_UUID);

/**
 * 감지 쿼리 — PowerShell. Uninstall 키 네 자리(HKLM/HKCU × 네이티브/WOW6432Node)에서 **우리 GUID 키**이거나
 *  DisplayName 이 `Lively…` 인 항목을 JSON 배열로 낸다(좁히는 판정은 JS pickStaleInstalls 가 한 번 더 한다).
 *  ⚠ DisplayName 은 `${productName} ${version}`("Lively 0.1.320")이다 — `-eq 'Lively'` 로 걸면 **전부 놓친다**
 *   (v0.1.326 에서 실제로 그랬다: 실측 화면에 카드가 안 떴다). 이름 대신 GUID 키가 정본이다.
 *  보간은 APP_GUID 하나뿐이고 그건 hex/하이픈 상수다(아래 정규식으로 못박음). ConvertTo-Json 은 원소가 하나면 배열이
 *  아니라 객체를 낸다 → `@(...)` 로 감싼다(parse 가 둘 다 받는다).
 */
if (!/^[0-9a-f-]{36}$/.test(APP_GUID)) throw new Error(`APP_GUID 형식 이상: ${APP_GUID}`);
export const STALE_QUERY_PS = [
  "$ErrorActionPreference='SilentlyContinue'",
  "$keys=@('HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*')",
  `$rows=@(Get-ItemProperty $keys | Where-Object { $_.PSChildName -eq '${APP_GUID}' -or $_.DisplayName -like 'Lively*' } | ForEach-Object { [pscustomobject]@{ key=$_.PSChildName; hive=($_.PSPath -replace '^.*::(HK[A-Z_]+).*$','$1'); name=$_.DisplayName; version=$_.DisplayVersion; location=$_.InstallLocation; uninstall=$_.UninstallString; quiet=$_.QuietUninstallString } })`,
  "[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)",
  "ConvertTo-Json -Compress -Depth 3 @($rows)",
].join("; ");

/** 쿼리 출력 → 항목 배열. BOM·빈 출력·단일 객체 출력 전부 흡수한다(못 읽으면 [] — 감지 실패는 '없음'과 같게 다룬다). */
export function parseStaleQuery(text) {
  const t = String(text || "").replace(/^\uFEFF/, "").trim();
  if (!t) return [];
  let v;
  try { v = JSON.parse(t); } catch { return []; }
  const arr = Array.isArray(v) ? v : (v && typeof v === "object" ? [v] : []);
  return arr.filter((e) => e && typeof e === "object").map((e) => ({
    key: String(e.key || ""),
    name: String(e.name || ""),
    hive: String(e.hive || ""),
    version: String(e.version || ""),
    location: String(e.location || ""),
    uninstall: String(e.uninstall || ""),
    quiet: String(e.quiet || ""),
  }));
}

/** 경로 비교용 정규화 — 대소문자·구분자·끝 슬래시를 무시한다. */
const normDir = (p) => String(p || "").replace(/\//g, "\\").replace(/[\\]+$/, "").toLowerCase();

/** UninstallString 에서 실행파일 경로만 — `"C:\…\Uninstall Lively.exe" /currentuser` 꼴이 흔하다. */
export function uninstallerPath(uninstallString) {
  const s = String(uninstallString || "").trim();
  if (!s) return "";
  const q = /^"([^"]+)"/.exec(s);
  if (q) return q[1];
  const m = /^(.+?\.exe)(\s|$)/i.exec(s);
  return m ? m[1] : s;
}

/** UninstallString 의 실행파일 **뒤** 인자들 — 옛 설치기가 등록한 `/allusers` 같은 모드 토큰을 그대로 넘겨야 같은 컨텍스트로 지운다. */
export function uninstallerArgs(uninstallString) {
  const s = String(uninstallString || "").trim();
  const rest = /^"[^"]+"\s*(.*)$/.exec(s)?.[1] ?? /^.+?\.exe\s+(.*)$/i.exec(s)?.[1] ?? "";
  return rest.split(/\s+/).filter(Boolean);
}

/**
 * **우리와 다른 자리**에 깔린 항목만 = 옛 설치본. 같은 자리(우리 자신의 등록)는 제외한다.
 * @param {ReturnType<typeof parseStaleQuery>} entries
 * @param {string} ownExe  process.execPath
 */
export function pickStaleInstalls(entries, ownExe) {
  const own = normDir(String(ownExe || "").replace(/[\\/][^\\/]+$/, ""));   // exe 의 디렉터리
  const out = [];
  for (const e of entries || []) {
    const uninst = uninstallerPath(e.quiet || e.uninstall);
    if (!uninst) continue;                                                // 지울 수단이 없으면 감지해도 할 게 없다
    // **우리 제품**인가 — GUID 키(정본) 또는 언인스톨러 파일명. "Lively Wallpaper" 같은 남의 제품이 이름으로 걸려도 여기서 걸러진다.
    const ours = String(e.key || "").toLowerCase() === APP_GUID
      || String(uninst).replace(/^.*[\\/]/, "").toLowerCase() === UNINSTALLER_NAME.toLowerCase();
    if (!ours) continue;
    const loc = normDir(e.location || uninst.replace(/[\\/][^\\/]+$/, ""));
    if (!loc || loc === own) continue;
    out.push({ ...e, uninstaller: uninst, uninstallArgs: uninstallerArgs(e.quiet || e.uninstall), location: e.location || uninst.replace(/[\\/][^\\/]+$/, "") });
  }
  return out;
}

/** PowerShell 단일따옴표 리터럴 — 값은 레지스트리에서 온다. 여기 말고는 이스케이프할 자리가 없다. */
export const psQuote = (s) => "'" + String(s ?? "").replace(/'/g, "''") + "'";

/**
 * 정리 스크립트(PowerShell). 앱 **밖**에서 돈다 — 옛 언인스톨러가 우리(같은 exe 이름)를 죽이므로 기다렸다 다시 띄운다.
 *  · 권한상승(RunAs) 1회 — HKLM 설치본은 관리자만 지운다. 사람이 UAC 를 거절하면 그냥 넘어가고 앱을 다시 띄운다.
 *  · /S 조용히. --updated 를 주지 않는다 = 옛 바로가기까지 지운다(그게 목적). 앱 데이터는 기본적으로 남는다.
 * @param {{stale:Array<{uninstaller:string, uninstallArgs?:string[]}>, ownExe:string}} o
 */
export function staleCleanupPs(o) {
  // 이 스크립트는 **보이는 콘솔**에서 돈다(main.mjs 가 창 없이 띄우지 않는다) — 숨김 프로세스가 요청한 승격은
  //  Windows 가 작업 표시줄에 최소화해 두고 사람이 누를 때까지 화면을 안 덮는다(실기기: 사용자가 5분 뒤에야 발견).
  //  보이는 콘솔이 포그라운드를 가지면 승격 창이 즉시 보안 데스크톱으로 뜬다.
  const lines = [
    "$ErrorActionPreference='Continue'",
    "Write-Host '라이블리 이전 버전 제거 — 화면이 어두워지며 관리자 확인 창이 뜹니다. 안 보이면 작업 표시줄의 방패 아이콘을 누르세요.'",
  ];
  for (const e of o.stale || []) {
    // /S 가 먼저, 그 뒤에 등록돼 있던 모드 토큰(/allusers 등). 각 인자는 PS 리터럴로 — 값은 레지스트리에서 왔다.
    const args = ["/S", ...(e.uninstallArgs || []).filter((a) => a !== "/S")].map(psQuote).join(",");
    lines.push(`try { Start-Process -Verb RunAs -Wait -FilePath ${psQuote(e.uninstaller)} -ArgumentList @(${args}) } catch { }`);
  }
  lines.push("Start-Sleep -Seconds 2");
  lines.push(`Start-Process -FilePath ${psQuote(o.ownExe)}`);
  return lines.join("\n");
}

/** 사람에게 보여줄 한 줄. */
export function staleInstallNote(stale) {
  const s = stale || [];
  if (!s.length) return "";
  const v = s.map((e) => e.version).filter(Boolean).join(", ");
  return `이전 버전${v ? " " + v : ""}이 다른 자리에 남아 있습니다 — 옛 바로가기와 로그인 자동 시작이 그걸 엽니다. 정리하면 옛 버전을 지우고 바로가기를 이 버전으로 잇습니다(관리자 확인 1회).`;
}
