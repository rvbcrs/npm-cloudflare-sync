import fetch, { RequestInit } from 'node-fetch';
import { logger } from './logger.js';
import { DNSRecord, CloudflareResponse, CloudflareZone } from './types.js';
import { getPublicIP } from './public-ip.js';

/**
 * Custom error class for Cloudflare API errors
 */
class CloudflareError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public response?: any
  ) {
    super(message);
    this.name = 'CloudflareError';
  }
}

/**
 * Handles all interactions with the Cloudflare API
 * Manages DNS records and zone information
 */
export class CloudflareAPI {
  private readonly apiToken: string;
  private readonly baseUrl: string = 'https://api.cloudflare.com/client/v4';
  private zones: Map<string, string> = new Map(); // domain -> zoneId
  private readonly maxRetries: number = 3;
  private readonly retryDelay: number = 1000; // 1 second

  constructor(apiToken: string) {
    if (!apiToken) {
      throw new Error('Cloudflare API token is required');
    }
    this.apiToken = apiToken;
    logger.info('CloudflareAPI initialized', {
      baseUrl: this.baseUrl,
      tokenLength: this.apiToken.length,
      maxRetries: this.maxRetries
    });
  }

  /**
   * Returns the standard headers required for Cloudflare API requests
   */
  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.apiToken}`,
      'Content-Type': 'application/json'
    };
  }

  /**
   * Implements exponential backoff for retrying failed requests
   */
  private async delay(attempt: number): Promise<void> {
    const waitTime = Math.min(this.retryDelay * Math.pow(2, attempt), 10000);
    await new Promise(resolve => setTimeout(resolve, waitTime));
  }

  /**
   * Makes a request to the Cloudflare API with retry logic
   */
  private async makeRequest<T>(
    url: string,
    options: RequestInit,
    context: string
  ): Promise<CloudflareResponse<T>> {
    let lastError: Error | null = null;
    
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        logger.debug(`Making request to ${url}`, {
          context,
          attempt: attempt + 1,
          method: options.method || 'GET'
        });

        const response = await fetch(url, {
          ...options,
          headers: {
            ...this.headers,
            ...(options.headers || {})
          }
        });
        
        // Log the raw response for debugging
        logger.debug('Received response', {
          status: response.status,
          statusText: response.statusText,
          headers: Object.fromEntries(response.headers.entries())
        });

        // Handle non-OK responses
        if (!response.ok) {
          const responseText = await response.text();
          let errorData;
          try {
            errorData = JSON.parse(responseText);
          } catch {
            errorData = { raw: responseText };
          }

          const errorMessage = errorData?.errors?.[0]?.message || response.statusText;
          
          // Log detailed error information
          logger.error('Request failed', {
            context,
            status: response.status,
            statusText: response.statusText,
            errorMessage,
            errorData,
            attempt: attempt + 1
          });

          switch (response.status) {
            case 530: // Authentication error
              throw new CloudflareError(
                'Authentication failed. Please check your API token.',
                response.status,
                errorData
              );
            case 429: // Rate limit
              if (attempt < this.maxRetries - 1) {
                const retryAfter = response.headers.get('Retry-After');
                const waitTime = retryAfter ? parseInt(retryAfter, 10) * 1000 : this.retryDelay;
                logger.warn(`Rate limited. Waiting ${waitTime}ms before retry...`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                continue;
              }
              break;
            case 403:
              throw new CloudflareError(
                'Access denied. Please check your API token permissions.',
                response.status,
                errorData
              );
            default:
              if (response.status >= 500 && attempt < this.maxRetries - 1) {
                logger.warn(`Server error ${response.status}. Retrying...`);
                await this.delay(attempt);
                continue;
              }
          }
          
          throw new CloudflareError(
            `${context} failed: ${errorMessage}`,
            response.status,
            errorData
          );
        }

        // Parse successful response
        const data = await response.json() as CloudflareResponse<T>;
        if (!data.success) {
          throw new CloudflareError(
            `${context} failed: ${data.errors[0]?.message || 'Unknown error'}`,
            response.status,
            data
          );
        }

        logger.debug(`Request successful`, {
          context,
          resultCount: Array.isArray(data.result) ? data.result.length : 1
        });

        return data;
      } catch (error) {
        lastError = error as Error;
        
        // Log detailed error information
        logger.error('Request error', {
          context,
          attempt: attempt + 1,
          error: {
            name: error.name,
            message: error.message,
            stack: error.stack
          }
        });

        if (error instanceof CloudflareError && error.statusCode === 530) {
          // Don't retry on authentication errors
          throw error;
        }

        if (!(error instanceof CloudflareError) && attempt < this.maxRetries - 1) {
          logger.warn(`Network error. Retrying...`);
          await this.delay(attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`${context} failed after ${this.maxRetries} attempts`);
  }

  /**
   * Fetches all zones available to the account
   */
  async getZones(): Promise<CloudflareZone[]> {
    try {
      const data = await this.makeRequest<CloudflareZone[]>(
        `${this.baseUrl}/zones`,
        { headers: this.headers },
        'Fetching zones'
      );
      logger.info(`Found ${data.result.length} Cloudflare zones`);
      return data.result;
    } catch (error) {
      if (error instanceof CloudflareError) {
        logger.error('Cloudflare API error:', {
          message: error.message,
          statusCode: error.statusCode
        });
      } else {
        logger.error('Error fetching zones:', error);
      }
      return [];
    }
  }

  /**
   * Initializes the zones map for quick lookups
   */
  async initZones(): Promise<void> {
    const zones = await this.getZones();
    this.zones.clear();
    for (const zone of zones) {
      this.zones.set(zone.name, zone.id);
      logger.info(`Mapped zone: ${zone.name} -> ${zone.id}`);
    }
    logger.info(`Initialized ${zones.length} Cloudflare zones`);

    // Check and update root domain A records
    await this.updateRootDomainRecords();
  }

  /**
   * Updates all root domain A records with the current public IP
   */
  private async updateRootDomainRecords(): Promise<void> {
    try {
      const publicIP = await getPublicIP();
      logger.debug('Checking root domain A records with current public IP:', { publicIP });

      for (const [domain, zoneId] of this.zones.entries()) {
        const records = await this.getDNSRecords(domain);
        const aRecord = records.find(r => r.type === 'A' && r.name === domain);

        logger.debug('Checking root domain record:', {
          domain,
          currentRecord: aRecord ? {
            type: aRecord.type,
            content: aRecord.content,
            proxied: aRecord.proxied
          } : 'No A record found',
          desiredIP: publicIP
        });

        if (aRecord) {
          if (aRecord.content !== publicIP) {
            logger.info(`Updating root domain A record for ${domain}`, {
              oldIP: aRecord.content,
              newIP: publicIP
            });

            await this.updateDNSRecord(domain, aRecord.id, {
              ...aRecord,
              content: publicIP
            });
          } else {
            logger.debug(`Root domain ${domain} already has correct IP`, {
              ip: publicIP
            });
          }
        } else {
          logger.info(`Creating root domain A record for ${domain}`, {
            ip: publicIP
          });

          await this.createDNSRecord(domain, {
            name: domain,
            type: 'A',
            content: publicIP,
            proxied: true
          });
        }
      }
    } catch (error) {
      logger.error('Error updating root domain records:', error);
    }
  }

  /**
   * Gets the root domain for a given domain/subdomain
   */
  getRootDomain(domain: string): string {
    let bestMatch = '';
    for (const zoneName of this.zones.keys()) {
      if (domain.endsWith(zoneName) && zoneName.length > bestMatch.length) {
        bestMatch = zoneName;
      }
    }
    return bestMatch;
  }

  /**
   * Gets the zone ID for a given domain
   */
  private getZoneIdForDomain(domain: string): string | undefined {
    const rootDomain = this.getRootDomain(domain);
    return this.zones.get(rootDomain);
  }

  /**
   * Fetches all DNS records for a given domain
   */
  async getDNSRecords(domain: string): Promise<DNSRecord[]> {
    const zoneId = this.getZoneIdForDomain(domain);
    if (!zoneId) {
      logger.warn(`No matching zone found for domain: ${domain}`);
      return [];
    }

    try {
      const data = await this.makeRequest<DNSRecord[]>(
        `${this.baseUrl}/zones/${zoneId}/dns_records`,
        { headers: this.headers },
        'Fetching DNS records'
      );
      return data.result;
    } catch (error) {
      if (error instanceof CloudflareError) {
        logger.error('Cloudflare API error:', {
          message: error.message,
          statusCode: error.statusCode,
          domain
        });
      } else {
        logger.error('Error fetching DNS records:', error);
      }
      return [];
    }
  }

  /**
   * Checks if a domain has a wildcard A record that would conflict with CNAME records
   * Only checks for single asterisk wildcard records
   */
  private async hasWildcardARecord(domain: string): Promise<boolean> {
    const rootDomain = this.getRootDomain(domain);
    const records = await this.getDNSRecords(rootDomain);
    
    const wildcardRecord = records.find(record => 
      record.type === 'A' && 
      record.name === '*.' + rootDomain  // Only check for single asterisk wildcard
    );

    if (wildcardRecord) {
      logger.warn(`Found wildcard A record for ${rootDomain}`, {
        recordName: wildcardRecord.name,
        content: wildcardRecord.content
      });
      return true;
    }

    return false;
  }

  /**
   * Creates a new DNS record with wildcard record check
   */
  async createDNSRecord(domain: string, data: Omit<DNSRecord, 'id'>): Promise<DNSRecord | null> {
    const zoneId = this.getZoneIdForDomain(domain);
    if (!zoneId) {
      logger.warn(`No matching zone found for domain: ${domain}`);
      return null;
    }

    // Check for wildcard record if trying to create a CNAME
    if (data.type === 'CNAME') {
      const hasWildcard = await this.hasWildcardARecord(domain);
      if (hasWildcard) {
        logger.error(`Cannot create CNAME record for ${domain} due to existing wildcard A record`, {
          domain,
          recordType: data.type,
          content: data.content
        });
        return null;
      }
    }

    try {
      const result = await this.makeRequest<DNSRecord>(
        `${this.baseUrl}/zones/${zoneId}/dns_records`,
        {
          method: 'POST',
          headers: this.headers,
          body: JSON.stringify(data)
        },
        'Creating DNS record'
      );
      logger.info(`Successfully created DNS record for ${domain}`, {
        type: data.type,
        content: data.content
      });
      return result.result;
    } catch (error) {
      if (error instanceof CloudflareError) {
        logger.error('Cloudflare API error:', {
          message: error.message,
          statusCode: error.statusCode,
          domain,
          recordType: data.type
        });
      } else {
        logger.error('Error creating DNS record:', error);
      }
      return null;
    }
  }

  /**
   * Updates an existing DNS record with wildcard record check
   */
  async updateDNSRecord(domain: string, recordId: string, data: Partial<DNSRecord>): Promise<DNSRecord | null> {
    const zoneId = this.getZoneIdForDomain(domain);
    if (!zoneId) {
      logger.warn(`No matching zone found for domain: ${domain}`);
      return null;
    }

    // Check for wildcard record if updating to a CNAME
    if (data.type === 'CNAME') {
      const hasWildcard = await this.hasWildcardARecord(domain);
      if (hasWildcard) {
        logger.error(`Cannot update to CNAME record for ${domain} due to existing wildcard A record`, {
          domain,
          recordType: data.type,
          content: data.content
        });
        return null;
      }
    }

    try {
      const result = await this.makeRequest<DNSRecord>(
        `${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: 'PUT',
          headers: this.headers,
          body: JSON.stringify(data)
        },
        'Updating DNS record'
      );
      logger.info(`Successfully updated DNS record for ${domain}`, {
        type: data.type,
        content: data.content
      });
      return result.result;
    } catch (error) {
      if (error instanceof CloudflareError) {
        logger.error('Cloudflare API error:', {
          message: error.message,
          statusCode: error.statusCode,
          domain,
          recordId
        });
      } else {
        logger.error('Error updating DNS record:', error);
      }
      return null;
    }
  }

  /**
   * Deletes a DNS record
   */
  async deleteDNSRecord(domain: string, recordId: string): Promise<boolean> {
    const zoneId = this.getZoneIdForDomain(domain);
    if (!zoneId) {
      logger.warn(`No matching zone found for domain: ${domain}`);
      return false;
    }

    try {
      await this.makeRequest<void>(
        `${this.baseUrl}/zones/${zoneId}/dns_records/${recordId}`,
        {
          method: 'DELETE',
          headers: this.headers
        },
        'Deleting DNS record'
      );
      logger.info(`Successfully deleted DNS record for ${domain}`, {
        recordId
      });
      return true;
    } catch (error) {
      if (error instanceof CloudflareError) {
        logger.error('Cloudflare API error:', {
          message: error.message,
          statusCode: error.statusCode,
          domain,
          recordId
        });
      } else {
        logger.error('Error deleting DNS record:', error);
      }
      return false;
    }
  }
}