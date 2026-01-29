# Alert Severity Levels - Ethereum Monitor

## 🚨 CRITICAL (Immediate - <1s delay, 10 min cooldown)
System failures requiring immediate attention

- **Node Unreachable** - Cannot connect to RPC endpoint
- **WebSocket Disconnected** - Lost real-time connection
- **Consensus Client Down** - Lighthouse not responding
- **No Blocks Received** - No new blocks for 60+ seconds
- **Block Production Stalled** - >30 seconds between blocks
- **Out of Sync** - Node >10 blocks behind canonical chain
- **Consensus Not Synced** - Consensus client not in sync

**Alert Window:** Immediate notification, 10 minute cooldown

---

## ⚠️ HIGH (Fast - <30s delay, 30 min cooldown)
Performance degradation affecting node operation

- **Low Peer Count** - <10 connected peers
- **High Memory Usage** - >16GB RAM consumption
- **Metrics Unavailable** - Cannot fetch Prometheus metrics

**Alert Window:** Within 30 seconds, 30 minute cooldown

---

## 📋 MEDIUM (Moderate - ~2 min delay, 2 hour cooldown)
Issues that don't require immediate action

- **Moderate Sync Lag** - 5-10 blocks behind (warning only)
- **RPC Error Rate** - Elevated but not critical

**Alert Window:** Within 2 minutes, 2 hour cooldown

---

## 📌 LOW (Slow - 6 hour cooldown)
Informational alerts for maintenance planning

- **Reth Version Update Available** - Minor/patch versions
- **Lighthouse Version Update Available** - Minor/patch versions

**Alert Window:** Check every 6 hours, 6 hour cooldown

---

## 🔴 CRITICAL_URGENT (Immediate - <1s delay, 30 min cooldown)
Security or data integrity issues

- **Wrong Chain ID** - Connected to wrong network
- **Fork Detected** - Block hash mismatch with canonical chain
- **Major Version Behind** - Critical security update available

**Alert Window:** Immediate notification, 30 minute cooldown

---

## ℹ️ INFO (Once per session)
Status messages, not repeated

- **Monitor Started** - Initial startup notification
- **Reconnection Successful** - After temporary failures

**Alert Window:** Once per event, no cooldown
