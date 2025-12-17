# NPM Cloudflare Sync

This add-on synchronizes your Nginx Proxy Manager hosts with Cloudflare DNS.

## Configuration

| Option | Description |
| - | - |
| `CF_API_TOKEN` | Your Cloudflare API Token. |
| `CF_EMAIL` | Your Cloudflare Email Address. |
| `NPM_API_URL` | URL to your Nginx Proxy Manager instance (e.g., `http://192.168.1.10:81`). |
| `NPM_EMAIL` | Email used to login to NPM. |
| `NPM_PASSWORD` | Password used to login to NPM. |
| `CHECK_INTERVAL` | Interval in milliseconds to check for changes (default: 10000). |
| `LOG_LEVEL` | Logging level (`info`, `debug`, `warn`, `error`). |
| `AUTO_CREATE_ROOT_RECORDS` | Automatically create CNAME records for root domain (A/AAAA). |

## Support

If you have issues, please report them on the [GitHub repository](https://github.com/rvbcrs/npm-cloudflare-sync).
