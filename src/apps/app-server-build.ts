// 앱 서버 빌드(#4484 앱 v2-5) — 판 하나를 그 판을 저장한 사람의 세션 컨테이너에서 빌드해 zip 을 S3 에 둔다. 게이트웨이 쪽 진행.
//
//  흐름: 빌드 지문(app-server-config buildKeyOf)으로 이미 있는 zip 을 찾는다 → 없으면 지문 줄을 잡고(org_app_server_build, 한 번에 하나) →
//   S3 서명 주소(그 zip 키 하나 · PUT)를 만들고 → 세션 컨테이너에서 빌더(app-server-builder SERVER_BUILDER_JS)를 띄워 판 파일을 stdin 으로 흘려 넣고 →
//   결과 줄을 읽어 S3 에 실제로 올라왔는지(크기) 보고 → 줄을 ok/failed 로 닫는다.
//  ★ 빌드 자리 = 그 판을 **저장한 사람**의 세션(상민 2026-10-15) — 부르는 쪽(app-server-deploy)이 사람·세션을 골라 넘긴다. 여기서는 그 세션에서 돌릴 뿐이다.
//  게이트웨이는 빌드 코드를 돌리지 않는다(설치 스크립트 = 남이 쓴 임의 코드) — 바이트를 나르고 결과를 적기만 한다.
import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "../log.js";
import { HttpError } from "../http-error.js";
import type { AppBundle } from "./app-bundle.js";
import { BUNDLE_READ_CONCURRENCY } from "./app-bundle.js";
import { appBundleS3Config, blobTenant, getBlob, type BlobStoreKind } from "./app-blob-store.js";
import { SERVER_BUILDER_JS, ZIP_EXCLUDE, encodeBuildHeader, parseBuildResult, type BuildHeader, type BuildResult } from "./app-server-builder.js";
import { buildKeyOf, tailText, zipKeyFor, type AppServerDecl, type AppServerEnv } from "./app-server-config.js";
import type { AppServerPolicy } from "./app-server-policy.js";
import {
  claimServerBuild, finishServerBuild, getServerBuild, invalidateServerBuild, setServerBuildZipBytes, setServerBuildZipVersion, touchServerBuild, type ServerBuildRow,
} from "./app-server-store.js";
import { s3Delete, s3Head, s3PresignUrl, type S3Config } from "../net/aws/s3-lite.js";
import { resolveGatewayBaseCredsWithin } from "../net/aws/aws-broker.js";

/** 빌드할 자리 — 그 판을 저장한 사람과 그 사람의 세션(컨테이너가 떠 있어야 한다). */
export interface BuildSeat { memberId: string; sessionId: string }

export interface BuildInput {
  appId: string;
  versionNo: number;
  bundle: AppBundle;
  store: BlobStoreKind;
  decl: AppServerDecl;
  env: AppServerEnv;
  policy: AppServerPolicy;
  seat: BuildSeat;
}

export interface BuildDeps {
  /** 세션 컨테이너에서 argv 를 돌리는 자식 프로세스(시험이 갈아 끼운다). 기본 = 세션 경계 중계(execAtArgv). */
  spawnInSession?: (seat: BuildSeat, argv: string[]) => Promise<ChildProcess>;
  /** zip 서명 주소(시험이 로컬 주소로). */
  presignPut?: (key: string, expiresSec: number) => Promise<string>;
  /** S3 에 zip 이 실제로 있나(크기 · 지금 판 번호 — #4801). versionId 를 주면 그 판이 아직 있나(#4887 — 함수 판이 읽는 zip 판). */
  headZip?: (key: string, versionId?: string) => Promise<{ size: number; versionId?: string | null } | null>;
  /** 시험 — zip 지우기(빌드 도중 앱이 지워진 경우 · 앱 지우기). 기본 = S3. */
  deleteZip?: (key: string) => Promise<void>;
  readBlob?: (kind: BlobStoreKind, h: string) => Promise<Buffer | null>;
  now?: () => number;
}

/** 빌드 중 무엇을 하고 있나(같은 게이트웨이 안 — 상태 조회가 «지금 npm ci 중» 을 보인다). 키 = 워크스페이스 · 앱 · 지문. */
const live = new Map<string, { startedAt: number; last: string }>();
const liveKey = (appId: string, key: string): string => `${blobTenant()}:${appId}:${key}`;
export function liveBuildProgress(appId: string, key: string): { startedAt: number; last: string } | null { return live.get(liveKey(appId, key)) ?? null; }

