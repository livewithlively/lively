// [외부 앱 연결] 목록의 «두 축» 잣대(web/lib/connect-axes.ts) — 값으로 지킨다 (#3778, 원준 2026-09-20).
//
//  신고: «여기 페이지에서 노션~클릭업 등 외부 앱들 연결이 2종류인데 연결 됐는지 여부를 어떻게 표시할지
//   고민한 적 있지 않았나?» — 화면은 머리말에서 «연결이 두 가지» 라고 말해 놓고 카드는 한 축만 봤다.
//
//  사양(엣지 표 A1~D2)은 스크래치패드가 아니라 여기 단언 문구로 남는다. 화면이 지켜야 하는 약속 넷:
//   ① 두 축의 근거는 서로 다르다 — 한쪽으로 다른 쪽을 추정하지 않는다.
//   ② «연결됨» 묶음은 **어느 한 축이라도** 켜진 앱이다(자격만 보면 자료를 가져오는 앱이 «연결 안 함» 칸에 선다).
//   ③ 자료 가져오기가 없는 앱은 «꺼짐» 이 아니라 «없어요» 다 — 켤 수도 없는 것을 껐다고 말하지 않는다.
//   ④ 준비 중은 묶음에선 이기고, 카드의 두 축은 사실 그대로다(쓰던 연결을 없는 척하지 않는다).
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const ok = (cond, what) => { assert.ok(cond, what); pass++; };
const eq = (got, want, what) => { assert.deepEqual(got, want, what); pass++; };

const { COLLECT_APPS, COLLECT_PRESET_APP, appAxes, collectTally, listBucket } =
  await import(join(root, "public/app/lib/connect-axes.js"));

const on = (preset) => ({ preset_key: preset, enabled: true });
const off = (preset) => ({ preset_key: preset, enabled: false });
const tallyOf = (...rows) => collectTally(rows);

// 배선 — 관측 장치가 죽어 있으면 아래 단언은 통과하면서 아무것도 안 본다.
ok(typeof collectTally === "function" && typeof appAxes === "function" && typeof listBucket === "function",
  "W0 잣대 셋을 실제로 불러왔다");
ok(COLLECT_APPS.length >= 6 && Object.keys(COLLECT_PRESET_APP).length >= 8, "W1 표 둘이 비어 있지 않다");

// ── A. 수집기 셈 (collectTally) ─────────────────────────────────────────────
{
  const t = tallyOf(on("slack"), off("slack"), on("notion"), on("notion"));
  eq(t.get("slack"), { on: 1, off: 1 }, "A1 슬랙 — 검색 수집기 켜짐 · 봇 수집기 꺼짐을 따로 센다");
  eq(t.get("notion"), { on: 2, off: 0 }, "A2 노션 — 워크스페이스 둘이면 켜진 수집기도 둘(«2곳»의 근거)");
  eq(t.get("github"), undefined, "A3 수집기가 없는 앱은 표에 아예 없다");

  // 구글만 프리셋이 여럿인데 화면 카드는 한 줄이다(#1881 G2).
  eq(tallyOf(on("gdrive")).get("google"), { on: 1, off: 0 }, "A4 gdrive 는 google 카드로 접힌다");
  eq(tallyOf(on("gmail"), off("gdrive")).get("google"), { on: 1, off: 1 }, "A5 gmail·gdrive 는 같은 google 칸에 합쳐진다");

  //  화면에 카드가 없는 수집기(도메인 위키 등)는 제 이름으로 센다 — 버리면 앱이 늘 때마다 그 카드가
  //  영영 «꺼짐» 이라고 말한다. 대신 **남의 칸을 켜지는 않는다**(그게 실제 위험이다).
  {
    const t2 = tallyOf(on("domain-wiki"), on("discord"));
    eq(t2.get("domain-wiki"), { on: 1, off: 0 }, "A6 모르는 프리셋도 제 이름으로 센다");
    for (const app of COLLECT_APPS) eq(t2.get(app), undefined, `A6b ${app} 칸은 켜지지 않는다(엉뚱한 칸 금지)`);
  }
  eq(collectTally(null).size, 0, "A7 못 읽었으면 빈 표다(화면이 안 깨진다)");
  eq(tallyOf({ preset_key: "slack" }).get("slack"), { on: 0, off: 1 }, "A8 enabled 가 없으면 꺼진 것으로 센다");
  eq(tallyOf({ preset_key: "" }, {}).size, 0, "A9 preset 이 빈 행은 센 표에 들어가지 않는다");
}

