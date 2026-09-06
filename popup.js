/**
 * SkelIO Popup Controller
 * Elegant Offwhite-Grey Theme with Real Speed-based Auto-Toggle
 */

let currentTabId = null;
let skelioActive = false;
let fontsBlocked = false;
let simplified3D = false;
let currentSpeedThreshold = 50; // Default 50 Mbps
let detectedSpeed = null;

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function formatSpeed(mbps) {
  if (mbps === null || mbps === undefined) return 'Measuring...';
  if (mbps === 0) return 'Offline';
  return (Number.isInteger(mbps) ? mbps : mbps.toFixed(1)) + ' Mbps';
}

function updateSpeedPill() {
  const currentSpeedText = document.getElementById('currentSpeedText');
  if (currentSpeedText) {
    currentSpeedText.textContent = formatSpeed(detectedSpeed);
  }
}

function updateSpeedSubtitle() {
  const speedSubtitle = document.getElementById('speedSubtitle');
  const speedDisplayVal = document.getElementById('speedDisplayVal');
  const sliderMidVal = document.getElementById('sliderMidVal');

  if (currentSpeedThreshold === 'always') {
    if (speedSubtitle) speedSubtitle.innerHTML = 'Always active on <strong>all network speeds</strong>';
    if (sliderMidVal) sliderMidVal.textContent = 'Always';
  } else {
    if (speedSubtitle) speedSubtitle.innerHTML = 'Engage when &le; <strong>' + currentSpeedThreshold + ' Mbps</strong>';
    if (speedDisplayVal) speedDisplayVal.textContent = currentSpeedThreshold + ' Mbps';
    if (sliderMidVal) sliderMidVal.textContent = currentSpeedThreshold + ' Mbps';
  }
}

function updateControlsUI() {
  // Update Chips
  document.querySelectorAll('.speed-chip').forEach(chip => {
    const chipSpeed = chip.dataset.speed;
    if (String(chipSpeed) === String(currentSpeedThreshold)) {
      chip.classList.add('active');
    } else {
      chip.classList.remove('active');
    }
  });

  // Update Slider
  const slider = document.getElementById('speedRangeSlider');
  if (slider && currentSpeedThreshold !== 'always') {
    slider.value = currentSpeedThreshold;
  }
}

async function updateCurrentSite() {
  try {
    const tab = await getCurrentTab();
    if (!tab) return;
    currentTabId = tab.id;

    if (tab.url) {
      const url = new URL(tab.url);
      const domain = url.hostname.replace(/^www\./, '');
      document.getElementById('siteDomain').textContent = domain || 'Web Page';

      const faviconEl = document.getElementById('siteFavicon');
      if (tab.favIconUrl) {
        faviconEl.src = tab.favIconUrl;
      } else {
        faviconEl.src = 'icons/icon32.png';
      }
    }
  } catch (e) {
    document.getElementById('siteDomain').textContent = 'Web Page';
  }
}

async function applySpeedThreshold(newThreshold) {
  currentSpeedThreshold = newThreshold;
  await chrome.storage.local.set({ maxSpeedThreshold: newThreshold });

  updateControlsUI();
  updateSpeedSubtitle();

  const storageData = await chrome.storage.local.get(['skelioEnabled']);
  const globalEnabled = storageData.skelioEnabled !== false;

  // Compute shouldBeActive
  let shouldBeActive = false;
  if (globalEnabled) {
    if (newThreshold === 'always') {
      shouldBeActive = true;
    } else if (!detectedSpeed || detectedSpeed <= newThreshold) {
      shouldBeActive = true;
    } else {
      shouldBeActive = false;
    }
  }

  // Update active tab immediately
  const tab = await getCurrentTab();
  if (tab && tab.id) {
    try {
      if (shouldBeActive) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'SKELIO_ACTIVATE'
        });
        skelioActive = true;
        fontsBlocked = true;
        simplified3D = true;
      } else {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'SKELIO_DEACTIVATE'
        });
        skelioActive = false;
        fontsBlocked = false;
        simplified3D = false;
      }

      await chrome.tabs.sendMessage(tab.id, {
        action: 'SKELIO_SET_SPEED_THRESHOLD',
        threshold: newThreshold,
        currentSpeed: detectedSpeed
      });
    } catch (err) {}
  } else {
    skelioActive = shouldBeActive;
  }

  updateUI();
}

