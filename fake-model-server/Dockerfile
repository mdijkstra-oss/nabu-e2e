# alpine's busybox provides the wget the compose healthcheck execs inside this
# container (nabu-self-hosted/compose.yaml:66-71).
FROM node:22-alpine

RUN wget --help >/dev/null 2>&1

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

EXPOSE 8081 8082

CMD ["node", "src/main.js"]
