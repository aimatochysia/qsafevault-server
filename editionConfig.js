/**
 * Edition Configuration for qsafevault-server
 * 
 * The Edition determines the server's operational mode and feature set.
 * This is configured via environment variables and is immutable for the
 * lifetime of the server process.
 * 
 * SECURITY PRINCIPLES:
 * - Server remains zero-knowledge
 * - No account database
 * - No vault data storage beyond encrypted blobs
 * - All cryptographic operations happen on the client
 */

const EDITION = {
  CONSUMER: 'consumer',
  ENTERPRISE: 'enterprise',
};

/**
 * Edition configuration
 */
class EditionConfig {
  constructor() {
    // Load edition from environment
    const editionEnv = (process.env.QSAFEVAULT_EDITION || 'consumer').toLowerCase().trim();
    
    if (editionEnv !== EDITION.CONSUMER && editionEnv !== EDITION.ENTERPRISE) {
      throw new Error(`Invalid QSAFEVAULT_EDITION: ${editionEnv}. Must be 'consumer' or 'enterprise'.`);
    }
    
    this.edition = editionEnv;
    this.isEnterprise = editionEnv === EDITION.ENTERPRISE;
    this.isConsumer = editionEnv === EDITION.CONSUMER;
    
    // Enterprise-specific configuration
    if (this.isEnterprise) {
      this._validateEnterpriseConfig();
    }
    
    this._logConfiguration();
  }
  
  /**
   * Validate Enterprise mode configuration
   * Enterprise mode MUST fail fast on misconfiguration
   */
  _validateEnterpriseConfig() {
    const errors = [];
    
    // Enterprise requires explicit acknowledgment
    if (!process.env.QSAFEVAULT_ENTERPRISE_ACKNOWLEDGED) {
      errors.push(
        'ENTERPRISE MODE: Explicit acknowledgment required. ' +
        'Set QSAFEVAULT_ENTERPRISE_ACKNOWLEDGED=true to confirm.'
      );
    }
    
    // Enterprise MUST NOT use managed/public deployment platforms
    // These platforms are designed for public hosting, not enterprise self-hosted deployments
    const managedPlatforms = [];
    if (process.env.VERCEL) managedPlatforms.push('Vercel');
    if (process.env.NETLIFY) managedPlatforms.push('Netlify');
    if (process.env.HEROKU) managedPlatforms.push('Heroku');
    if (process.env.AWS_LAMBDA_FUNCTION_NAME) managedPlatforms.push('AWS Lambda');
    if (process.env.GOOGLE_CLOUD_PROJECT) managedPlatforms.push('Google Cloud Functions');
    if (process.env.AZURE_FUNCTIONS_ENVIRONMENT) managedPlatforms.push('Azure Functions');
    
    if (managedPlatforms.length > 0) {
      // Check if self-hosted override is set
      if (process.env.QSAFEVAULT_ENTERPRISE_ALLOW_MANAGED === 'true') {
        console.warn(
          'WARNING: Enterprise mode on managed platform explicitly allowed. ' +
          `Platforms detected: ${managedPlatforms.join(', ')}. ` +
          'Ensure you understand the security implications.'
        );
      } else {
        errors.push(
          `ENTERPRISE MODE: Self-hosted deployment required. ` +
          `Managed platform(s) detected: ${managedPlatforms.join(', ')}. ` +
          'Enterprise mode is designed for organization-controlled infrastructure. ' +
          'To override (not recommended), set QSAFEVAULT_ENTERPRISE_ALLOW_MANAGED=true.'
        );
      }
    }
    
    if (errors.length > 0) {
      throw new Error(
        'ENTERPRISE MODE CONFIGURATION ERRORS:\n' +
        errors.map(e => `  - ${e}`).join('\n')
      );
    }
  }
  
  /**
   * Log the configuration at startup
   */
  _logConfiguration() {
    console.log('=================================================');
    console.log('QSafeVault Server Configuration');
    console.log(`Edition: ${this.edition.toUpperCase()}`);
    console.log(`Mode: ${this.isEnterprise ? 'Production' : 'Flexible'}`);
    console.log('=================================================');
    
    if (this.isEnterprise) {
      console.log('ENTERPRISE MODE ACTIVE:');
      console.log('  - Device registry: ENABLED');
      console.log('  - Device approval: ENABLED');
      console.log('  - Audit logging: ENABLED');
      console.log('  - Policy enforcement: ENABLED');
      console.log('  - Self-hosted only');
    } else {
      console.log('CONSUMER MODE ACTIVE:');
      console.log('  - Stateless relay: ENABLED');
      console.log('  - Ephemeral storage: ENABLED');
      console.log('  - Device registry: DISABLED');
    }
    console.log('=================================================');
  }
  
  /**
   * Get edition information for handshake
   */
  getEditionInfo() {
    return {
      edition: this.edition,
      isEnterprise: this.isEnterprise,
      features: this.getFeatures(),
      timestamp: Date.now(),
    };
  }
  
  /**
   * Get available features for this edition
   */
  getFeatures() {
    const baseFeatures = {
      relay: true,
      ephemeralChunks: true,
      webrtcSignaling: true,
    };
    
    if (this.isEnterprise) {
      return {
        ...baseFeatures,
        deviceRegistry: true,
        deviceApproval: true,
        deviceRevocation: true,
        auditLogging: true,
        policyEnforcement: true,
        organizationNamespace: true,
      };
    }
    
    return baseFeatures;
  }
  
  /**
   * Check if a feature is available
   */
  hasFeature(feature) {
    return this.getFeatures()[feature] === true;
  }
  
  /**
   * Require Enterprise mode for an operation
   * Throws if not in Enterprise mode
   */
  requireEnterprise(operation) {
    if (!this.isEnterprise) {
      throw new Error(
        `Operation '${operation}' requires Enterprise mode. ` +
        'Set QSAFEVAULT_EDITION=enterprise to enable.'
      );
    }
  }
  
  /**
   * Validate client edition compatibility
   * Enterprise server accepts both Consumer and Enterprise clients
   * Consumer server should warn about Enterprise clients
   */
  validateClientEdition(clientEdition) {
    if (this.isConsumer && clientEdition === EDITION.ENTERPRISE) {
      // This is a warning, not an error - Enterprise client will reject this server
      console.warn(
        'WARNING: Enterprise client connecting to Consumer server. ' +
        'The client should reject this connection.'
      );
    }
    return true;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the global edition configuration
 * Initializes on first call
 */
function getEditionConfig() {
  if (!instance) {
    instance = new EditionConfig();
  }
  return instance;
}

/**
 * Reset the edition configuration (for testing only)
 */
function resetEditionConfig() {
  instance = null;
}

module.exports = {
  EDITION,
  EditionConfig,
  getEditionConfig,
  resetEditionConfig,
};