async function runSpeedBenchmark() {
  const btn = document.getElementById('testSpeedBtn');
  const textEl = document.getElementById('currentSpeedText');
  if (btn) btn.classList.add('testing');
  if (textEl) textEl.textContent = 'Testing...';

  try {
    const response = await chrome.runtime.sendMessage({ action: 'TEST_SPEED' });
    if (response && response.success && typeof response.speed === 'number') {
      detectedSpeed = response.speed;
      await chrome.storage.local.set({ lastKnownSpeed: response.speed });
      updateSpeedPill();
      await applySpeedThreshold(currentSpeedThreshold);
    }
  } catch (e) {
    console.warn('[SkelIO Popup] Benchmark error:', e);
  } finally {
    if (btn) btn.classList.remove('testing');
    updateSpeedPill();
  }
}

async function checkStatus() {
  await updateCurrentSite();

  const storageData = await chrome.storage.local.get(['skelioEnabled', 'maxSpeedThreshold', 'lastKnownSpeed']);
  const globalEnabled = storageData.skelioEnabled !== false;
  if (storageData.maxSpeedThreshold !== undefined) {
    currentSpeedThreshold = storageData.maxSpeedThreshold;
  }
  if (typeof storageData.lastKnownSpeed === 'number') {
    detectedSpeed = storageData.lastKnownSpeed;
  }

  updateControlsUI();
  updateSpeedSubtitle();
  updateSpeedPill();

  try {
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      const response = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_STATUS' });
      if (response) {
        skelioActive = !!response.active;
        fontsBlocked = !!response.fontsBlocked;
        simplified3D = !!response.simplified3D;
        if (typeof response.currentSpeed === 'number') {
          detectedSpeed = response.currentSpeed;
          updateSpeedPill();
        }
        if (response.threshold !== undefined) {
          currentSpeedThreshold = response.threshold;
          updateControlsUI();
          updateSpeedSubtitle();
        }
        if (response.pageBlocked !== undefined) {
          updateStatsDisplay(response.pageShifts, response.pageBlocked, response.pageBandwidth);
        }
      } else {
        skelioActive = globalEnabled;
        fontsBlocked = globalEnabled;
        simplified3D = globalEnabled;
      }
    }
  } catch (err) {
    if (!globalEnabled) {
      skelioActive = false;
    } else if (currentSpeedThreshold === 'always' || !detectedSpeed || detectedSpeed <= currentSpeedThreshold) {
      skelioActive = true;
    } else {
      skelioActive = false;
    }
    fontsBlocked = skelioActive;
    simplified3D = skelioActive;
  }

  updateUI();

  // If no speed has ever been measured, run real benchmark in background
  if (!detectedSpeed) {
    runSpeedBenchmark();
  }
}

async function toggleSkelIO() {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) return;
  currentTabId = tab.id;

  const targetState = !skelioActive;
  await chrome.storage.local.set({ skelioEnabled: targetState });

  if (!targetState) {
    try {
      await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_DEACTIVATE' });
    } catch (err) {}
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
      } catch (e) {}
      skelioActive = true;
      fontsBlocked = true;
      simplified3D = true;
    }
  }
  updateUI();
}

async function toggleFonts() {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) return;

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
  if (!tab || !tab.id) return;

  try {
    const res = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_TOGGLE_3D' });
    simplified3D = res && res.simplified;
    updateUI();
  } catch (e) {
    console.error('[SkelIO Popup] Failed to toggle 3D:', e);
  }
}

async function hydrateAll() {
  const tab = await getCurrentTab();
  if (!tab || !tab.id) return;

  const btn = document.getElementById('hydrateAllBtn');
  const originalHtml = btn.innerHTML;

  try {
    btn.textContent = 'Unlocking...';
    await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_HYDRATE_ALL' });
    btn.textContent = 'All Loaded ✓';
    setTimeout(() => {
      btn.innerHTML = originalHtml;
    }, 1500);
  } catch (e) {
    btn.innerHTML = originalHtml;
  }
}

async function reloadTab() {
  const tab = await getCurrentTab();
  if (tab && tab.id) {
    chrome.tabs.reload(tab.id, { bypassCache: true });
    window.close();
  }
}

