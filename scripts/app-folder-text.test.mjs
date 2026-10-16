// 앱빌더 «배포 설정» 앱 폴더 줄(#4785)의 순수 규칙(web/lib/app-folder-text.ts) — 서버 칸 읽기 · 상태 조합별 문장 · 입력 검사 · 저장 알림 글.
//  컴파일된 모듈(public/app/lib/app-folder-text.js)을 돌린다 — 빌드가 없으면 건너뛰고 그 사실을 적는다(CI 의 run-tests --build 가 돈다).
//  이게 틀리면: 셀프호스트에서 걸리지도 않는 상한을 걸 수 있는 것처럼 보이거나, 정비가 멎은 날 낡은 쓰는 양 · «5분 안에 적용» 을
//   지금 일처럼 말하거나, 상한을 낮춘 직후(아직 쓸 수 있는데) «가득 찼다» 고 말한다.
import { strict as assert } from "node:assert";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const mod = join(root, "public/app/lib/app-folder-text.js");
if (!existsSync(mod)) { console.log("app-folder-text: 빌드 없음(public/app/lib/app-folder-text.js) — 건너뜀"); process.exit(0); }
const T = await import(mod);

let pass = 0, fail = 0;
const check = (ok, name) => { if (ok) { pass++; console.log("ok  " + name); } else { fail++; console.error("FAIL  " + name); } };
const GiB = 1024 ** 3;
const when = (ms) => `@${ms}`;
const view = (o) => ({ limitGb: null, usedBytes: null, appliedGb: null, measuredAt: 0, stale: false, level: 0, canSet: true, enforced: true, ...o });

// ── 서버 칸 읽기 ──
const v = T.folderView({ limit_gb: 5, used_bytes: 4 * GiB, applied_limit_gb: 5, measured_at: "2026-10-16T10:00:00.000Z", stale: true, level: 80, can_set: true, enforced: true });
check(v.limitGb === 5 && v.usedBytes === 4 * GiB && v.appliedGb === 5 && v.measuredAt === Date.parse("2026-10-16T10:00:00.000Z") && v.stale && v.level === 80 && v.canSet && v.enforced,
  "V1 서버 칸을 그대로 읽는다(잰 때는 ms)");
const z = T.folderView(undefined);
check(z.limitGb === null && z.usedBytes === null && z.measuredAt === 0 && !z.stale && z.level === 0 && !z.canSet && !z.enforced, "V2 칸이 없으면(옛 서버) 안 잼 · 바꿀 수 없음 · 걸지 않음으로 읽힌다");

// ── 줄 문장 ──
const self = T.folderLine(view({ enforced: false, limitGb: 5, usedBytes: GiB, appliedGb: 5 }), when);
check(/걸리지 않아요/.test(self) && !/쓰고 있어요|5분/.test(self), "L1 셀프호스트 — «걸리지 않는다» 만 말한다(쓰는 양 · 5분 약속 없음)");
const none = T.folderLine(view({}), when);
const noneLim = T.folderLine(view({ limitGb: 3 }), when);
check(/아직 재지 않았어요/.test(none) && !/상한은/.test(none) && /3GiB로 정해 두었어요/.test(noneLim), "L2 아직 안 잼 — 정해 둔 상한이 있으면 그것도 말한다");
const unl = T.folderLine(view({ usedBytes: 1.5 * 1024 ** 2 }), when);
check(/지금 1\.5MiB를 쓰고 있어요/.test(unl) && /상한은 없어요/.test(unl) && !/5분/.test(unl), "L3 상한 없음 — 쓰는 양만");
const l80 = T.folderLine(view({ limitGb: 5, appliedGb: 5, usedBytes: 4.2 * GiB, level: 80 }), when);
const l100 = T.folderLine(view({ limitGb: 5, appliedGb: 5, usedBytes: 5 * GiB, level: 100 }), when);
const l0 = T.folderLine(view({ limitGb: 5, appliedGb: 5, usedBytes: GiB, level: 0 }), when);
check(/80%를 넘었어요/.test(l80) && !/가득/.test(l80) && /가득 차서/.test(l100) && !/80%|가득/.test(l0), "L4 단계 문장 — 80 · 100 · 0");
const lower = T.folderLine(view({ limitGb: 4, appliedGb: 5, usedBytes: 4.5 * GiB, level: 80 }), when);
check(/상한은 5GiB예요/.test(lower) && /80%를 넘었어요/.test(lower) && !/가득/.test(lower) && /새 상한 4GiB는 5분 안에 적용돼요/.test(lower),
  "L5 상한을 낮춘 직후(정비 전) — 걸린 상한으로 말하고(가득 아님) 새 상한은 5분 안에 적용된다고");
const cleared = T.folderLine(view({ limitGb: null, appliedGb: 5, usedBytes: GiB }), when);
check(/상한을 없앤 것은 5분 안에 적용돼요/.test(cleared), "L6 상한을 없앤 직후 — 5분 안에 적용");
const stale = T.folderLine(view({ stale: true, measuredAt: 42, limitGb: 4, appliedGb: 5, usedBytes: 5 * GiB, level: 100 }), when);
check(/마지막으로 잰 때\(@42\) 5\.0GiB를 쓰고 있었어요/.test(stale) && /그때 상한은 5GiB였어요/.test(stale) && !/가득|80%|5분/.test(stale),
  "L7 낡은 값 — 잰 때를 말하고 단계 · «5분 안에 적용» 은 말하지 않는다(정비가 멎었을 수 있다)");
const staleNone = T.folderLine(view({ stale: true, measuredAt: 7, usedBytes: GiB }), when);
check(/그때 상한은 없었어요/.test(staleNone), "L8 낡은 값 · 상한 없음");

// ── 입력 · 저장 글 ──
const ok = (raw, gb) => { const p = T.parseFolderInput(raw); return "gb" in p && p.gb === gb; };
const bad = (raw) => "error" in T.parseFolderInput(raw);
check(ok("", null) && ok("  ", null) && ok("1", 1) && ok(" 25 ", 25) && ok(String(T.FOLDER_LIMIT_MAX_GB), T.FOLDER_LIMIT_MAX_GB), "I1 빈 값은 없앰 · 1 · 최댓값은 받는다");
check(T.FOLDER_LIMIT_MAX_GB === 1000 && bad("0") && bad("1001") && bad("1.5") && bad("-1") && bad("abc"), "I2 최댓값은 1000(서버 · CP 와 같은 자) · 0 · 1001 · 소수 · 음수 · 글자는 까닭을 돌려준다");
check(/1에서 1000 사이/.test(T.parseFolderInput("0").error), "I3 까닭은 범위를 말한다");
check(T.folderSavedText(null, false) === "앱 폴더 상한을 없앴어요. 5분 안에 적용돼요." && /4GiB로 바꿨어요\. 5분 안에 적용돼요\.$/.test(T.folderSavedText(4, false))
  && /4GiB로 바꿨어요/.test(T.folderSavedText(4, true)) && /더 쓸 수 없어요/.test(T.folderSavedText(4, true)), "S1 저장 글 — 경고여도 «바꿨어요» 를 먼저 말한다 · «GiB로» 붙여 쓴다");

console.log(`\napp-folder-text: ${pass} 통과 · ${fail} 실패`);
process.exit(fail ? 1 : 0);
