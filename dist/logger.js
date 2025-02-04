import winston from 'winston';
const customFormat = winston.format.printf(({ level, message, timestamp, ...metadata }) => {
    let msg = `${timestamp} [${level}]: ${message}`;
    if (Object.keys(metadata).length > 0) {
        msg += ` ${JSON.stringify(metadata)}`;
    }
    return msg;
});
export const logger = winston.createLogger({
    level: 'debug', // Set to debug to see all messages
    format: winston.format.combine(winston.format.timestamp(), winston.format.colorize(), customFormat),
    transports: [
        new winston.transports.Console()
    ]
});
