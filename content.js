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

  // Transparent 1x1 pixel - used as dummy src so YouTube can't show broken image
  const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Pre-compile regex - matches ?skelio, /?skelio, &skelio, etc.
  const URL_PATTERN = /[?&/]skelio(?:=1)?(?:&|$)/i;

  // ============================================================================
  // NETWORK DETECTION
  // ============================================================================

  function shouldActivateSkelIO() {
    // Check URL parameters first (with fallback to href for redirect cases)
    const hasParam = URL_PATTERN.test(window.location.search) || URL_PATTERN.test(window.location.href);

    if (hasParam) {
      // Remove the skelio parameter from the URL so it doesn't appear in search results
      const url = new URL(window.location.href);
      url.searchParams.delete('skelio');
      // Also remove if it's just ?skelio without value
      if (url.searchParams.toString() === '') {
        url.search = '';
        history.replaceState({}, document.title, url.pathname + url.hash);
      } else {
        history.replaceState({}, document.title, url.pathname + '?' + url.search);
      }
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

  // Adaptive color detection: sample the page's background and compute contrasting text
  function getAdaptiveColor(element) {
    // Try to get computed background color from the element or its parent
    let bgColor = '#1E1E1E'; // default dark
    let textColor = '#FFFFFF'; // default white

    // Check element's computed style
    const computed = window.getComputedStyle(element);
    const bg = computed.backgroundColor;
    if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') {
      // Simple heuristic: if bg looks light, use dark text, else light text
      const rgb = parseColor(bg);
      if (rgb) {
        const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
        if (luminance > 0.5) {
          textColor = '#000000';
        } else {
          textColor = '#FFFFFF';
        }
      }
    }

    // For images, try to detect website background by sampling a nearby element
    // or use the stored adaptive color
    return { bgColor: bgColor, textColor: textColor };
  }

  function parseColor(str) {
    // Parse rgb(), rgba(), #hex, or named colors
    const m = str.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
    const m2 = str.match(/^#([a-fA-F0-9]{2})([a-fA-F0-9]{2})([a-fA-F0-9]{2})$/);
    if (m2) return { r: parseInt(m2[1], 16), g: parseInt(m2[2], 16), b: parseInt(m2[3], 16) };
    return null;
  }

  function createSkeletonSVG(width, height, element) {
    // For very small images (icons), just show a solid box without text
    if (width < 50 || height < 50) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
        <rect width="100%" height="100%" fill="#1E1E1E"/>
        <rect width="100%" height="100%" fill="none" stroke="#FFFFFF" stroke-width="1" stroke-opacity="0.3"/>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // Get adaptive text color based on detected background
    const adaptive = getAdaptiveColor(element || document.body);

    // For larger images, show full text with adaptive coloring
    const fontSize = Math.max(14, Math.min(width / 12, height / 6));
    const smallFontSize = Math.max(11, fontSize * 0.75);

    // Rounded corners for a cleaner look
    const radius = Math.min(width, height) * 0.1; // 10% of smaller dimension

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
      <rect width="100%" height="100%" fill="#1E1E1E" rx="${radius}" ry="${radius}"/>
      <rect width="100%" height="100%" fill="none" stroke="${adaptive.textColor}" stroke-width="2" stroke-opacity="0.2" stroke-dasharray="8,4"/>
      <text x="50%" y="40%" text-anchor="middle" fill="${adaptive.textColor}" fill-opacity="0.95" font-family="system-ui, Arial, sans-serif" font-size="${fontSize}" font-weight="700" letter-spacing="0.5" dominant-baseline="middle">REMOVED BY SKELIO</text>
      <text x="50%" y="60%" text-anchor="middle" fill="${adaptive.textColor}" fill-opacity="0.7" font-family="system-ui, Arial, sans-serif" font-size="${smallFontSize}" font-weight="400" dominant-baseline="middle">Click to load</text>
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
    if (!originalSrc || originalSrc.startsWith('data:') || originalSrc.startsWith('blob:') || originalSrc.startsWith('about:')) {
      return; // Skip data URIs, blob URLs, internal frames, and elements without src
    }

    element.dataset.skelioOriginalSrc = originalSrc;

    // Set explicit dimensions to lock geometry
    element.style.width = width + 'px';
    element.style.height = height + 'px';
    element.style.minWidth = width + 'px';
    element.style.minHeight = height + 'px';
    element.style.display = 'inline-block';
    element.style.visibility = 'visible';
    element.style.backgroundColor = '#1E1E1E';
    element.style.cursor = 'pointer';
    element.style.border = '2px solid #3A3A3A';
    element.style.boxSizing = 'border-box';

    // Generate skeleton
    const skeletonSVG = createSkeletonSVG(width, height, element);

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

    // Add click handler for hydration
    element.addEventListener('click', function hydrateHandler(e) {
      e.preventDefault();
      e.stopPropagation();
      console.log('[SkelIO] Click detected on:', element.tagName, element.dataset.skelioOriginalSrc?.substring(0, 80));
      console.log('[SkelIO] Element tag:', element.tagName, 'has hydrated attr:', element.hasAttribute(SKELIO_HYDRATED_ATTR));
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
    if (!originalSrc) {
      console.warn('[SkelIO] Cannot hydrate - no original src stored. Checking attrs...');
      console.warn('[SkelIO] SKELIO_ATTR:', element.hasAttribute(SKELIO_ATTR), 'SKELIO_HYDRATED_ATTR:', element.hasAttribute(SKELIO_HYDRATED_ATTR));
      console.warn('[SkelIO] dataset keys:', Object.keys(element.dataset));
      return;
    }

    console.log('[SkelIO] Hydrating element, restoring src:', originalSrc.substring(0, 100));
    console.log('[SkelIO] Original src type:', typeof originalSrc);

    element.setAttribute(SKELIO_HYDRATED_ATTR, 'true');
    element.removeAttribute(SKELIO_ATTR);
    element.style.cursor = 'default';
    element.title = 'Loading...';
    element.style.opacity = '0.6';
    element.style.border = 'none'; // Remove skeleton border

    // Restore original src
    if (element.tagName === 'IMG') {
      const img = element;
      img.onload = () => {
        img.style.opacity = '1';
        img.title = '';
        img.style.backgroundColor = 'transparent';
        console.log('[SkelIO] Image loaded successfully');
      };
      img.onerror = () => {
        console.error('[SkelIO] Image failed to load:', originalSrc.substring(0, 80));
        img.style.opacity = '1';
        img.style.backgroundColor = '#FF0000';
        img.title = 'Failed to load';
      };
      img.src = originalSrc;
    } else if (element.tagName === 'VIDEO') {
      element.src = originalSrc;
      element.poster = '';
      element.load();
      element.style.opacity = '1';
      element.title = '';
      element.style.backgroundColor = 'transparent';
    } else if (element.tagName === 'IFRAME') {
      element.src = originalSrc;
      element.srcdoc = '';
      element.style.opacity = '1';
      element.title = '';
      element.style.backgroundColor = 'transparent';
    }

    console.log('[SkelIO] Hydration initiated for:', element.tagName);

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
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target.nodeType === 1 && TARGETS.includes(target.tagName)) {
            // If already locked but page JS overwrote src, re-force the skeleton
            if (target.hasAttribute(SKELIO_ATTR) && !target.hasAttribute(SKELIO_HYDRATED_ATTR)) {
              const currentSrc = target.src || target.poster || '';
              if (!currentSrc.startsWith('data:image/svg+xml')) {
                const { width, height } = extractGeometry(target);
                if (target.tagName === 'IMG') {
                  target.removeAttribute('srcset');
                  target.src = createSkeletonSVG(width, height, target);
                } else if (target.tagName === 'VIDEO') {
                  target.poster = createSkeletonSVG(width, height, target);
                }
              }
            } else {
              lockElement(target);
            }
          }
        }
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'data']
    });

    console.log('[SkelIO] MutationObserver activated (childList + attributes)');
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

    // Notify background service worker (optional - DNR blocking)
    sendToBackground({ action: 'ACTIVATE_SKELIO' }).then(res => {
      console.log('[SkelIO] Background DNR activation:', res);
    }).catch(err => {
      console.warn('[SkelIO] Background DNR activation failed (DOM-only mode):', err.message);
    });

    // Lock existing elements immediately
    lockExistingElements();

    // Also lock after DOM loads
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', lockExistingElements, { once: true });
    }

    // Setup observer for new elements
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
