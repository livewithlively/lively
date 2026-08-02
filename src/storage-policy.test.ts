// 박스 저장소 정책 + 로그 재니터 테스트 (#813 T4).
//
//  회귀 대상 ①: **로그에 상한이 없어 무한히 자라던 것**. 재니터가 실제로 파일을 줄이는지 + 회전본을 keep 개만 남기는지.
//  회귀 대상 ②: **copytruncate 여야 한다.** 서비스(systemd/launchd)가 원본 fd 를 쥐고 있어서 rename 으로 회전하면
//   서비스는 같은 inode 에 계속 쓰고 새 파일은 영영 비어 회전이 조용히 실패한다 → 원본 inode 가 유지되는지 못 박는다.
//  회귀 대상 ③: 관리탭(DB) 값이 env 시드/기본값을 **이긴다**(고객 박스는 SSH 가 없어 env 를 못 고친다).
import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_STORAGE_POLICY, normalizeStoragePolicy, resolveStoragePolicy, storagePolicySource,
  effectiveStoragePolicy, invalidateStoragePolicyCache,
} from "./org/policies/storage-policy.js";
import { rotateFile, sweepLogs } from "./ops/log-janitor.js";
import { sessionCacheEnv, sharedCacheRoot, safeCacheEnv, homeRelocateEnv, dirSize } from "./ops/build-cache.js";

// ── 정책 해석 ──
{
  // 미설정(DB 비어있음) → 기본값.
  assert.deepEqual(resolveStoragePolicy(null), DEFAULT_STORAGE_POLICY);
  assert.deepEqual(resolveStoragePolicy({}), DEFAULT_STORAGE_POLICY);
  assert.equal(storagePolicySource(null), "default");
  assert.equal(storagePolicySource({}), "default");

  // 관리탭(DB) 저장값이 이긴다.
  const db = resolveStoragePolicy({ log_max_mb: 10, disk_warn_pct: 70 });
  assert.equal(db.log_max_mb, 10, "관리탭 값이 기본값을 이겨야 한다");
  assert.equal(db.disk_warn_pct, 70);
  assert.equal(db.log_keep, DEFAULT_STORAGE_POLICY.log_keep, "안 건드린 항목은 기본값 유지");
  assert.equal(storagePolicySource({ log_max_mb: 10 }), "db");

  // 잡값 방어 — 범위를 벗어나면 기본값/클램프.
  assert.equal(normalizeStoragePolicy({ log_max_mb: "이상한값" }).log_max_mb, DEFAULT_STORAGE_POLICY.log_max_mb);
  assert.equal(normalizeStoragePolicy({ disk_warn_pct: 9999 }).disk_warn_pct, 94, "위험(95) 아래로 클램프");
  assert.equal(normalizeStoragePolicy({ log_keep: -5 }).log_keep, 0);

  // '경고 < 위험' 불변식 — 뒤집힌 입력이면 경고를 위험 바로 아래로 끌어내린다(경고 없이 위험만 뜨는 사고 방지).
  const flipped = normalizeStoragePolicy({ disk_warn_pct: 90, disk_critical_pct: 80 });
  assert.ok(flipped.disk_warn_pct < flipped.disk_critical_pct, `경고가 위험보다 낮아야: ${JSON.stringify(flipped)}`);
  assert.equal(flipped.disk_warn_pct, 79);
}

// ── 캐시: DB 가 죽어도 정책을 낸다 (readyz 가 가장 필요한 순간이 DB 다운이다) ──
{
  invalidateStoragePolicyCache();
  const good = await effectiveStoragePolicy(async () => resolveStoragePolicy({ log_max_mb: 7 }));
  assert.equal(good.log_max_mb, 7);

  // 캐시 유효 구간 — DB 가 터져도 마지막 값을 낸다(throw 금지).
  const cached = await effectiveStoragePolicy(async () => { throw new Error("DB down"); });
  assert.equal(cached.log_max_mb, 7, "DB 다운이어도 마지막 정책으로 계속 답해야 한다");

  // 캐시 비우고 DB 도 죽으면 → 기본값(그래도 throw 하지 않는다).
  invalidateStoragePolicyCache();
  const fallback = await effectiveStoragePolicy(async () => { throw new Error("DB down"); });
  assert.deepEqual(fallback, DEFAULT_STORAGE_POLICY, "캐시도 DB 도 없으면 기본값 — 절대 throw 하지 않는다");
  invalidateStoragePolicyCache();
}

