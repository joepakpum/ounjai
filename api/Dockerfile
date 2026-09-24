FROM docker.io/library/node:22-alpine

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY server.js migrate.js ./
COPY migrations ./migrations

ENV NODE_ENV=production
EXPOSE 3000
CMD ["npm", "start"]
