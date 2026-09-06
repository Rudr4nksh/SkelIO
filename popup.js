/**
 * SkelIO Popup Script
 * Fetches and displays real-time stats from background service worker
 */

// Load stats from background
async function loadStats() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_STATS' });

    if (response.success && response.stats) {
      const stats = response.stats;

      // Update DOM elements
      document.getElementById('layoutShifts').textContent = stats.layoutShiftsPrevented || 0;
      document.getElementById('blocked').textContent = stats.totalBlockedResources || 0;

      // Format bandwidth (bytes to KB/MB)
      const bandwidth = stats.totalBandwidthSaved || 0;
      const bandwidthFormatted = bandwidth >= 1000000
        ? (bandwidth / 1000000).toFixed(1) + ' MB'
        : (bandwidth / 1000).toFixed(0) + ' KB';
      document.getElementById('bandwidth').textContent = bandwidthFormatted;
    }
  } catch (err) {
    console.error('[SkelIO Popup] Failed to load stats:', err);
  }
}

// Load stats when popup opens
loadStats();

// Refresh stats every 2 seconds while popup is open
setInterval(loadStats, 2000);
