const { ethers } = require('ethers');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
require('dotenv').config();

// Configuration
const ETH_EXECUTION_RPC = process.env.ETH_EXECUTION_RPC || 'http://sui.bridge.neuler.xyz:8545';
const ETH_EXECUTION_METRICS = process.env.ETH_EXECUTION_METRICS;
const ETH_CONSENSUS_RPC = process.env.ETH_CONSENSUS_RPC;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '60');
const ENABLE_TELEGRAM = process.env.ENABLE_TELEGRAM === 'true';

// Reference RPCs for canonical chain comparison
const REFERENCE_RPCS = [
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth'
];

// GitHub APIs
const RETH_GITHUB_API = 'https://api.github.com/repos/paradigmxyz/reth/releases/latest';
const LIGHTHOUSE_GITHUB_API = 'https://api.github.com/repos/sigp/lighthouse/releases/latest';

const EXPECTED_CHAIN_ID = 1; // Ethereum Mainnet
const MAX_BLOCK_DELAY = 10;
const BLOCK_TIME_THRESHOLD_MS = 30000;
const MAX_PEER_COUNT_LOW = 10; // Minimum healthy peers
const MAX_MEMORY_MB = 16000; // 16GB warning threshold

class EthMonitor {
  constructor() {
    this.executionProvider = new ethers.JsonRpcProvider(ETH_EXECUTION_RPC);
    this.referenceProviders = REFERENCE_RPCS.map(url => new ethers.JsonRpcProvider(url));
    
    if (ENABLE_TELEGRAM && TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID) {
      this.telegram = new TelegramBot(TELEGRAM_BOT_TOKEN);
      this.telegramEnabled = true;
    } else {
      this.telegramEnabled = false;
      if (ENABLE_TELEGRAM) {
        console.warn('⚠ Telegram alerts disabled: Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID');
      }
    }
    
    this.lastAlerts = new Map();
  }

  async sendTelegramAlert(message, severity = 'warning') {
    if (!this.telegramEnabled) {
      console.log(`[TELEGRAM DISABLED] ${severity.toUpperCase()}: ${message}`);
      return;
    }

    const emoji = severity === 'critical' ? '🚨' : severity === 'warning' ? '⚠️' : 'ℹ️';
    const formattedMessage = `${emoji} *Ethereum Monitor Alert*\n\n${message}`;

    try {
      await this.telegram.sendMessage(TELEGRAM_CHAT_ID, formattedMessage, { parse_mode: 'Markdown' });
      console.log('✓ Telegram alert sent');
    } catch (error) {
      console.error('✗ Failed to send Telegram alert:', error.message);
    }
  }

  async shouldSendAlert(alertKey, cooldownMinutes = 60) {
    const lastSent = this.lastAlerts.get(alertKey);
    if (!lastSent) {
      this.lastAlerts.set(alertKey, Date.now());
      return true;
    }

    const minutesSinceLastAlert = (Date.now() - lastSent) / 1000 / 60;
    if (minutesSinceLastAlert >= cooldownMinutes) {
      this.lastAlerts.set(alertKey, Date.now());
      return true;
    }

    return false;
  }

  parsePrometheusMetrics(text) {
    const metrics = {};
    const lines = text.split('\n');
    
    for (const line of lines) {
      if (line.startsWith('#') || !line.trim()) continue;
      
      const match = line.match(/^([a-zA-Z_][a-zA-Z0-9_]*(?:{[^}]*})?)\s+([0-9.eE+-]+)$/);
      if (match) {
        const [, key, value] = match;
        const cleanKey = key.replace(/{.*}/, '');
        metrics[cleanKey] = parseFloat(value);
      }
    }
    
