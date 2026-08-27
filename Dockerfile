FROM node:20-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV ENVIRONMENT=production
EXPOSE 8000

CMD ["node", "src/server.js"]
