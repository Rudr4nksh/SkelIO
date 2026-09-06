/**
 * SkelIO Content Script
 * Pure DOM-based interception - no background service worker dependency
 * Sub-5ms geometry locking to eliminate CLS
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS & STATE
  // ============================================================================

  const SKELIO_ATTR = 'data-skelio-locked';
  const SKELIO_HYDRATED_ATTR = 'data-skelio-hydrated';

  let isActive = false;
  let observer = null;
  let layoutShiftsPrevented = 0;
  let blockedResourcesCount = 0;

  // Pre-compile regex
  const URL_PATTERN = /[?&]skelio(?:=1)?(?:&|$)/i;

  // ============================================================================
  // NETWORK DETECTION
  // ============================================================================

  function shouldActivateSkelIO() {
    // TEMP: Force activation on Wikipedia for testing
    if (window.location.hostname.includes('wikipedia.org')) {
      console.log('[SkelIO] Activated on Wikipedia (testing mode)');
      return true;
    }

    // Check URL parameters
    if (URL_PATTERN.test(window.location.search)) {
      console.log('[SkelIO] Activated via URL parameter');
      return true;
    }

    // Check Network Information API
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;

    if (conn) {
      const slowTypes = ['slow-2g', '2g', '3g'];
      if (slowTypes.includes(conn.effectiveType)) return true;
      if (conn.rtt && conn.rtt > 300) return true;
      if (conn.downlink && conn.downlink < 1.5) return true;
      if (conn.saveData === true) return true;
    }

    if (navigator.onLine === false) return true;

    return false;
  }

  // ============================================================================
  // GEOMETRY EXTRACTION
  // ============================================================================

  function extractGeometry(element) {
    let width = 0;
    let height = 0;

    // Priority 1: Explicit attributes
    if (element.width) width = parseInt(element.width, 10);
    if (element.height) height = parseInt(element.height, 10);

    // Priority 2: Inline styles
    if (!width || !height) {
      if (element.style.width) width = parseInt(element.style.width, 10) || width;
      if (element.style.height) height = parseInt(element.style.height, 10) || height;
    }

    // Priority 3: Parent container
    if (!width || !height) {
      const parent = element.parentElement;
      if (parent) {
        const parentRect = parent.getBoundingClientRect();
        if (!width && parentRect.width > 0) width = Math.floor(parentRect.width);
        if (!height && parentRect.height > 0) height = Math.floor(parentRect.height);
      }
    }

    // Priority 4: Aspect ratio fallback
    if (width && !height) height = Math.floor(width * 9 / 16);
    else if (height && !width) width = Math.floor(height * 16 / 9);

    // Priority 5: Defaults
    if (!width) width = 300;
    if (!height) height = 200;

    return { width, height };
  }

  // ============================================================================
  // SVG SKELETON GENERATION
  // ============================================================================

  function createSkeletonSVG(width, height) {
    // For very small images (icons), just show a solid box without text
    if (width < 50 || height < 50) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#1E1E1E"/>
        <rect width="100%" height="100%" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.3"/>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // For larger images, show full text
    const fontSize = Math.max(14, Math.min(width / 12, height / 6));
    const smallFontSize = Math.max(11, fontSize * 0.75);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <defs>
        <linearGradient id="shimmer-${width}-${height}" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" style="stop-color:#1E1E1E;stop-opacity:1">
            <animate attributeName="offset" values="-2;1" dur="2s" repeatCount="indefinite"/>
          </stop>
          <stop offset="50%" style="stop-color:#3A3A3A;stop-opacity:1">
            <animate attributeName="offset" values="-1.5;1.5" dur="2s" repeatCount="indefinite"/>
          </stop>
          <stop offset="100%" style="stop-color:#1E1E1E;stop-opacity:1">
            <animate attributeName="offset" values="-1;2" dur="2s" repeatCount="indefinite"/>
          </stop>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#shimmer-${width}-${height})"/>
      <rect width="100%" height="100%" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-opacity="0.2" stroke-dasharray="8,4"/>
      <text x="50%" y="40%" text-anchor="middle" fill="#FFFFFF" fill-opacity="0.95" font-family="system-ui, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.5">REMOVED BY SKELIO</text>
      <text x="50%" y="60%" text-anchor="middle" fill="#FFFFFF" fill-opacity="0.7" font-family="system-ui, Arial, sans-serif" font-size="${smallFontSize}" font-weight="400">Click to load</text>
    </svg>`;

    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  // ============================================================================
  // ELEMENT LOCKING & HYDRATION
  // ============================================================================

  function lockElement(element) {
    // Skip if already processed
    if (element.hasAttribute(SKELIO_ATTR) || element.hasAttribute(SKELIO_HYDRATED_ATTR)) {
      return;
    }

    const { width, height } = extractGeometry(element);

    // Store original src
    const originalSrc = element.src || element.currentSrc || element.data || element.poster;
    if (!originalSrc || originalSrc.startsWith('data:') || originalSrc.startsWith('blob:')) {
      return; // Skip data URIs, blob URLs, and elements without src
    }

    element.dataset.skelioOriginalSrc = originalSrc;

    // Set explicit dimensions to lock geometry
    element.style.width = width + 'px';
    element.style.height = height + 'px';
    element.style.minWidth = width + 'px';
    element.style.minHeight = height + 'px';
    element.style.display = 'inline-block';
    element.style.backgroundColor = '#1E1E1E';
    element.style.cursor = 'pointer';
    element.style.border = '2px solid #3A3A3A';
    element.style.boxSizing = 'border-box';

    // Generate skeleton
    const skeletonSVG = createSkeletonSVG(width, height);

    // FORCE replace src immediately - don't let browser load original
    if (element.tagName === 'IMG') {
      element.removeAttribute('srcset'); // Remove srcset to prevent fallback loading
      element.removeAttribute('loading'); // Remove lazy loading
      element.src = skeletonSVG;
    } else if (element.tagName === 'VIDEO') {
      element.poster = skeletonSVG;
      element.preload = 'none';
      element.removeAttribute('autoplay');
    } else if (element.tagName === 'IFRAME') {
      element.srcdoc = `<body style="margin:0;background:#1E1E1E;display:flex;align-items:center;justify-content:center;height:100vh;color:#FFF;font-family:system-ui;font-size:14px;">Click to load iframe</body>`;
    }

    // Mark as locked
    element.setAttribute(SKELIO_ATTR, 'true');
    element.title = 'Click to load (SkelIO)';

    // Add click handler
    element.addEventListener('click', function hydrateHandler(e) {
      e.preventDefault();
      e.stopPropagation();
      hydrateElement(element);
      element.removeEventListener('click', hydrateHandler);
    }, { once: true, capture: true });

    // Stats
    layoutShiftsPrevented++;
    blockedResourcesCount++;

    console.log('[SkelIO] Locked:', element.tagName, width + 'x' + height, originalSrc.substring(0, 50));
  }

  function hydrateElement(element) {
    const originalSrc = element.dataset.skelioOriginalSrc;
    if (!originalSrc) return;

    element.setAttribute(SKELIO_HYDRATED_ATTR, 'true');
    element.removeAttribute(SKELIO_ATTR);
    element.style.cursor = '';
    element.title = 'Loading...';
    element.style.opacity = '0.5';

    // Restore original src
    if (element.tagName === 'IMG') {
      const img = element;
      img.onload = () => {
        img.style.opacity = '1';
        img.title = '';
      };
      img.src = originalSrc;
    } else if (element.tagName === 'VIDEO') {
      element.src = originalSrc;
      element.poster = '';
      element.load();
      element.style.opacity = '1';
      element.title = '';
    } else if (element.tagName === 'IFRAME') {
      element.src = originalSrc;
      element.srcdoc = '';
      element.style.opacity = '1';
      element.title = '';
    }

    console.log('[SkelIO] Hydrated:', originalSrc);

    // Update stats (debounced)
    if (layoutShiftsPrevented % 5 === 0) {
      updateStats();
    }
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function setupObserver() {
    const TARGETS = ['IMG', 'VIDEO', 'IFRAME'];

    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;

            if (TARGETS.includes(node.tagName)) {
              lockElement(node);
            }

            if (node.querySelectorAll) {
              const targets = node.querySelectorAll(TARGETS.join(','));
              for (let i = 0; i < targets.length && i < 50; i++) {
                lockElement(targets[i]);
              }
            }
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true
    });

    console.log('[SkelIO] MutationObserver activated');
  }

  function lockExistingElements() {
    const elements = document.querySelectorAll('img, video, iframe');
    console.log('[SkelIO] Locking', elements.length, 'existing elements');

    for (let i = 0; i < elements.length; i++) {
      lockElement(elements[i]);
    }
  }

  // ============================================================================
  // STATS
  // ============================================================================

  function updateStats() {
    try {
      chrome.storage.local.set({
        layoutShiftsPrevented,
        totalBlockedResources: blockedResourcesCount,
        totalBandwidthSaved: blockedResourcesCount * 500000 // Estimate 500KB per asset
      });
    } catch (err) {
      console.warn('[SkelIO] Failed to update stats:', err);
    }
  }

  // ============================================================================
  // BACKGROUND COMMUNICATION
  // ============================================================================

  async function sendToBackground(message, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response) return response;
      } catch (err) {
        console.warn(`[SkelIO] Background message failed (attempt ${i + 1}/${retries}):`, err.message);
        if (i < retries - 1) await new Promise(r => setTimeout(r, 100 * (i + 1)));
      }
    }
    throw new Error('Failed to communicate with background worker');
  }

  // ============================================================================
  // ACTIVATION
  // ============================================================================

  async function activateSkelIO() {
    if (isActive) return;

    console.log('[SkelIO] Activating...');
    isActive = true;

    // Wait for <head> to exist, then inject CSS
    function injectCSS() {
      if (!document.head) {
        requestAnimationFrame(injectCSS);
        return;
      }
      const style = document.createElement('style');
      style.id = 'skelio-hide-media';
      style.textContent = `
        img:not([${SKELIO_HYDRATED_ATTR}]) {
          visibility: hidden !important;
        }
      `;
      document.head.appendChild(style);
      console.log('[SkelIO] CSS injected');
    }
    injectCSS();

    // Lock existing elements
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', lockExistingElements, { once: true });
    } else {
      lockExistingElements();
    }

    // Setup observer
    setupObserver();

    console.log('[SkelIO] Activated successfully');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  function init() {
    console.log('[SkelIO] Content script initializing...');

    if (shouldActivateSkelIO()) {
      activateSkelIO();
    }

    console.log('[SkelIO] Content script initialized');
  }

  // Run immediately
  init();

})();
