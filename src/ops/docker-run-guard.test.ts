// docker run 인자 검사기(#4487 · #5082 와 같이 씀) 단위 시험 — 코어가 짓는 꼴은 통과 · 박스를 내주는 인자는 거절.
// 실행: npm run build && node dist/ops/docker-run-guard.test.js
//  행 이름 G1~G20 은 사양 엣지 표(#4487 PR 2 A절 · G18~G20 은 #5082 요청)의 행 번호다.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DockerRunRejected, assertSafeDockerRun, type DockerRunPolicy } from "./docker-run-guard.js";
import { appRunArgs, appRunPolicy, buildRunArgs, buildRunPolicy, type AppRunSpec, type BuildRunSpec } from "../apps/app-server-docker.js";

let pass = 0;
const t = (name: string, fn: () => void): void => { fn(); pass++; console.log(`ok  ${name}`); };

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "drg-")));
const code = path.join(root, "fn", "t1", "lvly-app-a-w", "v", "1", "code");
const guard = path.join(root, "layers", "lvly-app-guard", "1", "files", "lively");
fs.mkdirSync(code, { recursive: true });
fs.mkdirSync(guard, { recursive: true });
fs.mkdirSync(path.join(root, "run"), { recursive: true });
const IMAGE = "node:22-bookworm-slim", NET = "lvly-apps";
const appSpec: AppRunSpec = {
  name: "lvly-app-a-w-v1", image: IMAGE, labels: { "lvly.app-server": "1", "lvly.fn": "lvly-app-a-w" }, network: NET, memoryMb: 512, tmpMb: 512, cpus: 0.5, pids: 512,
  user: "501:20", ro: [{ host: code, target: "/var/task" }, { host: guard, target: "/opt/lively" }], envFile: path.join(root, "run", "x.env"), guardPort: 8099,
  hostGateway: true, command: ["/bin/sh", "/opt/lively/bootstrap"],
};
const appPolicy = appRunPolicy(root, IMAGE, NET);
const okApp = appRunArgs(appSpec);
const rejects = (args: string[], policy: DockerRunPolicy, why: RegExp, label: string): void => {
  assert.throws(() => assertSafeDockerRun(args, policy), (e: unknown) => e instanceof DockerRunRejected && why.test(e.reason), label);
};
/** 이미지 바로 앞에 깃발을 끼운다(코어 꼴은 그대로 두고 하나만 더한 인자). */
const withFlag = (args: string[], ...extra: string[]): string[] => { const i = args.indexOf(IMAGE); return [...args.slice(0, i), ...extra, ...args.slice(i)]; };
/** 깃발 하나(와 그 값)를 뺀다. */
const without = (args: string[], flag: string, hasValue = true): string[] => {
  const i = args.indexOf(flag);
  assert.ok(i > 0, `${flag} 가 인자에 없다`);
  return [...args.slice(0, i), ...args.slice(i + (hasValue ? 2 : 1))];
};
/** 깃발의 값을 바꾼다. */
const swap = (args: string[], flag: string, value: string): string[] => { const i = args.indexOf(flag); assert.ok(i > 0); const out = [...args]; out[i + 1] = value; return out; };

t("G1 코어가 짓는 앱 서버 인자 · 빌드 인자는 통과(이미지 · 명령 돌려줌)", () => {
  const r = assertSafeDockerRun(okApp, appPolicy);
  assert.equal(r.image, IMAGE);
  assert.deepEqual(r.command, ["/bin/sh", "/opt/lively/bootstrap"]);
  const buildRoot = path.join(root, "build");
  const out = path.join(buildRoot, "b1", "out");
  fs.mkdirSync(out, { recursive: true });
  const b: BuildRunSpec = { name: "lvly-build-x", image: IMAGE, labels: { "lvly.app-build": "1" }, network: NET, memoryMb: 2048, cpus: 2, pids: 4096, user: "501:20",
    outDir: out, env: { HOME: "/tmp", npm_config_cache: "/tmp/.c", CI: "1" }, hostGateway: false, command: ["node", "-e", "1"] };
  assert.deepEqual(assertSafeDockerRun(buildRunArgs(b), buildRunPolicy(buildRoot, IMAGE, NET)).command, ["node", "-e", "1"]);
});

t("G2 박스를 내주는 깃발 — --privileged · --pid · --ipc · --cap-add · --device · --volumes-from · --userns · --entrypoint · --sysctl", () => {
  for (const extra of [["--privileged"], ["--pid", "host"], ["--ipc", "host"], ["--cap-add", "SYS_ADMIN"], ["--device", "/dev/sda"], ["--volumes-from", "x"],
    ["--userns", "host"], ["--entrypoint", "/bin/sh"], ["--sysctl", "net.ipv4.ip_forward=1"], ["--pid=host"]]) {
    rejects(withFlag(okApp, ...extra), appPolicy, /받지 않습니다/, extra.join(" "));
  }
});

