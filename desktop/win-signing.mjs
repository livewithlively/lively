// 윈도우 코드서명 — Azure Artifact Signing(구 Trusted Signing) 설정과 서명 게이트 (#3940 · #4066).
//
//   node win-signing.mjs configure             빌드 직전: 서명 자격(AZURE_*)이 있을 때만 package.json 에 win.azureSignOptions 를 끼운다
//                                              (서명 없는 Electron DLL 이름도 win.signExts 에 함께 끼운다 — #4066)
//   node win-signing.mjs verify                빌드 직후: 서명이 유효한지 + 설치된 앱이 다음 업데이트를 받아들이는지 +
//                                              앱 폴더의 PE 파일이 **전부** 서명됐는지 본다
//   node win-signing.mjs verify-files <exe…>   따로 서명한 파일(설치 도우미)이 우리 서명·타임스탬프를 갖췄는지 본다
//
// ── 왜 package.json 에 박지 않나 ───────────────────────────────────────────────────────────────
//  azureSignOptions 가 있으면 electron-builder 는 반드시 Azure 로 서명하려 든다(winPackager: azureSignOptions != null →
//  WindowsSignAzureManager). 박아 두면 자격 없는 빌드 — 포크·커뮤니티·로컬 `npm run dist:win` — 가 서명 단계에서 죽는다.
//  계약은 mac 과 같다: 자격이 없으면 무서명으로 그냥 빌드한다.
//
// ── 왜 서명을 «두 번» 보나 ─────────────────────────────────────────────────────────────────────
//  ① 유효: 설치기·앱 exe 의 Authenticode 가 Valid 이고 **타임스탬프**가 있어야 한다. Artifact Signing 인증서는 유효기간이
//     3일이라 타임스탬프 없는 서명은 사흘 뒤 무효가 된다(Microsoft Learn «Set up signing integrations»).
//  ② 업데이트 수락: 서명판부터 resources/app-update.yml 에 publisherName 이 박히고(app-builder-lib PublishManager),
//     설치된 앱의 electron-updater 는 **다음** 업데이트 설치기의 서명자를 그 이름과 대조한다(NsisUpdater.verifySignature).
//     비어 있으면 검사가 조용히 꺼지고, 틀리면 첫 서명판을 깐 사용자는 그 뒤 업데이트를 영영 못 받는다(되돌릴 길은 수동
//     재설치뿐). 우리 CN 은 한글(라이블리)이라 PowerShell 출력 코드페이지에서 깨질 여지까지 있다 — 그래서 대조를 흉내 내지
//     않고 **electron-updater 의 그 함수를 러너에서 그대로** 부른다.
//  (지금 깔린 무서명 앱은 publisherName 이 없어 검사 없이 첫 서명판으로 넘어간다 — electron-updater 6.8.9 NsisUpdater.js:84-99.)
//
// ⚠ 순수함수로 뺀다(#1510 §5) — 규칙은 desktop-core.test.mjs Z7 에서 플랫폼 무관하게 못박는다. 루트·윈도우 테스트 잡은
//  desktop 의존성을 설치하지 않으므로 최상위 import 는 node 내장만 쓴다(electron-updater·js-yaml 은 verify 에서만 부른다).
import { execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readdirSync, readFileSync, readSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** 서비스 주체 자격(env) — 셋이 **모두** 있거나 모두 없어야 한다. */
export const CREDENTIAL_ENV = Object.freeze(["AZURE_TENANT_ID", "AZURE_CLIENT_ID", "AZURE_CLIENT_SECRET"]);

/** 서명 대상 설정(env, 비밀 아님) → electron-builder `win.azureSignOptions` 필드. */
export const SIGN_ENV = Object.freeze({
  WIN_SIGN_ENDPOINT: "endpoint",
  WIN_SIGN_ACCOUNT: "codeSigningAccountName",
  WIN_SIGN_PROFILE: "certificateProfileName",
  WIN_SIGN_PUBLISHER: "publisherName",
});

// GitHub Actions 는 없는 시크릿을 **빈 문자열**로 넘긴다(unset 이 아니다) — 빈 값·공백은 «없음» 이다.
const present = (v) => typeof v === "string" && v.trim() !== "";

/**
 * 자격이 있으면 `win.azureSignOptions` 를 끼운 **새** package.json 객체, 없으면 null(무서명 빌드).
 *  자격이 일부만 있거나 서명 대상 설정이 빠졌으면 던진다 — 조용히 무서명으로 나가거나, 이름 없는 서명판이 나가면 안 된다.
 *  값은 바꾸지 않는다(정규화·공백 정리 없음): 게시자 이름은 인증서 주체와 한 글자도 달라선 안 된다.
 * @param {any} pkg  package.json 내용 — 변경하지 않는다
 * @param {Record<string, string | undefined>} env
 */
export function withAzureSigning(pkg, env) {
  const missingCred = CREDENTIAL_ENV.filter((k) => !present(env[k]));
  if (missingCred.length === CREDENTIAL_ENV.length) return null;
  if (missingCred.length) throw new Error(`서명 자격이 일부만 있다(없음: ${missingCred.join(", ")}) — 셋 다 넣거나 셋 다 빼야 한다`);
  const missingSign = Object.keys(SIGN_ENV).filter((k) => !present(env[k]));
  if (missingSign.length) throw new Error(`서명 자격은 있는데 서명 대상 설정이 없다: ${missingSign.join(", ")}`);
  const azureSignOptions = {};
  for (const [k, field] of Object.entries(SIGN_ENV)) azureSignOptions[field] = env[k];
  // signtoolOptions 와 같이 쓰지 않는다(electron-builder 스키마: «Cannot be used in conjunction»).
  const { signtoolOptions: _legacy, ...win } = (pkg.build && pkg.build.win) || {};
  return { ...pkg, build: { ...pkg.build, win: { ...win, azureSignOptions } } };
}

/**
 * `Get-AuthenticodeSignature` 요약의 문제 목록 — 비면 통과.
 * @param {{ Status?: string, StatusMessage?: string, Timestamped?: boolean } | null | undefined} report
 */
export function signatureProblems(report) {
  if (!report) return ["서명 정보를 읽지 못했다"];
  const problems = [];
  if (report.Status !== "Valid") {
    problems.push(`서명이 유효하지 않다: ${report.Status || "상태 없음"}${report.StatusMessage ? ` — ${report.StatusMessage}` : ""}`);
  }
  if (report.Timestamped !== true) problems.push("타임스탬프가 없다 — Artifact Signing 인증서는 3일짜리라 사흘 뒤 서명이 무효가 된다");
  return problems;
}

/** app-update.yml 의 publisherName(문자열 | 목록 | 없음) → 이름 목록. 빈 문자열은 이름이 아니다. */
export function publisherNames(value) {
  return (Array.isArray(value) ? value : [value]).filter((n) => typeof n === "string" && n !== "");
}

/**
 * 앱에 박힌 publisherName 의 문제 — 비면 통과.
 * @param {string | string[] | null | undefined} publisherName  resources/app-update.yml 의 값
 * @param {string | undefined} expected  끼운 azureSignOptions.publisherName — 정확히 같은 항목이 있어야 한다
 */
export function publisherProblems(publisherName, expected) {
  const names = publisherNames(publisherName);
  if (!names.length) return ["app-update.yml 에 publisherName 이 없다 — 설치된 앱이 다음 업데이트의 서명을 검사하지 않는다"];
  if (present(expected) && !names.includes(expected)) {
    return [`app-update.yml 의 publisherName 이 끼운 값과 다르다: ${JSON.stringify(names)} ≠ ${JSON.stringify(expected)}`];
  }
  return [];
}

/**
 * 검사 대상 — release/ 의 NSIS 설치기(`<productName>-Setup-*.exe`)와 win-unpacked/ 의 앱 exe.
 * @param {string[] | undefined} releaseFiles  release/ 의 이름들
 * @param {string[] | undefined} unpackedFiles release/win-unpacked/ 의 이름들
 * @param {string} productName
 */
export function signingTargets(releaseFiles, unpackedFiles, productName) {
  const installers = (releaseFiles || []).filter((f) => f.startsWith(`${productName}-Setup-`) && f.endsWith(".exe"));
  const app = (unpackedFiles || []).includes(`${productName}.exe`) ? [`win-unpacked/${productName}.exe`] : [];
  return { installers, app };
}

/**
 * 게이트가 할 일 — "verify" | "skip" | "misconfigured".
 *  자격은 있는데 서명 설정이 안 끼워졌으면 무서명 설치본이 서명된 척 나가므로 실패로 본다.
 * @param {{ clientId?: string, azureSignOptions?: object | null }} o
 */
export function gateMode({ clientId, azureSignOptions }) {
  if (azureSignOptions) return "verify";
  return present(clientId) ? "misconfigured" : "skip";
}

/**
 * powershell.exe(Windows PowerShell 5.1)에 넘길 환경 — PSModulePath 를 뺀다(키 대소문자 무관). 입력은 바꾸지 않는다.
 *  pwsh(PowerShell 7) 스텝에서 부르면 7 의 모듈 경로를 물려받아 `Get-AuthenticodeSignature` 가 든 Security 모듈을 못 싣는다
 *  (실측 run 34820230010: «found in the module 'Microsoft.PowerShell.Security', but the module could not be loaded»).
 *  electron-updater 도 같은 이유로 `set "PSModulePath="` 뒤에 powershell.exe 를 부른다(electron-builder#7127).
 * @param {Record<string, string | undefined>} env
 */
export function powershellEnv(env) {
  return Object.fromEntries(Object.entries(env).filter(([k]) => k.toUpperCase() !== "PSMODULEPATH"));
}

// ── 서명 없는 DLL 도 서명한다 (#4066) ──────────────────────────────────────────────────────────────
//  electron-builder 는 기본으로 .exe 만 서명한다(app-builder-lib 26.16.1 winPackager.shouldSignFile). Electron 43.3.0 배포본의
//  DLL 8개 중 6개(dxcompiler · ffmpeg · libEGL · libGLESv2 · vk_swiftshader · vulkan-1)는 서명이 없다(2026-09-17 실측). 이게 두 곳에 걸린다.
//   - Windows 11 스마트 앱 컨트롤은 서명 없는 DLL 을 막는다(logseq/og#55 가 같은 Electron DLL 목록으로 막혔다).
//   - Microsoft Store EXE 등록은 설치기 안의 **모든 PE 파일**이 서명돼 있기를 요구한다(Store 정책 10.2.9).
//  나머지 둘(d3dcompiler_47 · dxil)은 이미 Microsoft 서명이 있다. 서명 도구는 기존 서명을 **갈아 끼우므로** 그 둘은 건드리지 않는다.
//  그래서 확장자(".dll")가 아니라 **서명 없는 파일의 이름**을 signExts 에 넣는다 — shouldSignFile 은 `file.endsWith(ext)` 로
//  대조하므로 이름 전체도 된다. 목록은 러너에 받아진 Electron 배포본을 읽어 정한다 — Electron 을 올려 DLL 이 바뀌어도
//  손댈 자리가 없다. 그래도 빠진 게 있으면 verify 가 앱 폴더 전수 판독으로 막는다.

const PE_EXTS = [".exe", ".dll", ".node"];
/** 이름으로 본 PE 파일(서명 대상 후보)인가. */
export const isPeName = (name) => typeof name === "string" && PE_EXTS.some((e) => name.toLowerCase().endsWith(e));

/**
 * PE 머리에 인증서 테이블(Authenticode 서명이 들어가는 자리)이 있는가. PE 가 아니면 null.
 *  유효성은 보지 않는다 — «서명할 대상인가» 만 가른다. 유효성은 Windows 에서 verify 가 본다.
 * @param {Buffer} head  파일 앞부분(데이터 디렉터리까지 — 4KB 면 충분하다)
 * @returns {boolean | null}
 */
export function peHasSignature(head) {
  if (!Buffer.isBuffer(head) || head.length < 0x40 || head.readUInt16LE(0) !== 0x5a4d) return null;       // "MZ"
  const pe = head.readUInt32LE(0x3c);
  if (pe + 26 > head.length || head.readUInt32LE(pe) !== 0x00004550) return null;                            // "PE\0\0"
  const magic = head.readUInt16LE(pe + 24);
  // 데이터 디렉터리 시작 = 선택 헤더 + 96(PE32) / 112(PE32+). 바로 앞 4바이트가 NumberOfRvaAndSizes 다.
  const dirs = magic === 0x10b ? pe + 24 + 96 : magic === 0x20b ? pe + 24 + 112 : -1;
  if (dirs < 0) return null;
  const security = dirs + 4 * 8;                                                                              // IMAGE_DIRECTORY_ENTRY_SECURITY = 4
  if (security + 8 > head.length) return null;
  if (head.readUInt32LE(dirs - 4) <= 4) return false;
  return head.readUInt32LE(security + 4) > 0;
}

/**
 * 서명해야 할 DLL 이름 — 서명 자리가 **비어 있는** PE 만. 정렬해 돌려준다(빌드마다 같은 설정).
 *  남이 이미 서명한 것(signed: true)과 PE 가 아닌 것(signed: null)은 넣지 않는다.
 * @param {{ name: string, signed: boolean | null }[] | null | undefined} files
 */
export function unsignedDlls(files) {
  return (files || [])
    .filter((f) => f && typeof f.name === "string" && f.name.toLowerCase().endsWith(".dll") && f.signed === false)
    .map((f) => f.name)
    .sort();
}

/**
 * `win.signExts` 에 이름을 더한 **새** package.json. 무서명 빌드(pkg 가 null)이거나 이름이 없으면 받은 그대로 돌려준다.
 *  입력은 바꾸지 않는다. 이미 있는 항목은 지우지 않고 겹치는 이름은 한 번만 넣는다.
 * @param {any} pkg
 * @param {string[] | null | undefined} names
 */
export function withSignExts(pkg, names) {
  if (!pkg || !names || !names.length) return pkg;
  const win = (pkg.build && pkg.build.win) || {};
  const signExts = [...new Set([...(Array.isArray(win.signExts) ? win.signExts : []), ...names])];
  return { ...pkg, build: { ...pkg.build, win: { ...win, signExts } } };
}

/**
 * 인증서 주체 DN → Map(키 → 값). builder-util-runtime 9.7.0 `rfc2253Parser.parseDn` 을 그대로 옮겼다 — 설치된 앱의
 *  electron-updater 가 서명자를 이 파서로 읽으므로, 우리 게이트도 **같은 파서**로 읽어야 판정이 어긋나지 않는다.
 * @param {string} seq
 */
export function parseDn(seq) {
  let quoted = false;
  let key = null;
  let token = "";
  let nextNonSpace = 0;
  seq = String(seq ?? "").trim();
  const result = new Map();
  for (let i = 0; i <= seq.length; i++) {
    if (i === seq.length) {
      if (key !== null) result.set(key, token);
      break;
    }
    const ch = seq[i];
    if (quoted) {
      if (ch === '"') { quoted = false; continue; }
    } else {
      if (ch === '"') { quoted = true; continue; }
      if (ch === "\\") {
        i++;
        const ord = parseInt(seq.slice(i, i + 2), 16);
        if (Number.isNaN(ord)) token += seq[i];
        else { i++; token += String.fromCharCode(ord); }
        continue;
      }
      if (key === null && ch === "=") { key = token; token = ""; continue; }
      if (ch === "," || ch === ";" || ch === "+") {
        if (key !== null) result.set(key, token);
        key = null;
        token = "";
        continue;
      }
    }
    if (ch === " " && !quoted) {
      if (token.length === 0) continue;
      if (i > nextNonSpace) {
        let j = i;
        while (seq[j] === " ") j++;
        nextNonSpace = j;
      }
      if (nextNonSpace >= seq.length || seq[nextNonSpace] === "," || seq[nextNonSpace] === ";"
        || (key === null && seq[nextNonSpace] === "=") || (key !== null && seq[nextNonSpace] === "+")) {
        i = nextNonSpace - 1;
        continue;
      }
    }
    token += ch;
  }
  return result;
}

/**
 * 서명자 주체가 게시자 이름과 맞는가 — electron-updater 6.8.9 `windowsExecutableCodeSignatureVerifier.js` 와 같은 규칙.
 *  게시자 이름이 DN 이면 거기 적힌 키가 **모두** 같은 값이어야 한다(주체에 L·S·C 가 더 있어도 된다).
 *  DN 이 아니면 CN 하나와 같은지만 본다.
 * @param {string | null | undefined} subject
 * @param {string | null | undefined} publisherName
 */
export function subjectMatches(subject, publisherName) {
  if (!present(subject) || !present(publisherName)) return false;
  const got = parseDn(subject);
  const want = parseDn(publisherName);
  if (want.size) return [...want.keys()].every((k) => want.get(k) === got.get(k));
  return publisherName === got.get("CN");
}

/**
 * 따로 서명한 파일(설치 도우미)의 문제 — 비면 통과. 유효·타임스탬프에 더해 서명자가 우리여야 한다.
 * @param {{ Status?: string, StatusMessage?: string, Timestamped?: boolean, Subject?: string } | null | undefined} report
 * @param {string} publisherName
 */
export function ownSignatureProblems(report, publisherName) {
  const problems = signatureProblems(report);
  if (report && !subjectMatches(report.Subject, publisherName)) {
    problems.push(`서명자가 게시자(${publisherName})가 아니다: ${report.Subject || "주체 없음"}`);
  }
  return problems;
}

/**
 * 앱 폴더 PE 전수 판독의 문제 — 비면 통과.
 *  - 모든 PE 가 Valid 여야 한다. 서명 없음·깨진 서명은 스마트 앱 컨트롤이 막고, Store 등록도 거절된다.
 *  - 우리 서명(주체가 게시자와 맞는 것)은 타임스탬프가 있어야 한다. 인증서가 3일짜리라서다.
 *  - 남이 한 서명(예: Microsoft 의 d3dcompiler_47)은 Valid 면 된다.
 * @param {{ file: string, Status?: string, StatusMessage?: string, Subject?: string, Timestamped?: boolean }[] | null | undefined} reports
 * @param {string} publisherName
 */
export function appFilesProblems(reports, publisherName) {
  if (!reports || !reports.length) return ["앱 폴더에서 PE 파일(.exe·.dll·.node)을 찾지 못했다"];
  const problems = [];
  for (const r of reports) {
    const file = (r && r.file) || "(이름 없음)";
    if (!r || r.Status !== "Valid") {
      problems.push(`${file}: 서명이 유효하지 않다 — ${(r && r.Status) || "판독 실패"}${r && r.StatusMessage ? ` (${r.StatusMessage})` : ""}`);
      continue;
    }
    if (subjectMatches(r.Subject, publisherName) && r.Timestamped !== true) {
      problems.push(`${file}: 타임스탬프가 없다 — Artifact Signing 인증서는 3일짜리라 사흘 뒤 서명이 무효가 된다`);
    }
  }
  return problems;
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "package.json");

/** 파일 앞부분만 읽는다 — DLL 은 수십 MB 라 통째로 읽을 이유가 없다. */
function readHead(file, n = 4096) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(n);
    return buf.subarray(0, readSync(fd, buf, 0, n, 0));
  } finally { closeSync(fd); }
}

