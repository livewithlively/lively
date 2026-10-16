// 자료 보기 화면(#4672)의 서버 몫 — 링크(#/f?root=&path=) 하나가 가리키는 자리의 «정보 · 속한 곳 · 자료».
//  화면(web/filepage)은 미리보기와 함께 이것을 받아 정보 칸(종류 · 크기 · 고친 때 · 위치 · 주소 · 볼 수 있는 사람 · 올린 사람 · 여기서 나온 지식)과
//  «속한 프로젝트 · 앱으로 가기» 문을 그린다.
//
//  부르는 쪽은 홈 탐색기 라우트 하나다(terminal/terminal-files.ts browse/info). 그 라우트가 판정(공개범위 · 앱 동의 — 안 보이면 404)과
//   경로 봉쇄(.. · 링크로 바깥)를 건 **뒤에** 부른다 — 여기서는 보여도 되는 자리를 받아 모양만 만든다. 살아 있는 의존(파일 시스템 · DB)은
//   FileInfoDeps 로 받는다(시험이 가짜를 꽂는다 — file-access.ts 와 같은 자세).
import path from "node:path";
import { ADDRESS_APP_ID_RE, formatAddress, parseAddress } from "./address.js";

/** 이 자리가 속한 곳 — 화면의 «위치» 와 «○○ 로 가기» 문. */
export type FilePlace =
  /** 프로젝트 폴더 안(그 프로젝트를 이 사람이 볼 수 있을 때만 이 꼴이다) */
  | { kind: "project"; id: number; name: string; folder: string }
  /** 앱 폴더 안 — 이름은 이 사람이 보는 판의 것 */
  | { kind: "app"; id: string; name: string }
  /** 그 밖 공유 폴더 — 맨 위 폴더 이름(공유 자리 자신이면 "") */
  | { kind: "folder"; folder: string }
  /** 개인 폴더 — 여는 사람 자신의 폴더 */
  | { kind: "personal" };

/** 이 파일의 자료(올린 파일 1개 = 자료 1건, #1881) — 이 사람이 그 자료를 볼 수 있을 때만. */
export interface FileViewSource {
  id: number;
  title: string | null;
  /** 들어온 길 — 'generated' 면 AI 세션이 만든 파일(자료 앱 «라이블리에서 만든 자료»), 그 밖은 사람이 올린 것 */
  entry: string | null;
  /** 올린 사람(구성원 id · 표시 이름 — 이름은 이메일일 수 있다) */
  uploaderId: string | null;
  uploaderName: string | null;
  /** 자료가 처음 생긴 때(올린 때) */
  createdAt: string | null;
  /** 이 자료에서 나온 지식(이 사람이 볼 수 있는 것만) */
  knowledge: Array<{ name: string; title: string | null }>;
}

export interface FileViewInfo {
  /** 링크의 root(shared · personal · apps)와 그 자리 기준 상대경로('/' 구분 · 자리 자신이면 "") */
  root: string;
  path: string;
  /** 마지막 마디(자리 자신이면 "") */
  name: string;
  type: "file" | "dir";
  /** 폴더는 0 */
  size: number;
  /** ms(floor) — 모르면 0 */
  mtime: number;
  /** 파일 주소(shared/… · apps/…) — 개인 폴더 · 점으로 시작하는 마디가 든 자리는 주소가 없다(null) */
  address: string | null;
  place: FilePlace;
  /** 전원 공개가 아님 — 공유 폴더 공개범위(일부 공개) · 프로젝트 공개범위. 탐색기의 🔒 와 같은 뜻 */
  locked: boolean;
  source: FileViewSource | null;
}

export interface FileInfoDeps {
  /** 링크를 따라간 stat(격리 멤버면 그 uid 로). 없으면 null */
  stat(abs: string): Promise<{ file: boolean; dir: boolean; size: number; mtime?: number } | null>;
  /** 공유 자리 기준 경로가 든 프로젝트 — 이 사람이 볼 수 있을 때만, 아니면 null */
  projectAt(rel: string): Promise<{ id: number; name: string; folder: string } | null>;
  /** 앱 이름(이 사람이 보는 판). 못 읽으면 null(화면은 앱 id 로 쓴다) */
  appTitle(appId: string): Promise<string | null>;
  /** 전원 공개가 아닌가(공유 자리 기준 경로) */
  locked(rel: string): Promise<boolean>;
  /** 이 파일의 자료 — 없거나 이 사람이 못 보면 null */
  sourceAt(abs: string): Promise<FileViewSource | null>;
}

