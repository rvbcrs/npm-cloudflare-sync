FROM node:20-alpine AS builder

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

FROM node:20-alpine

WORKDIR /app

## Install jq for shell script JSON parsing, and bash for run.sh
RUN apk add --no-cache jq bash

COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json

COPY run.sh /run.sh
RUN chmod +x /run.sh

ENV NODE_ENV="production"
# Default values for required environment variables
ENV CF_API_TOKEN=""
ENV CF_EMAIL=""
ENV NPM_API_URL="http://npm:81"
ENV NPM_EMAIL=""
ENV NPM_PASSWORD=""
ENV CHECK_INTERVAL="10000"
ENV LOG_LEVEL="info"
ENV AUTO_CREATE_ROOT_RECORDS="false"

CMD [ "/run.sh" ]