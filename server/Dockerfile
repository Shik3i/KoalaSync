FROM node:20-alpine
WORKDIR /app

# Copy shared protocol first
COPY shared/ ./shared/

# Copy server
COPY server/package*.json ./server/
RUN cd server && npm install --production
COPY server/ ./server/

WORKDIR /app/server
CMD ["node", "index.js"]
