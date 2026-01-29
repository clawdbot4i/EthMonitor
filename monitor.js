const { ethers } = require('ethers');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
require('dotenv').config();

// Configuration
const ETH_EXECUTION_RPC = process.env.ETH_EXECUTION_RPC || 'http://sui.bridge.neuler.xyz:8545';
const ETH_EXECUTION_WS = process.env.ETH_EXECUTION_WS || 'ws://sui.bridge.neuler.xyz:8546';
const ETH_EXECUTION_METRICS = process.env.ETH_EXECUTION_METRICS;
const ETH_CONSENSUS_RPC = process.env.ETH_CONSENSUS_RPC;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const METRICS_POLL_INTERVAL_SEC = parseInt(process.env.METRICS_POLL_INTERVAL_SEC || '30');
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

const EXPECTED_CHAIN_ID = 1;
const MAX_BLOCK_DELAY = 10;
const BLOCK_TIME_THRESHOLD_MS = 30000;
const MAX_PEER_COUNT_LOW = 10;
const MAX_MEMORY_MB = 16000;
const VERSION_CHECK_INTERVAL_HOURS = 6;

class EthMonitor {
  constructor() {
    this.executionProvider = new ethers.JsonRpcProvider(ETH_EXECUTION_RPC);
    this.wsProvider = null;
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
    this.lastBlockTime = Date.now();
    this.lastBlockNumber = 0;
    this.lastMetricsCheck = 0;
    this.lastVersionCheck = 0;
    this.isHealthy = true;
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
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
      console.log(`✓ Telegram alert sent: ${severity}`);
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

  async handleNewBlock(blockNumber, blockHash) {
    const now = Date.now();
    const timeSinceLastBlock = now - this.lastBlockTime;
    
    console.log(`📦 New block: ${blockNumber} (${(timeSinceLastBlock / 1000).toFixed(1)}s since last)`);
    
    // Check for block stall (no blocks for too long)
    if (timeSinceLastBlock > BLOCK_TIME_THRESHOLD_MS) {
      const message = `*Block Production Stalled*\n\n` +
        `Last block was \`${(timeSinceLastBlock / 1000).toFixed(0)}s\` ago\n` +
        `Block: \`${blockNumber}\``;
      
      if (await this.shouldSendAlert('block_stall', 10)) {
        await this.sendTelegramAlert(message, 'critical');
      }
    } else {
      this.lastAlerts.delete('block_stall');
    }

    // Check sync status against canonical chain
    try {
      const canonicalBlock = await this.getCanonicalBlock();
      const blockDelay = canonicalBlock - blockNumber;

      if (blockDelay > MAX_BLOCK_DELAY) {
        const message = `*Node Out of Sync*\n\n` +
          `Lag: \`${blockDelay}\` blocks\n` +
          `Node: \`${blockNumber}\`\n` +
          `Canonical: \`${canonicalBlock}\``;
        
        if (await this.shouldSendAlert('out_of_sync', 15)) {
          await this.sendTelegramAlert(message, 'critical');
        }
      } else {
        this.lastAlerts.delete('out_of_sync');
      }
    } catch (error) {
      console.error('Failed to check canonical sync:', error.message);
    }

    this.lastBlockTime = now;
    this.lastBlockNumber = blockNumber;
    this.isHealthy = true;
  }

  async checkMetrics() {
    const now = Date.now();
    if (now - this.lastMetricsCheck < METRICS_POLL_INTERVAL_SEC * 1000) {
      return;
    }
    this.lastMetricsCheck = now;

    if (!ETH_EXECUTION_METRICS) return;

    const metrics = await this.fetchMetrics(ETH_EXECUTION_METRICS);
    if (!metrics) {
      const message = '*Reth Metrics Unavailable*';
      if (await this.shouldSendAlert('reth_metrics_unavailable', 60)) {
        await this.sendTelegramAlert(message, 'warning');
      }
      return;
    }

    this.lastAlerts.delete('reth_metrics_unavailable');

    // Peer count
    if (metrics.network_connected_peers !== undefined) {
      if (metrics.network_connected_peers < MAX_PEER_COUNT_LOW) {
        const message = `*Low Peer Count*\n\nPeers: \`${metrics.network_connected_peers}\`\nMin: \`${MAX_PEER_COUNT_LOW}\``;
        if (await this.shouldSendAlert('low_peers', 30)) {
          await this.sendTelegramAlert(message, 'warning');
        }
      } else {
        this.lastAlerts.delete('low_peers');
      }
    }

    // Memory usage
    if (metrics.process_resident_memory_bytes !== undefined) {
      const memoryMB = Math.floor(metrics.process_resident_memory_bytes / 1024 / 1024);
      
      if (memoryMB > MAX_MEMORY_MB) {
        const message = `*High Memory Usage*\n\nCurrent: \`${memoryMB}MB\`\nThreshold: \`${MAX_MEMORY_MB}MB\``;
        if (await this.shouldSendAlert('high_memory', 60)) {
          await this.sendTelegramAlert(message, 'warning');
        }
      } else {
        this.lastAlerts.delete('high_memory');
      }
    }

    console.log(`📊 Metrics check: peers=${metrics.network_connected_peers || 'N/A'}, memory=${metrics.process_resident_memory_bytes ? Math.floor(metrics.process_resident_memory_bytes / 1024 / 1024) + 'MB' : 'N/A'}`);
  }

  async checkVersions() {
    const now = Date.now();
    const hoursSinceLastCheck = (now - this.lastVersionCheck) / 1000 / 3600;
    
    if (hoursSinceLastCheck < VERSION_CHECK_INTERVAL_HOURS) {
      return;
    }
    this.lastVersionCheck = now;

    console.log('🔍 Checking versions...');

    // Check Reth version
    try {
      const clientVersion = await this.executionProvider.send('web3_clientVersion', []);
      const versionMatch = clientVersion.match(/reth\/v?([0-9.]+)/i);
      
      if (versionMatch) {
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
        } else {
          this.lastAlerts.delete('reth_outdated');
        }
      }
    } catch (error) {
      console.error('Failed to check Reth version:', error.message);
    }

    // Check Lighthouse version
    if (ETH_CONSENSUS_RPC) {
      try {
        const versionResponse = await axios.get(`${ETH_CONSENSUS_RPC}/eth/v1/node/version`, {
          timeout: 10000
        });

        const versionData = versionResponse.data.data.version;
        const versionMatch = versionData.match(/Lighthouse\/v?([0-9.]+)/i);
        
        if (versionMatch) {
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
          } else {
            this.lastAlerts.delete('lighthouse_outdated');
          }
        }
      } catch (error) {
        console.error('Failed to check Lighthouse version:', error.message);
      }
    }
  }

  async setupWebSocketConnection() {
    console.log(`🔌 Connecting to WebSocket: ${ETH_EXECUTION_WS}`);

    try {
      this.wsProvider = new ethers.WebSocketProvider(ETH_EXECUTION_WS);

      // Subscribe to new block headers
      this.wsProvider.on('block', async (blockNumber) => {
        try {
          const block = await this.wsProvider.getBlock(blockNumber);
          await this.handleNewBlock(blockNumber, block.hash);
          await this.checkMetrics();
          await this.checkVersions();
        } catch (error) {
          console.error('Error handling block:', error.message);
        }
      });

      // Access the underlying WebSocket for connection events
      const ws = this.wsProvider.websocket;
      
      ws.on('error', async (error) => {
        console.error('❌ WebSocket error:', error.message);
        
        const message = `*WebSocket Connection Error*\n\n\`${error.message}\``;
        if (await this.shouldSendAlert('ws_error', 30)) {
          await this.sendTelegramAlert(message, 'critical');
        }
      });

      ws.on('close', () => {
        console.warn('⚠️  WebSocket connection closed');
        this.reconnect();
      });

      console.log('✓ WebSocket connected - listening for new blocks');
      this.reconnectAttempts = 0;
      
      // Initial health check
      const blockNumber = await this.wsProvider.getBlockNumber();
      console.log(`📊 Current block: ${blockNumber}`);

    } catch (error) {
      console.error('Failed to setup WebSocket:', error.message);
      this.reconnect();
    }
  }

  async reconnect() {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      const message = `*Monitor Connection Failed*\n\nFailed to reconnect after ${this.maxReconnectAttempts} attempts`;
      await this.sendTelegramAlert(message, 'critical');
      
      console.error('❌ Max reconnection attempts reached. Exiting...');
      process.exit(1);
    }

    this.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 60000); // Exponential backoff, max 60s
    
    console.log(`🔄 Reconnecting in ${delay / 1000}s (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})...`);
    
    if (this.wsProvider) {
      try {
        await this.wsProvider.destroy();
      } catch (e) {
        // Ignore errors during cleanup
      }
      this.wsProvider = null;
    }

    setTimeout(() => {
      this.setupWebSocketConnection();
    }, delay);
  }

  async checkConsensusHealth() {
    if (!ETH_CONSENSUS_RPC) return;

    try {
      const healthResponse = await axios.get(`${ETH_CONSENSUS_RPC}/eth/v1/node/health`, {
        timeout: 10000,
        validateStatus: () => true
      });

      const isSynced = healthResponse.status === 200;
      const isSyncing = healthResponse.status === 206;

      if (!isSynced && !isSyncing) {
        const message = `*Consensus Client Not Synced*\n\nStatus: HTTP ${healthResponse.status}`;
        if (await this.shouldSendAlert('consensus_not_synced', 30)) {
          await this.sendTelegramAlert(message, 'critical');
        }
      } else {
        this.lastAlerts.delete('consensus_not_synced');
      }
    } catch (error) {
      const message = `*Consensus Client Unreachable*\n\n\`${error.message}\``;
      if (await this.shouldSendAlert('consensus_down', 30)) {
        await this.sendTelegramAlert(message, 'critical');
      }
    }
  }

  async startMonitoring() {
    console.log('='.repeat(70));
    console.log('🚀 ETHEREUM MONITOR - Real-Time Event-Driven Mode');
    console.log('='.repeat(70));
    console.log(`Execution RPC: ${ETH_EXECUTION_RPC}`);
    console.log(`Execution WS: ${ETH_EXECUTION_WS}`);
    console.log(`Consensus RPC: ${ETH_CONSENSUS_RPC || 'Not configured'}`);
    console.log(`Metrics Endpoint: ${ETH_EXECUTION_METRICS || 'Not configured'}`);
    console.log(`Metrics Poll Interval: ${METRICS_POLL_INTERVAL_SEC}s`);
    console.log(`Telegram Alerts: ${this.telegramEnabled ? 'Enabled' : 'Disabled'}`);
    console.log('='.repeat(70));
    console.log();

    // Send startup notification
    if (this.telegramEnabled) {
      const startupMessage = `🚀 *Ethereum Monitor Started*\n\n` +
        `Mode: Real-time WebSocket\n` +
        `Execution: Reth (WS)\n` +
        `Consensus: Lighthouse\n` +
        `Metrics: Every ${METRICS_POLL_INTERVAL_SEC}s\n` +
        `Status: Connecting...`;
      
      await this.sendTelegramAlert(startupMessage, 'info');
    }

    // Setup WebSocket connection
    await this.setupWebSocketConnection();

    // Periodic consensus health check (every 60 seconds)
    setInterval(async () => {
      await this.checkConsensusHealth();
    }, 60000);

    // Heartbeat check - alert if no blocks received
    setInterval(async () => {
      const timeSinceLastBlock = Date.now() - this.lastBlockTime;
      
      if (timeSinceLastBlock > 60000) { // No blocks for 60 seconds
        const message = `*No Blocks Received*\n\n` +
          `Last block was \`${(timeSinceLastBlock / 1000).toFixed(0)}s\` ago\n` +
          `Block: \`${this.lastBlockNumber}\``;
        
        if (await this.shouldSendAlert('no_blocks', 15)) {
          await this.sendTelegramAlert(message, 'critical');
        }
      }
    }, 30000);
  }
}

// Start monitor
const monitor = new EthMonitor();
monitor.startMonitoring().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
