import fetch from 'node-fetch';
import { logger } from './logger.js';
/**
 * Monitors Nginx Proxy Manager for changes in proxy hosts
 */
export class NPMMonitor {
    token = null;
    apiUrl;
    email;
    password;
    checkInterval;
    monitorInterval = null;
    isMonitoring = false;
    lastKnownHosts = [];
    constructor(apiUrl, email, password, checkInterval) {
        this.apiUrl = apiUrl.replace(/\/$/, '');
        this.email = email;
        this.password = password;
        this.checkInterval = checkInterval;
    }
    async login() {
        try {
            logger.info(`Attempting to login to NPM at ${this.apiUrl}`);
            const response = await fetch(`${this.apiUrl}/api/tokens`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    identity: this.email,
                    secret: this.password
                })
            });
            if (!response.ok) {
                const text = await response.text();
                throw new Error(`Login failed: ${response.statusText} - ${text}`);
            }
            const data = await response.json();
            this.token = data.token;
            logger.info('Successfully logged in to NPM');
            return true;
        }
        catch (error) {
            logger.error('Login failed:', error);
            return false;
        }
    }
    async getHeaders() {
        if (!this.token && !(await this.login())) {
            throw new Error('Unable to authenticate with NPM');
        }
        return {
            'Authorization': `Bearer ${this.token}`,
            'Accept': 'application/json'
        };
    }
    async getProxyHosts() {
        try {
            logger.debug('Fetching proxy hosts from NPM');
            const headers = await this.getHeaders();
            const response = await fetch(`${this.apiUrl}/api/nginx/proxy-hosts`, {
                headers
            });
            if (!response.ok) {
                if (response.status === 401) {
                    this.token = null;
                    logger.info('Token expired, retrying with new token');
                    return this.getProxyHosts();
                }
                const text = await response.text();
                throw new Error(`Failed to fetch proxy hosts: ${response.statusText} - ${text}`);
            }
            const hosts = await response.json();
            logger.debug(`Retrieved ${hosts.length} proxy hosts from NPM`);
            return hosts;
        }
        catch (error) {
            logger.error('Error fetching proxy hosts:', error);
            return [];
        }
    }
    async getChangesSinceLastCheck() {
        const currentHosts = await this.getProxyHosts();
        logger.debug(`Current check: Found ${currentHosts.length} hosts`);
        if (this.lastKnownHosts.length === 0) {
            this.lastKnownHosts = currentHosts;
            logger.info('Initial hosts loaded, starting change detection');
            return { currentHosts, changedHosts: [], deletedHosts: [] };
        }
        // Check for modified and new hosts
        const changedHosts = currentHosts.filter(currentHost => {
            const previousHost = this.lastKnownHosts.find(h => h.id === currentHost.id);
            if (!previousHost) {
                logger.debug(`New host detected: ${currentHost.domain_names}`);
                return true;
            }
            if (new Date(currentHost.modified_on).getTime() !== new Date(previousHost.modified_on).getTime()) {
                logger.debug(`Modified host detected: ${currentHost.domain_names}`);
                return true;
            }
            return false;
        });
        // Check for deleted hosts
        const deletedHosts = this.lastKnownHosts.filter(previousHost => !currentHosts.some(h => h.id === previousHost.id));
        if (deletedHosts.length > 0) {
            logger.debug(`Deleted hosts detected: ${deletedHosts.map(h => h.domain_names).join(', ')}`);
        }
        if (changedHosts.length > 0) {
            logger.info(`Detected ${changedHosts.length} changed/new hosts`, {
                hosts: changedHosts.map(h => ({
                    id: h.id,
                    domains: h.domain_names,
                    modifiedOn: h.modified_on
                }))
            });
        }
        // Update last known hosts
        this.lastKnownHosts = currentHosts;
        return { currentHosts, changedHosts, deletedHosts };
    }
    stopMonitoring() {
        if (this.monitorInterval) {
            clearInterval(this.monitorInterval);
            this.monitorInterval = null;
        }
        this.isMonitoring = false;
        logger.info('Monitoring stopped');
    }
    async startMonitoring(callback) {
        if (this.isMonitoring) {
            logger.warn('Monitoring is already running');
            return;
        }
        this.isMonitoring = true;
        logger.info(`Starting NPM monitoring with ${this.checkInterval}ms interval`);
        const monitor = async () => {
            try {
                const timestamp = new Date().toISOString();
                logger.debug(`[${timestamp}] Running monitoring check`);
                const { currentHosts, changedHosts, deletedHosts } = await this.getChangesSinceLastCheck();
                if (changedHosts.length > 0 || deletedHosts.length > 0) {
                    logger.info('Processing changes');
                    await callback(currentHosts, changedHosts, deletedHosts);
                    logger.info('Changes processed successfully');
                }
                else {
                    logger.debug(`[${timestamp}] No changes detected in this interval`);
                }
            }
            catch (error) {
                logger.error('Error in monitoring loop:', error);
            }
        };
        // Initial check
        await monitor();
        // Start continuous monitoring with setInterval
        this.monitorInterval = setInterval(() => {
            monitor().catch(error => {
                logger.error('Unhandled error in monitor interval:', error);
            });
        }, this.checkInterval);
        logger.info('Continuous monitoring started');
    }
}
