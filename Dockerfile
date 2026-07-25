FROM mcr.microsoft.com/playwright:v1.61.1-noble

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl -sSL https://raw.githubusercontent.com/okx/onchainos-skills/main/install.sh | sh

ENV PATH="/root/.local/bin:${PATH}"

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

COPY . .

ENV NODE_ENV=production
EXPOSE 8787

CMD ["pnpm", "start"]
