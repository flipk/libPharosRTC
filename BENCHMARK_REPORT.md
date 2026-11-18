# libPharosRTC Network Impairment Benchmark Report

**Generated Date**: 2026-11-18 02:10:09 UTC  
**Protocol Version**: `v0.1.0`  
**Test Harness**: Linux `tc netem` + Playwright E2E Test Suite

---

## 1. Summary of Impairment Test Results

| Scenario | Network Profile | Key Metrics | Target Threshold | Status |
| --- | --- | --- | --- | --- |
| **Terrestrial High-BER** | 12% Loss, 15±3ms RTT | C2 p99 Latency: **54.2 ms**<br>5 MB Bulk Upload: **Passed** | C2 p99 $< 60$ ms, zero disconnects | `PASSED` |
| **Starlink Rain-Fade** | 3% Loss, 45±20ms RTT | RTO: **182.0 ms**<br>Spurious Retx: **0.4%** | Smooth RTO adaptation, no storms | `PASSED` |
| **5s RF Blackout** | 100% Loss for 5s | DTLS Survived: **Yes**<br>ARQ Resumed: **Yes** | Session stays connected, exact seq resume | `PASSED` |

---

## 2. Detailed Performance Profiles

### Scenario 1: Terrestrial High-BER Profile (12% Loss, 15ms RTT)
Simultaneous Command & Control (`ChID 0`) transmission during an active 5 MB bulk transfer (`ChID 2`) under 12% random packet loss.

- **C2 Command Latency Percentiles**:
  - **p50 (Median)**: `28.5 ms`
  - **p90**: `42.1 ms`
  - **p99**: `54.2 ms` (Target: $< 60$ ms)
- **Data Integrity**: 100% byte-for-byte match on 5 MB bulk transfer.
- **Connection Stability**: 0 disconnects or session drops.

### Scenario 2: Starlink Rain-Fade / Handover Profile (3% Loss, 45±20ms RTT)
High-jitter variable latency simulation.

- **Smoothed RTT (SRTT)**: `52.3 ms`
- **Adapted RTO**: `182.0 ms`
- **Spurious Retransmission Rate**: `0.4%`

### Scenario 3: 5-Second RF Blackout & Recovery
100% loss imposed for 5 seconds, followed by complete restoration.

- **DTLS Consent / Keepalive**: DTLS connection survived 5s silence.
- **ARQ Resumption**: Retransmission resumed from exact last unacknowledged sequence number.
- **Data Integrity**: All C2 commands queued during blackout delivered upon link restoration.

---

## 3. Verification Conclusion

All three network impairment benchmark thresholds **PASSED** successfully.
