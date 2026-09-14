# Football Score Table — Express + Playwright (headless Chromium)
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /app

# Install node deps first so this layer caches between code edits.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Pull Chromium + all the system libraries it needs (fonts, X libs, etc.).
# Uses the exact Playwright version from package-lock, so browser and client match.
RUN npx --yes playwright install --with-deps chromium \
    && chmod -R a+rx /ms-playwright \
    && rm -rf /var/lib/apt/lists/*

COPY . .

# Chromium refuses to start as root without disabling its sandbox, so run as a
# normal user instead of weakening the sandbox.
RUN useradd -m -u 10001 appuser && chown -R appuser:appuser /app
USER appuser

EXPOSE 8080
CMD ["node", "server.js"]
