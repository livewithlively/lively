// 파일 주소 → 디스크(#4673 · #4822) — 주소를 그 자리의 절대경로로 펴고(봉쇄 · 멤버 경계) 지금 무엇이 있는지 본다.
//  서명 주소 받는 곳(files/signed-routes)이 받기 · 올리기 때, 파일 주소 도구(capabilities/files)가 옛 주소를 따라갈 때(#4822) 같은 함수를 쓴다 —
//  두 곳의 봉쇄 · 멤버 경계가 갈리지 않게 한 벌로 둔다(라우터 모듈에 두면 도구 계층이 Express 라우터를 끌어온다).
import fsp from "node:fs/promises";
import type { LivelyUser } from "../context.js";
import { HttpError } from "../http-error.js";
import { resolveRootPath, userOsUser } from "../terminal/profiles.js";
import { memberStat, memberPathProbe } from "../terminal/terminal-member-fs.js";
import { isConfined, probeLocal } from "../terminal/path-jail.js";
import { isInAppFolder } from "./app-jail.js";
import { nfcPath } from "../terminal/upload-file.js";
import { appOfAddress, type FileAddress } from "./address.js";
import type { FileOp } from "./file-access.js";

/** 주소 → 절대경로 + 파일 op 를 내릴 uid. 앱 폴더 주소는 그 앱 폴더 안에서만 연다(app-jail) · 그 밖은 자리 안에서만(path-jail). */
export async function locateAddress(user: LivelyUser, a: FileAddress, op: FileOp): Promise<{ abs: string; base: string; osUser: string | null }> {
  const rel = op === "write" ? nfcPath(a.rel) : a.rel;   // 새로 만드는 이름은 NFC 정본(#1278b) · 읽기는 그대로(옛 NFD 파일)
  const osUser = await userOsUser(user);
  const { base, abs } = await resolveRootPath(user, a.root, rel, osUser);
  const probe = osUser ? (b: string, t: string) => memberPathProbe(osUser, b, t) : probeLocal;
  const app = appOfAddress(a);
  const ok = app ? await isInAppFolder(base, app.app, abs, probe) : await isConfined(base, abs, probe);
  if (!ok) throw new HttpError(400, "허용 경로를 벗어났습니다");
  return { abs, base, osUser };
}

/** 그 절대경로에 지금 무엇이 있나(없으면 null). 멤버 경계면 그 구성원 uid 로 본다. */
export async function statAt(abs: string, osUser: string | null): Promise<{ size: number; file: boolean; dir: boolean; mtime?: number } | null> {
  if (osUser) return memberStat(osUser, abs);
  try { const st = await fsp.stat(abs); return { size: st.size, file: st.isFile(), dir: st.isDirectory(), mtime: Math.floor(st.mtimeMs) }; }
  catch { return null; }
}
