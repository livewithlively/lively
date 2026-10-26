// 시험 러너의 차례 — 어떤 파일을 언제 띄우나(#5029). run-tests.mjs 가 쓰고, test-runner-schedule.test.mjs 가 규칙과
//  실제 러너의 동작을 함께 잰다(자식 env 경계는 test-runner-env.mjs — 다른 관심사라 따로 둔다).
//
// 혼자 도는 시험 — 벽시계 마감을 단언하는 시험(훅이 1.2초 안에 답을 못 받으면 끊는다 · 1.5초 예산의 70% 지점에서 멈춘다 …)은
//  다른 시험과 CPU 를 나눠 쓰면 시험 프로세스 안의 가짜 게이트웨이가 제때 못 답해 흔들린다. 2코어 중앙 박스(gVisor)는 기본 -j 2 에서
//  그런 넷이 빨갰고 혼자 돌리면 초록이었다(4코어 CI 는 여유가 있어 덜 드러났다 — 그래도 project-sync-ledger 는 10-21~22 에 네 번
//  빨갰다). 그런 파일은 머리에 `// @lively-test exclusive` 를 달고, 러너는 병렬 묶음을 다 돌린 뒤 하나씩 혼자 돌린다.
//  ⚠ 상한을 늘려 흔들림을 덮는 것과 다르다 — 그 시험이 재는 것이 제품의 마감 동작 자체라, 상한을 바꾸면 사양이 바뀐다.
import { openSync, readSync, closeSync } from "node:fs";

/** 표식을 찾는 머리 — 앞 4KB(바이트). 러너도 시험도 이 함수 하나로 읽는다(창이 둘이면 «시험은 봤는데 러너는 못 본» 표식이 생긴다).
 *  통째로 안 읽는 까닭: 시험 파일 1천여 개를 다 읽으면 9p 공유 폴더(중앙 박스)에서 그것만으로 느려진다. */
export const HEAD_BYTES = 4096;
export function readHead(file) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(HEAD_BYTES);
    return buf.toString("utf8", 0, readSync(fd, buf, 0, HEAD_BYTES, 0));
  } finally { closeSync(fd); }
}

const SOLO_MARK = /^\s*\/\/\s*@lively-test\s+exclusive\b/m;
/** 글에 표식 줄이 있나 — 러너는 readHead() 의 머리에만 묻는다. 시험 쪽 린트는 파일 전체에도 묻는다(창 밖 표식 찾기). */
export const isSoloTest = (text) => SOLO_MARK.test(String(text ?? ""));
/** 혼자 도는 것을 맨 뒤로 — 각 묶음 안의 순서는 그대로 둔다. */
export const soloLast = (files, solo) => [...files.filter((f) => !solo.has(f)), ...files.filter((f) => solo.has(f))];
/** 다음 파일을 지금 띄워도 되나 — 혼자 도는 파일은 아무것도 안 돌 때만, 그 밖의 파일은 동시 실행수 안에서.
 *  혼자 도는 파일이 맨 뒤에 모여 있으니(soloLast) 그것이 도는 동안 보통 파일이 끼어들 일은 없다. */
export const mayStart = (nextIsSolo, running, jobs) => (nextIsSolo ? running === 0 : running < jobs);
