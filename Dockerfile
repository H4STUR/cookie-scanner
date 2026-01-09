# Use official Node image with Debian
FROM node:20-slim

# Install Chromium dependencies
RUN apt-get update && apt-get install -y \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libcups2 \
    libdrm2 \
    libgbm1 \
    libgtk-3-0 \
    libnss3 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libxss1 \
    libxtst6 \
    xdg-utils \
    --no-install-recommends \
 && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use bundled Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=false

# App directory
WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm install --omit=dev

# Copy app code
COPY . .

# Expose API port
EXPOSE 3000

# Start API
CMD ["npm", "start"]
