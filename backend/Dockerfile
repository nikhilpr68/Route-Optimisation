FROM node:20-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-pip \
  && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

COPY . .

RUN python3 -m pip install --no-cache-dir --break-system-packages -r engine/requirements.txt

ENV NODE_ENV=production

EXPOSE 5001

CMD ["node", "server.js"]
