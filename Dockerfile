# metabob-activity-api Dockerfile
# Build lightweight TypeScript activity system vessel

FROM oven/bun:1 as build
WORKDIR /app

# Copy package files
COPY package.json bun.lock* ./

# Install dependencies
RUN bun install --frozen-lockfile --production

# Copy source code
COPY src ./src
COPY tsconfig.json ./

# Verify TypeScript compilation
RUN bun build src/index.ts --target bun --outdir dist

FROM oven/bun:1-slim
WORKDIR /app

# Copy dependencies and source from build stage
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/package.json ./

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
