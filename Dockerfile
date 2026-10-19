FROM node:24-alpine

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server.mjs ./
COPY public ./public
COPY scripts ./scripts

ENV NODE_ENV=production
ENV PORT=4177
ENV OPC_SQLITE_PATH=/data/opc-demo.sqlite
EXPOSE 4177
CMD ["node", "server.mjs"]
