// 셀프호스트 다중 워크스페이스 **활성화 상태**(#1750 S1) — 상태파일이 유일한 스위치다.
//
// 왜 env 가 아니라 파일인가: 셀프서브가 목적이다. 고객 박스의 .env·plist 는 게이트웨이가 못 고치지만
//  stateDir 은 게이트웨이 소유다(ops/state-dir 규약). 활성화 capability 가 이 파일을 쓰고 프로세스를
//  끝내면, 상시구동 슈퍼바이저(launchd/systemd)가 재기동하며 새 상태로 뜬다 — 사람 손 0.
//
// 파일: <stateRoot>/tenancy/runtime.json (0600 — app_dsn 에 앱 role 비밀번호가 들어 있다)
//  { "mode": "registry", "app_dsn": "postgres://lvly_app:…" }
//
// 읽는 곳 둘, 시점이 다르다:
//  · boot/tenancy-env.ts — **부팅 최초**(client.ts 로드 전) readTenancyRuntimeSync 동기 읽기 → env 재배선.
//    이 모듈은 DB 무관 leaf 체인(state-dir→log)만 딛으므로 그 시점 import 가 안전하다(테스트가 잠근다).
//  · 활성화 capability — 쓰기(writeTenancyRuntime).
import path from "node:path";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { stateRoot } from "../../ops/state-dir.js";

export interface TenancyRuntime {
  mode: "registry";
  app_dsn: string;
}

export function tenancyRuntimePath(): string {
  return path.join(stateRoot(), "tenancy", "runtime.json");
}

/** 동기 읽기 — 부팅 경로용(비동기가 끼면 import 순서 보장이 깨진다). 없거나 파손이면 null. */
export function readTenancyRuntimeSync(p: string = tenancyRuntimePath()): TenancyRuntime | null {
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as Record<string, unknown>;
    if (raw?.mode !== "registry") return null;
    const dsn = String(raw.app_dsn ?? "").trim();
    if (!/^postgres(ql)?:\/\//.test(dsn)) return null;
    return { mode: "registry", app_dsn: dsn };
  } catch { return null; }
}

export async function writeTenancyRuntime(rt: TenancyRuntime): Promise<void> {
  const p = tenancyRuntimePath();
  await fsp.mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp-${process.pid}`;
  await fsp.writeFile(tmp, JSON.stringify(rt, null, 2), { mode: 0o600 });
  await fsp.rename(tmp, p);
}

/** 지금 프로세스가 registry 모드로 떠 있는가 — tenancy-env 가 부팅 때 env 로 표시한다. */
export function registryModeActive(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.LIVELY_TENANCY_MODE || "").trim().toLowerCase() === "registry";
}
