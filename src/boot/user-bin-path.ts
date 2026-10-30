// 부팅 — 셀프호스트 게이트웨이의 PATH 에 그 사용자 몫 프로그램 폴더를 잇는다(#4970). 사연은 terminal/user-bin-path.ts 머리말.
//
// 왜 부팅에서 또 하나: 템플릿(deploy/lib/common.sh @PATH@)은 고쳤지만 이미 깔린 박스의 유닛은 다시 렌더될 때까지 옛 PATH 다.
//  tmux 서버·로그인 러너·설치 확인이 전부 이 프로세스의 PATH 를 물려받으므로, 여기서 한 번 고치면 셋이 함께 고쳐진다.
// · 세션 경계 중계가 있는 배포(매니지드)는 손대지 않는다 — 거기 하네스는 세션 컨테이너에 있고 게이트웨이 홈과 무관하다.
// · 윈도우 게이트웨이는 PATH 구분자·폴더 규약이 달라 손대지 않는다.
import os from "node:os";
import { execTopology } from "../exec-topology.js";
import { withUserBinDirs } from "../terminal/user-bin-path.js";

(() => {
  if (process.platform === "win32") return;
  if (execTopology().hooks.sessionExec) return;
  process.env.PATH = withUserBinDirs(process.env.PATH, process.env.HOME || os.homedir());
})();
