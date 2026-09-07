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
  skelioActive = !skelioActive;
  await chrome.storage.local.set({ skelioEnabled: skelioActive });
  updateUI();

  try {
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      if (!skelioActive) {
        await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_DEACTIVATE' });
      } else {
        await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_ACTIVATE' });
      }
    }
  } catch (err) {}
}

async function toggleFonts() {
  fontsBlocked = !fontsBlocked;
  await chrome.storage.local.set({ fontsBlocked: fontsBlocked });
  updateUI();

  try {
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        action: fontsBlocked ? 'SKELIO_BLOCK_FONTS' : 'SKELIO_RESTORE_FONTS'
      });
    }
  } catch (err) {}
}

async function toggle3D() {
  simplified3D = !simplified3D;
  await chrome.storage.local.set({ simplified3D: simplified3D });
  updateUI();

  try {
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      await chrome.tabs.sendMessage(tab.id, {
        action: 'SKELIO_TOGGLE_3D',
        simplified: simplified3D
      });
    }
  } catch (err) {}
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
    if (statusBadge) statusBadge.className = 'status-badge';
    if (statusBadgeText) statusBadgeText.textContent = 'ACTIVE';
    if (toggleBtnText) toggleBtnText.textContent = 'SkelIO Active';
    if (siteProtectionText) siteProtectionText.textContent = 'Protection Active';
  } else {
    const isStandby = detectedSpeed && currentSpeedThreshold !== 'always' && detectedSpeed > currentSpeedThreshold;
    if (statusBadge) statusBadge.className = 'status-badge off';
    if (statusBadgeText) statusBadgeText.textContent = isStandby ? 'STANDBY' : 'PAUSED';
    if (toggleBtnText) toggleBtnText.textContent = 'Enable SkelIO';
    if (siteProtectionText) {
      siteProtectionText.textContent = isStandby
        ? `Standby (${detectedSpeed} Mbps > ${currentSpeedThreshold}M)`
        : 'Protection Standby';
    }
  }

  // Feature toggles reflect their own independent active states
  if (fontBtn) {
    fontBtn.className = fontsBlocked ? 'ios-switch active' : 'ios-switch';
  }
  if (fontBtnText) {
    fontBtnText.textContent = fontsBlocked ? 'Light (300)' : 'Web Fonts';
  }

  if (threeDBtn) {
    threeDBtn.className = simplified3D ? 'ios-switch active' : 'ios-switch';
  }
  if (threeDBtnText) {
    threeDBtnText.textContent = simplified3D ? 'Frozen Still' : 'Moving 3D';
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

async function syncStatsToDashboardTabs(storage) {
  if (!chrome || !chrome.tabs || !chrome.scripting) return;
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.url && (tab.url.includes('dashboard.html') || tab.url.includes('website'))) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: (stats, bw, shifts, blk, profile) => {
              if (stats && Object.keys(stats).length > 0) {
                const cur = JSON.parse(localStorage.getItem('skelio_domain_stats') || '{}');
                localStorage.setItem('skelio_domain_stats', JSON.stringify(Object.assign({}, cur, stats)));
              }
              if (bw) localStorage.setItem('skelio_total_bandwidth', String(bw));
              if (shifts) localStorage.setItem('skelio_total_shifts', String(shifts));
              if (blk) localStorage.setItem('skelio_total_blocked', String(blk));
              if (profile && profile.name) localStorage.setItem('skelio_user_profile', JSON.stringify(profile));

              window.postMessage({ type: 'SKELIO_STATS_UPDATED' }, '*');
              if (typeof window.loadRealData === 'function') window.loadRealData();
              if (typeof window.loadUserProfile === 'function') window.loadUserProfile();
            },
            args: [
              storage.skelio_domain_stats || {},
              storage.totalBandwidthSaved || 0,
              storage.layoutShiftsPrevented || 0,
              storage.totalBlockedResources || 0,
              storage.skelio_user_profile || null
            ]
          });
        } catch (e) {}
      }
    }
  } catch (e) {}
}

async function loadStats() {
  try {
    // 1. Query storage for both page-level and global metrics
    const storage = await chrome.storage.local.get([
      'pageBlocked',
      'pageShifts',
      'pageBandwidth',
      'totalBlockedResources',
      'layoutShiftsPrevented',
      'totalBandwidthSaved',
      'skelio_domain_stats',
      'skelio_user_profile'
    ]);

    // Actively synchronize to open dashboard tabs
    syncStatsToDashboardTabs(storage).catch(() => {});

    // 2. Try to get real-time live page stats from active tab
    const tab = await getCurrentTab();
    if (tab && tab.id) {
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: 'SKELIO_STATUS' });
        if (response && response.active && response.pageBlocked > 0) {
          updateStatsDisplay(response.pageShifts, response.pageBlocked, response.pageBandwidth);
          return;
        }
      } catch (e) {}
    }

    // 3. Fallback: If page has blocks, show page stats; otherwise show cumulative all-time saved!
    const blocked = (skelioActive && storage.pageBlocked > 0) ? storage.pageBlocked : (storage.totalBlockedResources || 0);
    const shifts = (skelioActive && storage.pageShifts > 0) ? storage.pageShifts : (storage.layoutShiftsPrevented || 0);
    const bandwidth = (skelioActive && storage.pageBandwidth > 0) ? storage.pageBandwidth : (storage.totalBandwidthSaved || 0);

    updateStatsDisplay(shifts, blocked, bandwidth);
  } catch (err) {}
}

