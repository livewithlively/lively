// 로그 재니터(#813 T4) — 게이트웨이 로그 파일이 **무한히 자라지 못하게** 주기적으로 회전한다.
//
// 무엇이 문제였나: systemd 유닛이 `StandardOutput=append:<APP_DIR>/logs/gateway.log`(맥 plist 도 동일)로 **파일에 무한
//  append** 하는데 번들에 로테이션이 전혀 없었다(deploy/ 전체 logrotate|max-size grep 0). 상한이 없으니 박스 수명
//  (수년) 동안 계속 자란다. 고객 박스는 우리가 들여다보지도 못한다. (지식: gateway-disk-leak-audit-2026-07-13 L3)
//
// 왜 in-process 인가 — OS logrotate 를 안 쓴 이유:
//  ① **관리탭에서 설정 가능해야 한다.** 고객 박스엔 우리가 못 들어가므로 /etc/logrotate.d 는 사실상 아무도 못 바꾼다.
//  ② **크로스플랫폼.** 리눅스 고객 박스(systemd)와 맥 dev 박스(launchd)가 같은 코드로 동작한다(맥엔 logrotate 없음).
//
// 왜 copy + truncate 인가 — rename 하면 안 되는 이유:
//  systemd `append:` / launchd `StandardOutPath` 는 **그 파일의 fd 를 계속 쥐고 있다.** rename 하면 서비스는 이름만
//  바뀐 **같은 inode 에 계속 쓴다** → 새 gateway.log 는 영원히 비고 회전본만 자란다(= 회전이 조용히 실패).
//  그래서 내용을 복사해 두고 **원본을 제자리에서 truncate** 한다(logrotate 의 copytruncate 와 같은 전략).
//  O_APPEND 로 열려 있어 truncate 뒤의 쓰기는 offset 0 부터 간다(sparse hole 안 생김).
//  ⚠ 알려진 한계: copy~truncate 사이에 쓰인 몇 줄은 유실될 수 있다(logrotate copytruncate 와 동일). 로그엔 수용 가능.
import fsp from "node:fs/promises";
import path from "node:path";
import { logRoot } from "./state-dir.js";
import { logger } from "../log.js";

// 회전본(gateway.log.1)은 이 패턴에 안 걸린다 → 재회전되지 않는다.
const LOG_FILE = /\.(log|out|err)$/;
const SWEEP_MS = Number(process.env.LOG_JANITOR_INTERVAL_MS ?? 5 * 60_000);

export interface Rotated {
  file: string;
  bytesBefore: number;
}

/** 한 파일 회전 — .N 삭제 → .N-1…1 을 한 칸씩 밀고 → 원본을 .1 로 복사 → 원본 truncate. */
export async function rotateFile(file: string, keep: number): Promise<void> {
  // 회전본들은 서비스가 fd 를 안 쥐고 있으므로 rename 으로 밀어도 안전하다(원본만 copytruncate 대상).
  const oldest = `${file}.${keep}`;
  await fsp.rm(oldest, { force: true });
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    const to = `${file}.${i + 1}`;
    await fsp.rename(from, to).catch(() => { /* 아직 그 회전본이 없으면 그냥 넘어간다 */ });
  }
  if (keep >= 1) {
    const first = `${file}.1`;
    await fsp.copyFile(file, first); // ⚠ rename 금지 — 서비스가 원본 fd 를 쥐고 있다(위 주석).
  }
  await fsp.truncate(file, 0); // 제자리 비우기 — 서비스는 같은 fd 로 계속 쓴다(O_APPEND → offset 0 부터).
}

/** 로그 디렉터리 1회 스윕 — 상한 초과 파일만 회전한다. */
export async function sweepLogs(dir: string, maxMb: number, keep: number): Promise<Rotated[]> {
  const out: Rotated[] = [];
  if (maxMb <= 0) return out; // 0 = 회전 끔(관리탭에서 명시적으로 끈 경우)
  const maxBytes = maxMb * 1024 * 1024;
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return out; // logs/ 가 아직 없는 박스 — 할 일 없음(에러 아님)
  }
  for (const name of names) {
    if (!LOG_FILE.test(name)) continue;
    const file = path.join(dir, name);
    let size: number;
    try {
      const st = await fsp.stat(file);
      if (!st.isFile()) continue;
      size = st.size;
    } catch {
      continue;
    }
    if (size <= maxBytes) continue;
    try {
      await rotateFile(file, keep);
      out.push({ file: name, bytesBefore: size });
      logger.info({ file: name, bytesBefore: size, maxMb, keep }, "로그 회전(copytruncate)");
    } catch (err) {
      logger.warn({ err, file: name }, "로그 회전 실패 — 다음 스윕에 재시도");
    }
  }
  return out;
}

export interface LogFile {
  name: string;
  bytes: number;
  rotated: boolean; // 회전본(.1 …)인지 — UI 가 '현재 로그'와 '보관본'을 구분해 보여준다
}

/** 관리탭 표시용 — 로그 디렉터리의 파일과 크기. 회전본(.1 …)까지 포함해 '실제 총량'을 보여준다. */
export async function listLogs(dir: string): Promise<LogFile[]> {
  let names: string[];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const out: LogFile[] = [];
  for (const name of names) {
    const rotated = /\.(log|out|err)\.\d+$/.test(name);
    if (!LOG_FILE.test(name) && !rotated) continue;
    try {
      const st = await fsp.stat(path.join(dir, name));
      if (st.isFile()) out.push({ name, bytes: st.size, rotated });
    } catch { /* 스윕 중 사라졌을 수 있다 — 무시 */ }
  }
  return out.sort((a, b) => b.bytes - a.bytes);
}

let timer: NodeJS.Timeout | null = null;

/**
 * 주기 스윕 시작. loadPolicy 는 주입받는다 — 관리탭(DB) 값을 매 스윕마다 새로 읽어
 * **게이트웨이 재시작 없이** 설정이 반영되게 한다(임베딩 설정과 같은 관례).
 */
export function startLogJanitor(loadPolicy: () => Promise<{ log_max_mb: number; log_keep: number }>): void {
  if (timer) return;
  const sweep = async (): Promise<void> => {
    try {
      const p = await loadPolicy();
      await sweepLogs(logRoot(), p.log_max_mb, p.log_keep);
    } catch (err) {
      logger.warn({ err }, "로그 재니터 스윕 실패");
    }
  };
  timer = setInterval(() => { void sweep(); }, SWEEP_MS);
  timer.unref?.(); // 재니터가 프로세스 종료를 붙잡지 않게
  void sweep(); // 부팅 직후 1회 — 이미 커져 있는 로그를 다음 주기까지 방치하지 않는다
}

export function stopLogJanitor(): void {
  if (timer) { clearInterval(timer); timer = null; }
}
