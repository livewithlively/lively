// propose CLI — MCP 툴과 동일한 검증 쓰기 함수를 공유(단일 진실). 사람/하네스가 터미널에서 동일하게 구동.
// 사용:
//   node --env-file-if-exists=.env dist/items/propose-cli.js domain  --item 123 --key campaigns --by llm --evidence "본문 인용 …" [--repo X] [--confidence 0.7]
//   node --env-file-if-exists=.env dist/items/propose-cli.js project --item 123 --key explore-feed --by manual
//   node --env-file-if-exists=.env dist/items/propose-cli.js domain  --item 123 --key campaigns --confirm   ← state='confirmed' 로 못 박음(사람 큐레이션)
//   node --env-file-if-exists=.env dist/items/propose-cli.js domain  --item 123 --key campaigns --reject --evidence "기각 사유"
//     ← state='rejected' 로 기각(사람 큐레이션). 이후 rule/llm 재제안 영구 차단, 부활은 --confirm 만.
import {
  initItemSchema, proposeItemDomain, proposeItemProject,
  confirmItemDomain, confirmItemProject,
  rejectItemDomain, rejectItemProject, type MappedBy,
} from "./store.js";
import { logger } from "../log.js";

function argVal(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i > -1 ? process.argv[i + 1] : undefined;
}
function hasFlag(flag: string): boolean {
  return process.argv.includes(flag);
}

const kind = process.argv[2]; // 'domain' | 'project'
const itemId = Number(argVal("--item"));
const key = argVal("--key");
const by = (argVal("--by") ?? "manual") as MappedBy;
const repo = argVal("--repo");
const evidence = argVal("--evidence");
const confRaw = argVal("--confidence");
const confidence = confRaw != null ? Number(confRaw) : undefined;
const confirm = hasFlag("--confirm"); // proposed → confirmed(state) 전이.
const reject = hasFlag("--reject");   // → rejected 전이(사람 큐레이션). --evidence 는 기각 사유로 audit 에 기록.

function usage(): never {
  console.error(
    "사용: propose-cli <domain|project> --item <id> --key <key> [--by rule|llm|manual] [--confirm | --reject] [--repo X] [--confidence 0..1] [--evidence \"…\"]",
  );
  process.exit(1);
}

if ((kind !== "domain" && kind !== "project") || !Number.isFinite(itemId) || !key) usage();
if (confirm && reject) {
  console.error("--confirm 과 --reject 는 동시에 줄 수 없습니다");
  usage();
}

await initItemSchema();

// CLI 발 쓰기 출처 표식(감사 완전성) — store 의 item_mapping_audit 행에 source/actor 로 영속.
const source = "cli";
const actor = process.env.USER ?? process.env.LOGNAME ?? "unknown";
const audit = { source, actor };
logger.info({ audit: kind === "domain" ? "item_domain_propose" : "item_project_propose", source, actor, itemId, key, by, confirm, reject });

try {
  let result: unknown;
  if (reject) {
    // 기각: state='rejected'. --by 무시(기각은 사람 진실), --evidence 는 기각 사유(audit.evidence).
    // 이후 rule/llm 재제안은 skipped-rejected 로 영구 차단 — 부활은 --confirm 만.
    result = kind === "domain"
      ? await rejectItemDomain({ itemId, domainKey: key!, repo, reason: evidence }, { audit })
      : await rejectItemProject({ itemId, projectKey: key!, repo, reason: evidence }, { audit });
  } else if (confirm) {
    // 확정: state='confirmed', mapped_by='manual'. --by 는 무시(확정은 사람 진실).
    result = kind === "domain"
      ? await confirmItemDomain({ itemId, domainKey: key!, repo, confidence, evidence }, { audit })
      : await confirmItemProject({ itemId, projectKey: key!, repo, confidence, evidence }, { audit });
  } else {
    result = kind === "domain"
      ? await proposeItemDomain({ itemId, domainKey: key!, mappedBy: by, repo, confidence, evidence }, { audit })
      : await proposeItemProject({ itemId, projectKey: key!, mappedBy: by, repo, confidence, evidence }, { audit });
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(0);
} catch (err) {
  // 검증 거부는 비-0 종료(하네스가 실패로 인지).
  console.error(`거부: ${(err as Error).message}`);
  process.exit(1);
}