    return metrics;
  }

  async fetchMetrics(url) {
    try {
      const response = await axios.get(url, { timeout: 10000 });
      return this.parsePrometheusMetrics(response.data);
    } catch (error) {
      console.error(`Failed to fetch metrics from ${url}:`, error.message);
      return null;
    }
  }

  async getLatestGitHubRelease(apiUrl) {
    try {
      const response = await axios.get(apiUrl, {
        headers: {
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'EthMonitor'
        }
      });

      const tagName = response.data.tag_name;
      const version = tagName.replace(/^v/, '');
      
      return {
        version,
        tagName,
        publishedAt: response.data.published_at,
        url: response.data.html_url
      };
    } catch (error) {
      throw new Error(`Failed to fetch release: ${error.message}`);
    }
  }

  parseVersion(versionString) {
    const match = versionString.match(/(\d+)\.(\d+)\.(\d+)/);
    if (!match) return null;
    
    return {
      major: parseInt(match[1]),
      minor: parseInt(match[2]),
      patch: parseInt(match[3]),
      string: versionString
    };
  }

  compareVersions(current, latest) {
    const curr = this.parseVersion(current);
    const lat = this.parseVersion(latest);

    if (!curr || !lat) {
      return { outdated: null, message: 'Unable to parse versions' };
    }

    if (curr.major < lat.major) {
      return { outdated: true, severity: 'critical', message: 'Major version behind' };
    }
    if (curr.major > lat.major) {
      return { outdated: false, message: 'Ahead of latest' };
    }

    if (curr.minor < lat.minor) {
      return { outdated: true, severity: 'warning', message: 'Minor version behind' };
    }
    if (curr.minor > lat.minor) {
      return { outdated: false, message: 'Ahead of latest' };
    }

    if (curr.patch < lat.patch) {
      return { outdated: true, severity: 'info', message: 'Patch version behind' };
    }

    return { outdated: false, message: 'Up to date' };
  }

  async getCanonicalBlock() {
    const blockNumbers = await Promise.allSettled(
      this.referenceProviders.map(p => p.getBlockNumber())
    );

    const validBlocks = blockNumbers
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (validBlocks.length === 0) {
      throw new Error('Failed to get canonical block from any reference RPC');
    }

    return Math.max(...validBlocks);
  }

  async checkExecutionClient() {
    try {
      const [network, blockNumber, syncing] = await Promise.all([
        this.executionProvider.getNetwork(),
        this.executionProvider.getBlockNumber(),
        this.executionProvider.send('eth_syncing', [])
      ]);

      const chainId = Number(network.chainId);
      
      if (chainId !== EXPECTED_CHAIN_ID) {
        const message = `*Wrong Chain ID*\n\nExpected: \`${EXPECTED_CHAIN_ID}\`\nGot: \`${chainId}\``;
        if (await this.shouldSendAlert('wrong_chain_id', 60)) {
          await this.sendTelegramAlert(message, 'critical');
        }
        return {
          status: 'ERROR',
          message: `Wrong chain ID: ${chainId}`
        };
      }

      this.lastAlerts.delete('wrong_chain_id');

      return {
        status: 'OK',
        chainId,
        blockNumber,
        syncing: syncing !== false,
        syncInfo: syncing
      };
    } catch (error) {
      const message = `*Execution Client Unreachable*\n\n\`${error.message}\``;
      if (await this.shouldSendAlert('execution_down', 60)) {
        await this.sendTelegramAlert(message, 'critical');
      }
      return {
        status: 'ERROR',
        message: `Execution client check failed: ${error.message}`
      };
    }
  }

  async checkSyncStatus() {
    try {
      const executionBlock = await this.executionProvider.getBlockNumber();
      const canonicalBlock = await this.getCanonicalBlock();
      const blockDelay = canonicalBlock - executionBlock;

      if (blockDelay > MAX_BLOCK_DELAY) {
        const message = `*Node Out of Sync*\n\n` +
          `Lag: \`${blockDelay}\` blocks\n` +
          `Node: \`${executionBlock}\`\n` +
          `Canonical: \`${canonicalBlock}\``;
        
        if (await this.shouldSendAlert('out_of_sync', 60)) {
          await this.sendTelegramAlert(message, 'critical');
        }
        
        return {
          status: 'WARNING',
          executionBlock,
          canonicalBlock,
          blockDelay,
          message: `${blockDelay} blocks behind`
        };
      }

      this.lastAlerts.delete('out_of_sync');

      return {
        status: 'OK',
        executionBlock,
        canonicalBlock,
        blockDelay,
        message: `In sync (${blockDelay} blocks behind)`
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Sync check failed: ${error.message}`
      };
    }
  }

  async checkRethMetrics() {
    if (!ETH_EXECUTION_METRICS) {
      return { status: 'SKIPPED', message: 'Metrics URL not configured' };
    }

    const metrics = await this.fetchMetrics(ETH_EXECUTION_METRICS);
    if (!metrics) {
      const message = '*Reth Metrics Unavailable*';
      if (await this.shouldSendAlert('reth_metrics_unavailable', 60)) {
        await this.sendTelegramAlert(message, 'warning');
      }
      return { status: 'ERROR', message: 'Failed to fetch metrics' };
    }

    this.lastAlerts.delete('reth_metrics_unavailable');

    const issues = [];
    const info = {};

    // Peer count
    if (metrics.network_connected_peers !== undefined) {
      info.peers = metrics.network_connected_peers;
      
      if (metrics.network_connected_peers < MAX_PEER_COUNT_LOW) {
        issues.push(`Low peer count: ${metrics.network_connected_peers}`);
        
        const message = `*Low Peer Count*\n\nPeers: \`${metrics.network_connected_peers}\`\nMin: \`${MAX_PEER_COUNT_LOW}\``;
        if (await this.shouldSendAlert('low_peers', 120)) {
          await this.sendTelegramAlert(message, 'warning');
        }
      } else {
        this.lastAlerts.delete('low_peers');
      }
    }

    // Memory usage
    if (metrics.process_resident_memory_bytes !== undefined) {
      const memoryMB = Math.floor(metrics.process_resident_memory_bytes / 1024 / 1024);
      info.memoryMB = memoryMB;
      
      if (memoryMB > MAX_MEMORY_MB) {
        issues.push(`High memory: ${memoryMB}MB`);
        
        const message = `*High Memory Usage*\n\nCurrent: \`${memoryMB}MB\`\nThreshold: \`${MAX_MEMORY_MB}MB\``;
        if (await this.shouldSendAlert('high_memory', 180)) {
          await this.sendTelegramAlert(message, 'warning');
        }
      } else {
        this.lastAlerts.delete('high_memory');
      }
    }

    // Sync progress
    if (metrics.sync_progress !== undefined) {
      info.syncProgress = (metrics.sync_progress * 100).toFixed(2) + '%';
    }

    // Chain tip
    if (metrics.chain_tip_number !== undefined) {
      info.chainTip = metrics.chain_tip_number;
    }

    // CPU usage
    if (metrics.process_cpu_seconds_total !== undefined) {
      info.cpuSeconds = metrics.process_cpu_seconds_total;
    }

    return {
      status: issues.length > 0 ? 'WARNING' : 'OK',
      issues,
      info,
      message: issues.length > 0 ? issues.join('; ') : 'All metrics healthy'
    };
  }

  async checkRethVersion() {
    try {
      // Get version from web3_clientVersion
      const clientVersion = await this.executionProvider.send('web3_clientVersion', []);
      
      // Parse Reth version (e.g., "reth/v1.0.0/...")
      const versionMatch = clientVersion.match(/reth\/v?([0-9.]+)/i);
      if (!versionMatch) {
        return {
          status: 'UNKNOWN',
          message: `Could not parse version from: ${clientVersion}`
        };
      }

      const currentVersion = versionMatch[1];
      const latestRelease = await this.getLatestGitHubRelease(RETH_GITHUB_API);
      const comparison = this.compareVersions(currentVersion, latestRelease.version);

      if (comparison.outdated === true) {
        const message = `*Reth Update Available*\n\n` +
          `Current: \`${currentVersion}\`\n` +
          `Latest: \`${latestRelease.version}\`\n` +
          `Status: ${comparison.message}\n\n` +
          `[View Release](${latestRelease.url})`;

        if (await this.shouldSendAlert('reth_outdated', 360)) {
          await this.sendTelegramAlert(message, comparison.severity);
        }

        return {
          status: 'WARNING',
          currentVersion,
          latestVersion: latestRelease.version,
          outdated: true,
          severity: comparison.severity,
          message: comparison.message
        };
      }

      this.lastAlerts.delete('reth_outdated');

      return {
        status: 'OK',
        currentVersion,
        latestVersion: latestRelease.version,
        message: comparison.message
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Version check failed: ${error.message}`
      };
    }
  }

  async checkLighthouseConsensus() {
    if (!ETH_CONSENSUS_RPC) {
      return { status: 'SKIPPED', message: 'Consensus RPC not configured' };
    }

    try {
      // Check Lighthouse health
      const healthResponse = await axios.get(`${ETH_CONSENSUS_RPC}/eth/v1/node/health`, {
        timeout: 10000,
        validateStatus: () => true // Accept all status codes
      });

      // 200 = synced, 206 = syncing, 503 = not synced
      const isSynced = healthResponse.status === 200;
      const isSyncing = healthResponse.status === 206;

      if (!isSynced && !isSyncing) {
        const message = `*Consensus Client Issue*\n\nStatus: Not synced (${healthResponse.status})`;
        if (await this.shouldSendAlert('consensus_not_synced', 60)) {
          await this.sendTelegramAlert(message, 'critical');
        }
        return {
          status: 'ERROR',
          message: `Consensus not synced (HTTP ${healthResponse.status})`
        };
      }

      this.lastAlerts.delete('consensus_not_synced');

      // Get sync status details
      const syncResponse = await axios.get(`${ETH_CONSENSUS_RPC}/eth/v1/node/syncing`, {
        timeout: 10000
      });

      const syncData = syncResponse.data.data;

      return {
        status: isSynced ? 'OK' : 'SYNCING',
        headSlot: syncData.head_slot,
        syncDistance: syncData.sync_distance,
        isSynced,
        isSyncing,
        message: isSynced ? 'Synced' : `Syncing (${syncData.sync_distance} slots behind)`
      };
    } catch (error) {
      const message = `*Consensus Client Unreachable*\n\n\`${error.message}\``;
      if (await this.shouldSendAlert('consensus_down', 60)) {
        await this.sendTelegramAlert(message, 'critical');
      }
      return {
        status: 'ERROR',
        message: `Consensus check failed: ${error.message}`
      };
    }
  }

  async checkLighthouseVersion() {
    if (!ETH_CONSENSUS_RPC) {
      return { status: 'SKIPPED', message: 'Consensus RPC not configured' };
    }

    try {
      const versionResponse = await axios.get(`${ETH_CONSENSUS_RPC}/eth/v1/node/version`, {
        timeout: 10000
      });

      const versionData = versionResponse.data.data.version;
      
      // Parse Lighthouse version (e.g., "Lighthouse/v5.0.0/...")
      const versionMatch = versionData.match(/Lighthouse\/v?([0-9.]+)/i);
      if (!versionMatch) {
        return {
          status: 'UNKNOWN',
          message: `Could not parse version from: ${versionData}`
        };
      }

      const currentVersion = versionMatch[1];
      const latestRelease = await this.getLatestGitHubRelease(LIGHTHOUSE_GITHUB_API);
      const comparison = this.compareVersions(currentVersion, latestRelease.version);

      if (comparison.outdated === true) {
        const message = `*Lighthouse Update Available*\n\n` +
          `Current: \`${currentVersion}\`\n` +
          `Latest: \`${latestRelease.version}\`\n` +
          `Status: ${comparison.message}\n\n` +
          `[View Release](${latestRelease.url})`;

        if (await this.shouldSendAlert('lighthouse_outdated', 360)) {
          await this.sendTelegramAlert(message, comparison.severity);
        }

        return {
          status: 'WARNING',
          currentVersion,
          latestVersion: latestRelease.version,
          outdated: true,
          severity: comparison.severity,
          message: comparison.message
        };
      }

      this.lastAlerts.delete('lighthouse_outdated');

      return {
        status: 'OK',
        currentVersion,
        latestVersion: latestRelease.version,
        message: comparison.message
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Version check failed: ${error.message}`
      };
    }
  }

  async runChecks() {
    console.log('='.repeat(70));
    console.log('ETHEREUM NODE MONITOR - Health Check');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Execution RPC: ${ETH_EXECUTION_RPC}`);
    console.log(`Telegram Alerts: ${this.telegramEnabled ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(70));
    console.log();

    let hasErrors = false;
    let hasWarnings = false;

    // Execution client check
    console.log('⚙️  Execution Client (Reth)');
    const execCheck = await this.checkExecutionClient();
    if (execCheck.status === 'OK') {
      console.log(`  ✓ Chain ID: ${execCheck.chainId}`);
      console.log(`  ✓ Block: ${execCheck.blockNumber}`);
      console.log(`  ✓ Syncing: ${execCheck.syncing ? 'Yes' : 'No'}`);
    } else {
      console.log(`  ✗ ${execCheck.message}`);
      hasErrors = true;
    }
    console.log();

    // Sync status
    console.log('🔄 Sync Status');
    const syncCheck = await this.checkSyncStatus();
    if (syncCheck.status === 'OK') {
      console.log(`  ✓ ${syncCheck.message}`);
      console.log(`    Node: ${syncCheck.executionBlock} | Canonical: ${syncCheck.canonicalBlock}`);
    } else if (syncCheck.status === 'WARNING') {
      console.log(`  ⚠ ${syncCheck.message}`);
      hasWarnings = true;
    } else {
      console.log(`  ✗ ${syncCheck.message}`);
      hasErrors = true;
    }
    console.log();

    // Reth metrics
    console.log('📊 Reth Metrics');
    const metricsCheck = await this.checkRethMetrics();
    if (metricsCheck.status === 'OK') {
      console.log('  ✓ All metrics healthy');
      if (metricsCheck.info) {
        if (metricsCheck.info.peers !== undefined) {
          console.log(`    - Peers: ${metricsCheck.info.peers}`);
        }
        if (metricsCheck.info.memoryMB !== undefined) {
          console.log(`    - Memory: ${metricsCheck.info.memoryMB}MB`);
        }
        if (metricsCheck.info.chainTip !== undefined) {
          console.log(`    - Chain tip: ${metricsCheck.info.chainTip}`);
        }
      }
    } else if (metricsCheck.status === 'WARNING') {
      console.log(`  ⚠ ${metricsCheck.message}`);
      hasWarnings = true;
    } else if (metricsCheck.status === 'ERROR') {
      console.log(`  ✗ ${metricsCheck.message}`);
      hasErrors = true;
    } else {
      console.log(`  ⊘ ${metricsCheck.message}`);
    }
    console.log();

    // Reth version
    console.log('🔍 Reth Version');
    const rethVersion = await this.checkRethVersion();
    if (rethVersion.status === 'OK') {
      console.log(`  ✓ Current: ${rethVersion.currentVersion}`);
      console.log(`  ✓ Latest: ${rethVersion.latestVersion}`);
      console.log(`  ✓ Status: ${rethVersion.message}`);
    } else if (rethVersion.status === 'WARNING') {
      console.log(`  ⚠ Current: ${rethVersion.currentVersion}`);
      console.log(`  ⚠ Latest: ${rethVersion.latestVersion}`);
      console.log(`  ⚠ ${rethVersion.message}`);
      hasWarnings = true;
    } else {
      console.log(`  ✗ ${rethVersion.message}`);
      hasErrors = true;
    }
    console.log();

    // Consensus client
    console.log('🏛️  Consensus Client (Lighthouse)');
    const consensusCheck = await this.checkLighthouseConsensus();
    if (consensusCheck.status === 'OK') {
      console.log(`  ✓ Status: ${consensusCheck.message}`);
      console.log(`  ✓ Head slot: ${consensusCheck.headSlot}`);
    } else if (consensusCheck.status === 'SYNCING') {
      console.log(`  ⚠ ${consensusCheck.message}`);
      console.log(`    Head slot: ${consensusCheck.headSlot}`);
      hasWarnings = true;
    } else if (consensusCheck.status === 'ERROR') {
      console.log(`  ✗ ${consensusCheck.message}`);
      hasErrors = true;
    } else {
      console.log(`  ⊘ ${consensusCheck.message}`);
    }
    console.log();

    // Lighthouse version
    console.log('🔍 Lighthouse Version');
    const lighthouseVersion = await this.checkLighthouseVersion();
    if (lighthouseVersion.status === 'OK') {
      console.log(`  ✓ Current: ${lighthouseVersion.currentVersion}`);
      console.log(`  ✓ Latest: ${lighthouseVersion.latestVersion}`);
      console.log(`  ✓ Status: ${lighthouseVersion.message}`);
    } else if (lighthouseVersion.status === 'WARNING') {
      console.log(`  ⚠ Current: ${lighthouseVersion.currentVersion}`);
      console.log(`  ⚠ Latest: ${lighthouseVersion.latestVersion}`);
      console.log(`  ⚠ ${lighthouseVersion.message}`);
      hasWarnings = true;
    } else if (lighthouseVersion.status === 'ERROR') {
      console.log(`  ✗ ${lighthouseVersion.message}`);
      hasErrors = true;
    } else {
      console.log(`  ⊘ ${lighthouseVersion.message}`);
    }
    console.log();

    console.log('='.repeat(70));

    if (hasErrors) {
      console.log('STATUS: CRITICAL - Errors detected');
      return 1;
    } else if (hasWarnings) {
      console.log('STATUS: WARNING - Issues detected');
      return 0;
    } else {
      console.log('STATUS: HEALTHY - All checks passed');
      return 0;
    }
  }

  async startContinuousMonitoring() {
    console.log(`🚀 Starting continuous monitoring (interval: ${CHECK_INTERVAL_MINUTES} minutes)`);
    console.log();

    // Send startup notification
    if (this.telegramEnabled) {
      const startupMessage = `🚀 *Ethereum Monitor Started*\n\n` +
        `Execution: Reth\n` +
        `Consensus: Lighthouse\n` +
        `Check Interval: ${CHECK_INTERVAL_MINUTES} minutes\n` +
        `Status: Initializing first health check...`;
      
      await this.sendTelegramAlert(startupMessage, 'info');
    }

    // Run immediately
    await this.runChecks();

    // Then run on interval
    setInterval(async () => {
      console.log();
      await this.runChecks();
    }, CHECK_INTERVAL_MINUTES * 60 * 1000);
  }
}

// CLI
const monitor = new EthMonitor();

const args = process.argv.slice(2);
if (args.includes('--continuous') || args.includes('-c')) {
  monitor.startContinuousMonitoring().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
} else {
  monitor.runChecks()
    .then(exitCode => process.exit(exitCode))
    .catch(error => {
      console.error('Fatal error:', error);
      process.exit(1);
    });
}