// ── 로그 회전: copytruncate ──
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "janitor-"));
  const file = path.join(dir, "gateway.log");
  await fsp.writeFile(file, "x".repeat(3 * 1024 * 1024)); // 3MB

  // ⚠ 서비스가 로그 fd 를 쥐고 있는 상황 재현 — systemd `StandardOutput=append:` / launchd 와 같은 조건.
  const fd = fs.openSync(file, "a");
  const inodeBefore = fs.fstatSync(fd).ino;

  await rotateFile(file, 2);

  // ① 원본은 비워졌다.
  assert.equal((await fsp.stat(file)).size, 0, "원본이 truncate 돼야 한다");
  // ② 내용은 .1 로 보존됐다.
  assert.equal((await fsp.stat(`${file}.1`)).size, 3 * 1024 * 1024, "회전본에 내용이 남아야 한다");
  // ③ **원본 inode 가 그대로다** — rename 이 아니라 copytruncate 라는 증거.
  //    (rename 이었다면 서비스의 fd 는 옛 inode 를 계속 가리켜 새 파일은 영원히 비고 회전이 조용히 실패한다.)
  assert.equal(fs.statSync(file).ino, inodeBefore, "원본 inode 유지 — rename 회전은 서비스 로그를 잃는다");

  // ④ 서비스가 계속 쓰면 그대로 append 된다(회전 후에도 로그가 살아있다).
  fs.writeSync(fd, "회전 후 로그\n");
  fs.closeSync(fd);
  const after = await fsp.readFile(file, "utf8");
  assert.match(after, /회전 후 로그/, "회전 뒤에도 서비스 로그가 원본 파일에 계속 들어와야 한다");

  // ⑤ keep 개를 넘는 회전본은 지운다.
  await fsp.writeFile(file, "y".repeat(3 * 1024 * 1024));
  await rotateFile(file, 2);
  await fsp.writeFile(file, "z".repeat(3 * 1024 * 1024));
  await rotateFile(file, 2);
  assert.ok(fs.existsSync(`${file}.1`) && fs.existsSync(`${file}.2`), "keep=2 → .1 .2 존재");
  assert.ok(!fs.existsSync(`${file}.3`), "keep 초과 회전본은 삭제돼야 한다(무한 증가 방지)");

  await fsp.rm(dir, { recursive: true, force: true });
}

// ── 스윕: 상한 넘는 것만 회전, 회전본은 재회전 안 함 ──
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "janitor2-"));
  const big = path.join(dir, "gateway.log");
  const small = path.join(dir, "small.log");
  const notLog = path.join(dir, "keep-me.json");
  await fsp.writeFile(big, "x".repeat(2 * 1024 * 1024)); // 2MB
  await fsp.writeFile(small, "x".repeat(1024)); // 1KB
  await fsp.writeFile(notLog, "x".repeat(2 * 1024 * 1024)); // 로그 아님 — 건드리면 안 됨

  const rotated = await sweepLogs(dir, 1, 2); // 상한 1MB
  assert.equal(rotated.length, 1, "상한 넘는 파일만 회전");
  assert.equal(rotated[0].file, "gateway.log");
  assert.equal((await fsp.stat(big)).size, 0);
  assert.equal((await fsp.stat(small)).size, 1024, "작은 로그는 그대로");
  assert.equal((await fsp.stat(notLog)).size, 2 * 1024 * 1024, "로그가 아닌 파일은 절대 건드리지 않는다");

  // 회전본(gateway.log.1)은 다시 회전 대상이 아니다 — 아니면 무한 재회전.
  const again = await sweepLogs(dir, 1, 2);
  assert.equal(again.length, 0, "회전본은 재회전 대상이 아니다");

  // 상한 0 = 회전 끔(관리탭에서 명시적으로 끈 경우).
  await fsp.writeFile(big, "x".repeat(2 * 1024 * 1024));
  assert.equal((await sweepLogs(dir, 0, 2)).length, 0, "상한 0 이면 아무것도 안 한다");
  assert.equal((await fsp.stat(big)).size, 2 * 1024 * 1024);

  // 없는 디렉터리는 에러가 아니다(신규 박스에 logs/ 가 아직 없을 수 있다).
  assert.deepEqual(await sweepLogs(path.join(dir, "nope"), 1, 2), []);

  await fsp.rm(dir, { recursive: true, force: true });
}

