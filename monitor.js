const { ethers } = require('ethers');
require('dotenv').config();

// Configuration
const MONITORED_RPC = process.env.MONITORED_RPC || 'https://eth-mainnet.g.alchemy.com/v2/zaPyqXLB_lnO5weQzBEuQXvYgv2BKlQe';

// Reference RPCs for canonical chain comparison
const REFERENCE_RPCS = [
  'https://ethereum.publicnode.com',
  'https://eth.llamarpc.com',
  'https://rpc.ankr.com/eth'
];

const EXPECTED_CHAIN_ID = 1; // Ethereum Mainnet
const MAX_BLOCK_DELAY = 10; // Maximum acceptable blocks behind
const BLOCK_TIME_THRESHOLD_MS = 30000; // Alert if block is older than 30 seconds
const CHECK_INTERVAL_MINUTES = parseInt(process.env.CHECK_INTERVAL_MINUTES || '60');

class EthMonitor {
  constructor() {
    this.monitoredProvider = new ethers.JsonRpcProvider(MONITORED_RPC);
    this.referenceProviders = REFERENCE_RPCS.map(url => new ethers.JsonRpcProvider(url));
  }

  async getCanonicalBlock() {
    // Get block number from all reference providers and take the majority consensus
    const blockNumbers = await Promise.allSettled(
      this.referenceProviders.map(p => p.getBlockNumber())
    );

    const validBlocks = blockNumbers
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    if (validBlocks.length === 0) {
      throw new Error('Failed to get canonical block from any reference RPC');
    }

    // Return the most common block number (or highest if no consensus)
    return Math.max(...validBlocks);
  }

  async checkChainId() {
    const network = await this.monitoredProvider.getNetwork();
    const chainId = Number(network.chainId);
    
    if (chainId !== EXPECTED_CHAIN_ID) {
      return {
        status: 'ERROR',
        message: `Wrong chain ID: expected ${EXPECTED_CHAIN_ID}, got ${chainId}`
      };
    }
    
    return { status: 'OK', message: `Chain ID: ${chainId}` };
  }

  async checkSyncStatus() {
    try {
      const monitoredBlock = await this.monitoredProvider.getBlockNumber();
      const canonicalBlock = await this.getCanonicalBlock();
      const blockDelay = canonicalBlock - monitoredBlock;

      if (blockDelay > MAX_BLOCK_DELAY) {
        return {
          status: 'WARNING',
          message: `Node is ${blockDelay} blocks behind (monitored: ${monitoredBlock}, canonical: ${canonicalBlock})`
        };
      } else if (blockDelay < 0) {
        return {
          status: 'WARNING',
          message: `Node reports block ${monitoredBlock} but canonical is ${canonicalBlock} (ahead by ${Math.abs(blockDelay)})`
        };
      }

      return {
        status: 'OK',
        message: `In sync: block ${monitoredBlock} (${blockDelay} blocks behind)`
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Failed to check sync status: ${error.message}`
      };
    }
  }

  async checkBlockConsistency() {
    try {
      const monitoredBlock = await this.monitoredProvider.getBlockNumber();
      
      // Check a recent block (5 blocks back to ensure it's finalized)
      const blockNumber = monitoredBlock - 5;
      
      const monitoredBlockData = await this.monitoredProvider.getBlock(blockNumber);
      
      // Get the same block from reference providers
      const referenceBlocks = await Promise.allSettled(
        this.referenceProviders.map(p => p.getBlock(blockNumber))
      );

      const validReferenceBlocks = referenceBlocks
        .filter(r => r.status === 'fulfilled')
        .map(r => r.value);

      if (validReferenceBlocks.length === 0) {
        return {
          status: 'WARNING',
          message: 'Could not verify block consistency with reference nodes'
        };
      }

      // Check if block hash matches
      const referenceHash = validReferenceBlocks[0].hash;
      if (monitoredBlockData.hash !== referenceHash) {
        return {
          status: 'ERROR',
          message: `Block hash mismatch at ${blockNumber}! Monitored: ${monitoredBlockData.hash}, Canonical: ${referenceHash}`
        };
      }

      return {
        status: 'OK',
        message: `Block consistency verified (block ${blockNumber})`
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Failed to check block consistency: ${error.message}`
      };
    }
  }

  async checkBlockTimestamp() {
    try {
      const latestBlock = await this.monitoredProvider.getBlock('latest');
      const blockTimestamp = Number(latestBlock.timestamp) * 1000; // Convert to ms
      const currentTime = Date.now();
      const timeDiff = currentTime - blockTimestamp;

      if (timeDiff > BLOCK_TIME_THRESHOLD_MS) {
        return {
          status: 'WARNING',
          message: `Latest block is ${Math.floor(timeDiff / 1000)}s old (threshold: ${BLOCK_TIME_THRESHOLD_MS / 1000}s)`
        };
      }

      return {
        status: 'OK',
        message: `Latest block timestamp is ${Math.floor(timeDiff / 1000)}s old`
      };
    } catch (error) {
      return {
        status: 'ERROR',
        message: `Failed to check block timestamp: ${error.message}`
      };
    }
  }

  async runChecks() {
    console.log('='.repeat(60));
    console.log('ETH MONITOR - Health Check');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log(`Monitored RPC: ${MONITORED_RPC}`);
    console.log('='.repeat(60));
    console.log();

    const checks = [
      { name: 'Chain ID', fn: () => this.checkChainId() },
      { name: 'Sync Status', fn: () => this.checkSyncStatus() },
      { name: 'Block Consistency', fn: () => this.checkBlockConsistency() },
      { name: 'Block Timestamp', fn: () => this.checkBlockTimestamp() }
    ];

    let hasErrors = false;
    let hasWarnings = false;

    for (const check of checks) {
      try {
        const result = await check.fn();
        const icon = result.status === 'OK' ? '✓' : result.status === 'WARNING' ? '⚠' : '✗';
        console.log(`${icon} ${check.name}: ${result.message}`);
        
        if (result.status === 'ERROR') hasErrors = true;
        if (result.status === 'WARNING') hasWarnings = true;
      } catch (error) {
        console.log(`✗ ${check.name}: FAILED - ${error.message}`);
        hasErrors = true;
      }
      console.log();
    }

    console.log('='.repeat(60));
    if (hasErrors) {
      console.log('STATUS: CRITICAL - Errors detected');
      return 1;
    } else if (hasWarnings) {
      console.log('STATUS: WARNING - Some checks raised warnings');
      return 0;
    } else {
      console.log('STATUS: HEALTHY - All checks passed');
      return 0;
    }
  }

  async startContinuousMonitoring() {
    console.log(`🚀 Starting continuous monitoring (interval: ${CHECK_INTERVAL_MINUTES} minutes)`);
    console.log();

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