/** 러너에 받아진 Electron 배포본(npm ci 가 이 OS 용으로 받는다)의 최상위 PE 파일과 서명 자리 유무. 없으면 null. */
function electronDistFiles() {
  const dist = join(HERE, "node_modules", "electron", "dist");
  if (!existsSync(dist)) return null;
  return readdirSync(dist).filter(isPeName).map((name) => ({ name, signed: peHasSignature(readHead(join(dist, name))) }));
}

function configure() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  let next;
  try { next = withAzureSigning(pkg, process.env); } catch (e) { console.error(`::error::${e.message}`); return 1; }
  if (!next) { console.log("::warning::win 서명 자격(AZURE_*) 없음 — 미서명 빌드(SmartScreen 경고)."); return 0; }
  const dist = electronDistFiles();
  if (!dist) { console.error("::error::Electron 배포본(desktop/node_modules/electron/dist)이 없다 — 서명할 DLL 을 정하지 못한다"); return 1; }
  const dlls = unsignedDlls(dist);
  next = withSignExts(next, dlls);
  writeFileSync(PKG, JSON.stringify(next, null, 2) + "\n");
  const o = next.build.win.azureSignOptions;
  console.log(`win: Artifact Signing 연결 — ${o.codeSigningAccountName}/${o.certificateProfileName} @ ${o.endpoint} · 게시자 ${o.publisherName}`);
  console.log(`win: 서명 없는 Electron DLL ${dlls.length}개도 서명한다 — ${dlls.join(", ") || "없음"}`);
  return 0;
}

