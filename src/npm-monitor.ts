import fetch from 'node-fetch';
import { logger } from './logger.js';
import { NPMHost, NPMTokenResponse } from './types.js';

/**
 * Monitors Nginx Proxy Manager for changes in proxy hosts
 */
export class NPMMonitor {
  private token: string | null = null;
  private readonly apiUrl: string;
  private readonly email: string;
  private readonly password: string;
  private readonly checkInterval: number;
  private monitorInterval: NodeJS.Timer | null = null;
  private isMonitoring: boolean = false;
  private lastKnownHosts: NPMHost[] = [];
  private readonly maxRetries = 3;
  private readonly retryDelay = 5000; // 5 seconds between retries
  private readonly requestTimeout = 10000; // 10 second timeout
  private consecutiveFailures = 0;
  private readonly maxConsecutiveFailures = 5;
  private isInitialized: boolean = false;

  constructor(apiUrl: string, email: string, password: string, checkInterval: number) {
    this.apiUrl = apiUrl.replace(/\/$/, '');
    this.email = email;
    this.password = password;
    this.checkInterval = checkInterval;
  }

  private async login(): Promise<boolean> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        logger.info(`Attempting to login to NPM at ${this.apiUrl} (attempt ${attempt + 1})`);
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
          const response = await fetch(`${this.apiUrl}/api/tokens`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              identity: this.email,
              secret: this.password
            }),
            signal: controller.signal
          });

          clearTimeout(timeout);

          if (!response.ok) {
            const text = await response.text();
            throw new Error(`Login failed: ${response.statusText} - ${text}`);
          }
          
          const data = await response.json() as NPMTokenResponse;
          this.token = data.token;
          this.consecutiveFailures = 0; // Reset failure counter on successful login
          logger.info('Successfully logged in to NPM');
          return true;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const isNetworkError = error instanceof Error && 
          (error.message.includes('ECONNREFUSED') || 
           error.message.includes('ETIMEDOUT') ||
           error.message.includes('getaddrinfo'));

        if (isNetworkError) {
          logger.error('NPM API is not accessible:', {
            url: this.apiUrl,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        } else {
          logger.error('Login attempt failed:', {
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }

        if (attempt < this.maxRetries - 1) {
          const waitTime = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
          logger.info(`Retrying login in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    this.consecutiveFailures++;
    logger.error('All login attempts failed', {
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    });
    return false;
  }

  private async getHeaders(): Promise<HeadersInit> {
    if (!this.token && !(await this.login())) {
      throw new Error('Unable to authenticate with NPM');
    }
    return {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json'
    };
  }

  private async getProxyHosts(): Promise<NPMHost[]> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        logger.debug('Fetching proxy hosts from NPM');
        const headers = await this.getHeaders();
        
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), this.requestTimeout);

        try {
          const response = await fetch(`${this.apiUrl}/api/nginx/proxy-hosts`, {
            headers,
            signal: controller.signal
          });

          clearTimeout(timeout);

          if (!response.ok) {
            if (response.status === 401) {
              this.token = null;
              logger.info('Token expired, retrying with new token');
              return this.getProxyHosts();
            }
            const text = await response.text();
            throw new Error(`Failed to fetch proxy hosts: ${response.statusText} - ${text}`);
          }

          const hosts = await response.json() as NPMHost[];
          this.consecutiveFailures = 0; // Reset failure counter on success
          logger.debug(`Retrieved ${hosts.length} proxy hosts from NPM`);
          return hosts;
        } finally {
          clearTimeout(timeout);
        }
      } catch (error) {
        const isNetworkError = error instanceof Error && 
          (error.message.includes('ECONNREFUSED') || 
           error.message.includes('ETIMEDOUT') ||
           error.message.includes('getaddrinfo'));

        if (isNetworkError) {
          logger.error('NPM API is not accessible:', {
            url: this.apiUrl,
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        } else {
          logger.error('Error fetching proxy hosts:', {
            attempt: attempt + 1,
            error: error instanceof Error ? error.message : 'Unknown error'
          });
        }

        if (attempt < this.maxRetries - 1) {
          const waitTime = this.retryDelay * Math.pow(2, attempt); // Exponential backoff
          logger.info(`Retrying in ${waitTime}ms...`);
          await new Promise(resolve => setTimeout(resolve, waitTime));
        }
      }
    }

    this.consecutiveFailures++;
    logger.error('All attempts to fetch proxy hosts failed', {
      consecutiveFailures: this.consecutiveFailures,
      maxConsecutiveFailures: this.maxConsecutiveFailures
    });
    
    if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
      logger.error('Maximum consecutive failures reached. Stopping monitoring...');
      this.stopMonitoring();
      throw new Error('NPM API is unreachable after multiple attempts. Monitoring stopped.');
    }

    return [];
  }

  private async getChangesSinceLastCheck(): Promise<{
    currentHosts: NPMHost[];
    changedHosts: NPMHost[];
    deletedHosts: NPMHost[];
  }> {
    const currentHosts = await this.getProxyHosts();
    logger.debug(`Current check: Found ${currentHosts.length} hosts`);
    
    // If this is the first check after startup, treat all hosts as changed
    if (!this.isInitialized) {
      this.lastKnownHosts = currentHosts;
      this.isInitialized = true;
      logger.info('Initial hosts loaded, processing all hosts as new', {
        hostCount: currentHosts.length,
        hosts: currentHosts.map(h => ({
          id: h.id,
          domains: h.domain_names
        }))
      });
      return { 
        currentHosts, 
        changedHosts: currentHosts, // Treat all hosts as changed on first run
        deletedHosts: [] 
      };
    }

    // Check for modified and new hosts
    const changedHosts = currentHosts.filter(currentHost => {
      const previousHost = this.lastKnownHosts.find(h => h.id === currentHost.id);
      if (!previousHost) {
        logger.debug(`New host detected: ${currentHost.domain_names}`);
        return true;
      }
      
      // Compare all relevant fields to detect changes
      const hasChanged = 
        new Date(currentHost.modified_on).getTime() !== new Date(previousHost.modified_on).getTime() ||
        currentHost.forward_host !== previousHost.forward_host ||
        currentHost.forward_port !== previousHost.forward_port ||
        JSON.stringify(currentHost.domain_names) !== JSON.stringify(previousHost.domain_names);
      
      if (hasChanged) {
        logger.debug(`Modified host detected: ${currentHost.domain_names}`, {
          id: currentHost.id,
          changes: {
            modifiedOn: currentHost.modified_on !== previousHost.modified_on,
            forwardHost: currentHost.forward_host !== previousHost.forward_host,
            forwardPort: currentHost.forward_port !== previousHost.forward_port,
            domainNames: JSON.stringify(currentHost.domain_names) !== JSON.stringify(previousHost.domain_names)
          }
        });
      }
      return hasChanged;
    });

    // Check for deleted hosts
    const deletedHosts = this.lastKnownHosts.filter(previousHost => 
      !currentHosts.some(h => h.id === previousHost.id)
    );

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

  public stopMonitoring(): void {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    this.isMonitoring = false;
    this.isInitialized = false;
    logger.info('Monitoring stopped');
  }

  async startMonitoring(
    callback: (
      currentHosts: NPMHost[],
      changedHosts: NPMHost[],
      deletedHosts: NPMHost[]
    ) => Promise<void>
  ): Promise<void> {
    if (this.isMonitoring) {
      logger.warn('Monitoring is already running');
      return;
    }

    this.isMonitoring = true;
    this.isInitialized = false; // Reset initialization flag
    logger.info(`Starting NPM monitoring with ${this.checkInterval}ms interval`);

    const monitor = async () => {
      try {
        const timestamp = new Date().toISOString();
        logger.debug(`[${timestamp}] Running monitoring check`);
        const { currentHosts, changedHosts, deletedHosts } = await this.getChangesSinceLastCheck();
        
        if (changedHosts.length > 0 || deletedHosts.length > 0) {
          logger.info('Processing changes', {
            changedCount: changedHosts.length,
            deletedCount: deletedHosts.length,
            totalHosts: currentHosts.length
          });
          await callback(currentHosts, changedHosts, deletedHosts);
          logger.info('Changes processed successfully');
        } else {
          logger.debug(`[${timestamp}] No changes detected in this interval`);
        }
      } catch (error) {
        logger.error('Error in monitoring loop:', error);
        
        // Check if we should stop monitoring due to consecutive failures
        if (this.consecutiveFailures >= this.maxConsecutiveFailures) {
          logger.error('Maximum consecutive failures reached. Stopping monitoring...');
          this.stopMonitoring();
          return;
        }
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