# 게이트웨이 이미지 — full-docker(Option 1) / 미래용. 파일럿(Option 2)은 게이트웨이를 네이티브로 돌려 미사용.
# 기존 Dockerfile 의 버그를 정정: web/·public/·kit/ 포함(웹UI 빌드·/install 번들), node 22, npm ci,
# node-pty 네이티브 빌드 의존(python3/make/g++) 포함, non-root.
FROM node:22-bookworm-slim AS build
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY web/tsconfig.json ./web/tsconfig.json
COPY src ./src
COPY web ./web
RUN npm run build           # tsc 백엔드(dist/) + 프론트(web/tsconfig)

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production LANG=C.UTF-8 LC_ALL=C.UTF-8
# 런타임: node-pty 네이티브(python3/make/g++) + 터미널 세션이 spawn 하는 git/tmux/bash.
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ tmux git ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY public ./public
COPY kit ./kit
EXPOSE 8080
# 컨테이너 안에선 env_file/compose 가 환경을 주입하지만, .env 가 있으면 함께 로드(로컬 편의).
CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
