FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["pnpm", "start"]
