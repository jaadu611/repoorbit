# Stage 1: Dependencies
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# Stage 2: Builder
FROM node:20-slim AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Next.js build requires a production environment
ENV NODE_ENV=production
RUN npm run build

# Stage 3: Runner
FROM mcr.microsoft.com/playwright:v1.49.1-jammy AS runner
WORKDIR /app

# Install opencode core engine globally
RUN npm install -g opencode

# Set production environment
ENV NODE_ENV=production
ENV NEXT_CMD="next start"

# Copy essential files from builder
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/start.sh ./start.sh

# Ensure start.sh is executable
RUN chmod +x start.sh

# Expose Next.js and Opencode ports
EXPOSE 3000 3001

# Run the orchestrator
CMD ["bash", "start.sh"]
