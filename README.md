# Nginx Proxy Manager to Cloudflare DNS Sync

A service that automatically synchronizes Nginx Proxy Manager host configurations with Cloudflare DNS records using the NPM REST API. It supports both A records for root domains and CNAME records for subdomains, with built-in DDNS functionality.

## Features

- Uses NPM REST API to monitor proxy host changes
- Automatically updates Cloudflare DNS records when changes are detected
- Smart handling of root domains (A records) and subdomains (CNAME records)
- Built-in DDNS (Dynamic DNS) functionality
  - Automatically detects public IP changes
  - Updates root domain A records with new IP
  - Configurable check intervals
  - Fallback to cached IP if services are unavailable
- Configurable check interval
- Docker support with environment variable configuration
- Token-based authentication with NPM
- Automatic zone detection and management
- Real-time synchronization
- Configurable logging levels

## Prerequisites

- Nginx Proxy Manager instance
- Cloudflare account with API token
- Docker (recommended for deployment)

## Installation

### Docker Compose Installation

1. Create a `docker-compose.yml` file:

```yaml
version: "3"

services:
  npm-cloudflare-sync:
    image: rvbcrs/npm-cloudflare-sync:latest
    container_name: npm-cloudflare-sync
    environment:
      - CF_API_TOKEN=your_token
      - CF_EMAIL=your_email
      - NPM_API_URL=http://npm:81
      - NPM_EMAIL=your_npm_email
      - NPM_PASSWORD=your_npm_password
      - CHECK_INTERVAL=10000
      - LOG_LEVEL=info
      - AUTO_CREATE_ROOT_RECORDS=false
    restart: unless-stopped
```

2. Replace the environment variables with your values
3. Run the container:

```bash
docker-compose up -d
```

### Docker Installation

```bash
docker run -d \
  -e CF_API_TOKEN=your_token \
  -e CF_EMAIL=your_email \
  -e NPM_API_URL=http://your-npm-instance:81 \
  -e NPM_EMAIL=your_npm_email \
  -e NPM_PASSWORD=your_npm_password \
  -e CHECK_INTERVAL=10000 \
  -e LOG_LEVEL=info \
  -e AUTO_CREATE_ROOT_RECORDS=false \
  rvbcrs/npm-cloudflare-sync
```

### Unraid Installation

1. Open the Unraid web interface
2. Go to the "Apps" tab
3. Click "Search"
4. Search for "npm-cloudflare-sync"
5. Click "Install"

### Required Environment Variables

- `CF_API_TOKEN`: Cloudflare API token
- `CF_EMAIL`: Cloudflare account email
- `NPM_API_URL`: URL of your NPM instance (e.g., http://npm:81)
- `NPM_EMAIL`: NPM admin email
- `NPM_PASSWORD`: NPM admin password

### Optional Environment Variables

- `CHECK_INTERVAL`: Interval in milliseconds between checks (default: 10000)
- `LOG_LEVEL`: Logging level (error, warn, info, debug) (default: info)
- `AUTO_CREATE_ROOT_RECORDS`: Automatically create root A records when missing (default: false)

## How It Works

1. The service authenticates with both NPM and Cloudflare APIs
2. It periodically checks for changes in NPM proxy hosts
3. For each changed host:
   - Root domains get A records pointing to the NPM host
   - Subdomains get CNAME records pointing to their root domain
4. Changes are automatically synchronized to Cloudflare DNS

### Dynamic DNS (DDNS)

The service includes built-in DDNS functionality to handle dynamic IP addresses:

1. Periodically checks your public IP address using multiple reliable services
2. If a change is detected:
   - Updates all root domain A records with the new IP
   - Maintains DNS records even when your IP changes
3. Features:
   - Smart caching to reduce API calls
   - Automatic failover between multiple IP detection services
   - 5-minute cache for IP checks
   - Exponential backoff for retries
   - Fallback to cached IP if all services are temporarily unavailable

This ensures your domains always point to the correct IP address, even when your public IP changes.

## Logging

The service provides detailed logging of all operations and errors to help with monitoring and troubleshooting. Logs include timestamps and are formatted for easy reading.

### Log Levels

- `error`: Only show errors
- `warn`: Show warnings and errors
- `info`: Show general information, warnings, and errors (default)
- `debug`: Show all debug information, including detailed API responses

## Support

For support, please create an issue on the GitHub repository.

## Author

**Ramon van Bruggen**  
Interpreter Software B.V.  
Email: info@interpretersoftware.nl

## License

This project is open source software.  
Copyright © 2025 Interpreter Software B.V.