const LOG_TAIL_BYTES = 64 * 1024;
const STDOUT_MAX = 1024 * 1024;
const LEASE_SEC = 120;
/** 세션 경계 중계의 «컨테이너 없음» 종료 코드(lvly-cloud tenant-image/session-exec-relay.cjs die(…, 44)). */
const RELAY_NO_CONTAINER = 44;

/** 빌드 지문(같은 값 = 같은 zip). */
export function buildKeyFor(i: Pick<BuildInput, "bundle" | "decl" | "env">): string {
  return buildKeyOf(i.bundle, i.decl, { runtime: i.env.runtime, arch: i.env.arch });
}

async function defaultSpawnInSession(seat: BuildSeat, argv: string[]): Promise<ChildProcess> {
  const { execAtArgv } = await import("../terminal/terminal-member-fs.js");
  const { resolveMemberOsUser } = await import("../terminal/terminal-isolation.js");
  const { userSlug } = await import("../terminal/profiles.js");
  const { sessionExecConfigured } = await import("../terminal/session-exec.js");
  if (!sessionExecConfigured()) throw new HttpError(503, "이 배포에는 세션 컨테이너 실행 길이 없어 앱 서버를 빌드할 수 없습니다");
  const osUser = await resolveMemberOsUser(userSlug({ userId: seat.memberId } as unknown as Parameters<typeof userSlug>[0]));
  if (!osUser) throw new HttpError(503, "빌드할 세션의 OS 계정을 찾지 못했습니다");
  const full = execAtArgv({ osUser, sessionId: seat.sessionId }, argv);
  return spawn(full[0]!, full.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
}

async function defaultPresignPut(cfg: S3Config, key: string, expiresSec: number): Promise<string> {
  const got = await resolveGatewayBaseCredsWithin(expiresSec * 1000);
  if (!got) throw new HttpError(503, "S3 자격이 없어 빌드 결과를 올릴 주소를 만들지 못했습니다");
  //  자격이 먼저 끝나면 주소도 그때 죽는다 — 그 시각까지로 줄인다(빌더가 받은 주소로 403 을 보며 헤매지 않게 · 그래도 1분은 둔다).
  const left = got.expiresAtMs ? Math.floor((got.expiresAtMs - Date.now()) / 1000) - 30 : expiresSec;
  return s3PresignUrl(cfg, key, { method: "PUT", expiresSec: Math.max(60, Math.min(expiresSec, left)), creds: got.creds, now: new Date() });
}

/** 판 파일을 차례로 꺼내 빌더 stdin 에 흘린다 — 앞의 몇 개를 미리 읽어 두고(동시 BUNDLE_READ_CONCURRENCY), 쓰기는 받는 쪽 속도를 따른다. */
async function pump(stdin: NodeJS.WritableStream, header: Buffer, files: AppBundle["files"], read: (h: string) => Promise<Buffer | null>): Promise<void> {
  const write = (b: Buffer): Promise<void> => new Promise((resolve, reject) => {
    const ok = stdin.write(b, (err) => { if (err) reject(err); });
    if (ok) resolve(); else stdin.once("drain", () => resolve());
  });
  await write(header);
  const ahead: Array<Promise<Buffer>> = [];
  const fetchAt = (i: number): Promise<Buffer> => {
    const p = read(files[i]!.h).then((b) => {
      if (!b) throw new HttpError(503, `판 파일을 저장소에서 찾지 못했습니다: ${files[i]!.p}`);
      if (b.length !== files[i]!.s) throw new HttpError(503, `판 파일 크기가 목록과 다릅니다: ${files[i]!.p}`);
      return b;
    });
    //  미리 읽어 둔 것이 차례가 오기 전에 실패해도 «처리 안 된 거절» 로 게이트웨이를 죽이지 않게 — 실패는 차례가 와서 await 할 때 던진다.
    p.catch(() => { /* 아래 await 가 받는다 */ });
    return p;
  };
  let next = 0;
  for (; next < Math.min(BUNDLE_READ_CONCURRENCY, files.length); next++) ahead.push(fetchAt(next));
  for (let i = 0; i < files.length; i++) {
    const b = await ahead[i]!;
    if (next < files.length) { ahead.push(fetchAt(next)); next++; }
    await write(b);
    ahead[i] = Promise.resolve(Buffer.alloc(0));   // 다 쓴 것은 놓아준다(메모리)
  }
  //  끝(EOF)은 중계가 전하지 않는다 — 빌더는 길이로 끝을 안다. 그래도 우리 쪽 파이프는 닫아 둔다.
  stdin.end();
}

/** 기록 끝 64KB 만 쥐는 고리. */
function tailRing(): { push: (d: Buffer) => void; text: () => string; lastLine: () => string } {
  let buf = Buffer.alloc(0);
  let cut = false;
  return {
    push: (d) => { buf = Buffer.concat([buf, d]); if (buf.length > LOG_TAIL_BYTES * 2) { buf = buf.subarray(buf.length - LOG_TAIL_BYTES); cut = true; } },
    text: () => {
      const over = buf.length > LOG_TAIL_BYTES;
      const s = buf.subarray(Math.max(0, buf.length - LOG_TAIL_BYTES)).toString("utf8");
      //  앞이 잘렸으면 첫 줄(조각)을 버린다 — 반쪽 줄 · 깨진 글자를 보이지 않게.
      return (cut || over) ? s.slice(s.indexOf("\n") + 1) : s;
    },
    lastLine: () => { const s = buf.subarray(Math.max(0, buf.length - 4096)).toString("utf8").trimEnd(); return s.slice(s.lastIndexOf("\n") + 1).slice(0, 300); },
  };
}

/**
 * 이 판의 zip 을 보장한다 — 같은 지문의 성공한 빌드가 있으면 그것(reused), 남이 빌드 중이면 끝날 때까지 기다린 결과, 아니면 지금 빌드한다.
 *  돌려주는 줄의 status 가 'failed' 면 실패(stage · error · log_tail). 던지는 것은 빌드를 시작조차 못 한 경우(설정 · 자격 · 세션 없음)뿐이다.
 */
export async function ensureServerBuild(input: BuildInput, deps: BuildDeps = {}): Promise<{ build: ServerBuildRow; reused: boolean; key: string }> {
  const key = buildKeyFor(input);
  const have = await usableBuild(await getServerBuild(input.appId, key), deps);
  if (have) return { build: have, reused: true, key };
  const claim = await claimServerBuild(input.appId, key, {
    version_no: input.versionNo, built_by: input.seat.memberId, session_id: input.seat.sessionId, leaseSec: LEASE_SEC,
  });
  if (!claim.claimed) {
    if (claim.row?.status === "ok") return { build: claim.row, reused: true, key };
    return { build: await waitForBuild(input.appId, key, input.policy.build_timeout_s + 180), reused: false, key };
  }
  return { build: await runBuild(input, key, deps), reused: false, key };
}

/**
 * 성공한 빌드를 쓸 수 있나 — zip 이 저장소에 그 크기로 있나 직접 본다(기록만 믿고 함수에 올리면 NoSuchKey 로 실패하고, 다시 해도 같은 줄을
 *  «재사용» 해서 스스로 못 고친다 — 격리 리뷰). 없거나 크기가 다르면 그 줄을 실패로 돌리고(다음 배포가 다시 빌드) null.
 *  저장소를 못 봤으면(일시 오류) 쓸 수 있다고 본다 — 올리기에서 다시 드러난다.
 *  #4801 판 번호 — 지금 판이 기록한 판과 다르면(누가 같은 키에 다시 올렸다) 그 빌드를 다시 만든다: 함수가 읽는 판이 «옛 판» 이 되면 버킷 수명 규칙이
 *   30일 뒤 지우고, 그러면 그 판을 읽던 함수가 멈춘다(Inactive). 판 번호를 모르는 옛 줄은 지금 판을 적어 둔다.
 */
export async function usableBuild(row: ServerBuildRow | null, deps: BuildDeps = {}): Promise<ServerBuildRow | null> {
  if (!row || row.status !== "ok" || !row.zip_key || !row.zip_sha256) return null;
  let head: { size: number; versionId?: string | null } | null;
  try {
    const s3 = appBundleS3Config();
    if (!deps.headZip && !s3) return row;
    //  공개 확인은 앱 설치 락 안에서 부른다 — 한 번 · 5초만(s3-lite «잠근 채 부르는 일은 attempts:1» 관례). 못 보면 아래에서 있다고 본다.
    head = deps.headZip ? await deps.headZip(row.zip_key) : await s3Head(s3!, row.zip_key, { attempts: 1, timeoutMs: 5_000 });
  } catch (e) {
    logger.warn({ err: e, appId: row.app_id, key: row.build_key }, "빌드 zip 을 확인하지 못했다 — 있다고 보고 진행(#4484)");
    return row;
  }
  if (!head) { await invalidateServerBuild(row.app_id, row.build_key, "빌드 결과(zip)가 저장소에 없습니다 — 다시 빌드합니다"); return null; }
  const why = row.zip_bytes != null && head.size !== Number(row.zip_bytes) ? `빌드 결과(zip) 크기가 기록과 다릅니다(${head.size} ≠ ${row.zip_bytes}) — 다시 빌드합니다`
    : row.zip_version && head.versionId && head.versionId !== row.zip_version ? "빌드 결과(zip)가 다른 판으로 바뀌었습니다 — 다시 빌드합니다"
    : null;
  if (why) { await invalidateServerBuild(row.app_id, row.build_key, why); return null; }
  let out = row;
  if (row.zip_bytes == null) {
    //  크기를 모르는 옛 줄 — 본 크기를 적는다(#4792 코드 저장 셈이 «모름 → 0 → 통과» 로 새지 않게 · 격리 리뷰).
    await setServerBuildZipBytes(row.app_id, row.build_key, head.size).catch(() => { /* 다음에 */ });
    out = { ...out, zip_bytes: head.size };
  }
  if (!row.zip_version && head.versionId) {
    await setServerBuildZipVersion(row.app_id, row.build_key, head.versionId).catch(() => { /* 다음에 */ });
    out = { ...out, zip_version: head.versionId };
  }
  return out;
}

/** 남이 잡은 빌드를 기다린다(같은 지문을 두 곳에서 동시에 넣은 경우). */
async function waitForBuild(appId: string, key: string, maxSec: number): Promise<ServerBuildRow> {
  const until = Date.now() + maxSec * 1000;
  for (;;) {
    const row = await getServerBuild(appId, key);
    if (row && row.status !== "building") return row;
    if (!row || Date.now() > until) throw new HttpError(504, "같은 코드를 다른 곳에서 빌드하고 있는데 끝나지 않았습니다 — 잠시 뒤 상태(app_server_status)를 보세요");
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function runBuild(input: BuildInput, key: string, deps: BuildDeps): Promise<ServerBuildRow> {
  const lk = liveKey(input.appId, key);
  const now = deps.now ?? Date.now;
  live.set(lk, { startedAt: now(), last: "빌드를 준비합니다" });
  const fail = async (stage: string, error: string, log = "", detail: Record<string, unknown> = {}): Promise<ServerBuildRow> => {
    const row = await finishServerBuild(input.appId, key, { ok: false, stage, error, log_tail: log ? tailText(log, LOG_TAIL_BYTES) : null, detail });
    return row ?? ({ app_id: input.appId, build_key: key, status: "failed", stage, error } as ServerBuildRow);
  };
  try {
    const s3 = appBundleS3Config();
    if (!s3 && !deps.presignPut) return await fail("setup", "판 묶음 버킷(LIVELY_APP_BUNDLE_BUCKET)이 없어 빌드 결과를 둘 곳이 없습니다");
    const zipKey = zipKeyFor(s3?.prefix ?? "", blobTenant(), input.appId, key);
    const deadlineMs = now() + input.policy.build_timeout_s * 1000;
    const uploadUrl = deps.presignPut ? await deps.presignPut(zipKey, input.policy.build_timeout_s + 600) : await defaultPresignPut(s3!, zipKey, input.policy.build_timeout_s + 600);
    const files = input.bundle.files.filter((f) => !ZIP_EXCLUDE.includes(f.p));
    const header: BuildHeader = {
      v: 1, deadline_ms: deadlineMs, files: files.map((f) => [f.p, f.s]),
      build: input.decl.build, start: input.decl.start, dir: input.decl.dir,
      unzipped_max: (250 - 5) * 1024 * 1024,   // Lambda 풀린 크기 250MB 에서 웹 어댑터 레이어(약 2MB)와 여유를 뺀다
      mem_floor_mb: input.policy.build_mem_floor_mb, heap_mb: input.policy.build_heap_mb, upload_url: uploadUrl,
    };
    let child: ChildProcess;
    try { child = await (deps.spawnInSession ?? defaultSpawnInSession)(input.seat, ["node", "-e", SERVER_BUILDER_JS]); }
    catch (e) { return await fail("session", `빌드할 세션에서 프로그램을 띄우지 못했습니다: ${(e as Error)?.message ?? e}`); }
    //  stdout 은 조각을 모았다가 한 번에 푼다 — 조각마다 글자로 바꾸면 경계에 걸린 한글이 깨진다(#4135 stream-text 와 같은 까닭).
    const outParts: Buffer[] = [];
    let outBytes = 0;
    const ring = tailRing();
    child.stdout?.on("data", (d: Buffer) => { if (outBytes < STDOUT_MAX) { outParts.push(d); outBytes += d.length; } });
    child.stderr?.on("data", (d: Buffer) => { ring.push(d); const l = ring.lastLine(); if (l) live.set(lk, { startedAt: live.get(lk)?.startedAt ?? now(), last: l }); });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.on("close", (code, signal) => resolve({ code, signal: signal ?? null }));
      child.on("error", (e) => { ring.push(Buffer.from(`\n[중계 오류] ${e.message}\n`)); resolve({ code: null, signal: null }); });
    });
    child.stdin?.on("error", () => { /* 빌더가 먼저 끝나 파이프가 닫힌 것 — 결과 줄이 말한다 */ });
    const beat = setInterval(() => { void touchServerBuild(input.appId, key, LEASE_SEC).catch(() => { /* 다음 박동에서 */ }); }, 30_000);
    //  빌더도 deadline 에 스스로 멈추지만, 중계가 매달리면 우리가 끊는다(빌더 상한 + 2분).
    const hard = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* 이미 끝 */ } }, input.policy.build_timeout_s * 1000 + 120_000);
    let pumpErr: unknown = null;
    if (child.stdin) {
      await pump(child.stdin, encodeBuildHeader(header), files, (h) => (deps.readBlob ?? getBlob)(input.store, h)).catch((e) => {
        pumpErr = e;
        try { child.kill("SIGKILL"); } catch { /* 이미 끝 */ }
      });
    }
    const ex = await exited;
    clearInterval(beat);
    clearTimeout(hard);
    const log = ring.text();
    if (pumpErr) return await fail("input", `판 파일을 빌더에 넘기지 못했습니다: ${(pumpErr as Error)?.message ?? pumpErr}`, log);
    const res: BuildResult | null = parseBuildResult(Buffer.concat(outParts).toString("utf8"));
    if (!res) {
      if (ex.code === RELAY_NO_CONTAINER) return await fail("session", "빌드할 세션이 꺼져 있습니다 — 그 세션을 다시 열고(또는 그 세션의 AI 가) 다시 빌드하세요", log);
      return await fail("crash", `빌더가 결과를 남기지 못하고 끝났습니다(종료 ${ex.code ?? ex.signal ?? "?"}) — 세션 메모리가 모자랐거나 연결이 끊겼을 수 있습니다`, log);
    }
    const detail = { steps: res.steps, warnings: res.warnings, mem: res.mem, ms: res.ms, install: res.install, build_cmd: res.build_cmd, start_cmd: res.start_cmd };
    if (!res.ok || !res.zip) return await fail(res.stage ?? "build", res.error ?? "빌드가 실패했습니다", log, detail);
    //  올라왔는지 직접 본다 — 빌더의 말만 믿고 함수를 고치지 않는다(크기가 다르면 올리기가 잘렸다).
    const head = deps.headZip ? await deps.headZip(zipKey) : await s3Head(s3!, zipKey).catch(() => null);
    if (!head || head.size !== res.zip.bytes) {
      return await fail("upload", `빌드 결과(zip)가 저장소에 ${head ? `다른 크기(${head.size} ≠ ${res.zip.bytes})로` : "없이"} 남았습니다 — 다시 빌드하세요`, log, detail);
    }
    //  #4801 지금 판 번호를 함께 적는다 — 함수가 이 판을 바로 읽는다(REFERENCE). 빌더가 말한 판이 아니라 우리가 본 판이다.
    const row = await finishServerBuild(input.appId, key, {
      ok: true, zip: { key: zipKey, bytes: res.zip.bytes, sha256_b64: res.zip.sha256_b64, unzipped: res.zip.unzipped, entries: res.zip.entries, version: head.versionId ?? null },
      log_tail: tailText(log, 16 * 1024), detail,
    });
    if (!row) {
      //  빌드하는 동안 앱(과 그 빌드 기록)이 지워졌다 — 방금 올린 zip 은 주인이 없다. 지운다(best-effort · 남으면 버킷 수명 규칙이 걷는다).
      await (deps.deleteZip ? deps.deleteZip(zipKey) : s3 ? s3Delete(s3, zipKey, { attempts: 1, timeoutMs: 10_000 }) : Promise.resolve()).catch(() => { /* best-effort */ });
      throw new HttpError(409, "빌드하는 동안 앱이 지워졌습니다");
    }
    return row;
  } catch (e) {
    logger.warn({ err: e, appId: input.appId, key }, "앱 서버 빌드 실패(#4484)");
    return await fail("internal", `빌드를 진행하지 못했습니다: ${(e as Error)?.message ?? e}`);
  } finally {
    live.delete(lk);
  }
}
