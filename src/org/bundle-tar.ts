// 설치 번들 tar 인자 — **비-ASCII 경로가 크로스플랫폼으로 살아남게** 하는 계약 (#1087).
//
// ⚠ tar 의 기본 헤더에는 **경로의 문자셋 표시가 없다.** 리눅스 게이트웨이가 GNU tar 기본값으로 묶으면
//   파일명이 UTF-8 **원시 바이트**로만 들어가고, 그걸 윈도우 `tar.exe`(bsdtar/libarchive)가 풀 때는
//   **활성 ANSI 코드페이지**(한국어 윈도우면 cp949)로 해석한다 → 이름이 깨지고 추출이 통째로 죽는다:
//
//     ✗ tar 실행 실패 (exit 1): ./setup/사용�\200이드.md: Invalid empty pathname
//
//   pax 포맷은 확장헤더에 `path=` 를 **UTF-8 로 명시**하므로 읽는 쪽 로케일과 무관하게 복원된다.
//   리눅스 GNU tar 1.35 실측: 기본값 → `path=` 없음 / `--format=pax` → `path=` 있음.
//
// ⚠ **이 버그는 우리 dev 박스에서 절대 재현되지 않는다.** dev 게이트웨이는 macOS 라 `tar` 가
//   bsdtar 이고, bsdtar 는 pax 계열이 기본이라 이미 `path=` 를 굽고 있었다. 즉 "우리 박스에선 되는데
//   고객 박스(리눅스)에서만 윈도우 멤버가 죽는" 형태였다 — 배포 전에 볼 방법이 없었다.
//
// 적용 범위: **윈도우에서 풀리는 번들**만이다. `/api/ui/node-agent` 번들은 리눅스 워커 전용이고 경로도
//   전부 ASCII 라 대상이 아니다(넓히려면 그 경로도 같은 계약으로 묶을 것).

/** stage 디렉터리를 stdout 으로 묶는 tar 인자. 비-ASCII 경로 보존을 위해 pax 포맷을 강제한다. */
export function installBundleTarArgs(stageDir: string): string[] {
  return ["--format=pax", "-czf", "-", "-C", stageDir, "."];
}
