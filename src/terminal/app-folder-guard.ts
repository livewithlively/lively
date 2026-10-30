// 앱 폴더 자리 보호 (#4684) — 작업 폴더 안 `.lively/apps` 는 노드가 **세션마다** 앱 폴더를 붙이는 자리다(lvly-cloud sessionapps).
//  웹·API 로 그 아래에 쓰면 그 바이트는 공유 저장소의 빈 마운트 지점 폴더에 떨어진다 — 세션 안에서는 붙인 앱 폴더에 가려 안 보이고,
//  웹 목록에서는 점 이름이라 안 보인다. 아무도 못 보는 파일이 생기는 것이라 처음부터 받지 않는다(파일 주소 체계 #4671 결정).
//  읽기·지우기는 막지 않는다 — 읽으면 빈 폴더이고, 지워도 도는 세션의 마운트는 그대로다(다음 컨테이너가 자리를 다시 만든다).
import path from "node:path";
import { HttpError } from "../http-error.js";

/** 경로(상대·절대 어느 쪽이든)에 `.lively` 다음 `apps` 조각이 있나 — 작업 폴더가 어디든 그 아래의 자리를 잡는다. */
export function touchesAppFolderMount(p: unknown): boolean {
  //  정규화한 뒤에 본다 — `.`·`..` 조각이 끼어도 같은 곳이면 같은 판정이어야 한다.
  const segs = path.posix.normalize(String(p ?? "").replace(/\\/g, "/")).split("/").filter(Boolean);
  for (let i = 0; i + 1 < segs.length; i++) if (segs[i] === ".lively" && segs[i + 1] === "apps") return true;
  return false;
}

/** 쓰기 대상이 앱 폴더 자리면 403. 여러 경로(원본·목적지)를 한 번에 본다. */
export function assertNotAppFolderMount(...paths: unknown[]): void {
  if (paths.some(touchesAppFolderMount)) {
    throw new HttpError(403, "`.lively/apps` 아래는 세션에 붙인 앱 폴더 자리라 웹·API 로 쓰지 않습니다 — 앱 폴더의 파일은 그 앱이 붙은 세션 안에서 다룹니다");
  }
}