// ── B. 두 축 판정 (appAxes) ────────────────────────────────────────────────
{
  const none = tallyOf();
  eq(appAxes("notion", "off", none), { use: "off", get: "off", getOn: 0 },
    "B1 노션 — 둘 다 안 켰다");
  eq(appAxes("notion", "off", tallyOf(on("notion"), on("notion"))), { use: "off", get: "on", getOn: 2 },
    "★B2 자격은 없는데 자료는 2곳에서 가져오는 중 — 카드가 그 사실을 말해야 한다(#2202 B1 이 목록에 남아 있던 자리)");
  eq(appAxes("github", "on", none), { use: "on", get: "off", getOn: 0 },
    "B3 GitHub — 계정은 연결했고 자료 가져오기는 아직");
  eq(appAxes("github", "on", tallyOf(on("github"))), { use: "on", get: "on", getOn: 1 },
    "B4 둘 다 켜짐(0→1 경계)");

  // ③ 없는 축은 «꺼짐» 이 아니다.
  eq(appAxes("prometheus", "on", none).get, "none", "★B5 자료 가져오기가 없는 앱은 «없어요»(끌 수 있는 것이 아니다)");
  eq(appAxes("claude-headless", "off", none).get, "none", "B6 헤드리스도 마찬가지");
  ok(COLLECT_APPS.includes("clickup") && !COLLECT_APPS.includes("prometheus"),
    "B7 명단은 «가진 앱» 을 적는다 — 없는 앱을 빼는 방식이 아니다");

  // 표가 낡아도 사실이 먼저 — 명단에 없는데 수집기가 돌면 «켜짐»(새로 들인 표가 만든 엣지).
  eq(appAxes("prometheus", "off", tallyOf(on("prometheus"))).get, "on",
    "B8 명단에 없어도 실제로 돌고 있으면 켜짐이다(표가 낡아도 거짓말하지 않는다)");

  // ④ 준비 중 앱의 축은 사실 그대로.
  eq(appAxes("google", "soon", none), { use: "soon", get: "off", getOn: 0 }, "B9 구글 — 준비 중");
  eq(appAxes("google", "on", tallyOf(on("gdrive"))), { use: "on", get: "on", getOn: 1 },
    "B10 준비 중이라도 이미 연결해 둔 사람에겐 켜진 그대로 보인다");
}

// ── C. 목록 묶음 (listBucket) ──────────────────────────────────────────────
{
  const none = tallyOf();
  eq(listBucket(appAxes("notion", "on", none), false), "on", "C1 자격만 켜져도 «연결된 앱»");
  eq(listBucket(appAxes("notion", "off", tallyOf(on("notion"))), false), "on",
    "★C2 자료 가져오기만 켜져도 «연결된 앱» — 종전엔 여기서 «연결할 수 있는 앱» 칸에 섰다");
  eq(listBucket(appAxes("figma", "off", none), false), "off", "C3 둘 다 꺼짐이면 «연결할 수 있는 앱»");
  eq(listBucket(appAxes("prometheus", "off", none), false), "off", "C4 축이 하나뿐인 앱도 판정은 같다");
  eq(listBucket(appAxes("google", "on", tallyOf(on("gdrive"))), true), "soon",
    "C5 준비 중은 묶음에서 연결 여부를 이긴다(#2243) — 그래도 카드의 두 축은 켜짐으로 남는다");
}

// ── D. 표 둘의 정합 ────────────────────────────────────────────────────────
{
  for (const app of COLLECT_APPS) {
    ok(Object.values(COLLECT_PRESET_APP).includes(app),
      `D1 «자료 가져오기가 있다»고 적은 앱 ${app} 은 프리셋 표로도 닿는다(둘이 어긋나면 영영 «꺼짐»)`);
  }
  ok(!COLLECT_PRESET_APP["prometheus"], "D2 축이 없는 앱은 프리셋 표에도 없다");
}

console.log(`connect-axes: ${pass} checks passed`);
