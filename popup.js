/**
 * SkelIO Popup Script
 * Toggle button + font restore + real-time stats
 */

let currentTabId = null;
let skelioActive = false;
let fontsBlocked = false;
let simplified3D = false;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function checkStatus() {
  const data = await chrome.storage.local.get(['skelioEnabled']);
  const globalEnabled = data.skelioEnabled !== false;

  try {
    const tab = await getCurrentTab();
    currentTabId = tab.id;
    const response = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_STATUS' });
    if (response) {
      skelioActive = !!response.active;
      fontsBlocked = !!response.fontsBlocked;
      simplified3D = !!response.simplified3D;
    } else {
      skelioActive = globalEnabled;
      fontsBlocked = globalEnabled;
      simplified3D = globalEnabled;
    }
  } catch (err) {
    skelioActive = globalEnabled;
    fontsBlocked = globalEnabled;
    simplified3D = globalEnabled;
  }
  updateUI();
}

async function toggleSkelIO() {
  const tab = await getCurrentTab();
  currentTabId = tab.id;

  const targetState = !skelioActive;
  await chrome.storage.local.set({ skelioEnabled: targetState });

  if (!targetState) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_DEACTIVATE' });
    } catch (err) {
      console.error('[SkelIO Popup] Failed to deactivate:', err);
    }
    skelioActive = false;
    fontsBlocked = false;
    simplified3D = false;
  } else {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_ACTIVATE' });
      skelioActive = true;
      fontsBlocked = true;
      simplified3D = true;
    } catch (err) {
      // Content script not loaded — inject it first
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['freeze.js'],
          world: 'MAIN'
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        });
        setTimeout(async () => {
          try {
            await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_ACTIVATE' });
            skelioActive = true;
            fontsBlocked = true;
            simplified3D = true;
            updateUI();
          } catch (e) {}
        }, 200);
      } catch (e) {
        console.error('[SkelIO Popup] Failed to inject:', e);
      }
      skelioActive = true;
      fontsBlocked = true;
      simplified3D = true;
    }
  }
  updateUI();
}

async function toggleFonts() {
  const tab = await getCurrentTab();
  try {
    if (fontsBlocked) {
      await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_RESTORE_FONTS' });
      fontsBlocked = false;
    } else {
      await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_BLOCK_FONTS' });
      fontsBlocked = true;
    }
    updateUI();
  } catch (e) {
    console.error('[SkelIO Popup] Failed to toggle fonts:', e);
  }
}

async function toggle3D() {
  const tab = await getCurrentTab();
  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_TOGGLE_3D' });
    simplified3D = res && res.simplified;
    updateUI();
  } catch (e) {
    console.error('[SkelIO Popup] Failed to toggle 3D:', e);
  }
}

function updateUI() {
  const toggleBtn = document.getElementById('toggleBtn');
  const fontBtn = document.getElementById('fontBtn');
  const threeDBtn = document.getElementById('threeDBtn');

  if (skelioActive) {
    toggleBtn.textContent = 'Active ✓';
    toggleBtn.className = 'toggle-btn on';

    fontBtn.disabled = false;
    fontBtn.textContent = fontsBlocked ? 'Load Web Fonts' : 'Use Light Font';
    fontBtn.style.background = fontsBlocked ? '#2196F3' : '#FF9800';

    threeDBtn.disabled = false;
    threeDBtn.textContent = simplified3D ? 'Animations & 3D: Frozen (ON)' : 'Animations & 3D: Active (OFF)';
    threeDBtn.style.background = simplified3D ? '#9C27B0' : '#555';
  } else {
    toggleBtn.textContent = 'Enable on this page';
    toggleBtn.className = 'toggle-btn off';

    fontBtn.disabled = true;
    fontBtn.textContent = 'Load Fonts';
    fontBtn.style.background = '#2196F3';

    threeDBtn.disabled = true;
    threeDBtn.textContent = 'Freeze Animations & 3D';
    threeDBtn.style.background = '#9C27B0';
  }
}

async function loadStats() {
  try {
    const response = await chrome.runtime.sendMessage({ action: 'GET_STATS' });

    if (response && response.success && response.stats) {
      const stats = response.stats;

      document.getElementById('layoutShifts').textContent = stats.layoutShiftsPrevented || 0;
      document.getElementById('blocked').textContent = stats.totalBlockedResources || 0;

      const bandwidth = stats.totalBandwidthSaved || 0;
      const bandwidthFormatted = bandwidth >= 1000000
        ? (bandwidth / 1000000).toFixed(1) + ' MB'
        : (bandwidth / 1000).toFixed(0) + ' KB';
      document.getElementById('bandwidth').textContent = bandwidthFormatted;
    }
  } catch (err) {}
}

// Init
document.getElementById('toggleBtn').addEventListener('click', toggleSkelIO);
document.getElementById('fontBtn').addEventListener('click', toggleFonts);
document.getElementById('threeDBtn').addEventListener('click', toggle3D);
checkStatus();
loadStats();
setInterval(loadStats, 2000);
