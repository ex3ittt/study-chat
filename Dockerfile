FROM node:24-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080 DB_PATH=/data/chat.db
COPY package*.json ./
RUN npm ci --omit=dev && mkdir /data && chown node /data
COPY server server
COPY --from=build /app/dist dist
USER node
VOLUME /data
EXPOSE 8080
CMD ["node", "server/index.ts"]
