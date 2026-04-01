# metabob-activity-api Dockerfile
# Build lightweight TypeScript activity system vessel
#
# Build context: Parent directory containing both metabob-activity-api/ and metabob-proto/ as siblings
#
# Monorepo: docker build -f metabob-activity-api/Dockerfile -t metabob-activity-api:latest repos/
# Deployment: docker build -f metabob-activity-api/Dockerfile -t metabob-activity-api:latest vessels/

FROM oven/bun:1 as build
WORKDIR /app

# Install SSH client and git for private dependencies
RUN apt-get update && apt-get install -y openssh-client git && rm -rf /var/lib/apt/lists/*

# Copy activity-api package files
COPY metabob-activity-api/package.json metabob-activity-api/bun.lock* ./

# Install dependencies (with SSH for git dependencies)
RUN --mount=type=ssh \
  mkdir -p ~/.ssh && \
  ssh-keyscan github.com >> ~/.ssh/known_hosts && \
  git config --global url."git@github.com:".insteadOf "https://github.com/" && \
  bun install --frozen-lockfile --production

# Copy activity-api source code
COPY metabob-activity-api/src ./src
COPY metabob-activity-api/scripts ./scripts
COPY metabob-activity-api/sql ./sql
COPY metabob-activity-api/tsconfig.json ./

# Copy metabob-proto for schema migrations
COPY metabob-proto ./repos/metabob-proto

# Verify TypeScript compilation
RUN bun build src/index.ts --target bun --outdir dist

FROM oven/bun:1-slim
WORKDIR /app

# Copy dependencies and source from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/sql ./sql
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/package.json ./

# Copy metabob-proto for migrations
COPY --from=build /app/repos ./repos

# Environment configuration
ENV NODE_ENV=production
ENV PORT=8080
ENV HOST=0.0.0.0

# Expose HTTP port
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Run the server
CMD ["bun", "run", "src/index.ts"]
