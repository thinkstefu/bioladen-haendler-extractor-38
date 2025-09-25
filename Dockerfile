FROM apify/actor-node-playwright:20

WORKDIR /usr/src/app

# Install deps as root (avoids EACCES in CI) and install matching Playwright browsers
USER root
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN npx playwright install --with-deps

# Copy source with runtime ownership
COPY --chown=myuser:myuser . ./

# Switch back to non-root user for runtime
USER myuser

CMD ["node", "src/main.js"]
