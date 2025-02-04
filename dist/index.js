import { config } from './config.js';
import { NPMMonitor } from './npm-monitor.js';
import { CloudflareAPI } from './cloudflare.js';
import { logger } from './logger.js';
async function handleNPMChanges(currentHosts, changedHosts, deletedHosts) {
    const cf = new CloudflareAPI(config.cloudflare.apiToken);
    // Initialize zones first
    await cf.initZones();
    // Handle deleted hosts first
    for (const host of deletedHosts) {
        const domains = Array.isArray(host.domain_names)
            ? host.domain_names
            : host.domain_names.split(',');
        for (const domain of domains) {
            const domainName = domain.trim();
            const existingRecords = await cf.getDNSRecords(domainName);
            const existingRecord = existingRecords.find(r => r.name === domainName);
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
            : host.domain_names.split(',');
        for (const domain of domains) {
            const domainName = domain.trim();
            const rootDomain = cf.getRootDomain(domainName);
            const isSubdomain = domainName !== rootDomain;
            const existingRecords = await cf.getDNSRecords(domainName);
            const existingRecord = existingRecords.find(r => r.name === domainName);
            if (isSubdomain) {
                // For subdomains, create a CNAME record pointing to the root domain
                const recordData = {
                    name: domainName,
                    type: 'CNAME',
                    content: rootDomain,
                    proxied: true
                };
                if (existingRecord) {
                    logger.info(`Updating CNAME record for ${domainName} -> ${rootDomain}`);
                    await cf.updateDNSRecord(domainName, existingRecord.id, recordData);
                }
                else {
                    logger.info(`Creating new CNAME record for ${domainName} -> ${rootDomain}`);
                    await cf.createDNSRecord(domainName, recordData);
                }
            }
            else {
                // For root domains, create/update A record
                const recordData = {
                    name: domainName,
                    type: 'A',
                    content: host.forward_host,
                    proxied: true
                };
                if (existingRecord) {
                    logger.info(`Updating A record for ${domainName}`);
                    await cf.updateDNSRecord(domainName, existingRecord.id, recordData);
                }
                else {
                    logger.info(`Creating new A record for ${domainName}`);
                    await cf.createDNSRecord(domainName, recordData);
                }
            }
        }
    }
}
let monitorInterval = null;
async function main() {
    if (!config) {
        logger.error('Invalid configuration. Exiting...');
        process.exit(1);
    }
    const monitor = new NPMMonitor(config.npm.apiUrl, config.npm.email, config.npm.password, config.checkInterval);
    logger.info('Starting Nginx Proxy Manager to Cloudflare DNS sync service');
    try {
        await monitor.startMonitoring(handleNPMChanges);
    }
    catch (error) {
        logger.error('An error occurred:', error);
        process.exit(1);
    }
}
// Cleanup function to handle graceful shutdown
function cleanup() {
    if (monitorInterval) {
        clearInterval(monitorInterval);
        monitorInterval = null;
    }
    logger.info('Shutting down gracefully...');
    process.exit(0);
}
// Set maximum listeners to prevent warning
process.setMaxListeners(5);
// Handle graceful shutdown with a single listener for each signal
process.once('SIGTERM', cleanup);
process.once('SIGINT', cleanup);
// Handle uncaught exceptions and rejections
process.once('uncaughtException', (error) => {
    logger.error('Uncaught exception:', error);
    cleanup();
});
process.once('unhandledRejection', (reason) => {
    logger.error('Unhandled rejection:', reason);
    cleanup();
});
main().catch(error => {
    logger.error('Fatal error:', error);
    process.exit(1);
});
