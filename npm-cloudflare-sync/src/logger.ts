import winston from 'winston';

// Get log level from environment variable, default to 'info'
const logLevel = (process.env.LOG_LEVEL || 'info').toLowerCase();

const customFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
  let msg = `${timestamp} [${level}]: ${message}`;
  if (Object.keys(metadata).length > 0) {
    msg += ` ${JSON.stringify(metadata)}`;
  }
  return msg;
});

export const logger = winston.createLogger({
  level: logLevel,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.colorize(),
    customFormat
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.colorize(),
        customFormat
      )
    })
  ]
});

// Log initial configuration
logger.debug('Logger initialized', {
  level: logLevel,
  availableLevels: Object.keys(logger.levels)
});