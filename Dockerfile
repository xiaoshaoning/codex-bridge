# Build stage
FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src/ ./src/
RUN npm run build

# Production stage
FROM node:22-alpine
WORKDIR /app
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package*.json ./
RUN npm ci --only=production --ignore-scripts && npm cache clean --force
COPY --from=builder /app/dist ./dist

RUN mkdir -p /app/log && chown -R appuser:appgroup /app/log

USER appuser
EXPOSE 8098

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:8098/health || exit 1

CMD ["node", "dist/server.js"]
