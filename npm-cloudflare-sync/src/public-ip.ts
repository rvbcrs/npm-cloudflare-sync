import fetch from "node-fetch";
import { logger } from "./logger.js";
import { PublicIPResponse } from "./types.js";

let cachedIP: string | null = null;
let lastCheck: number = 0;
const CACHE_DURATION = 300000; // 5 minute cache
const TIMEOUT = 15000; // 15 second timeout (increased)
const MAX_RETRIES = 3;
const RETRY_DELAY = 2000; // 2 seconds between retries (increased)

export async function getPublicIP(): Promise<string> {
  const now = Date.now();

  // Return cached IP if it's still valid
  if (cachedIP && now - lastCheck < CACHE_DURATION) {
    logger.debug("Using cached public IP:", { ip: cachedIP });
    return cachedIP;
  }

  // Try multiple IP services in case one fails
  const services = [
    {
      url: "https://api64.ipify.org?format=json",
      extract: (data: any) => data.ip,
    },
    {
      url: "https://ip.seeip.org/jsonip",
      extract: (data: any) => data.ip,
    },
    {
      url: "https://api.myip.com",
      extract: (data: any) => data.ip,
    },
    {
      url: "https://ifconfig.me/ip",
      extract: (data: string) => data.trim(), // This service returns plain text
    },
    {
      url: "https://icanhazip.com",
      extract: (data: string) => data.trim(), // This service returns plain text
    },
  ];

  let lastError: Error | null = null;
  let successfulService: string | null = null;

  for (const service of services) {
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        logger.debug("Trying IP service:", {
          service: service.url,
          attempt: attempt + 1,
        });

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), TIMEOUT);

        try {
          const response = await fetch(service.url, {
            signal: controller.signal,
            headers: {
              Accept: "application/json, text/plain, */*",
              "User-Agent": "npm-cloudflare-sync/1.0",
            },
          });

          clearTimeout(timeout);

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
          }

          // Handle both JSON and plain text responses
          const contentType = response.headers.get("content-type") || "";
          const data = contentType.includes("application/json")
            ? await response.json()
            : ((await response.text()) as string);

          const ip = service.extract(data as any);

          // Validate IP format (IPv4 only for now)
          if (!ip || !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) {
            throw new Error("Invalid IP format received");
          }

          // Update cache
          cachedIP = ip;
          lastCheck = now;
          successfulService = service.url;

          logger.debug("Successfully retrieved public IP:", {
            ip,
            service: service.url,
            attempt: attempt + 1,
          });

          return ip;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        lastError = error as Error;
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error";

        logger.warn(`Failed to get IP from ${service.url}:`, {
          attempt: attempt + 1,
          error: errorMessage,
          remainingServices: services.length - services.indexOf(service) - 1,
        });

        if (attempt < MAX_RETRIES - 1) {
          logger.debug(`Retrying service in ${RETRY_DELAY}ms...`);
          await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY));
        }
      }
    }
  }

  // All services failed
  logger.error("All IP services failed:", {
    lastError: lastError?.message,
    lastSuccessfulService: successfulService,
    totalServices: services.length,
    lastCachedIP: cachedIP,
    lastCheckAge: cachedIP
      ? Math.floor((now - lastCheck) / 1000) + "s ago"
      : "never",
  });

  // Return cached IP if available, even if expired
  if (cachedIP) {
    logger.warn("Using expired cached IP as fallback:", {
      ip: cachedIP,
      lastCheck: new Date(lastCheck).toISOString(),
      age: Math.floor((now - lastCheck) / 1000) + "s",
    });
    return cachedIP;
  }

  throw new Error("Failed to retrieve public IP from all services");
}
