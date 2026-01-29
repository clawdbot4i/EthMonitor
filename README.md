# EthMonitor

Monitor Ethereum RPC endpoints for sync status and chain consistency with the canonical mainnet.

## Features

- ✅ **Chain ID Verification** - Ensures endpoint is on Ethereum Mainnet (chain ID 1)
- ✅ **Sync Status Check** - Compares block height with multiple reference nodes
- ✅ **Block Consistency** - Verifies block hashes match canonical chain
- ✅ **Timestamp Monitoring** - Alerts if latest block is too old
- ✅ **Telegram Alerts** - Get notified immediately when issues are detected
- ✅ **Smart Alert Cooldown** - Prevents notification spam with configurable cooldowns

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file (copy from `.env.example`):

```bash
cp .env.example .env
```

Edit `.env` and configure:

```bash
# Your Ethereum RPC endpoint
MONITORED_RPC=https://your-rpc-endpoint.com

# Telegram alerts (optional)
ENABLE_TELEGRAM=true
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_CHAT_ID=your_chat_id_here

# Check interval (minutes)
CHECK_INTERVAL_MINUTES=60
```

### Telegram Setup (Optional)

To receive alerts via Telegram:

1. **Get your chat ID:**
   - Message your bot on Telegram (send `/start`)
   - Run: `node get-chat-id.js` (if available) or visit:
   - `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
   - Look for `"chat":{"id":123456789}` in the response

2. **Update `.env`:**
   - Set `TELEGRAM_BOT_TOKEN` to your bot token
   - Set `TELEGRAM_CHAT_ID` to your chat ID
   - Set `ENABLE_TELEGRAM=true`

3. **Alert Types:**
   - 🚨 **Critical**: Wrong chain ID, sync failures, block hash mismatch
   - ⚠️ **Warning**: Out of sync, stale blocks, unusual behavior
   - ℹ️ **Info**: Recoverable issues

4. **Alert Cooldown:**
   - Most alerts: 60 minutes
   - Block hash mismatch: 30 minutes (more urgent)
   - Cooldown resets when issue is resolved

## Usage

### One-time check
```bash
npm start
```

### Continuous monitoring
```bash
npm run monitor
```

Runs checks at the configured interval (default: 60 minutes)

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