/** 링크 root 와 그 자리 기준 상대경로 → 파일 주소. 개인 폴더 · 점으로 시작하는 마디가 든 경로는 주소가 없다(null — files/address.ts 규칙). 순수. */
export function addressOfLink(root: string, rel: string): string | null {
  if (root !== "shared" && root !== "apps") return null;
  try { return formatAddress(parseAddress(rel ? `${root}/${rel}` : root)); } catch { return null; }
}

/**
 * 앱 폴더 링크(root apps)가 가리키는 앱 — 판정이 본 자리 그대로 읽어, 첫 마디가 앱 id 꼴(files/address ADDRESS_APP_ID_RE)일 때만 그 id, 아니면 "". 순수.
 *  동의 안내(browse/info)는 판정에서 떨어진 링크를 이 값으로만 묻는다 — 날 글자(NUL · 꼴이 아닌 이름)를 DB 에 넘기지 않고,
 *  `crmx/../crm/a` 처럼 접히는 링크는 접힌 경로(실제로 판정받은 자리)의 앱으로 안내한다.
 *  읽는 법은 판정과 같아야 한다: 경로는 자리 찾기(terminal/profiles resolveRootPath)처럼 앞의 `/` · `\` 만 떼고 `/` 로만 접고,
 *  첫 마디는 앱 폴더 게이트(terminal-files browseGate)처럼 `/` · `\` 어느 쪽에서든 자른다.
 */
export function appIdOfLink(rel: string): string {
  const segs: string[] = [];
  for (const s of String(rel ?? "").replace(/^[/\\]+/, "").split("/")) {
    if (!s || s === ".") continue;
    if (s === "..") { if (!segs.length) return ""; segs.pop(); continue; }
    segs.push(s);
  }
  const first = (segs[0] ?? "").split("\\")[0] ?? "";
  return ADDRESS_APP_ID_RE.test(first) ? first : "";
}

/** 공유 자리에서 프로젝트 밖 자리의 «위치» — 맨 위 폴더 이름(자리 자신이나 맨 위 파일이면 ""). 순수. */
export function topFolderOf(rel: string, isDir: boolean): string {
  const segs = String(rel ?? "").split("/").filter(Boolean);
  if (!segs.length) return "";
  return segs.length >= 2 || isDir ? segs[0]! : "";
}

/**
 * 판정을 지난 자리 하나의 정보. 그 자리에 아무것도 없으면 null(부르는 쪽이 404 — 안 보이는 것과 같은 답).
 *  root 는 링크의 root, base 는 그 자리의 기준 경로(resolveRootPath), abs 는 봉쇄를 지난 절대경로다.
 */
export async function buildFileInfo(root: string, base: string, abs: string, deps: FileInfoDeps): Promise<FileViewInfo | null> {
  const st = await deps.stat(abs);
  if (!st || (!st.file && !st.dir)) return null;
  const rel = path.relative(base, abs).split(path.sep).join("/");
  const type = st.dir ? "dir" : "file";
  let place: FilePlace;
  if (root === "personal") place = { kind: "personal" };
  else if (root === "apps") {
    const appId = rel.split("/")[0] ?? "";
    place = appId ? { kind: "app", id: appId, name: (await deps.appTitle(appId)) ?? appId } : { kind: "folder", folder: "" };
  } else {
    const p = rel ? await deps.projectAt(rel) : null;
    place = p ? { kind: "project", id: p.id, name: p.name, folder: p.folder } : { kind: "folder", folder: topFolderOf(rel, type === "dir") };
  }
  return {
    root, path: rel, name: rel ? rel.split("/").pop()! : "", type,
    size: type === "file" ? st.size : 0, mtime: st.mtime ?? 0,
    address: addressOfLink(root, rel),
    place,
    locked: root === "shared" && rel ? await deps.locked(rel) : false,
    //  자료는 파일만(폴더는 자료가 아니다). 앱 폴더 파일은 자료를 만들지 않는다(#4673 결정 ①) — 물어볼 것도 없다.
    source: type === "file" && root !== "apps" ? await deps.sourceAt(abs) : null,
  };
}
