import { config } from "./config.js";
import { NPMMonitor } from "./npm-monitor.js";
import { CloudflareAPI } from "./cloudflare.js";
import { logger } from "./logger.js";
import { NPMHost, DNSRecord } from "./types.js";
import { getPublicIP } from "./public-ip.js";

let currentPublicIP: string | null = null;
let ipCheckInterval: NodeJS.Timer | null = null;

async function ensureRootDomainRecord(
  cf: CloudflareAPI,
  domain: string
): Promise<boolean> {
  const rootDomain = cf.getRootDomain(domain);
  if (!rootDomain) {
    logger.error(`Could not determine root domain for ${domain}`);
    return false;
  }

  // Skip if this is already a root domain
  if (domain === rootDomain) {
    return true;
  }

  logger.debug("Checking root domain record:", {
    subdomain: domain,
    rootDomain,
  });

  const rootRecords = await cf.getDNSRecords(rootDomain);
  const rootARecord = rootRecords.find(
    (r) => r.type === "A" && r.name === rootDomain
  );

  if (!rootARecord) {
    if (!config?.autoCreateRootRecords) {
      logger.error(
        `Missing root A record for ${rootDomain} and auto-creation is disabled`
      );
      return false;
    }

    logger.info(`Creating missing A record for root domain ${rootDomain}`);
    const publicIP = await getPublicIP();

    const created = await cf.createDNSRecord(rootDomain, {
      name: rootDomain,
      type: "A",
      content: publicIP,
      proxied: true,
    });

    if (!created) {
      logger.error(`Failed to create A record for root domain ${rootDomain}`);
      return false;
    }

    logger.info(`Successfully created A record for root domain ${rootDomain}`, {
      ip: publicIP,
    });
  } else {
    logger.debug(`Root domain ${rootDomain} already has an A record`, {
      ip: rootARecord.content,
    });
  }

  return true;
}

async function updateDomainIP(
  cf: CloudflareAPI,
  domain: string,
  newIP: string
): Promise<void> {
  const records = await cf.getDNSRecords(domain);
  const aRecord = records.find((r) => r.type === "A" && r.name === domain);

  logger.debug("IP Comparison for domain:", {
    domain,
    currentARecord: aRecord
      ? {
          ip: aRecord.content,
          proxied: aRecord.proxied,
          type: aRecord.type,
        }
      : "No A record found",
    newPublicIP: newIP,
    needsUpdate: aRecord ? aRecord.content !== newIP : true,
  });

  if (aRecord) {
    if (aRecord.content !== newIP) {
      logger.info(`Updating A record IP for ${domain}:`, {
        oldIP: aRecord.content,
        newIP,
        recordId: aRecord.id,
      });

      const updateData = {
        ...aRecord,
        content: newIP,
      };

      logger.debug("Updating record with data:", updateData);

      const updated = await cf.updateDNSRecord(domain, aRecord.id, updateData);

      if (updated) {
        logger.info("Successfully updated A record");
      } else {
        logger.error("Failed to update A record");
      }
    } else {
      logger.debug(`A record for ${domain} already has correct IP:`, {
        currentIP: aRecord.content,
        desiredIP: newIP,
      });
    }
  } else if (config?.autoCreateRootRecords) {
    logger.info(`Creating new A record for ${domain} with IP ${newIP}`);
    const recordData = {
      name: domain,
      type: "A",
      content: newIP,
      proxied: true,
    };

    logger.debug("Creating record with data:", recordData);

    const created = await cf.createDNSRecord(domain, recordData);

    if (created) {
      logger.info("Successfully created A record");
    } else {
      logger.error("Failed to create A record");
    }
  } else {
    logger.error(
      `Missing A record for ${domain} and auto-creation is disabled`
    );
  }
}

async function checkPublicIPChange(cf: CloudflareAPI): Promise<void> {
  try {
    logger.debug("Starting public IP check");
    const newIP = await getPublicIP();

    logger.debug("Public IP Check:", {
      currentStoredIP: currentPublicIP,
      newDetectedIP: newIP,
      isInitialCheck: currentPublicIP === null,
      hasChanged: currentPublicIP !== null && currentPublicIP !== newIP,
      timestamp: new Date().toISOString(),
    });

    if (currentPublicIP === null) {
      currentPublicIP = newIP;
      logger.info("Initial public IP set:", { ip: newIP });
      return;
    }

    if (newIP !== currentPublicIP) {
      logger.info("Public IP changed:", {
        oldIP: currentPublicIP,
        newIP,
      });

      // Get all zones and update their root A records
      const zones = await cf.getZones();
      logger.debug("Updating IP for zones:", {
        zoneCount: zones.length,
        zones: zones.map((z) => ({
          name: z.name,
          id: z.id,
        })),
      });

      for (const zone of zones) {
        await updateDomainIP(cf, zone.name, newIP);
      }

      currentPublicIP = newIP;
      logger.info("Completed updating all zones with new IP");
    } else {
      logger.debug("Public IP unchanged:", {
        ip: currentPublicIP,
        lastCheck: new Date().toISOString(),
      });
    }
  } catch (error) {
    logger.error("Failed to check/update public IP:", error);
  }
}