// ── 공유 빌드 캐시(#813 T3) ──
//  회귀 대상: **자격증명이 딸려가는 변수(GRADLE_USER_HOME·CARGO_HOME)가 기본으로 켜지면 고객 빌드가 깨진다.**
//   그 둘은 캐시가 아니라 '홈'이라 ~/.gradle/gradle.properties(서명키)·~/.cargo/credentials.toml(토큰)을 무시하게 만든다.
//   → 기본 OFF 여야 하고, 명시적 opt-in 일 때만 들어가야 한다.
{
  const base = "/srv/lively/shared";
  assert.equal(sharedCacheRoot(base), "/srv/lively/shared/.cache");

  // 기본(순수 캐시만) — 홈 이전 변수는 절대 들어가면 안 된다.
  const safe = sessionCacheEnv(base, { enabled: true, relocateHome: false });
  assert.ok(safe.npm_config_cache?.startsWith("/srv/lively/shared/.cache"), "npm 캐시가 공유 루트를 가리켜야");
  assert.ok(safe.npm_config_store_dir, "pnpm 스토어(하드링크 공유)도 있어야");
  assert.ok(safe.GOMODCACHE && safe.PIP_CACHE_DIR && safe.UV_CACHE_DIR && safe.YARN_CACHE_FOLDER);
  assert.match(safe.MAVEN_ARGS ?? "", /^-Dmaven\.repo\.local=/, "Maven 은 로컬저장소만 옮긴다(settings.xml 보존)");
  assert.equal(safe.GRADLE_USER_HOME, undefined, "⚠ 기본값에 GRADLE_USER_HOME 이 들어가면 gradle.properties(서명키)가 무시돼 고객 빌드가 깨진다");
  assert.equal(safe.CARGO_HOME, undefined, "⚠ 기본값에 CARGO_HOME 이 들어가면 credentials.toml(레지스트리 토큰)이 무시된다");

  // opt-in 하면 그때만 들어간다.
  const withHome = sessionCacheEnv(base, { enabled: true, relocateHome: true });
  assert.ok(withHome.GRADLE_USER_HOME && withHome.CARGO_HOME, "opt-in 시엔 홈 이전 변수도 주입");
  assert.deepEqual(Object.keys(safeCacheEnv("/x")).length + Object.keys(homeRelocateEnv("/x")).length, Object.keys(withHome).length);

  // 꺼두면 **아무것도 주입하지 않는다**(무회귀 — 기존 세션 동작 그대로).
  assert.deepEqual(sessionCacheEnv(base, { enabled: false, relocateHome: true }), {}, "꺼져 있으면 relocateHome 이어도 빈 객체");

  // 기본 정책이 안전한가 — 이게 뒤집히면 위 회귀가 무의미해진다.
  assert.equal(DEFAULT_STORAGE_POLICY.shared_cache_enabled, true);
  assert.equal(DEFAULT_STORAGE_POLICY.shared_cache_relocate_home, false, "홈 이전은 기본 꺼짐이어야 한다");
}

// ── dirSize: 시간 예산 · 심볼릭 링크 미추적 ──
{
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "dirsize-"));
  const sub = path.join(dir, "a", "b");
  await fsp.mkdir(sub, { recursive: true });
  await fsp.writeFile(path.join(dir, "f1"), "x".repeat(1000));
  await fsp.writeFile(path.join(sub, "f2"), "x".repeat(2000));
  const r = await dirSize(dir);
  assert.equal(r.bytes, 3000, "재귀 합산");
  assert.equal(r.partial, false);

  // 심볼릭 링크는 안 따라간다(순환·이중계산 방지).
  await fsp.symlink(dir, path.join(dir, "loop"));
  const r2 = await dirSize(dir);
  assert.equal(r2.bytes, 3000, "심링크를 따라가면 무한/이중계산이 된다");

  // 예산 0 이면 즉시 partial.
  const r3 = await dirSize(dir, 0);
  assert.equal(r3.partial, true, "시간 예산을 넘기면 partial 로 알린다(관리탭이 멈추면 안 된다)");

  await fsp.rm(dir, { recursive: true, force: true });
}

console.log("storage-policy.test.ts ok — 관리탭 값 우선 · DB 다운에도 정책 응답 · copytruncate(inode 유지) · keep 초과 삭제 · 공유캐시 기본 안전(홈 이전 opt-in) · dirSize 예산/심링크");
