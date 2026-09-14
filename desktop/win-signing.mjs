// 윈도우 코드서명 — Azure Artifact Signing(구 Trusted Signing) 설정과 서명 게이트 (#3940).
//
//   node win-signing.mjs configure   빌드 직전: 서명 자격(AZURE_*)이 있을 때만 package.json 에 win.azureSignOptions 를 끼운다
//   node win-signing.mjs verify      빌드 직후: 서명이 유효한지 + 설치된 앱이 다음 업데이트를 받아들이는지 본다
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
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const PKG = join(HERE, "package.json");

function configure() {
  const pkg = JSON.parse(readFileSync(PKG, "utf8"));
  let next;
  try { next = withAzureSigning(pkg, process.env); } catch (e) { console.error(`::error::${e.message}`); return 1; }
  if (!next) { console.log("::warning::win 서명 자격(AZURE_*) 없음 — 미서명 빌드(SmartScreen 경고)."); return 0; }
  writeFileSync(PKG, JSON.stringify(next, null, 2) + "\n");
  const o = next.build.win.azureSignOptions;
  console.log(`win: Artifact Signing 연결 — ${o.codeSigningAccountName}/${o.certificateProfileName} @ ${o.endpoint} · 게시자 ${o.publisherName}`);
  return 0;
}

/** Authenticode 판독 — 결과를 UTF-8 JSON 의 Base64 로 받는다(콘솔 코드페이지가 한글 주체를 깨지 못하게). */
function readSignature(file) {
  const ps = [
    "$ErrorActionPreference = 'Stop'",
    `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'`,
    "$c = $s.SignerCertificate",
    "$o = [ordered]@{ Status = [string]$s.Status; StatusMessage = [string]$s.StatusMessage; Subject = [string]$(if ($c) { $c.Subject }); Issuer = [string]$(if ($c) { $c.Issuer }); NotAfter = [string]$(if ($c) { $c.NotAfter.ToUniversalTime().ToString('o') }); Timestamped = ($null -ne $s.TimeStamperCertificate) }",
    "[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes(($o | ConvertTo-Json -Compress)))",
  ].join("; ");
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", timeout: 60_000, env: powershellEnv(process.env) });
  return JSON.parse(Buffer.from(out.trim(), "base64").toString("utf8"));
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
  if (problems.length) { for (const p of problems) console.error(`::error::${p}`); return 1; }
  console.log("✓ 윈도우 서명 게이트 통과");
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const cmd = process.argv[2];
  if (cmd === "configure") process.exit(configure());
  else if (cmd === "verify") process.exit(await verify());
  else { console.error("사용법: node win-signing.mjs configure | verify"); process.exit(2); }
}
