import dotenv from 'dotenv';
import { Config, LogLevel } from './types.js';
import { logger } from './logger.js';

/**
 * Logs the source and value of environment variables
 * Masks sensitive values for security
 */
function logEnvironmentVariables(): void {
  const envSource = process.env.NODE_ENV === 'production' ? 'Docker/Environment' : '.env file';
  
  // Define variables to check and their masking rules
  const variables = [
    { name: 'CF_API_TOKEN', mask: true },
    { name: 'CF_EMAIL', mask: false },
    { name: 'NPM_API_URL', mask: false },
    { name: 'NPM_EMAIL', mask: false },
    { name: 'NPM_PASSWORD', mask: true },
    { name: 'CHECK_INTERVAL', mask: false },
    { name: 'LOG_LEVEL', mask: false },
    { name: 'AUTO_CREATE_ROOT_RECORDS', mask: false }
  ];

  logger.info('Environment Configuration:', {
    source: envSource,
    nodeEnv: process.env.NODE_ENV || 'development',
    variables: variables.reduce((acc, { name, mask }) => ({
      ...acc,
      [name]: {
        exists: !!process.env[name],
        value: mask ? (process.env[name] ? '********' : undefined) : process.env[name]
      }
    }), {})
  });
}

function validateLogLevel(level: string): LogLevel {
  const validLevels: LogLevel[] = ['error', 'warn', 'info', 'debug'];
  const normalizedLevel = level.toLowerCase() as LogLevel;
  
  if (validLevels.includes(normalizedLevel)) {
    return normalizedLevel;
  }
  
  logger.warn(`Invalid log level "${level}", defaulting to "info"`);
  return 'info';
}

function validateConfig(config: Config): boolean {
  const requiredFields = [
    { path: 'cloudflare.apiToken', value: config.cloudflare.apiToken, name: 'CF_API_TOKEN' },
    { path: 'cloudflare.email', value: config.cloudflare.email, name: 'CF_EMAIL' },
    { path: 'npm.apiUrl', value: config.npm.apiUrl, name: 'NPM_API_URL' },
    { path: 'npm.email', value: config.npm.email, name: 'NPM_EMAIL' },
    { path: 'npm.password', value: config.npm.password, name: 'NPM_PASSWORD' }
  ];

  let isValid = true;
  const missingFields: string[] = [];

  for (const field of requiredFields) {
    if (!field.value) {
      isValid = false;
      missingFields.push(field.name);
    }
  }

  if (!isValid) {
    logger.error('Missing required environment variables:', {
      missingFields,
      hint: process.env.NODE_ENV === 'production' 
        ? 'Please provide these variables when running the Docker container'
        : 'Please check your .env file and ensure all required variables are set'
    });
  }

  return isValid;
}

function getConfig(): Config | null {
  // Load .env file only in development
  if (process.env.NODE_ENV !== 'production') {
    dotenv.config();
  }

  const logLevel = validateLogLevel(process.env.LOG_LEVEL || 'info');
  logger.level = logLevel;

  // Log environment variables and their sources
  logEnvironmentVariables();

  const config = {
    cloudflare: {
      apiToken: process.env.CF_API_TOKEN || '',
      email: process.env.CF_EMAIL || ''
    },
    npm: {
      apiUrl: process.env.NPM_API_URL || '',
      email: process.env.NPM_EMAIL || '',
      password: process.env.NPM_PASSWORD || ''
    },
    checkInterval: parseInt(process.env.CHECK_INTERVAL || '10000', 10),
    logLevel,
    autoCreateRootRecords: process.env.AUTO_CREATE_ROOT_RECORDS?.toLowerCase() === 'true'
  };

  return validateConfig(config) ? config : null;
}

export const config = getConfig();