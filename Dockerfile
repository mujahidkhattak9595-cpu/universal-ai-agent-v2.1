FROM node:20-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev && npx playwright install --with-deps chromium
COPY . .
ENV NODE_ENV=production
CMD ["node","backend_server.js"]
