FROM node:20-alpine

WORKDIR /app

# Install production dependencies first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev

COPY src ./src
COPY public ./public

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "src/server.js"]
