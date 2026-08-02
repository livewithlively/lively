// 세션 공유 빌드 캐시(#813 T3) — 생태계별 다운로드/의존성 캐시를 **박스 전역 한 곳**으로 모은다.
//
// 왜:
//  ① **회수를 싸게 만든다(주목적).** 워크트리의 파생물(node_modules·build/…)을 회수하면 재설치·재빌드가 필요한데,
//     캐시가 공유·warm 이면 네트워크 재다운로드 없이 금방 복구된다. 이게 없으면 "지우면 너무 아파서 아무도 안 지우는"
//     죽은 정책이 된다. (지식: workspace-storage-model-asset-vs-derived-cache — '선행조건')
//  ② **멤버 격리(#524)의 중복을 없앤다.** 세션은 멤버별 OS 유저로 뜨므로 홈이 갈리고, `~/.npm`·`~/.gradle` 같은
//     사용자 캐시가 **멤버 수만큼 복제**된다. 공유 캐시는 그 중복을 하나로 접는다.
//  ③ 부수효과로 빌드가 빨라진다(캐시 히트) — 삭제가 아니라 구조 개선이라 위험이 없고 고객 가치는 오른다.
//
// ⚠ 정직하게 — 이것만으로 부피가 줄지는 않는다: npm 은 캐시를 공유해도 `node_modules` 를 프로젝트마다 **실제 복사**한다
//  (pnpm 만 하드링크 공유). 부피는 회수(T3-2)가 줄이고, 이 모듈은 그 회수를 감당 가능하게 만든다.
//
// ⚠ 안전 경계 — 기본값은 **순수 캐시 디렉터리만** 옮긴다:
//  `GRADLE_USER_HOME`·`CARGO_HOME` 은 캐시뿐 아니라 **설정·자격증명까지** 옮긴다
//  (`~/.gradle/gradle.properties` 의 서명키·저장소 인증, `~/.cargo/credentials.toml` 의 레지스트리 토큰).
//  그걸 무단으로 옮기면 **고객 빌드가 깨진다** → 별도 opt-in(관리탭 토글, 기본 꺼짐)으로 분리한다.
import path from "node:path";
import fsp from "node:fs/promises";
import { logger } from "../log.js";

/** 공유 캐시 루트 — 세션 공유 워크스페이스 바로 아래 `.cache`.
 *  그 디렉터리의 그룹·setgid 권한을 물려받아 멤버별 격리 OS 유저들이 모두 쓸 수 있다(홈이 갈려도 캐시는 하나).
 *  ⚠ 워크스페이스 스캔(T3-2)은 이 `.cache` 를 '프로젝트'로 세지 않아야 한다. */
export function sharedCacheRoot(sharedBase: string): string {
  return path.join(sharedBase, ".cache");
}

/** 순수 캐시 변수 — 설정·자격증명을 옮기지 않는다. 기본 ON. */
export function safeCacheEnv(root: string): Record<string, string> {
  const at = (...segs: string[]): string => path.join(root, ...segs);
  return {
    npm_config_cache: at("npm"),
    npm_config_store_dir: at("pnpm-store"), // pnpm 하드링크 스토어 — node 에서 유일하게 '실제 중복'을 없앤다
    YARN_CACHE_FOLDER: at("yarn"),
    PIP_CACHE_DIR: at("pip"),
    UV_CACHE_DIR: at("uv"),
    GOMODCACHE: at("go", "mod"),
    GOCACHE: at("go", "build"),
    COMPOSER_CACHE_DIR: at("composer"),
    NUGET_PACKAGES: at("nuget"),
    // Maven 3.9+ — 로컬 저장소만 옮긴다(설정 ~/.m2/settings.xml 은 그대로 읽힌다). 구버전은 무시 = 무해.
    MAVEN_ARGS: `-Dmaven.repo.local=${at("maven")}`,
  };
}

/** ⚠ 홈 자체를 옮기는 변수 — 설정·자격증명도 함께 이동한다. opt-in(기본 OFF). */
export function homeRelocateEnv(root: string): Record<string, string> {
  const at = (...segs: string[]): string => path.join(root, ...segs);
  return {
    GRADLE_USER_HOME: at("gradle"), // ⚠ ~/.gradle/gradle.properties(서명키·저장소 인증)가 무시된다
    CARGO_HOME: at("cargo"), // ⚠ ~/.cargo/credentials.toml(레지스트리 토큰)이 무시된다
  };
}

