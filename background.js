/**
 * SkelIO Background Service Worker
 * Handles dynamic network interception via declarativeNetRequest session rules
 */

// Rule ID ranges (avoid collisions across tabs)
const RULE_ID_BASE_BLOCK = 1000;
const RULE_ID_BASE_ALLOW = 2000;
const RULE_ID_INCREMENT = 10000;

// Track active tabs and their rule IDs
const activeTabs = new Map(); // tabId -> { blockRuleId, allowRuleIds: Set, allowRuleCounter: number }

/**
 * Real-time network speed measurement
 * Fetches a micro-payload from CDN and calculates real throughput in Mbps
 */
async function measureRealSpeedMbps() {
  const testUrl = `https://speed.cloudflare.com/__down?bytes=150000&_=${Date.now()}`;
  try {
    const start = performance.now();
    const response = await fetch(testUrl, { cache: 'no-store' });
    const blob = await response.blob();
    const durationSec = (performance.now() - start) / 1000;
    if (durationSec > 0.01 && blob.size > 0) {
      const speedMbps = (blob.size * 8) / (durationSec * 1000000);
      const rounded = Math.max(0.1, Math.round(speedMbps * 10) / 10);
      await chrome.storage.local.set({ lastKnownSpeed: rounded });
      console.log('[SkelIO] Real speed measured:', rounded, 'Mbps');
      return rounded;
    }
  } catch (e) {
    console.warn('[SkelIO] Speed test error, trying fallback:', e);
    try {
      const fallbackUrl = `https://upload.wikimedia.org/wikipedia/commons/c/ca/1x1.png?_=${Date.now()}`;
      const start = performance.now();
      await fetch(fallbackUrl, { cache: 'no-store' });
      const durationSec = (performance.now() - start) / 1000;
      const estimated = durationSec > 0.5 ? 5.0 : (durationSec > 0.2 ? 15.0 : 40.0);
      await chrome.storage.local.set({ lastKnownSpeed: estimated });
      return estimated;
    } catch (err) {}
  }
  const fallback = 25.0;
  await chrome.storage.local.set({ lastKnownSpeed: fallback });
  return fallback;
}

/**
 * Initialize stats storage on install
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    totalBlockedResources: 0,
    totalBandwidthSaved: 0,
    sessionsActivated: 0,
    layoutShiftsPrevented: 0,
    skelioEnabled: true,
    maxSpeedThreshold: 50
  });
  measureRealSpeedMbps().catch(() => {});
  console.log('[SkelIO] Extension installed, stats, enabled, and speed threshold initialized');
});

chrome.runtime.onStartup.addListener(() => {
  measureRealSpeedMbps().catch(() => {});
});

/**
 * Generate unique rule IDs for a tab
 */
function generateBlockRuleId(tabId) {
  return RULE_ID_BASE_BLOCK + (tabId * RULE_ID_INCREMENT);
}

function generateAllowRuleId(tabId, counter) {
  return RULE_ID_BASE_ALLOW + (tabId * RULE_ID_INCREMENT) + counter;
}

/**
 * ACTIVATE_SKELIO: Block images, media, and fonts for a specific tab
 */
