# Video Downloader Hub — backend image for Render (free tier).
# Node.js (Express API) + Python + ffmpeg + yt-dlp. The server listens on
# $PORT (set by Render) and serves /health, /api/info and /api/download.
FROM node:20-slim

# Python (for yt-dlp) and ffmpeg (for merging video+audio streams).
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip ffmpeg ca-certificates curl \
  && rm -rf /var/lib/apt/lists/* \
  && pip3 install --no-cache-dir --break-system-packages yt-dlp

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "server.js"]
