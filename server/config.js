import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

// Load environment variables from root folder
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const rootDir = join(__dirname, '..'); // Go up one level to root

config({ path: join(rootDir, '.env') });

// Default configuration values
const defaults = {
  // Server Configuration
  WS_URL: 'ws://localhost:8080',
  
  // Transcript Processing
  TRANSCRIPT_END_TIMEOUT: 5000,
  BATCH_SIZE: 50,
  SEND_INTERVAL: 50,
  
  // Logging
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'compact',
  
  // Session Management
  SESSION_TIMEOUT: 300000,
  MAX_RECONNECT_ATTEMPTS: 10,
  RECONNECT_DELAY_BASE: 1000,
};

// Type-safe configuration loader
class Config {
  constructor() {
    this.values = {};
    this.loadConfig();
  }

  loadConfig() {
    // Load from environment variables with fallback to defaults
    for (const [key, defaultValue] of Object.entries(defaults)) {
      const envValue = process.env[key];
      
      if (envValue !== undefined) {
        // Type conversion based on default value type
        if (typeof defaultValue === 'number') {
          this.values[key] = parseInt(envValue, 10) || defaultValue;
        } else if (typeof defaultValue === 'boolean') {
          this.values[key] = envValue.toLowerCase() === 'true';
        } else {
          this.values[key] = envValue;
        }
      } else {
        this.values[key] = defaultValue;
      }
    }
  }

  // Safe getter methods
  getWsUrl() {
    return this.values.WS_URL;
  }

  getPort() {
    // Extract port from WS_URL for backward compatibility
    const url = new URL(this.values.WS_URL);
    return parseInt(url.port) || (url.protocol === 'wss:' ? 443 : 80);
  }

  getHost() {
    // Extract host from WS_URL for backward compatibility
    const url = new URL(this.values.WS_URL);
    return url.hostname;
  }

  getTranscriptEndTimeout() {
    return this.values.TRANSCRIPT_END_TIMEOUT;
  }

  getBatchSize() {
    return this.values.BATCH_SIZE;
  }

  getSendInterval() {
    return this.values.SEND_INTERVAL;
  }

  getLogLevel() {
    return this.values.LOG_LEVEL;
  }

  getLogFormat() {
    return this.values.LOG_FORMAT;
  }

  getSessionTimeout() {
    return this.values.SESSION_TIMEOUT;
  }

  getMaxReconnectAttempts() {
    return this.values.MAX_RECONNECT_ATTEMPTS;
  }

  getReconnectDelayBase() {
    return this.values.RECONNECT_DELAY_BASE;
  }

  // Get all config for debugging
  getAll() {
    return { ...this.values };
  }

  // Validate configuration
  validate() {
    const errors = [];

    // Validate WS_URL format
    try {
      const url = new URL(this.getWsUrl());
      if (!['ws:', 'wss:'].includes(url.protocol)) {
        errors.push('WS_URL must use ws:// or wss:// protocol');
      }
      if (!url.hostname) {
        errors.push('WS_URL must include a valid hostname');
      }
    } catch (e) {
      errors.push('WS_URL must be a valid URL');
    }

    if (this.getTranscriptEndTimeout() < 1000) {
      errors.push('TRANSCRIPT_END_TIMEOUT must be at least 1000ms');
    }

    if (this.getBatchSize() < 1) {
      errors.push('BATCH_SIZE must be at least 1');
    }

    if (this.getSendInterval() < 10) {
      errors.push('SEND_INTERVAL must be at least 10ms');
    }

    if (errors.length > 0) {
      throw new Error(`Configuration validation failed:\n${errors.join('\n')}`);
    }

    return true;
  }
}

// Export singleton instance
export const appConfig = new Config();

// Validate configuration on load
try {
  appConfig.validate();
//   console.log('Configuration loaded successfully:', appConfig.getAll());
  console.log('Configuration loaded successfully');
} catch (error) {
  console.error('Configuration validation failed:', error.message);
  process.exit(1);
}