async function activateSkelIO(tabId) {
  if (activeTabs.has(tabId)) {
    console.log(`[SkelIO] Refreshing active state on tab ${tabId}`);
    await deactivateSkelIO(tabId);
  }

  const blockRuleId = generateBlockRuleId(tabId);

  const blockRule = {
    id: blockRuleId,
    priority: 1,
    action: { type: 'block' },
    condition: {
      tabIds: [tabId],
      resourceTypes: ['image', 'media', 'font']
    }
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [blockRule],
      removeRuleIds: []
    });

    activeTabs.set(tabId, {
      blockRuleId,
      allowRuleIds: new Set(),
      allowRuleCounter: 0
    });

    // Increment sessions activated
    const data = await chrome.storage.local.get(['sessionsActivated']);
    await chrome.storage.local.set({
      sessionsActivated: (data.sessionsActivated || 0) + 1
    });

    console.log(`[SkelIO] Activated for tab ${tabId}, block rule ${blockRuleId}`);
    return { success: true };
  } catch (err) {
    console.error(`[SkelIO] Failed to activate tab ${tabId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * HYDRATE_URL: Allow a specific URL to load on a tab (high-priority allow rule)
 */
async function hydrateURL(url, tabId) {
  const tabData = activeTabs.get(tabId);
  if (!tabData) {
    console.warn(`[SkelIO] Tab ${tabId} not active, cannot hydrate ${url}`);
    return { success: false, error: 'Tab not active' };
  }

  const allowRuleId = generateAllowRuleId(tabId, tabData.allowRuleCounter);
  tabData.allowRuleCounter++;

  const allowRule = {
    id: allowRuleId,
    priority: 10, // Higher priority than block rule
    action: { type: 'allow' },
    condition: {
      tabIds: [tabId],
      urlFilter: url,
      resourceTypes: ['image', 'media', 'font']
    }
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [allowRule],
      removeRuleIds: []
    });

    tabData.allowRuleIds.add(allowRuleId);

    // Update bandwidth saved stats (estimate ~500KB per media asset)
    const data = await chrome.storage.local.get(['totalBandwidthSaved']);
    await chrome.storage.local.set({
      totalBandwidthSaved: (data.totalBandwidthSaved || 0) + 500000
    });

    console.log(`[SkelIO] Hydrated ${url} on tab ${tabId}, allow rule ${allowRuleId}`);
    return { success: true };
  } catch (err) {
    console.error(`[SkelIO] Failed to hydrate ${url} on tab ${tabId}:`, err);
    return { success: false, error: err.message };
  }
/**
 * ALLOW_FONTS: Lift font blocking on a tab so custom web fonts can load
 */
async function allowFonts(tabId) {
  const tabData = activeTabs.get(tabId);
  if (!tabData) return { success: true };

  const fontAllowRuleId = generateAllowRuleId(tabId, tabData.allowRuleCounter++);
  const allowRule = {
    id: fontAllowRuleId,
    priority: 20,
    action: { type: 'allow' },
    condition: {
      tabIds: [tabId],
      resourceTypes: ['font']
    }
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [allowRule],
      removeRuleIds: []
    });
    tabData.allowRuleIds.add(fontAllowRuleId);
    tabData.fontAllowRuleId = fontAllowRuleId;
    console.log(`[SkelIO] Allowed fonts on tab ${tabId}, rule ${fontAllowRuleId}`);
    return { success: true };
  } catch (err) {
    console.error(`[SkelIO] Failed to allow fonts on tab ${tabId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * BLOCK_FONTS: Re-enable font blocking by removing font allow rule
 */
async function blockFonts(tabId) {
  const tabData = activeTabs.get(tabId);
  if (!tabData || !tabData.fontAllowRuleId) return { success: true };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: [tabData.fontAllowRuleId]
    });
    tabData.allowRuleIds.delete(tabData.fontAllowRuleId);
    delete tabData.fontAllowRuleId;
    console.log(`[SkelIO] Re-blocked fonts on tab ${tabId}`);
    return { success: true };
  } catch (err) {
    console.error(`[SkelIO] Failed to re-block fonts on tab ${tabId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * DEACTIVATE_SKELIO: Remove all interception rules for a tab
 */
async function deactivateSkelIO(tabId) {
  const tabData = activeTabs.get(tabId);
  if (!tabData) {
    console.log(`[SkelIO] Tab ${tabId} not active, nothing to deactivate`);
    return { success: true, alreadyInactive: true };
  }

  const ruleIdsToRemove = [
    tabData.blockRuleId,
    ...Array.from(tabData.allowRuleIds)
  ];

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [],
      removeRuleIds: ruleIdsToRemove
    });

    activeTabs.delete(tabId);

    console.log(`[SkelIO] Deactivated tab ${tabId}, removed ${ruleIdsToRemove.length} rules`);
    return { success: true };
  } catch (err) {
    console.error(`[SkelIO] Failed to deactivate tab ${tabId}:`, err);
    return { success: false, error: err.message };
  }
}

/**
 * Increment blocked resources counter
 */
async function incrementBlockedResources(count = 1) {
  try {
    const data = await chrome.storage.local.get(['totalBlockedResources']);
    await chrome.storage.local.set({
      totalBlockedResources: (data.totalBlockedResources || 0) + count
    });
    return { success: true };
  } catch (err) {
    console.error('[SkelIO] Failed to increment blocked resources:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Increment layout shifts prevented counter
 */
async function incrementLayoutShiftsPrevented(count = 1) {
  try {
    const data = await chrome.storage.local.get(['layoutShiftsPrevented']);
    await chrome.storage.local.set({
      layoutShiftsPrevented: (data.layoutShiftsPrevented || 0) + count
    });
    return { success: true };
  } catch (err) {
    console.error('[SkelIO] Failed to increment layout shifts:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Get current stats
 */
async function getStats() {
  try {
    const data = await chrome.storage.local.get([
      'totalBlockedResources',
      'totalBandwidthSaved',
      'sessionsActivated',
      'layoutShiftsPrevented'
    ]);
    return {
      success: true,
      stats: {
        totalBlockedResources: data.totalBlockedResources || 0,
        totalBandwidthSaved: data.totalBandwidthSaved || 0,
        sessionsActivated: data.sessionsActivated || 0,
        layoutShiftsPrevented: data.layoutShiftsPrevented || 0
      }
    };
  } catch (err) {
    console.error('[SkelIO] Failed to get stats:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Message listener from content scripts and popup
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab?.id || message.tabId;

  if (!tabId && message.action !== 'GET_STATS' && message.action !== 'TEST_SPEED') {
    console.error('[SkelIO] No tabId in message:', message);
    sendResponse({ success: false, error: 'No tabId provided' });
    return false;
  }

  switch (message.action) {
    case 'TEST_SPEED':
      measureRealSpeedMbps().then(speed => {
        sendResponse({ success: true, speed });
      });
      return true;

    case 'ACTIVATE_SKELIO':
      activateSkelIO(tabId).then(sendResponse);
      return true; // Keep channel open for async

    case 'HYDRATE_URL':
      if (!message.url) {
        sendResponse({ success: false, error: 'No URL provided' });
        return false;
      }
      hydrateURL(message.url, tabId).then(sendResponse);
      return true;

    case 'DEACTIVATE_SKELIO':
      deactivateSkelIO(tabId).then(sendResponse);
      return true;

    case 'ALLOW_FONTS':
      allowFonts(tabId).then(sendResponse);
      return true;

    case 'BLOCK_FONTS':
      blockFonts(tabId).then(sendResponse);
      return true;

    case 'INCREMENT_BLOCKED':
      incrementBlockedResources(message.count || 1).then(sendResponse);
      return true;

    case 'INCREMENT_LAYOUT_SHIFTS':
      incrementLayoutShiftsPrevented(message.count || 1).then(sendResponse);
      return true;

    case 'GET_STATS':
      getStats().then(sendResponse);
      return true;

    default:
      console.warn('[SkelIO] Unknown action:', message.action);
      sendResponse({ success: false, error: 'Unknown action' });
      return false;
  }
});

/**
 * Clean up rules when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
  if (activeTabs.has(tabId)) {
    console.log(`[SkelIO] Tab ${tabId} closed, cleaning up`);
    deactivateSkelIO(tabId);
  }
});

/**
 * Check whether auto-activation should occur based on enable state & speed threshold
 */
async function shouldAutoActivateTab() {
  const data = await chrome.storage.local.get(['skelioEnabled', 'maxSpeedThreshold', 'lastKnownSpeed']);
  if (data.skelioEnabled === false) return false;
  const threshold = data.maxSpeedThreshold !== undefined ? data.maxSpeedThreshold : 50;
  if (threshold === 'always' || threshold === 0 || threshold === '0') return true;
  if (data.lastKnownSpeed !== undefined && data.lastKnownSpeed !== null) {
    return data.lastKnownSpeed <= threshold;
  }
  return true; // Default to active if speed not yet detected
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;
  const shouldActivate = await shouldAutoActivateTab();
  if (shouldActivate && !activeTabs.has(tabId)) {
    console.log('[SkelIO] Auto-activating for tab', tabId, tab.url.substring(0, 50));
    activateSkelIO(tabId);
  }
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;
  const shouldActivate = await shouldAutoActivateTab();
  if (shouldActivate && !activeTabs.has(tab.id)) {
    console.log('[SkelIO] Auto-activating for new tab', tab.id);
    activateSkelIO(tab.id);
  }
});

console.log('[SkelIO] Background service worker initialized');