function updateUI() {
  const statusBadge = document.getElementById('statusBadge');
  const statusBadgeText = document.getElementById('statusBadgeText');
  const toggleBtn = document.getElementById('toggleBtn');
  const toggleBtnText = document.getElementById('toggleBtnText');
  const siteProtectionText = document.getElementById('siteProtectionText');
  const fontBtn = document.getElementById('fontBtn');
  const fontBtnText = document.getElementById('fontBtnText');
  const threeDBtn = document.getElementById('threeDBtn');
  const threeDBtnText = document.getElementById('threeDBtnText');

  if (skelioActive) {
    statusBadge.className = 'status-badge';
    statusBadgeText.textContent = 'ACTIVE';

    toggleBtn.className = 'master-btn';
    toggleBtnText.textContent = 'SkelIO Active ✓';
    siteProtectionText.textContent = 'CLS Shield & Skeleton Lock';

    fontBtn.className = fontsBlocked ? 'feature-btn active' : 'feature-btn';
    fontBtnText.textContent = fontsBlocked ? 'Light (300)' : 'Web Fonts';

    threeDBtn.className = simplified3D ? 'feature-btn purple-active' : 'feature-btn';
    threeDBtnText.textContent = simplified3D ? 'Frozen Still' : 'Moving 3D';

  } else {
    const isStandby = detectedSpeed && currentSpeedThreshold !== 'always' && detectedSpeed > currentSpeedThreshold;

    statusBadge.className = 'status-badge off';
    statusBadgeText.textContent = isStandby ? 'STANDBY' : 'PAUSED';

    toggleBtn.className = 'master-btn off';
    toggleBtnText.textContent = 'Enable SkelIO';
    siteProtectionText.textContent = isStandby
      ? `Standby (${detectedSpeed} Mbps > ${currentSpeedThreshold}M)`
      : 'Protection Standby';

    fontBtn.className = 'feature-btn';
    fontBtnText.textContent = 'Web Fonts';

    threeDBtn.className = 'feature-btn';
    threeDBtnText.textContent = 'Moving 3D';
  }
}

function formatBandwidthSaved(bytes) {
  if (!bytes || bytes <= 0) return '0 KB';
  if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(1) + ' MB';
  }
  return Math.max(1, Math.round(bytes / 1024)) + ' KB';
}

function updateStatsDisplay(shifts, blocked, bandwidth) {
  const shiftsEl = document.getElementById('layoutShifts');
  const blockedEl = document.getElementById('blocked');
  const bandwidthEl = document.getElementById('bandwidth');

  if (shiftsEl) shiftsEl.textContent = shifts || 0;
  if (blockedEl) blockedEl.textContent = blocked || 0;
  if (bandwidthEl) bandwidthEl.textContent = formatBandwidthSaved(bandwidth);
}

async function loadStats() {
  try {
    // 1. Try to get real-time live page stats from active tab
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_STATUS' });
        if (response && response.pageBlocked !== undefined && response.active) {
          updateStatsDisplay(response.pageShifts, response.pageBlocked, response.pageBandwidth);
          return;
        }
      } catch (e) {}
    }

    // 2. Query storage directly
    const storage = await chrome.storage.local.get([
      'pageBlocked',
      'pageShifts',
      'pageBandwidth',
      'totalBlockedResources',
      'layoutShiftsPrevented',
      'totalBandwidthSaved'
    ]);

    const blocked = (skelioActive && storage.pageBlocked) ? storage.pageBlocked : (storage.totalBlockedResources || 0);
    const shifts = (skelioActive && storage.pageShifts) ? storage.pageShifts : (storage.layoutShiftsPrevented || 0);
    const bandwidth = (skelioActive && storage.pageBandwidth) ? storage.pageBandwidth : (storage.totalBandwidthSaved || 0);

    updateStatsDisplay(shifts, blocked, bandwidth);
  } catch (err) {}
}

// ─── Attach Event Listeners ───
document.getElementById('toggleBtn').addEventListener('click', toggleSkelIO);
document.getElementById('fontBtn').addEventListener('click', toggleFonts);
document.getElementById('threeDBtn').addEventListener('click', toggle3D);
document.getElementById('hydrateAllBtn').addEventListener('click', hydrateAll);
document.getElementById('reloadTabBtn').addEventListener('click', reloadTab);
document.getElementById('shortcutHintBtn').addEventListener('click', reloadTab);
document.getElementById('testSpeedBtn').addEventListener('click', runSpeedBenchmark);

// ─── Interactive Slider Listener ───
const slider = document.getElementById('speedRangeSlider');
if (slider) {
  slider.addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    const speedSubtitle = document.getElementById('speedSubtitle');
    const sliderMidVal = document.getElementById('sliderMidVal');
    if (speedSubtitle) speedSubtitle.innerHTML = 'Engage when &le; <strong>' + val + ' Mbps</strong>';
    if (sliderMidVal) sliderMidVal.textContent = val + ' Mbps';
  });

  slider.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value);
    applySpeedThreshold(val);
  });
}

// ─── Speed Presets Listener ───
document.getElementById('speedPresets').addEventListener('click', async (e) => {
  const chip = e.target.closest('.speed-chip');
  if (!chip) return;

  const speedAttr = chip.dataset.speed;
  const newThreshold = speedAttr === 'always' ? 'always' : parseFloat(speedAttr);
  await applySpeedThreshold(newThreshold);
});

// Init
checkStatus();
loadStats();
setInterval(loadStats, 2000);
