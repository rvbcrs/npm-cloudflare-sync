FROM node:20-alpine

WORKDIR /app

# First install dependencies
COPY package*.json ./
RUN npm install

# Then copy source files
COPY . .

# Install dependencies again in case package.json changed
RUN npm install

# Build the TypeScript code
RUN npm run build

ENV NODE_ENV=production

# Default values for required environment variables
ENV CF_API_TOKEN=""
ENV CF_EMAIL=""
ENV NPM_API_URL="http://localhost:81"
ENV NPM_EMAIL=""
ENV NPM_PASSWORD=""
ENV CHECK_INTERVAL="10000"
ENV LOG_LEVEL="info"
ENV AUTO_CREATE_ROOT_RECORDS="false"

CMD ["node", "dist/index.js"]