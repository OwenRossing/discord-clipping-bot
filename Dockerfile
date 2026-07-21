FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY api ./api
COPY bot ./bot
COPY scripts ./scripts
COPY web ./web
COPY config.example.json ./config.example.json
RUN mkdir -p /app/data/clips /app/data/previews && chown -R node:node /app
USER node
EXPOSE 3000
CMD ["node", "api/server.js"]
