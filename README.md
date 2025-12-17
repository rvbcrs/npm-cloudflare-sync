# NPM Cloudflare Sync

This tool synchronizes Nginx Proxy Manager (NPM) hosts with Cloudflare DNS. It automatically creates CNAME records in Cloudflare for every proxy host defined in NPM.

## Features
- **Automatic Sync**: Watches for new NPM hosts and adds them to Cloudflare.
- **Root Domain Support**: Optionally creates A/AAAA records for the root domain.
- **Configurable**: usage via Docker Environment Variables or Home Assistant UI.

---

## 1. Standalone Docker Usage
You can run this container alongside Nginx Proxy Manager using Docker Compose.

### Installation
1.  Clone this repository or create a `docker-compose.yml` file.
2.  Create a `.env` file based on `.env.example`:
    ```bash
    cp .env.example .env
    ```
3.  Edit `.env` and fill in your Cloudflare and NPM credentials.
4.  Start the container:
    ```bash
    docker-compose up -d
    ```

### Configuration (.env)
| Variable | Description |
| - | - |
| `CF_API_TOKEN` | Cloudflare API Token (Edit zone DNS permissions required) |
| `NPM_API_URL` | URL to NPM (e.g., `http://npm:81`) |
| `NPM_EMAIL` | NPM Login Email |
| `NPM_PASSWORD` | NPM Login Password |
| `CHECK_INTERVAL` | Sync interval in ms (default: `10000`) |

---

## 2. Home Assistant Add-on Usage
You can install this directly as a Home Assistant Add-on.

### Installation
1.  **Add Repository**:
    - Go to **Settings** > **Add-ons** > **Add-on Store**.
    - Click the 3 dots (top right) > **Repositories**.
    - Add the URL of this GitHub repository.
2.  **Install**:
    - Refresh the store.
    - Search for **"NPM Cloudflare Sync"** and click **Install**.
3.  **Configure**:
    - Go to the **Configuration** tab of the add-on.
    - Fill in your Cloudflare Token and NPM details.
4.  **Start**:
    - Click **Start** on the Info tab.

### Configuration (UI)
All options found in the `.env` file are available in the **Configuration** tab in Home Assistant.

---

## Development
- **Build**: `npm run build`
- **Run**: `npm start`
- **Docker Build**: `docker build -t npm-cloudflare-sync .`
