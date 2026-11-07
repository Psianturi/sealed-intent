# A public SeIn on testnet, for Cloud Run. See DEPLOY.md.
FROM node:22-bookworm-slim
WORKDIR /app
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile && chown -R node:node /app
USER node
ENV PORT=8080 HOST=0.0.0.0 SEALED_NETWORK=testnet
EXPOSE 8080
CMD ["node", "node_modules/tsx/dist/cli.mjs", "apps/server/src/hosted.ts"]