t("G3 docker 소켓 마운트", () => {
  rejects(withFlag(okApp, "--volume", "/var/run/docker.sock:/var/run/docker.sock"), appPolicy, /docker 소켓/, "소켓");
  rejects(withFlag(okApp, "-v", `${root}/docker.sock:/opt/x:ro`), appPolicy, /docker 소켓/, "뿌리 안 이름이라도");
});

t("G4 뿌리 밖 원본 · 읽기 전용 뿌리에 쓰기 · 자리 꼴 밖", () => {
  rejects(withFlag(okApp, "--volume", "/etc:/opt/etc:ro"), appPolicy, /마운트 원본/, "뿌리 밖");
  rejects(withFlag(okApp, "--volume", `${code}:/opt/x`), appPolicy, /마운트 원본/, "쓰기(:ro 없음)");
  rejects(withFlag(okApp, "--volume", `${code}:/etc:ro`), appPolicy, /마운트 원본/, "자리 꼴 밖");
});

t("G5 뿌리 안 심링크가 밖을 가리키는 원본", () => {
  const link = path.join(root, "evil");
  fs.symlinkSync("/etc", link);
  rejects(withFlag(okApp, "--volume", `${link}:/opt/evil:ro`), appPolicy, /마운트 원본/, "링크");
  rejects(withFlag(okApp, "--volume", `${link}/nested:/opt/evil:ro`), appPolicy, /마운트 원본/, "링크 밑의 아직 없는 자리");
});

t("G6 .. 든 원본 · 자리", () => {
  rejects(withFlag(okApp, "--volume", `${code}/../../../../../../etc:/opt/x:ro`), appPolicy, /마운트 원본/, "원본 ..");
  rejects(withFlag(okApp, "--volume", `${code}:/opt/../etc:ro`), appPolicy, /마운트 자리/, "자리 ..");
});

t("G7 --user 0:0 · 없음 · 이름", () => {
  rejects(swap(okApp, "--user", "0:0"), appPolicy, /root/, "uid 0");
  rejects(swap(okApp, "--user", "root"), appPolicy, /숫자 uid:gid/, "이름");
  rejects(without(okApp, "--user"), appPolicy, /--user/, "없음");
});

t("G8 --cap-drop 없음 · ALL 아님", () => {
  rejects(without(okApp, "--cap-drop"), appPolicy, /cap-drop ALL 이 없습니다/, "없음");
  rejects(swap(okApp, "--cap-drop", "NET_RAW"), appPolicy, /ALL 만/, "일부만");
});

t("G9 no-new-privileges 없음 · 다른 security-opt", () => {
  rejects(without(okApp, "--security-opt"), appPolicy, /no-new-privileges 가 없습니다/, "없음");
  rejects(withFlag(okApp, "--security-opt", "seccomp=unconfined"), appPolicy, /받지 않습니다/, "seccomp 끔");
});

t("G10 --memory 없음 · 스왑 다름", () => {
  rejects(without(without(okApp, "--memory"), "--memory-swap"), appPolicy, /--memory 가 없습니다/, "없음");
  rejects(swap(okApp, "--memory-swap", "4096m"), appPolicy, /스왑 없음/, "스왑 더 큼");
});

t("G11 --pids-limit 없음", () => {
  rejects(without(okApp, "--pids-limit"), appPolicy, /pids-limit 이 없습니다/, "없음");
});

t("G12 --read-only 없음", () => {
  rejects(without(okApp, "--read-only", false), appPolicy, /--read-only 가 없습니다/, "없음");
});

t("G13 포트 — 0.0.0.0 · 박스 포트 고정 · 정책이 안 받음", () => {
  rejects(swap(okApp, "--publish", "0.0.0.0::8099"), appPolicy, /127\.0\.0\.1 에만/, "모든 자리");
  rejects(swap(okApp, "--publish", "8080:8099"), appPolicy, /127\.0\.0\.1 에만/, "주소 없음");
  rejects(okApp, { ...appPolicy, publish: false }, /포트를 내지 않습니다/, "정책이 안 받음");
});

t("G14 정책 밖 이미지 · 이미지 없음", () => {
  const i = okApp.indexOf(IMAGE);
  rejects([...okApp.slice(0, i), "alpine:3", ...okApp.slice(i + 1)], appPolicy, /이미지 alpine:3/, "다른 이미지");
  rejects(okApp.slice(0, i), appPolicy, /이미지가 없습니다/, "없음");
});