/**
 * Authenticode 판독 — 여러 파일을 PowerShell 한 번에 읽는다. 결과는 UTF-8 JSON 의 Base64 로 받는다
 *  (콘솔 코드페이지가 한글 주체를 깨지 못하게). 돌려주는 배열의 순서는 files 와 같다.
 * @param {string[]} files
 */
function readSignatures(files) {
  if (!files.length) return [];
  const list = files.map((f) => `'${f.replace(/'/g, "''")}'`).join(",");
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$r = @(foreach ($f in @(${list})) { $s = Get-AuthenticodeSignature -LiteralPath $f; $c = $s.SignerCertificate; [ordered]@{ Status = [string]$s.Status; StatusMessage = [string]$s.StatusMessage; Subject = [string]$(if ($c) { $c.Subject }); Issuer = [string]$(if ($c) { $c.Issuer }); NotAfter = [string]$(if ($c) { $c.NotAfter.ToUniversalTime().ToString('o') }); Timestamped = ($null -ne $s.TimeStamperCertificate) } })`,
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((ConvertTo-Json -InputObject $r -Compress -Depth 3)))",
  ].join("; ");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 120_000, env: powershellEnv(process.env) });
  const parsed = JSON.parse(Buffer.from(out.trim(), "base64").toString("utf8"));
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  if (arr.length !== files.length) throw new Error(`판독 결과 수(${arr.length})가 파일 수(${files.length})와 다르다`);
  return arr;
}
const readSignature = (file) => readSignatures([file])[0];

/** 디렉터리 아래 PE 파일 — root 기준 상대경로('/' 구분), 정렬. */
function peFilesUnder(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), r);
      else if (isPeName(ent.name)) out.push(r);
    }
  };
  if (existsSync(root)) walk(root, "");
  return out.sort();
}

async function verify() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  const azure = pkg.build && pkg.build.win && pkg.build.win.azureSignOptions;
  const mode = gateMode({ clientId: process.env.AZURE_CLIENT_ID, azureSignOptions: azure });
  if (mode === "skip") { console.log("win: 서명 자격·설정 없음 — 무서명 빌드라 서명 검증을 건너뛴다"); return 0; }
  if (mode === "misconfigured") {
    console.error("::error::서명 자격(AZURE_CLIENT_ID)은 있는데 package.json 에 win.azureSignOptions 가 없다 — configure 가 안 돌았다. 무서명 설치본이 나간다");
    return 1;
  }
  if (process.platform !== "win32") { console.error("::error::Authenticode 판독은 Windows 에서만 된다"); return 1; }

  const productName = (pkg.build && pkg.build.productName) || pkg.productName || pkg.name;
  const rel = join(HERE, "release");
  const unpacked = join(rel, "win-unpacked");
  const { installers, app } = signingTargets(existsSync(rel) ? readdirSync(rel) : [], existsSync(unpacked) ? readdirSync(unpacked) : [], productName);
  const problems = [];
  if (!installers.length) problems.push(`release/ 에 ${productName}-Setup-*.exe 가 없다`);
  if (!app.length) problems.push(`release/win-unpacked/${productName}.exe 가 없다`);

  // ② 의 기준 = 앱에 **실제로 박힌** publisherName. electron-updater 가 읽는 파일을, electron-updater 가 쓰는 파서로 읽는다.
  const updaterRequire = createRequire(createRequire(PKG).resolve("electron-updater"));
  const { load } = updaterRequire("js-yaml");
  const { verifySignature } = updaterRequire("./windowsExecutableCodeSignatureVerifier.js");
  const updateYml = join(unpacked, "resources", "app-update.yml");
  const conf = existsSync(updateYml) ? load(readFileSync(updateYml, "utf8")) : null;
  if (!conf) problems.push("release/win-unpacked/resources/app-update.yml 이 없다");
  const embedded = conf ? conf.publisherName : undefined;
  problems.push(...publisherProblems(embedded, azure.publisherName));
  const names = publisherNames(embedded);
  console.log(`app-update.yml publisherName = ${JSON.stringify(names)}`);

  const say = (m) => console.log(`    [electron-updater] ${m}`);
  const logger = { info: say, warn: say, error: say };
  for (const rp of [...installers, ...app]) {
    const file = join(rel, rp);
    let report;
    try { report = readSignature(file); } catch (e) { problems.push(`${rp}: 서명 판독 실패 — ${String((e && e.message) || e).slice(0, 300)}`); continue; }
    console.log(`${rp}\n    상태 ${report.Status} · 타임스탬프 ${report.Timestamped ? "있음" : "없음"} · 인증서 만료 ${report.NotAfter || "-"}\n    서명자 ${report.Subject || "-"}\n    발급자 ${report.Issuer || "-"}`);
    problems.push(...signatureProblems(report).map((p) => `${rp}: ${p}`));
    if (!names.length) continue;
    try {
      const verdict = await verifySignature(names, file, logger);
      if (verdict == null) console.log("    ✓ electron-updater 대조 통과 — 설치된 앱이 이 서명을 받아들인다");
      else problems.push(`${rp}: electron-updater 가 거부했다 — ${String(verdict).slice(0, 400)}`);
    } catch (e) {
      problems.push(`${rp}: electron-updater 대조가 오류로 끝났다 — ${String((e && e.message) || e).slice(0, 300)}`);
    }
  }

  // ③ 앱 폴더 전수 — 설치기에 들어가는 PE 가 하나도 빠짐없이 서명됐는가(#4066). 서명 없는 DLL 은 스마트 앱 컨트롤이 막는다.
  const peFiles = peFilesUnder(unpacked);
  let reports = [];
  try {
    reports = readSignatures(peFiles.map((f) => join(unpacked, f))).map((r, i) => ({ ...r, file: `win-unpacked/${peFiles[i]}` }));
  } catch (e) {
    problems.push(`앱 폴더 서명 판독 실패 — ${String((e && e.message) || e).slice(0, 300)}`);
  }
  if (reports.length || !peFiles.length) {
    console.log(`앱 폴더 PE ${peFiles.length}개`);
    for (const r of reports) console.log(`    ${r.Status === "Valid" ? "✓" : "✗"} ${r.file} — ${r.Status}${r.Timestamped ? " · 타임스탬프" : ""} · ${r.Subject || "서명자 없음"}`);
    problems.push(...appFilesProblems(reports, azure.publisherName));
  }

  if (problems.length) { for (const p of problems) console.error(`::error::${p}`); return 1; }
  console.log("✓ 윈도우 서명 게이트 통과");
  return 0;
}

/** 따로 서명한 파일(설치 도우미 — release-desktop 밖에서 서명한다) 검사. 게시자 이름은 WIN_SIGN_PUBLISHER. */
function verifyFiles(files) {
  const publisher = process.env.WIN_SIGN_PUBLISHER;
  if (!present(publisher)) { console.error("::error::WIN_SIGN_PUBLISHER 가 없다 — 누구의 서명이어야 하는지 모른다"); return 1; }
  if (!files.length) { console.error("::error::검사할 파일을 주지 않았다"); return 2; }
  if (process.platform !== "win32") { console.error("::error::Authenticode 판독은 Windows 에서만 된다"); return 1; }
  const problems = [];
  let reports = [];
  try { reports = readSignatures(files); } catch (e) { problems.push(`서명 판독 실패 — ${String((e && e.message) || e).slice(0, 300)}`); }
  reports.forEach((report, i) => {
    console.log(`${files[i]}\n    상태 ${report.Status} · 타임스탬프 ${report.Timestamped ? "있음" : "없음"} · 인증서 만료 ${report.NotAfter || "-"}\n    서명자 ${report.Subject || "-"}\n    발급자 ${report.Issuer || "-"}`);
    problems.push(...ownSignatureProblems(report, publisher).map((p) => `${files[i]}: ${p}`));
  });
  if (problems.length) { for (const p of problems) console.error(`::error::${p}`); return 1; }
  console.log("✓ 서명 확인 — 유효 · 타임스탬프 · 게시자 일치");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === "configure") process.exit(configure());
  else if (cmd === "verify") process.exit(await verify());
  else if (cmd === "verify-files") process.exit(verifyFiles(process.argv.slice(3)));
  else { console.error("사용법: node win-signing.mjs configure | verify | verify-files <파일…>"); process.exit(2); }
}
