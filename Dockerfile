FROM apify/actor-node-playwright:20

WORKDIR /usr/src/app

USER root
COPY package*.json ./
RUN npm install --omit=dev --no-audit --no-fund
RUN npx playwright install --with-deps

COPY --chown=myuser:myuser . ./
USER myuser

CMD ["node", "src/main.js"]
