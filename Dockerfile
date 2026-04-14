FROM node:20-slim

# Install Playwright dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    libnss3 \
    libatk-bridge2.0-0 \
    libdrm2 \
    libxkbcommon0 \
    libgbm1 \
    libasound2 \
    libxrandr2 \
    libxdamage1 \
    libxfixes3 \
    libxcomposite1 \
    libxext6 \
    fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

ENV PLAYWRIGHT_BROWSERS_PATH=/usr/bin
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev

# Install Playwright browsers
RUN npx playwright install chromium --with-deps

COPY . .

EXPOSE 3000

CMD ["node", "src/server.js"]
