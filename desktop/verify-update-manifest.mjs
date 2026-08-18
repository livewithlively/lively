// 업데이트 매니페스트(latest*.yml) ↔ 실제 산출물 이름 대조 (#1541).
//
// ★ 실측(2026-08-18, 사용자 Windows 실기기 · 앱 0.1.320 → 0.1.323 업데이트):
//     업데이트 확인 실패: Cannot download "…/v0.1.323/Lively-Setup-0.1.323.exe", status 404
//  릴리스엔 파일이 **있었다** — 이름이 `Lively.Setup.0.1.323.exe` 였을 뿐이다. 세 당사자가 이름을 제각각 만든다:
//   · electron-builder 는 NSIS 기본 이름을 `Lively Setup 0.1.323.exe`(공백)로 굽고, latest.yml 엔
//     GitHub-안전 이름 `Lively-Setup-0.1.323.exe`(공백→하이픈)를 적는다(app-builder-lib computeSafeArtifactNameIfNeeded).
//     자기 GitHub 퍼블리셔로 올릴 땐 그 안전 이름으로 올리므로 둘이 맞는다.
//   · 우리는 `--publish never` 로 굽고 action-gh-release 로 **파일 이름 그대로** 올린다 → GitHub 이 공백을 점으로 바꾼다.
//   · electron-updater(GitHubProvider)는 latest.yml 의 이름에서 공백을 하이픈으로 바꿔 요청한다.
//  → 매니페스트(하이픈) ≠ 자산(점) → 404. 사용자는 **영영 업데이트를 못 받는다** — 그리고 이번엔 그 업데이트에
//    앱이 CLI 를 못 띄우던 결함(spawn EINVAL, 0.1.321 수정)의 수정이 들어 있어서, 잠금이 됐다.
//
// 이 파일은 그 갈림을 **업로드 전에** 잡는다: 매니페스트가 가리키는 이름이 ① release/ 에 실제로 있고
//  ② GitHub 이 바꾸지 않을 문자만으로 돼 있어야 한다. 하나라도 어긋나면 릴리스를 막는다 — 자산이 없는 릴리스보다
//  업데이트가 조용히 죽는 릴리스가 더 나쁘다(사용자는 몇 달 뒤에 안다).
//
// ⚠ 순수함수로 뺀다(#1510 §5): 이 검사는 각 OS 러너에서 그 OS 산출물에만 돈다. 규칙 자체는 여기서
//  플랫폼 무관하게 테스트로 못박는다(desktop-core.test.mjs Z5/Z6).
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** GitHub 릴리스 자산 이름이 **그대로** 보존되는 문자 집합(app-builder-lib isSafeGithubName 과 동일). */
export const GITHUB_SAFE = /^[0-9A-Za-z._-]+$/;

/** latest*.yml 이 가리키는 파일 이름들(files[].url · path). 최소 파서 — 우리 매니페스트는 electron-builder 가 쓴 평평한 YAML 이다. */
export function manifestRefs(yamlText) {
  const out = [];
  for (const line of String(yamlText || "").split(/\r?\n/)) {
    const m = /^\s*(?:-\s*)?(?:url|path):\s*(.+?)\s*$/.exec(line);
    if (m) out.push(m[1].replace(/^['"]|['"]$/g, ""));
  }
  return out;
}

/**
 * 매니페스트 문제 목록 — 비어 있으면 통과.
 * @param {string} yamlText   latest*.yml 내용
 * @param {string[]} files    release/ 의 파일 이름들
 */
export function manifestProblems(yamlText, files) {
  const refs = manifestRefs(yamlText);
  const problems = [];
  if (!refs.length) problems.push("매니페스트가 가리키는 파일이 하나도 없다(url/path 부재) — 업데이터가 받을 것이 없다");
  const have = new Set(files || []);
  for (const name of new Set(refs)) {   // url 과 path 가 같은 파일을 가리키는 게 정상 — 한 번만 본다
    if (!have.has(name)) problems.push(`매니페스트가 가리키는 파일이 release/ 에 없다: ${name}`);
    if (!GITHUB_SAFE.test(name)) {
      problems.push(/\s/.test(name)
        ? `이름에 공백이 있다 — GitHub 은 점으로, 업데이터는 하이픈으로 바꿔 서로 못 만난다(404): ${name}`
        : `이름에 GitHub 이 바꾸는 문자가 있다(허용: 영숫자 . _ -): ${name}`);
    }
  }
  // 차등 다운로드 재료(#1541): 설치기 옆에 `<이름>.blockmap` 이 있어야 다음 업데이트가 전체(~100MB)가 아니라 차등이 된다.
  //  Windows 설치기(.exe)는 **필수** — 자동 업데이트가 실제로 도는 축이고, electron-builder 는 nsis.differentialPackage 가
  //  false 가 아니면 늘 만든다. 없다는 건 설정이 바뀌었거나 업로드 목록에서 빠진 것 = 조용히 100MB 로 되돌아간다.
  //  (mac zip 도 만들어지지만 mac 자동 업데이트는 미서명이라 꺼져 있다 — 여기선 강제하지 않는다.)
  for (const name of new Set(refs)) {
    if (/\.exe$/i.test(name) && !have.has(`${name}.blockmap`)) {
      problems.push(`차등 다운로드용 ${name}.blockmap 이 release/ 에 없다 — 업데이트마다 설치기 전체를 받게 된다`);
    }
  }
  return problems;
}

// CLI: release/ 아래 latest*.yml 전부 검사. 하나라도 문제면 exit 1.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "release");
  let files = [];
  try { files = readdirSync(dir); } catch { console.error(`✗ ${dir} 가 없다 — 빌드가 먼저다`); process.exit(1); }
  const manifests = files.filter((f) => /^latest.*\.yml$/.test(f));
  if (!manifests.length) { console.error("✗ latest*.yml 이 없다 — 업데이터가 읽을 매니페스트가 없다"); process.exit(1); }
  let bad = 0;
  for (const m of manifests) {
    const problems = manifestProblems(readFileSync(join(dir, m), "utf8"), files);
    if (problems.length) { bad++; console.error(`✗ ${m}`); for (const p of problems) console.error(`    ${p}`); }
    else console.log(`✓ ${m} — ${[...new Set(manifestRefs(readFileSync(join(dir, m), "utf8")))].join(", ")}`);
  }
  process.exit(bad ? 1 : 0);
}
