// per-member 브로커 엔트리(#746 T4) — 게이트웨이(또는 managed-session keep-alive)가 멤버당 하나 spawn.
//  기동 시 env 로 구성(자격도 env/파일로 주입 — 브로커 uid 만 읽음). unix 소켓 열고 0660(브로커 uid + lively 그룹).
//  spawn 예(운영자/게이트웨이): sudo -u broker_<m> LIVELY_BROKER_SOCKET=/run/lively-broker/<m>.sock \
//    LIVELY_BROKER_MEMBER=<m> LIVELY_BROKER_WORKROOT=/home/box_<m>/work \
//    LIVELY_BROKER_ALLOWED_TOOLS=git,kubectl,terraform,helm node dist/broker/index.js
import fs from "node:fs";
import path from "node:path";
import { createBrokerServer, type BrokerConfig } from "./server.js";

function envList(name: string, dflt: string[]): string[] {
  const v = process.env[name];
  if (!v) return dflt;
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

const socketPath = process.env.LIVELY_BROKER_SOCKET;
if (!socketPath) { console.error("LIVELY_BROKER_SOCKET 미설정"); process.exit(2); }
const member = process.env.LIVELY_BROKER_MEMBER || "unknown";
// workroot 는 spawn 시 명시 필수(멤버 작업영역). process.cwd() 폴백 금지(state-dir 가드레일 — 런타임 경로는 명시 주입).
const workroot = process.env.LIVELY_BROKER_WORKROOT;
if (!workroot) { console.error("LIVELY_BROKER_WORKROOT 미설정"); process.exit(2); }
const cfg: BrokerConfig = {
  member,
  allowedTools: envList("LIVELY_BROKER_ALLOWED_TOOLS", ["git", "kubectl", "terraform", "helm", "aws"]),
  workroot: fs.realpathSync(workroot),
  timeoutMs: Number(process.env.LIVELY_BROKER_TIMEOUT_MS) || 60000,
  // env: 이 프로세스 env 를 자식에 그대로(자격 포함). 응답엔 안 실림.
};

fs.mkdirSync(path.dirname(socketPath), { recursive: true });
try { fs.unlinkSync(socketPath); } catch { /* 이전 소켓 없음 */ }
const server = createBrokerServer(cfg);
server.listen(socketPath, () => {
  try { fs.chmodSync(socketPath, 0o660); } catch { /* 권한설정 실패는 무시(운영자 umask/그룹으로 보정) */ }
  console.log(`broker[${member}] listening ${socketPath} (tools: ${cfg.allowedTools.join(",")}, workroot: ${cfg.workroot})`);
});
const shutdown = (): void => { try { server.close(); fs.unlinkSync(socketPath); } catch { /* */ } process.exit(0); };
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
