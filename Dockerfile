# syntax=docker/dockerfile:1

# ---- Build: compile the server and the web UI ---------------------------------
FROM node:22-bookworm AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY server server
COPY web web
RUN npm run build && npm prune --omit=dev

# ---- Runtime: the app plus the toolbelt Claude works with ---------------------
FROM node:22-bookworm-slim AS runtime

ARG CLAUDE_CODE_VERSION=latest
# Empty installs the latest mise release. Set a tag such as v2025.1.0 to pin it.
ARG MISE_VERSION=
# System libraries Chromium needs, so Playwright tests can run. Set to false for a smaller image.
ARG INSTALL_BROWSER_DEPS=true

# Toolbelt: version control, GitHub CLI, compilers for native modules, common CLI helpers.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl wget gnupg git git-lfs openssh-client \
      build-essential python3 python3-pip python3-venv pkg-config \
      jq ripgrep fd-find unzip zip xz-utils less procps tini util-linux \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update && apt-get install -y --no-install-recommends gh \
 && if [ "$INSTALL_BROWSER_DEPS" = "true" ]; then npx --yes playwright@latest install-deps chromium; fi \
 && rm -rf /var/lib/apt/lists/* /root/.npm

# mise installs the language runtimes a formula asks for (into the agent's home volume).
RUN curl -fsSL https://mise.run | MISE_VERSION=${MISE_VERSION} MISE_INSTALL_PATH=/usr/local/bin/mise sh
# Keeps those runtimes first on PATH in login shells, which would otherwise reset it.
COPY docker/profile.d/autoworker-path.sh /etc/profile.d/autoworker-path.sh

# Claude Code, plus yarn and pnpm through corepack.
RUN npm install --global @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} \
 && corepack enable \
 && rm -rf /root/.npm

# The unprivileged user Claude, workflow commands and the web shell run as.
RUN groupadd --gid 10001 agent \
 && useradd --uid 10001 --gid agent --create-home --home-dir /home/agent --shell /bin/bash agent \
 && install -d -o root -g root -m 0700 /data \
 && install -d -o agent -g agent -m 0755 /workspaces \
 && install -d -o root -g root -m 0755 /formulas

WORKDIR /app
COPY --from=build /src/package.json ./
COPY --from=build /src/node_modules node_modules
COPY --from=build /src/server/package.json server/
COPY --from=build /src/server/dist server/dist
COPY --from=build /src/web/dist web/dist

ENV NODE_ENV=production \
    AUTOWORKER_DATA_DIR=/data \
    AUTOWORKER_WORKSPACES_DIR=/workspaces \
    AUTOWORKER_AGENT_HOME=/home/agent \
    AUTOWORKER_AGENT_UID=10001 \
    AUTOWORKER_AGENT_GID=10001 \
    AUTOWORKER_FORMULAS_DIR=/formulas

VOLUME ["/data", "/workspaces", "/home/agent"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:8080/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"

# The server starts as root with almost no capabilities (see compose.yaml and
# docs/SECURITY.md). It needs to be root only to start processes as `agent`.
ENTRYPOINT ["tini", "--"]
CMD ["node", "--disable-warning=ExperimentalWarning", "/app/server/dist/main.js"]
