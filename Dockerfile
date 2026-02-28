# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

# Install Chromium + required libs
RUN apt-get update && apt-get install -y \
  chromium \
  ca-certificates \
  fonts-liberation \
  libasound2 \
  libatk-bridge2.0-0 \
  libatk1.0-0 \
  xvfb \
  libcups2 \
  libdbus-1-3 \
  libdrm2 \
  libgbm1 \
  libglib2.0-0 \
  libnss3 \
  libx11-6 \
  libx11-xcb1 \
  libxcb1 \
  libxcomposite1 \
  libxdamage1 \
  libxext6 \
  libxfixes3 \
  libxkbcommon0 \
  libxrandr2 \
  libxrender1 \
  libxshmfence1 \
  libxss1 \
  libxtst6 \
  wget \
  --no-install-recommends \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy only package files first for better caching
COPY package.json package-lock.json* ./

# Install deps
RUN npm ci || npm install

# Copy the rest
COPY . .

# Puppeteer/Chromium env hints (many libs respect this)
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV NODE_ENV=production

# Create output dir (optional; you also mkdir in code)
RUN mkdir -p /app/debug_out

# Default command: run your TS file
# Change main.ts -> whatever your entry file is
CMD ["npx", "ts-node", "main.ts"]