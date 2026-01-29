# EthMonitor

Monitor Ethereum RPC endpoints for sync status and chain consistency with the canonical mainnet.

## Features

- ✅ **Chain ID Verification** - Ensures endpoint is on Ethereum Mainnet (chain ID 1)
- ✅ **Sync Status Check** - Compares block height with multiple reference nodes
- ✅ **Block Consistency** - Verifies block hashes match canonical chain
- ✅ **Timestamp Monitoring** - Alerts if latest block is too old

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` and set your monitored RPC endpoint:

```
MONITORED_RPC=https://your-rpc-endpoint.com
```

## Usage

Run a single health check:

```bash
npm start
```

Run continuous monitoring (every 60 seconds):

```bash
npm run watch
```

## How It Works

The monitor performs four key checks:

### 1. Chain ID Verification
Confirms the RPC endpoint is connected to Ethereum Mainnet (chain ID 1).

### 2. Sync Status
Compares the monitored node's latest block with multiple reference RPCs:
- ethereum.publicnode.com
- eth.llamarpc.com  
- rpc.ankr.com

**Warning** if the node is more than 10 blocks behind.

### 3. Block Consistency
Fetches a recent finalized block (5 blocks back) and compares its hash with reference nodes to ensure the monitored endpoint is on the canonical chain (not a fork).

### 4. Block Timestamp
Checks if the latest block is recent (within 30 seconds). Older timestamps may indicate sync issues.

## Exit Codes

- `0` - All checks passed (or warnings only)
- `1` - Critical errors detected

## Example Output

```
============================================================
ETH MONITOR - Health Check
Timestamp: 2026-01-29T11:30:00.000Z
Monitored RPC: https://eth-mainnet.g.alchemy.com/v2/...
============================================================

✓ Chain ID: Chain ID: 1

✓ Sync Status: In sync: block 21234567 (2 blocks behind)

✓ Block Consistency: Block consistency verified (block 21234562)

✓ Block Timestamp: Latest block timestamp is 15s old

============================================================
STATUS: HEALTHY - All checks passed
============================================================
```

## Continuous Monitoring

For production monitoring, consider:

1. **Cron job** - Schedule regular checks:
   ```bash
   */5 * * * * cd /path/to/EthMonitor && npm start >> monitor.log 2>&1
   ```

2. **systemd service** - Run as a daemon

3. **Container** - Deploy with Docker

4. **Alerting** - Integrate with monitoring systems (parse exit codes and output)

## License

ISC