async function handleNPMChanges(
  currentHosts: NPMHost[],
  changedHosts: NPMHost[],
  deletedHosts: NPMHost[]
): Promise<void> {
  const cf = new CloudflareAPI(config!.cloudflare.apiToken);

  // Initialize zones first
  await cf.initZones();

  // Handle deleted hosts first
  for (const host of deletedHosts) {
    const domains = Array.isArray(host.domain_names)
      ? host.domain_names
      : host.domain_names.split(",");

    for (const domain of domains) {
      const domainName = domain.trim();
      const existingRecords = await cf.getDNSRecords(domainName);
      const existingRecord = existingRecords.find((r) => r.name === domainName);

      if (existingRecord) {
        logger.info(`Deleting DNS record for ${domainName}`);
        await cf.deleteDNSRecord(domainName, existingRecord.id);
      }
    }
  }

  // Handle changed and new hosts
  for (const host of changedHosts) {
    const domains = Array.isArray(host.domain_names)
      ? host.domain_names
      : host.domain_names.split(",");

    for (const domain of domains) {
      const domainName = domain.trim();
      const rootDomain = cf.getRootDomain(domainName);

      // For subdomains, ensure root domain has an A record first
      if (domainName !== rootDomain) {
        const success = await ensureRootDomainRecord(cf, domainName);
        if (!success) {
          logger.error(
            `Cannot proceed with ${domainName} due to root domain A record issues`
          );
          continue;
        }
      }

      const existingRecords = await cf.getDNSRecords(domainName);
      const existingRecord = existingRecords.find((r) => r.name === domainName);

      if (existingRecord) {
        logger.info(
          `DNS record for ${domainName} already exists. Skipping update.`
        );
        continue; // Skip to the next domain if record already exists
      }

      // If record does not exist, proceed with creation logic
      if (domainName !== rootDomain) {
        // For subdomains, create a CNAME record pointing to the root domain
        const recordData: Omit<DNSRecord, "id"> = {
          name: domainName,
          type: "CNAME",
          content: rootDomain,
          proxied: true,
        };

        // No updateDNSRecord call here, only create
        logger.info(
          `Creating new CNAME record for ${domainName} -> ${rootDomain}`
        );
        await cf.createDNSRecord(domainName, recordData);
      } else {
        // For root domains, ensure A record points to current public IP
        const currentIP = await getPublicIP();
        logger.debug("Creating root domain A record:", {
          domain: domainName,
          currentIP,
        });

        const recordData: Omit<DNSRecord, "id"> = {
          name: domainName,
          type: "A",
          content: currentIP,
          proxied: true,
        };

        // No updateDNSRecord call here, only create if autoCreateRootRecords is enabled
        if (config?.autoCreateRootRecords) {
          logger.info(`Creating new A record for ${domainName}`);
          await cf.createDNSRecord(domainName, recordData);
        } else {
          logger.warn(
            // Changed from error to warn as we are skipping, not failing
            `Skipping A record creation for ${domainName} - auto-creation is disabled and record does not exist`
          );
        }
      }
    }
  }
}

let monitorInterval: NodeJS.Timer | null = null;

async function main(): Promise<void> {
  if (!config) {
    logger.error("Invalid configuration. Exiting...");
    process.exit(1);
  }

  const cf = new CloudflareAPI(config.cloudflare.apiToken);
  await cf.initZones();

  // Start IP check interval
  logger.info("Starting IP check interval");
  await checkPublicIPChange(cf); // Initial check
  ipCheckInterval = setInterval(() => {
    checkPublicIPChange(cf).catch((error) => {
      logger.error("Error in IP check interval:", error);
    });
  }, config.checkInterval);

  const monitor = new NPMMonitor(
    config.npm.apiUrl,
    config.npm.email,
    config.npm.password,
    config.checkInterval
  );

  logger.info("Starting Nginx Proxy Manager to Cloudflare DNS sync service");

  try {
    await monitor.startMonitoring(handleNPMChanges);
  } catch (error) {
    logger.error("An error occurred:", error);
    process.exit(1);
  }
}

// Cleanup function to handle graceful shutdown
function cleanup() {
  if (monitorInterval) {
    clearInterval(monitorInterval as NodeJS.Timeout);
    monitorInterval = null;
  }
  if (ipCheckInterval) {
    clearInterval(ipCheckInterval as NodeJS.Timeout);
    ipCheckInterval = null;
  }
  logger.info("Shutting down gracefully...");
  process.exit(0);
}

// Set maximum listeners to prevent warning
process.setMaxListeners(5);

// Handle graceful shutdown with a single listener for each signal
process.once("SIGTERM", cleanup);
process.once("SIGINT", cleanup);

// Handle uncaught exceptions and rejections
process.once("uncaughtException", (error) => {
  logger.error("Uncaught exception:", error);
  cleanup();
});

process.once("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection:", reason);
  cleanup();
});

main().catch((error) => {
  logger.error("Fatal error:", error);
  process.exit(1);
});
