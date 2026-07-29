FROM litestream/litestream:0.5.15 AS litestream

FROM node:22-bookworm-slim AS build
ENV COREPACK_HOME=/corepack
ENV PATH="${COREPACK_HOME}:${PATH}"
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@10.15.0 --activate
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm worker:build

FROM node:22-bookworm-slim AS runtime
ENV APP_ENV=production
ENV NODE_ENV=production
ENV PORT=7331
WORKDIR /app
COPY --from=litestream /usr/local/bin/litestream /usr/local/bin/litestream
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/.output ./src/.output
COPY .env.schema ./
COPY deploy/litestream.yml /etc/litestream.yml
COPY deploy/worker-entrypoint.sh /usr/local/bin/worker-entrypoint
RUN mkdir -p /data && \
    chmod 0755 /usr/local/bin/worker-entrypoint && \
    chown -R node:node /app /data /etc/litestream.yml /usr/local/bin/worker-entrypoint
USER node
EXPOSE 7331
ENTRYPOINT ["/usr/local/bin/worker-entrypoint"]