t("G15 모르는 깃발 · 값 없는 -e · 정책 밖 env 키", () => {
  rejects(withFlag(okApp, "--foo", "bar"), appPolicy, /모르는 깃발/, "모르는 깃발");
  rejects(withFlag(okApp, "-e", "AWS_SECRET_ACCESS_KEY"), appPolicy, /값 없는 -e/, "값 없음");
  rejects(withFlag(okApp, "-e", "X=1"), appPolicy, /env X 는 받지 않습니다/, "앱 정책은 -e 없음");
  const buildRoot = path.join(root, "build");
  const out = path.join(buildRoot, "b2", "out");
  fs.mkdirSync(out, { recursive: true });
  const b = buildRunArgs({ name: "lvly-build-y", image: IMAGE, labels: {}, network: NET, memoryMb: 1024, cpus: 1, pids: 100, user: "501:20", outDir: out,
    env: { HOME: "/tmp", LIVELY_APP_TOKEN: "lvk_x" }, hostGateway: false, command: ["node"] });
  rejects(b, buildRunPolicy(buildRoot, IMAGE, NET), /env LIVELY_APP_TOKEN/, "빌드에 토큰 env");
});

t("G16 한 번만 쓰는 깃발 두 번", () => {
  rejects(withFlag(okApp, "--user", "501:20"), appPolicy, /두 번/, "--user 두 번");
  rejects(withFlag(okApp, "--network", NET), appPolicy, /두 번/, "--network 두 번");
});

t("G17 --network=host(= 꼴) · 정책 밖 네트워크 · 정책에 host 가 있으면 통과", () => {
  rejects(swap(okApp, "--network", "host"), appPolicy, /네트워크 host/, "host");
  const i = okApp.indexOf("--network");
  const eq = [...okApp.slice(0, i), "--network=host", ...okApp.slice(i + 2)];
  rejects(eq, appPolicy, /네트워크 host/, "= 꼴");
  //  작업 컨테이너(#5082) 정책 — host 네트워크 · -p 없음
  const jobArgs = without(swap(okApp, "--network", "host"), "--publish");
  assert.equal(assertSafeDockerRun(jobArgs, { ...appPolicy, networks: ["host"], publish: false }).image, IMAGE);
});

t("G18 --group-add(#5082) — 정책에 없으면 거절 · 정책의 숫자 gid 만 · 0 · 이름 · 목록 밖 거절 · 여러 번 됨", () => {
  rejects(withFlag(okApp, "--group-add", "1001"), appPolicy, /--group-add 1001 는 받지 않습니다/, "정책에 칸 없음");
  const p = { ...appPolicy, groupAdds: [1001, 1002, 0] };
  assert.equal(assertSafeDockerRun(withFlag(okApp, "--group-add", "1001", "--group-add", "1002"), p).image, IMAGE);
  rejects(withFlag(okApp, "--group-add", "1003"), p, /받지 않습니다/, "목록 밖");
  rejects(withFlag(okApp, "--group-add", "0"), p, /받지 않습니다/, "0 은 목록에 있어도 거절");
  rejects(withFlag(okApp, "--group-add", "docker"), p, /받지 않습니다/, "이름");
  rejects(withFlag(okApp, "--group-add=01001"), p, /받지 않습니다/, "앞 0");
});

t("G19 --oom-score-adj(#5082) — 0~1000 만(음수 · 넘음 · 글 거절) · 한 번만", () => {
  for (const v of ["0", "500", "1000"]) assert.equal(assertSafeDockerRun(withFlag(okApp, "--oom-score-adj", v), appPolicy).image, IMAGE, v);
  for (const v of ["-500", "1001", "abc", "1e3"]) rejects(withFlag(okApp, "--oom-score-adj", v), appPolicy, /0~1000/, v);
  rejects(withFlag(okApp, "--oom-score-adj", "10", "--oom-score-adj", "20"), appPolicy, /두 번/, "두 번");
});

t("G20 tmpfs 임자 uid · gid(#5082) — 컨테이너 사용자(--user)와 같을 때만", () => {
  const i = okApp.indexOf("--tmpfs");
  const withTmp = (v: string): string[] => { const a = [...okApp]; a[i + 1] = v; return a; };
  assert.equal(assertSafeDockerRun(withTmp("/tmp:rw,uid=501,gid=20,mode=0700"), appPolicy).image, IMAGE);
  rejects(withTmp("/tmp:rw,uid=0"), appPolicy, /tmpfs uid=0 는 컨테이너 사용자/, "root 소유");
  rejects(withTmp("/tmp:rw,uid=502"), appPolicy, /tmpfs uid=502/, "다른 uid");
  rejects(withTmp("/tmp:rw,gid=0"), appPolicy, /tmpfs gid=0/, "다른 gid");
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`\ndocker-run-guard: ${pass} 통과`);