// ─── Attach Event Listeners ───
document.getElementById('toggleBtn')?.addEventListener('click', toggleSkelIO);
document.getElementById('fontCard')?.addEventListener('click', toggleFonts);
document.getElementById('threeDCard')?.addEventListener('click', toggle3D);
document.getElementById('themeToggleBtn')?.addEventListener('click', toggleTheme);
document.getElementById('hydrateAllBtn')?.addEventListener('click', hydrateAll);
document.getElementById('reloadTabBtn')?.addEventListener('click', reloadTab);
document.getElementById('shortcutHintBtn')?.addEventListener('click', reloadTab);
document.getElementById('testSpeedBtn')?.addEventListener('click', runSpeedBenchmark);

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

// ─── User Profile Synchronization ───
let cachedWebsiteBaseUrl = null;

async function loadUserProfile() {
  try {
    let profile = null;

    // 1. Check extension storage first
    if (chrome && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['skelio_user_profile', 'skelio_website_url']);
      profile = data.skelio_user_profile;
      if (data.skelio_website_url) {
        cachedWebsiteBaseUrl = data.skelio_website_url;
      }
    }

    // 2. If not found in extension storage, actively scan open tabs
    if (!profile && chrome && chrome.tabs && chrome.scripting) {
      try {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.url && (tab.url.includes('website') || tab.url.includes('dashboard.html') || tab.url.includes('index.html') || tab.url.includes('SkelIO')) && !tab.url.includes('login.html')) {
            try {
              const injection = await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  return {
                    profile: localStorage.getItem('skelio_user_profile'),
                    stats: localStorage.getItem('skelio_domain_stats'),
                    url: window.location.href
                  };
                }
              });

              if (injection && injection[0] && injection[0].result) {
                const res = injection[0].result;
                cachedWebsiteBaseUrl = res.url;
                if (res.profile) {
                  profile = JSON.parse(res.profile);
                  await chrome.storage.local.set({
                    skelio_user_profile: profile,
                    skelio_website_url: res.url
                  });
                }
                if (res.stats) {
                  try {
                    const stats = JSON.parse(res.stats);
                    const cur = (await chrome.storage.local.get(['skelio_domain_stats']))?.skelio_domain_stats || {};
                    await chrome.storage.local.set({ skelio_domain_stats: Object.assign({}, cur, stats) });
                  } catch (e) {}
                }
                if (profile) break;
              }
            } catch (err) {}
          }
        }
      } catch (e) {}
    }

    // 3. Fallback to isolated extension localStorage
    if (!profile) {
      const stored = localStorage.getItem('skelio_user_profile');
      if (stored) {
        try { profile = JSON.parse(stored); } catch (e) {}
      }
    }

    const avatarEl = document.getElementById('userAvatarChip');
    const nameEl = document.getElementById('userProfileName');
    const badgeEl = document.getElementById('userProfileBadge');
    const dashBtn = document.getElementById('openDashBtn');
    const logoutBtn = document.getElementById('popupLogoutBtn');

    if (profile && profile.name) {
      if (avatarEl) {
        avatarEl.textContent = profile.initials || profile.name.slice(0, 2).toUpperCase();
        avatarEl.classList.remove('guest');
      }
      if (nameEl) nameEl.textContent = profile.name;
      if (badgeEl) {
        badgeEl.textContent = (profile.plan || 'PRO') + ' MEMBER';
        badgeEl.classList.remove('guest');
      }
      if (dashBtn) {
        dashBtn.innerHTML = `<span>Dashboard</span><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:currentColor;"><path d="M5 13h11.86l-5.43 5.43 1.42 1.42L21.14 12l-8.29-7.85-1.42 1.42L16.86 11H5v2z"/></svg>`;
        dashBtn.title = 'Open SkelIO Analytics Dashboard';
      }
      if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
      }
    } else {
      if (avatarEl) {
        avatarEl.textContent = 'RU';
        avatarEl.classList.remove('guest');
      }
      if (nameEl) nameEl.textContent = 'Rudranksh';
      if (badgeEl) {
        badgeEl.textContent = 'PRO MEMBER';
        badgeEl.classList.remove('guest');
      }
      if (dashBtn) {
        dashBtn.innerHTML = `<span>Dashboard</span><svg viewBox="0 0 24 24" style="width:10px;height:10px;fill:currentColor;"><path d="M5 13h11.86l-5.43 5.43 1.42 1.42L21.14 12l-8.29-7.85-1.42 1.42L16.86 11H5v2z"/></svg>`;
        dashBtn.title = 'Open SkelIO Dashboard';
      }
      if (logoutBtn) {
        logoutBtn.style.display = 'inline-flex';
      }
    }
  } catch (e) {
    console.warn('Error loading user profile:', e);
  }
}