export interface CacheOpts {
  enabled: boolean; // 순수 캐시 공유(기본 true)
  relocateHome: boolean; // gradle/cargo 홈까지 공유(기본 false — 자격증명 이동 위험)
}

/** 세션에 주입할 env. 꺼져 있으면 빈 객체(= 아무것도 안 바꾼다 = 무회귀). */
export function sessionCacheEnv(sharedBase: string, opts: CacheOpts): Record<string, string> {
  if (!opts.enabled) return {};
  const root = sharedCacheRoot(sharedBase);
  return opts.relocateHome
    ? { ...safeCacheEnv(root), ...homeRelocateEnv(root) }
    : safeCacheEnv(root);
}

/** 디렉터리 총 크기(재귀). **시간 예산**이 있다 — 캐시·워크스페이스는 GB·수십만 파일급이라
 *  관리탭이 이걸 기다리다 멈추면 안 된다. 예산을 넘기면 `partial: true` 로 '지금까지 센 값'을 돌려준다.
 *  심볼릭 링크는 따라가지 않는다(순환·이중계산 방지 — pnpm 스토어는 하드링크라 정상 집계된다). */
export async function dirSize(root: string, budgetMs = 2000): Promise<{ bytes: number; partial: boolean }> {
  const deadline = Date.now() + budgetMs;
  let bytes = 0;
  let partial = false;
  // ⚠ **루트가 심링크면 따라가지 않는다.** readdir 은 심링크를 따라가므로, 예컨대 node_modules 가 다른 곳을 가리키는
  //  심링크면 **그 대상의 크기**를 이 디렉터리의 크기인 양 보고하게 된다(실측 확인). 회수 도구가 "224MB 회수 가능"
  //  이라고 거짓 보고하는 원인이었다 — 정작 이 워크트리가 쓰는 공간은 0인데. 아래 항목 루프는 이미 심링크를 건너뛴다.
  try {
    if ((await fsp.lstat(root)).isSymbolicLink()) return { bytes: 0, partial: false };
  } catch {
    return { bytes: 0, partial: false }; // 없는 경로 — 0
  }
  const stack: string[] = [root];
  while (stack.length) {
    // >= 로 본다: 예산 0 = '잴 시간이 없다' → 즉시 partial. (> 로 두면 같은 밀리초 안에 끝나버려 예산이 무의미해진다.)
    if (Date.now() >= deadline) { partial = true; break; }
    const dir = stack.pop() as string;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      continue; // 없거나 권한 없음 — 건너뛴다
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try {
        bytes += (await fsp.stat(p)).size;
      } catch { /* 스캔 중 사라졌을 수 있다 */ }
    }
  }
  return { bytes, partial };
}

/** 캐시 디렉터리 보장(부팅 1회, 멱등). 그룹 쓰기(2775) — 멤버별 격리 OS 유저들이 공유해야 한다.
 *  ⚠ 비치명: 실패해도 기동을 막지 않는다(각 툴이 자기 캐시 디렉터리를 알아서 만들기도 한다). */
export async function ensureSharedCache(sharedBase: string, opts: CacheOpts): Promise<void> {
  if (!opts.enabled) return;
  const root = sharedCacheRoot(sharedBase);
  const dirs = new Set<string>();
  for (const v of Object.values(sessionCacheEnv(sharedBase, opts))) {
    // MAVEN_ARGS 는 경로가 아니라 플래그 문자열 — 값에서 경로만 뽑는다.
    const p = v.startsWith("-D") ? v.slice(v.indexOf("=") + 1) : v;
    if (path.isAbsolute(p)) dirs.add(p);
  }
  for (const dir of [root, ...dirs]) {
    try {
      await fsp.mkdir(dir, { recursive: true, mode: 0o2775 });
    } catch (err) {
      logger.warn({ err, dir }, "공유 캐시 디렉터리 생성 실패(비치명) — 툴이 각자 만들 수 있음");
    }
  }
}
