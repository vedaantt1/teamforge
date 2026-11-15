FROM node:22-slim AS web
WORKDIR /app/web
COPY web/package*.json ./
RUN npm ci
COPY web ./
RUN npm run build
FROM node:22-slim
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY src ./src
COPY scripts ./scripts
COPY --from=web /app/web/dist ./web/dist
ENV DB_PATH=/data/app.db PORT=3000
EXPOSE 3000
CMD ["node","src/server.js"]