// ─── Extension Sign Out Button Handler (Syncs to website tabs) ───
const popupLogoutBtn = document.getElementById('popupLogoutBtn');
if (popupLogoutBtn) {
  popupLogoutBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      // 1. Remove from extension storage and local storage
      if (chrome && chrome.storage && chrome.storage.local) {
        await chrome.storage.local.remove(['skelio_user_profile']);
      }
      localStorage.removeItem('skelio_user_profile');

      // 2. Clear profile from all open website tabs and redirect any dashboard tabs to login.html
      if (chrome && chrome.tabs && chrome.scripting) {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (tab.url && (tab.url.includes('website') || tab.url.includes('dashboard.html') || tab.url.includes('login.html') || tab.url.includes('SkelIO'))) {
            try {
              await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                func: () => {
                  try {
                    localStorage.removeItem('skelio_user_profile');
                    document.documentElement.removeAttribute('data-skelio-profile');
                    window.postMessage({ type: 'SKELIO_PROFILE_LOGOUT' }, '*');
                    document.dispatchEvent(new CustomEvent('SKELIO_PROFILE_LOGOUT'));
                    if (window.location.href.includes('dashboard.html')) {
                      window.location.href = 'login.html';
                    }
                  } catch (e) {}
                }
              });
            } catch (err) {}
          }
        }
      }

      // 3. Immediately switch popup UI to Guest mode
      await loadUserProfile();
    } catch (err) {
      console.warn('Error during popup logout:', err);
    }
  });
}

const openDashBtn = document.getElementById('openDashBtn');
if (openDashBtn) {
  openDashBtn.addEventListener('click', async (e) => {
    e.preventDefault();
    try {
      const data = await chrome.storage.local.get([
        'skelio_user_profile',
        'skelio_website_url',
        'skelio_domain_stats',
        'totalBandwidthSaved',
        'layoutShiftsPrevented',
        'totalBlockedResources'
      ]);
      const isLoggedIn = !!(data.skelio_user_profile && data.skelio_user_profile.name);
      const targetPage = isLoggedIn ? 'dashboard.html' : 'login.html';

      // Push latest stats into any dashboard tab
      await syncStatsToDashboardTabs(data);

      // 1. Check if an existing tab has this page or any SkelIO website page
      if (chrome && chrome.tabs) {
        const tabs = await chrome.tabs.query({});
        const existingTab = tabs.find(t => t.url && (t.url.includes(targetPage) || t.url.includes('website')));
        if (existingTab) {
          const targetUrl = existingTab.url.replace(/[^/]*$/, targetPage);
          await chrome.tabs.update(existingTab.id, { url: targetUrl, active: true });
          return;
        }

        // 2. If we cached the website URL, open targetPage
        const baseUrl = data.skelio_website_url || cachedWebsiteBaseUrl;
        if (baseUrl) {
          const targetUrl = baseUrl.replace(/[^/]*$/, targetPage);
          await chrome.tabs.create({ url: targetUrl });
          return;
        }
      }
    } catch (err) {}

    window.open('../website/dashboard.html', '_blank');
  });
}

// Listen to storage changes in real-time
if (chrome && chrome.storage && chrome.storage.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local') {
      if (changes.skelio_user_profile) {
        loadUserProfile();
      }
      if (changes.skelio_domain_stats) {
        loadStats();
      }
    }
  });
}

// ─── Theme Management (Light / Dark Mode synced with Website) ───
async function initTheme() {
  try {
    let theme = null;
    if (chrome && chrome.storage && chrome.storage.local) {
      const data = await chrome.storage.local.get(['skelio_theme']);
      theme = data.skelio_theme;
    }
    if (!theme) {
      theme = localStorage.getItem('skelio_theme');
    }
    if (!theme) {
      theme = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    document.documentElement.setAttribute('data-theme', 'light');
  }
}

async function toggleTheme() {
  try {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const newTheme = current === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('skelio_theme', newTheme);
    if (chrome && chrome.storage && chrome.storage.local) {
      await chrome.storage.local.set({ skelio_theme: newTheme });
    }

    // Sync to open website and dashboard tabs
    if (chrome && chrome.tabs && chrome.scripting) {
      const tabs = await chrome.tabs.query({});
      for (const tab of tabs) {
        if (tab.url && (tab.url.includes('website') || tab.url.includes('dashboard.html') || tab.url.includes('index.html') || tab.url.includes('login.html'))) {
          try {
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: (t) => {
                document.documentElement.setAttribute('data-theme', t);
                localStorage.setItem('skelio_theme', t);
              },
              args: [newTheme]
            });
          } catch (err) {}
        }
      }
    }
  } catch (err) {
    console.warn('Error toggling theme:', err);
  }
}

// Init
initTheme();
checkStatus();
loadStats();
loadUserProfile();
setInterval(loadStats, 2000);


