FROM node:22-alpine

WORKDIR /app
COPY src ./src
COPY package.json ./

ENV NODE_ENV=production
EXPOSE 8000
USER node

CMD ["node", "--experimental-strip-types", "src/index.ts"]
