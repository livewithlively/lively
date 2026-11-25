// 세션 요청 종류 목록(#5713) — **새 종류는 여기 한 줄**(+ 화면 쪽 web/asks/kinds.ts 한 줄). 등록부 계약은 ../kinds.ts 머리말.
//  등록 순서 = 도구 목록에 서는 순서다(표면 스냅샷이 순서까지 본다).
import { registerAskKind, askKinds } from "../kinds.js";
import { secretAskKind } from "./secret.js";
import { choiceAskKind } from "./choice.js";
import { uploadAskKind } from "./upload.js";

let done = false;
/** 내장 종류를 등록한다(멱등 — 여러 모듈이 불러도 한 번만). */
export function registerBuiltinAskKinds(): void {
  if (done) return;
  done = true;
  for (const k of [secretAskKind, choiceAskKind, uploadAskKind]) registerAskKind(k);
}

export { askKinds };
