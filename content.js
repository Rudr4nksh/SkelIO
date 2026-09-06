/**
 * SkelIO Content Script
 * Pure DOM-based interception with CSS background-image skeletons
 * Sub-5ms geometry locking to eliminate CLS
 * 
 * Intercepts: img, video, iframe, audio, object, embed,
 *             picture/source, CSS background images, web fonts, link preloads
 */

(function() {
  'use strict';

  // ============================================================================
  // CONSTANTS & STATE
  // ============================================================================

  const SKELIO_ATTR = 'data-skelio-locked';
  const SKELIO_HYDRATED_ATTR = 'data-skelio-hydrated';
  const SKELIO_BG_ATTR = 'data-skelio-bg-locked';

  let isActive = false;
  let observer = null;
  let layoutShiftsPrevented = 0;
  let blockedResourcesCount = 0;

  // Transparent 1x1 pixel - used as dummy src so broken image icon never shows
  const TRANSPARENT_PIXEL = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

  // Media element tags that get skeleton placeholders
  const MEDIA_TARGETS = ['IMG', 'VIDEO', 'IFRAME', 'AUDIO', 'OBJECT', 'EMBED'];

  // Lightweight modern system font stack used when web fonts are swapped
  const SYSTEM_FONT_STACK = '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';

  // ============================================================================
  // NETWORK DETECTION & SPEED THRESHOLD
  // ============================================================================

  let currentSpeedThreshold = 50; // Default: 50 Mbps
  let cachedSpeedMbps = 25; // Default sensible speed

  function getEffectiveSpeedMbps() {
    if (navigator.onLine === false) return 0;
    if (typeof cachedSpeedMbps === 'number' && cachedSpeedMbps > 0) {
      return cachedSpeedMbps;
    }
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && typeof conn.downlink === 'number' && conn.downlink > 0) {
      return conn.downlink;
    }
    if (conn && conn.effectiveType) {
      if (conn.effectiveType === 'slow-2g') return 0.05;
      if (conn.effectiveType === '2g') return 0.25;
      if (conn.effectiveType === '3g') return 0.75;
      if (conn.effectiveType === '4g') return 15.0;
    }
    return 25.0;
  }

  function shouldActivateForSpeed(threshold) {
    if (threshold === 'always' || threshold === 0 || threshold === '0') {
      return true;
    }
    const limit = parseFloat(threshold) || 50;
    const currentSpeed = getEffectiveSpeedMbps();
    return currentSpeed <= limit;
  }

  function setupSpeedWatcher() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    if (conn && conn.addEventListener) {
      conn.addEventListener('change', async () => {
        const speed = getEffectiveSpeedMbps();
        console.log('[SkelIO] Network speed changed:', speed, 'Mbps');
        try {
          await chrome.storage.local.set({ lastKnownSpeed: speed });
        } catch (e) {}

        const data = await chrome.storage.local.get(['skelioEnabled', 'maxSpeedThreshold']);
        if (data.skelioEnabled === false) return; // User manually disabled

        const threshold = data.maxSpeedThreshold !== undefined ? data.maxSpeedThreshold : 2;
        const shouldBeActive = shouldActivateForSpeed(threshold);

        if (shouldBeActive && !isActive) {
          console.log(`[SkelIO] Speed (${speed} Mbps) <= threshold (${threshold} Mbps) -> Auto-Activating`);
          activateSkelIO();
        } else if (!shouldBeActive && isActive) {
          console.log(`[SkelIO] Speed (${speed} Mbps) > threshold (${threshold} Mbps) -> Auto-Deactivating`);
          deactivateSkelIO();
        }
      });
    }
  }

  // ============================================================================
  // GEOMETRY EXTRACTION
  // ============================================================================

  function extractGeometry(element) {
    let width = 0;
    let height = 0;

    // Priority 1: Element's own rendered bounding rect (actual on-screen rendered size)
    const rect = element.getBoundingClientRect();
    if (rect.width > 2 && rect.height > 2) {
      width = Math.floor(rect.width);
      height = Math.floor(rect.height);
    }

    // Priority 2: Parent container's bounding rect
    const parent = element.parentElement;
    if (parent) {
      const parentRect = parent.getBoundingClientRect();
      if (parentRect.width > 2 && parentRect.height > 2) {
        if (!width || !height) {
          width = Math.floor(parentRect.width);
          height = Math.floor(parentRect.height);
        } else {
          // If parent container clips overflow (e.g. YouTube thumbnail 16:9 container), clamp to visible frame
          try {
            const parentStyle = window.getComputedStyle(parent);
            if (parentStyle.overflow === 'hidden' || parentStyle.overflowY === 'hidden' || parentStyle.overflowX === 'hidden') {
              if (parentRect.height < height) height = Math.floor(parentRect.height);
              if (parentRect.width < width) width = Math.floor(parentRect.width);
            }
          } catch (e) {}
        }
      }
    }

    // Priority 3: Inline styles
    if (!width || !height) {
      if (element.style.width) width = parseInt(element.style.width, 10) || width;
      if (element.style.height) height = parseInt(element.style.height, 10) || height;
    }

    // Priority 4: Explicit HTML attributes (for unrendered / detached elements)
    if (!width || !height) {
      if (element.width) width = parseInt(element.width, 10) || width;
      if (element.height) height = parseInt(element.height, 10) || height;
    }

    // Priority 5: Aspect ratio fallback
    if (width && !height) height = Math.floor(width * 9 / 16);
    else if (height && !width) width = Math.floor(height * 16 / 9);

    // Priority 6: Detect icons/avatars to avoid giant boxes
    if (!width || !height) {
      const isIcon = (element.className + ' ' + (element.parentElement?.className || '')).toLowerCase().match(/icon|avatar|badge|logo|thumb|btn/);
      if (isIcon) {
        width = width || 32;
        height = height || 32;
      } else {
        width = width || 300;
        height = height || 200;
      }
    }

    return { width, height };
  }

  // ============================================================================
  // SVG SKELETON GENERATION
  // ============================================================================

  function createSkeletonSVG(width, height, label) {
    const mainText = label || 'REMOVED BY SKELIO';
    const subText = 'Click to load';

    // 1. For very small images/icons (< 45px), show minimalist rounded box
    if (width < 45 || height < 45) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <rect width="100%" height="100%" fill="#0F172A" rx="6" ry="6"/>
        <rect width="100%" height="100%" fill="none" stroke="#334155" stroke-width="1" rx="6" ry="6"/>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // 2. For compact elements (height < 75px or width < 140px), show a single centered "Click to load"
    if (height < 75 || width < 140) {
      const singleFontSize = Math.max(11, Math.min(13, Math.floor(height * 0.32)));
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <rect width="100%" height="100%" fill="#0F172A" rx="8" ry="8"/>
        <rect width="100%" height="100%" fill="none" stroke="#334155" stroke-width="1.5" rx="8" ry="8"/>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="central" fill="#F8FAFC" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${singleFontSize}px" font-weight="600" letter-spacing="0.3px">${subText}</text>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // 3. For standard and large elements: symmetric two-line layout centered at exactly 50%
    const fontSize = Math.max(12, Math.min(18, Math.floor(width / 18), Math.floor(height / 10)));
    const smallFontSize = Math.max(10, Math.min(13, Math.floor(fontSize * 0.75)));
    const gap = Math.max(4, Math.floor(fontSize * 0.35));

    // Vertical offsets relative to y="50%"
    const dyMain = -Math.round((gap + smallFontSize) / 2);
    const dySub = Math.round((fontSize + gap) / 2);

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <rect width="100%" height="100%" fill="#0F172A" rx="10" ry="10"/>
      <rect width="100%" height="100%" fill="none" stroke="#334155" stroke-width="1.5" rx="10" ry="10"/>
      <text x="50%" y="50%" dy="${dyMain}px" text-anchor="middle" dominant-baseline="central" fill="#FFFFFF" fill-opacity="0.95" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${fontSize}px" font-weight="700" letter-spacing="0.4px">${mainText}</text>
      <text x="50%" y="50%" dy="${dySub}px" text-anchor="middle" dominant-baseline="central" fill="#94A3B8" font-family="-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif" font-size="${smallFontSize}px" font-weight="500" letter-spacing="0.2px">${subText}</text>
    </svg>`;

    return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
  }

  // ============================================================================
  // MEDIA ELEMENT LOCKING & HYDRATION
  // ============================================================================

  function lockElement(element) {
    if (element.hasAttribute(SKELIO_ATTR)) {
      return;
    }

    const tag = element.tagName;

    // Get original source (prefer cached originalSrc if re-locking after deactivation)
    let originalSrc = element.dataset.skelioOriginalSrc;
    if (!originalSrc || originalSrc.startsWith('data:')) {
      originalSrc = element.src || element.currentSrc || element.data || element.poster;
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      if (!originalSrc || originalSrc.startsWith('blob:') || originalSrc.startsWith('data:')) {
        const sourceEl = element.querySelector('source');
        if (sourceEl && sourceEl.src) {
          originalSrc = sourceEl.src;
        }
      }
    }

    if (!originalSrc || (originalSrc.startsWith('data:') && !element.dataset.skelioOriginalSrc) || originalSrc.startsWith('blob:') || originalSrc.startsWith('about:')) {
      return;
    }

    // Clear hydrated state if re-locking
    element.removeAttribute(SKELIO_HYDRATED_ATTR);

    // Track original inline geometry before applying locks
    if (element.style.width) element.dataset.skelioHadInlineWidth = 'true';
    if (element.style.height) element.dataset.skelioHadInlineHeight = 'true';
    if (element.style.borderRadius) element.dataset.skelioHadInlineBorderRadius = 'true';

    const { width, height } = extractGeometry(element);
    element.dataset.skelioOriginalSrc = originalSrc;

    // Determine label based on element type
    let label = 'REMOVED BY SKELIO';
    if (tag === 'VIDEO') label = 'VIDEO BLOCKED';
    else if (tag === 'AUDIO') label = 'AUDIO BLOCKED';
    else if (tag === 'IFRAME') label = 'IFRAME BLOCKED';
    else if (tag === 'OBJECT' || tag === 'EMBED') label = 'EMBED BLOCKED';

    const skeletonSVG = createSkeletonSVG(width, height, label);

    // Lock geometry with !important to resist page CSS overrides
    element.style.setProperty('width', width + 'px', 'important');
    element.style.setProperty('height', height + 'px', 'important');
    element.style.setProperty('min-width', width + 'px', 'important');
    element.style.setProperty('min-height', height + 'px', 'important');
    element.style.setProperty('max-width', '100%', 'important');
    element.style.setProperty('display', 'inline-block', 'important');
    element.style.setProperty('visibility', 'visible', 'important');
    element.style.setProperty('opacity', '1', 'important');
    element.style.setProperty('filter', 'none', 'important');
    element.style.setProperty('mix-blend-mode', 'normal', 'important');
    element.style.setProperty('z-index', '1', 'important');
    element.style.setProperty('overflow', 'hidden', 'important');
    element.style.setProperty('cursor', 'pointer', 'important');
    element.style.setProperty('box-sizing', 'border-box', 'important');
    element.style.setProperty('border-radius', '10px', 'important');

    // Skeleton via CSS background-image (page JS can't overwrite this)
    element.style.setProperty('background-image', `url("${skeletonSVG}")`, 'important');
    element.style.setProperty('background-size', '100% 100%', 'important');
    element.style.setProperty('background-position', 'center center', 'important');
    element.style.setProperty('background-repeat', 'no-repeat', 'important');
    element.style.setProperty('background-color', '#0F172A', 'important');

    // Tag-specific source replacement
    if (tag === 'IMG') {
      // Handle <picture> parent — strip all <source> srcsets
      const picture = element.closest('picture');
      if (picture) {
        const sources = picture.querySelectorAll('source');
        const savedSrcsets = [];
        sources.forEach(source => {
          savedSrcsets.push(source.srcset || '');
          source.removeAttribute('srcset');
          source.removeAttribute('src');
        });
        element.dataset.skelioPictureSrcsets = JSON.stringify(savedSrcsets);
      }

      element.removeAttribute('srcset');
      element.removeAttribute('loading');
      element.src = TRANSPARENT_PIXEL;

      // Error handler: if page JS overwrites src, DNR blocks it → reset to transparent
      element.addEventListener('error', function() {
        if (element.hasAttribute(SKELIO_ATTR) && !element.hasAttribute(SKELIO_HYDRATED_ATTR)) {
          element.src = TRANSPARENT_PIXEL;
        }
      });

    } else if (tag === 'VIDEO') {
      element.pause && element.pause();
      element.dataset.skelioOriginalPoster = element.poster || '';
      element.poster = skeletonSVG;
      element.removeAttribute('autoplay');
      element.removeAttribute('loop');

    } else if (tag === 'AUDIO') {
      element.preload = 'none';
      element.removeAttribute('autoplay');
      element.pause && element.pause();
      element.querySelectorAll('source').forEach(s => {
        s.dataset.skelioSrc = s.src;
        s.removeAttribute('src');
      });

    } else if (tag === 'IFRAME') {
      element.srcdoc = `<!DOCTYPE html><html style="width:100%;height:100%;margin:0;padding:0;"><body style="margin:0;padding:0;width:100%;height:100%;background:#0F172A;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#F8FAFC;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;cursor:pointer;user-select:none;"><div style="font-size:14px;font-weight:700;letter-spacing:0.4px;margin-bottom:6px;">IFRAME BLOCKED</div><div style="font-size:11px;font-weight:500;color:#94A3B8;">Click to load</div></body></html>`;

    } else if (tag === 'OBJECT') {
      element.dataset.skelioOriginalData = element.data;
      element.data = '';

    } else if (tag === 'EMBED') {
      element.dataset.skelioOriginalData = element.src;
      element.src = '';
    }

    // Mark as locked
    element.setAttribute(SKELIO_ATTR, 'true');
    element.title = 'Click to load (SkelIO)';

    // Click-to-hydrate
    element.addEventListener('click', function hydrateHandler(e) {
      if (!element.hasAttribute(SKELIO_ATTR)) return;
      e.preventDefault();
      e.stopPropagation();
      hydrateElement(element);
    }, { capture: true });

    // Stats
    layoutShiftsPrevented++;
    blockedResourcesCount++;
    syncStats();

    console.log('[SkelIO] Locked:', tag, width + 'x' + height, originalSrc.substring(0, 60));
  }

  function hydrateElement(element) {
    const originalSrc = element.dataset.skelioOriginalSrc;
    if (!originalSrc) return;

    const tag = element.tagName;

    element.setAttribute(SKELIO_HYDRATED_ATTR, 'true');
    element.removeAttribute(SKELIO_ATTR);
    element.style.cursor = 'default';
    element.title = 'Loading...';
    element.style.opacity = '0.5';

    // Clear skeleton background
    element.style.removeProperty('background-image');
    element.style.removeProperty('background-size');
    element.style.removeProperty('background-position');
    element.style.removeProperty('background-repeat');
    element.style.removeProperty('background-color');

    // Clear locked geometry so responsive styles restore
    if (!element.dataset.skelioHadInlineWidth) {
      element.style.removeProperty('width');
      element.style.removeProperty('min-width');
      element.style.removeProperty('max-width');
    }
    if (!element.dataset.skelioHadInlineHeight) {
      element.style.removeProperty('height');
      element.style.removeProperty('min-height');
    }
    element.style.removeProperty('display');
    element.style.removeProperty('box-sizing');
    element.style.removeProperty('visibility');
    element.style.removeProperty('filter');
    element.style.removeProperty('mix-blend-mode');
    element.style.removeProperty('z-index');
    element.style.removeProperty('overflow');
    if (!element.dataset.skelioHadInlineBorderRadius) {
      element.style.removeProperty('border-radius');
    }

    // Tell background to allow this URL through DNR
    sendToBackground({ action: 'HYDRATE_URL', url: originalSrc }).catch(() => {});

    if (tag === 'IMG') {
      // Restore <picture> <source> srcsets
      const picture = element.closest('picture');
      if (picture && element.dataset.skelioPictureSrcsets) {
        try {
          const srcsets = JSON.parse(element.dataset.skelioPictureSrcsets);
          const sources = picture.querySelectorAll('source');
          sources.forEach((source, i) => {
            if (srcsets[i]) source.srcset = srcsets[i];
          });
        } catch (e) {}
      }

      element.onload = () => {
        element.style.opacity = '1';
        element.title = '';
      };
      element.onerror = () => {
        element.style.opacity = '1';
        element.title = 'Failed to load';
      };
      element.src = originalSrc;

    } else if (tag === 'VIDEO') {
      element.removeAttribute('poster');
      if (element.dataset.skelioOriginalPoster) {
        element.poster = element.dataset.skelioOriginalPoster;
      }
      element.src = originalSrc;
      element.load();
      element.style.opacity = '1';
      element.title = '';
      try {
        element.play && element.play().catch(() => {});
      } catch (e) {}

    } else if (tag === 'AUDIO') {
      element.querySelectorAll('source').forEach(s => {
        if (s.dataset.skelioSrc) s.src = s.dataset.skelioSrc;
      });
      element.src = originalSrc;
      element.load();
      element.style.opacity = '1';
      element.title = '';

    } else if (tag === 'IFRAME') {
      element.removeAttribute('srcdoc');
      element.src = originalSrc;
      element.style.opacity = '1';
      element.title = '';

    } else if (tag === 'OBJECT') {
      element.data = element.dataset.skelioOriginalData || originalSrc;
      element.style.opacity = '1';
      element.title = '';

    } else if (tag === 'EMBED') {
      element.src = element.dataset.skelioOriginalData || originalSrc;
      element.style.opacity = '1';
      element.title = '';
    }

    console.log('[SkelIO] Hydrated:', tag, originalSrc.substring(0, 60));
    updateStats();
  }

  // ============================================================================
  // WEB FONT INTERCEPTION
  // ============================================================================

  let fontStyleEl = null;

  function ensureFontStyleLast() {
    if (!fontStyleEl) return;
    const parent = document.head || document.documentElement;
    if (parent && parent.lastElementChild !== fontStyleEl) {
      parent.appendChild(fontStyleEl);
    }
  }

  function blockWebFonts() {
    const parent = document.head || document.documentElement;
    if (!parent) {
      requestAnimationFrame(blockWebFonts);
      return;
    }

    if (!fontStyleEl) {
      fontStyleEl = document.createElement('style');
      fontStyleEl.id = 'skelio-font-block';
    }

    // Always append as the last child to take precedence over all existing stylesheets
    parent.appendChild(fontStyleEl);

    // Apply clean, visibly lightweight font across all elements
    fontStyleEl.textContent = `
      /* Override modern framework font variables (Tailwind, Next.js, etc.) */
      :root {
        --font-sans: ${SYSTEM_FONT_STACK} !important;
        --font-display: ${SYSTEM_FONT_STACK} !important;
        --font-heading: ${SYSTEM_FONT_STACK} !important;
        --font-geist-sans: ${SYSTEM_FONT_STACK} !important;
        --font-inter: ${SYSTEM_FONT_STACK} !important;
      }

      /* Apply lightweight typography to all body text and elements */
      html, body,
      body *:not(code):not(pre):not(kbd):not(samp):not(i[class*="icon"]):not(i[class*="fa"]):not([class*="material-icons"]):not(.material-symbols-outlined),
      body [class]:not(code):not(pre):not(kbd):not(samp):not(i[class*="icon"]):not(i[class*="fa"]):not([class*="material-icons"]):not(.material-symbols-outlined),
      body [id]:not(code):not(pre):not(kbd):not(samp):not(i[class*="icon"]):not(i[class*="fa"]):not([class*="material-icons"]):not(.material-symbols-outlined) {
        font-family: ${SYSTEM_FONT_STACK} !important;
        font-weight: 300 !important;
        letter-spacing: 0.01em !important;
        -webkit-font-smoothing: antialiased !important;
        -moz-osx-font-smoothing: grayscale !important;
        text-rendering: optimizeLegibility !important;
      }

      /* Large display headings & titles — force ultra-lightweight (weight: 200) */
      h1, h2, h3,
      h1 *, h2 *, h3 *,
      [class*="hero"], [class*="display"] {
        font-family: ${SYSTEM_FONT_STACK} !important;
        font-weight: 200 !important;
        letter-spacing: -0.015em !important;
      }

      /* Smaller headings & subheadings — clean light weight (weight: 300) */
      h4, h5, h6,
      h4 *, h5 *, h6 *,
      [class*="title"], [class*="heading"] {
        font-family: ${SYSTEM_FONT_STACK} !important;
        font-weight: 300 !important;
      }

      /* Soften heavy bold text so it stays elegant and light (weight: 400) */
      b, strong, [class*="bold"], [class*="semibold"], [class*="black"], [class*="heavy"] {
        font-weight: 400 !important;
      }

      /* Preserve monospace for code */
      code, pre, kbd, samp, .font-mono, [class*="mono"], code *, pre * {
        font-family: Consolas, "Liberation Mono", Menlo, Monaco, monospace !important;
        font-weight: 400 !important;
      }

      /* Preserve icon fonts */
      i[class*="fa-"], i[class*="icon"], [class*="material-icons"], .material-symbols-outlined, [data-icon] {
        font-family: inherit !important;
      }
    `;
    blockedResourcesCount++;
    syncStats();
    sendToBackground({ action: 'BLOCK_FONTS' }).catch(() => {});
    console.log('[SkelIO] Lightweight typography applied');
  }

  function restoreWebFonts() {
    if (fontStyleEl) {
      fontStyleEl.remove();
      fontStyleEl = null;
      syncStats();
      console.log('[SkelIO] Web fonts restored');
    }
    // Tell background service worker to unblock font downloads via DNR
    sendToBackground({ action: 'ALLOW_FONTS' }).catch(() => {});
  }

  // ============================================================================
  // 3D & ANIMATION REMOVER (Kill all animations, freeze to still images)
  // ============================================================================

  let threeDStyleEl = null;

  function freezeVideos() {
    document.querySelectorAll('video').forEach(vid => {
      try {
        vid.pause();
        vid.removeAttribute('autoplay');
        vid.removeAttribute('loop');
      } catch (e) {}
    });
  }

  function simplify3DWebsites() {
    if (!document.head) {
      requestAnimationFrame(simplify3DWebsites);
      return;
    }

    // Determine base text color (sampling body or defaulting to dark/light)
    let bodyColor = window.getComputedStyle(document.body || document.documentElement).color || 'rgb(255, 255, 255)';
    let isLightText = true;
    const rgbMatch = bodyColor.match(/\d+/g);
    if (rgbMatch && rgbMatch.length >= 3) {
      const r = parseInt(rgbMatch[0], 10);
      const g = parseInt(rgbMatch[1], 10);
      const b = parseInt(rgbMatch[2], 10);
      const brightness = (r * 299 + g * 587 + b * 114) / 1000;
      isLightText = brightness > 128;
    }

    // Background color completely opposite to text color (flat, clean, no text overlays)
    const flatBgColor = isLightText ? '#0E0E10' : '#FAFAFA';

    if (!threeDStyleEl) {
      threeDStyleEl = document.createElement('style');
      threeDStyleEl.id = 'skelio-3d-simplifier';
      document.head.appendChild(threeDStyleEl);
    }

    // Stop animations while ensuring all text, buttons, and UI components are fully visible
    threeDStyleEl.textContent = `
      /* 1. Instantly finish entrance animations so text, buttons, and layout are in settled state */
      *, *::before, *::after {
        animation-duration: 0.001s !important;
        animation-delay: 0s !important;
        animation-iteration-count: 1 !important;
        animation-fill-mode: both !important;
        transition-duration: 0.001s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }

      /* 2. Guarantee text, headings, buttons, links, and inputs are ALWAYS visible and clickable */
      h1, h2, h3, h4, h5, h6, p, span, a, button, input, textarea, select, [role="button"], label, code, pre, img, svg {
        opacity: 1 !important;
        visibility: visible !important;
        pointer-events: auto !important;
      }

      /* 3. Stop continuous SVG and marquee animations */
      svg animate, svg animateTransform, svg animateMotion {
        display: none !important;
      }
      marquee {
        -webkit-marquee-repetition: 0 !important;
      }

      /* 4. Disable mouse-interaction loops and set contrasting flat background for 3D canvases */
      canvas[style*="fixed"], canvas[style*="absolute"],
      [class*="hero"] canvas, [class*="bg"] canvas, [class*="canvas"] canvas,
      canvas, model-viewer, spline-viewer, babylon {
        background-color: ${flatBgColor} !important;
        pointer-events: none !important;
      }
    `;

    // Pause all playing/looping videos to still frames
    freezeVideos();

    // Ensure MAIN world hook is present
    function ensureMainWorldHook() {
      if (document.getElementById('skelio-freeze-script')) return;
      try {
        const s = document.createElement('script');
        s.id = 'skelio-freeze-script';
        s.src = chrome.runtime.getURL('freeze.js');
        (document.head || document.documentElement).appendChild(s);
      } catch (e) {}
    }
    ensureMainWorldHook();

    // Notify MAIN world script (freeze.js) to freeze requestAnimationFrame loops & Web Animations API
    window.postMessage({ type: 'SKELIO_FREEZE_ANIMATIONS', freeze: true }, '*');

    blockedResourcesCount++;
    syncStats();

    console.log('[SkelIO] All animations frozen into still images, contrast bg:', flatBgColor);
  }

  function restore3DWebsites() {
    if (threeDStyleEl) {
      threeDStyleEl.remove();
      threeDStyleEl = null;
      // Notify MAIN world script (freeze.js) to resume
      window.postMessage({ type: 'SKELIO_FREEZE_ANIMATIONS', freeze: false }, '*');
      syncStats();
      console.log('[SkelIO] Animations and 3D backgrounds restored');
    }
  }

  // ============================================================================
  // CSS BACKGROUND IMAGE INTERCEPTION
  // ============================================================================

  function scanBackgroundImages() {
    // Fast query targeting elements with explicit background images — avoids layout thrashing
    const candidates = document.querySelectorAll('[style*="background"], [style*="background-image"], header, [class*="hero"], [class*="banner"]');

    let count = 0;
    for (let i = 0; i < candidates.length && count < 20; i++) {
      const el = candidates[i];
      if (el.hasAttribute(SKELIO_BG_ATTR)) continue;

      const bgImage = el.style.backgroundImage || (el.style.background && el.style.background.includes('url(') ? el.style.background : '');

      if (bgImage && bgImage.includes('url(') && !bgImage.startsWith('url("data:')) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 50 && rect.height > 50) {
          lockBackgroundImage(el, bgImage);
          count++;
        }
      }
    }

    if (count > 0) {
      console.log('[SkelIO] Locked', count, 'CSS background images');
    }
  }

  function lockBackgroundImage(element, originalBg) {
    element.dataset.skelioOriginalBg = originalBg;
    element.setAttribute(SKELIO_BG_ATTR, 'true');

    const rect = element.getBoundingClientRect();
    const width = Math.floor(rect.width);
    const height = Math.floor(rect.height);
    const skeletonSVG = createSkeletonSVG(width, height, 'BG IMAGE BLOCKED');

    element.style.setProperty('background-image', `url("${skeletonSVG}")`, 'important');
    element.style.setProperty('background-size', '100% 100%', 'important');
    element.style.setProperty('background-position', 'center center', 'important');
    element.style.setProperty('background-repeat', 'no-repeat', 'important');
    element.style.setProperty('cursor', 'pointer', 'important');
    element.style.setProperty('border-radius', '10px', 'important');

    // Click-to-restore
    element.addEventListener('click', function bgHydrateHandler(e) {
      if (!element.hasAttribute(SKELIO_BG_ATTR)) return;
      e.preventDefault();
      e.stopPropagation();
      hydrateBackgroundImage(element);
      element.removeEventListener('click', bgHydrateHandler);
    }, { once: true, capture: true });

    blockedResourcesCount++;
    layoutShiftsPrevented++;
    syncStats();
  }

  function hydrateBackgroundImage(element) {
    const originalBg = element.dataset.skelioOriginalBg;
    if (!originalBg) return;

    element.removeAttribute(SKELIO_BG_ATTR);
    element.style.removeProperty('background-image');
    element.style.removeProperty('background-size');
    element.style.removeProperty('background-position');
    element.style.removeProperty('background-repeat');
    element.style.removeProperty('cursor');
    element.style.removeProperty('border-radius');

    // Let the original CSS background-image reassert itself
    // If it was inline, restore it
    element.style.backgroundImage = originalBg;

    console.log('[SkelIO] BG image hydrated');
    syncStats();
  }

  // ============================================================================
  // LINK PRELOAD / PREFETCH REMOVAL
  // ============================================================================

  function removePreloads() {
    const preloads = document.querySelectorAll(
      'link[rel="preload"][as="image"], link[rel="preload"][as="video"], link[rel="preload"][as="audio"], link[rel="preload"][as="font"], link[rel="prefetch"][as="image"], link[rel="prefetch"][as="font"]'
    );

    preloads.forEach(link => {
      link.remove();
      blockedResourcesCount++;
    });

    if (preloads.length > 0) {
      console.log('[SkelIO] Removed', preloads.length, 'preload/prefetch hints');
    }
  }

  // ============================================================================
  // MUTATION OBSERVER
  // ============================================================================

  function setupObserver() {
    observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;

            // Lock media elements
            if (MEDIA_TARGETS.includes(node.tagName)) {
              lockElement(node);
            }

            // Remove dynamically added preloads
            if (node.tagName === 'LINK') {
              const rel = node.getAttribute('rel');
              const as = node.getAttribute('as');
              if ((rel === 'preload' || rel === 'prefetch') && ['image', 'video', 'audio', 'font'].includes(as)) {
                node.remove();
                blockedResourcesCount++;
              }
            }

            // If 3D/animation simplifier is active, pause new videos to still frames
            if (threeDStyleEl && node.tagName === 'VIDEO') {
              try { node.pause(); node.removeAttribute('autoplay'); node.removeAttribute('loop'); } catch (e) {}
            }

            // Scan children
            if (node.querySelectorAll) {
              const targets = node.querySelectorAll(MEDIA_TARGETS.join(','));
              for (let i = 0; i < targets.length && i < 50; i++) {
                lockElement(targets[i]);
              }
            }
          }
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target.nodeType === 1 && MEDIA_TARGETS.includes(target.tagName)) {
            if (target.hasAttribute(SKELIO_ATTR) && !target.hasAttribute(SKELIO_HYDRATED_ATTR)) {
              // Already locked — page JS overwrote src, reset to transparent pixel
              const currentSrc = target.src || '';
              if (target.tagName === 'IMG' && !currentSrc.startsWith('data:')) {
                target.src = TRANSPARENT_PIXEL;
              }
            } else {
              lockElement(target);
            }
          }
        }
      }

      if (fontStyleEl) {
        ensureFontStyleLast();
      }
    });

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', 'poster', 'data', 'url']
    });

    console.log('[SkelIO] MutationObserver active');
  }

  function lockExistingElements() {
    // Clear any leftover hydrated marks from past sessions so all elements can re-lock
    document.querySelectorAll(`[${SKELIO_HYDRATED_ATTR}]`).forEach(el => {
      el.removeAttribute(SKELIO_HYDRATED_ATTR);
    });

    // Lock all media elements
    const elements = document.querySelectorAll(MEDIA_TARGETS.map(t => t.toLowerCase()).join(', '));
    console.log('[SkelIO] Locking', elements.length, 'existing media elements');

    for (let i = 0; i < elements.length; i++) {
      lockElement(elements[i]);
    }

    syncStats();

    // Remove preloads
    removePreloads();

    // Scan background images (deferred slightly for computed styles to settle)
    setTimeout(scanBackgroundImages, 500);
  }

  // ============================================================================
  // STATS
  // ============================================================================

  let statsSyncTimer = null;

  function syncStats() {
    if (statsSyncTimer) clearTimeout(statsSyncTimer);
    statsSyncTimer = setTimeout(async () => {
      try {
        const lockedEls = document.querySelectorAll(`[${SKELIO_ATTR}]`).length;
        const lockedBgs = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`).length;
        const extras = (fontStyleEl ? 1 : 0) + (threeDStyleEl ? 1 : 0);
        const currentPageBlocked = lockedEls + lockedBgs + extras;
        const currentPageShifts = lockedEls + lockedBgs;
        const bandwidthPerItem = 480000; // ~480 KB saved per media/3D resource

        const data = await chrome.storage.local.get([
          'layoutShiftsPrevented',
          'totalBlockedResources',
          'totalBandwidthSaved'
        ]);

        const totalBlocked = Math.max(data.totalBlockedResources || 0, blockedResourcesCount, currentPageBlocked);
        const totalShifts = Math.max(data.layoutShiftsPrevented || 0, layoutShiftsPrevented, currentPageShifts);
        const totalBandwidth = Math.max(data.totalBandwidthSaved || 0, totalBlocked * bandwidthPerItem);

        await chrome.storage.local.set({
          layoutShiftsPrevented: totalShifts,
          totalBlockedResources: totalBlocked,
          totalBandwidthSaved: totalBandwidth,
          pageBlocked: currentPageBlocked,
          pageShifts: currentPageShifts,
          pageBandwidth: currentPageBlocked * bandwidthPerItem
        });
      } catch (err) {}
    }, 40);
  }

  function updateStats() {
    syncStats();
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

    // Clear previous hydrated flags
    document.querySelectorAll(`[${SKELIO_HYDRATED_ATTR}]`).forEach(el => {
      el.removeAttribute(SKELIO_HYDRATED_ATTR);
    });

    // Tell background to set up DNR blocking rules
    sendToBackground({ action: 'ACTIVATE_SKELIO' }).catch(() => {});

    // Block web fonts immediately
    blockWebFonts();

    // Simplify 3D websites: replace GPU-heavy 3D backgrounds with contrasting flat backgrounds
    simplify3DWebsites();

    // Lock existing elements
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', lockExistingElements, { once: true });
    } else {
      lockExistingElements();
    }

    // Setup observer for dynamically added elements
    setupObserver();

    console.log('[SkelIO] Activated successfully');
  }

  async function deactivateSkelIO() {
    if (!isActive) return;

    console.log('[SkelIO] Deactivating...');
    isActive = false;

    // Disconnect MutationObserver
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    // Restore web fonts
    restoreWebFonts();

    // Restore 3D backgrounds
    restore3DWebsites();

    // Hydrate all currently locked elements
    const lockedElements = document.querySelectorAll(`[${SKELIO_ATTR}]`);
    lockedElements.forEach(el => hydrateElement(el));

    // Restore all locked CSS background images
    const bgLockedElements = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`);
    bgLockedElements.forEach(el => hydrateBackgroundImage(el));

    // Clear hydrated marks so next activation locks cleanly
    document.querySelectorAll(`[${SKELIO_HYDRATED_ATTR}]`).forEach(el => {
      el.removeAttribute(SKELIO_HYDRATED_ATTR);
    });

    // Tell background service worker to remove DNR rules
    sendToBackground({ action: 'DEACTIVATE_SKELIO' }).catch(() => {});

    console.log('[SkelIO] Deactivated successfully');
  }

  // ============================================================================
  // INITIALIZATION
  // ============================================================================

  // Listen for messages from popup toggle
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'SKELIO_ACTIVATE') {
      activateSkelIO();
      sendResponse({ success: true, active: isActive });
    } else if (message.action === 'SKELIO_DEACTIVATE') {
      deactivateSkelIO();
      sendResponse({ success: true, active: isActive });
    } else if (message.action === 'SKELIO_STATUS') {
      const lockedEls = document.querySelectorAll(`[${SKELIO_ATTR}]`).length;
      const lockedBgs = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`).length;
      const extras = (fontStyleEl ? 1 : 0) + (threeDStyleEl ? 1 : 0);
      const currentPageBlocked = Math.max(blockedResourcesCount, lockedEls + lockedBgs + extras);
      const currentPageShifts = Math.max(layoutShiftsPrevented, lockedEls + lockedBgs);
      const currentPageBandwidth = currentPageBlocked * 480000;

      sendResponse({
        active: isActive,
        fontsBlocked: !!fontStyleEl,
        simplified3D: !!threeDStyleEl,
        currentSpeed: getEffectiveSpeedMbps(),
        threshold: currentSpeedThreshold,
        pageBlocked: currentPageBlocked,
        pageShifts: currentPageShifts,
        pageBandwidth: currentPageBandwidth
      });
    } else if (message.action === 'SKELIO_SET_SPEED_THRESHOLD') {
      currentSpeedThreshold = message.threshold;
      if (typeof message.currentSpeed === 'number') {
        cachedSpeedMbps = message.currentSpeed;
      }
      chrome.storage.local.get(['skelioEnabled', 'lastKnownSpeed'], (data) => {
        if (data && typeof data.lastKnownSpeed === 'number') {
          cachedSpeedMbps = data.lastKnownSpeed;
        }
        if (data.skelioEnabled !== false) {
          const shouldBeActive = shouldActivateForSpeed(currentSpeedThreshold);
          if (shouldBeActive && !isActive) {
            activateSkelIO();
          } else if (!shouldBeActive && isActive) {
            deactivateSkelIO();
          }
        }
        sendResponse({
          success: true,
          active: isActive,
          currentSpeed: getEffectiveSpeedMbps(),
          threshold: currentSpeedThreshold
        });
      });
      return true; // Keep channel open for async storage lookup
    } else if (message.action === 'SKELIO_RESTORE_FONTS') {
      restoreWebFonts();
      sendResponse({ success: true, fontsBlocked: false });
    } else if (message.action === 'SKELIO_BLOCK_FONTS') {
      blockWebFonts();
      sendResponse({ success: true, fontsBlocked: true });
    } else if (message.action === 'SKELIO_TOGGLE_3D') {
      if (threeDStyleEl) {
        restore3DWebsites();
        sendResponse({ simplified: false });
      } else {
        simplify3DWebsites();
        sendResponse({ simplified: true });
      }
    } else if (message.action === 'SKELIO_HYDRATE_ALL') {
      const lockedElements = document.querySelectorAll(`[${SKELIO_ATTR}]`);
      lockedElements.forEach(el => hydrateElement(el));
      const bgLockedElements = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`);
      bgLockedElements.forEach(el => hydrateBackgroundImage(el));
      sendResponse({ success: true, count: lockedElements.length + bgLockedElements.length });
    }
    return false;
  });

  async function init() {
    console.log('[SkelIO] Content script initializing...');

    let enabled = true;
    let threshold = 50;
    try {
      const data = await chrome.storage.local.get(['skelioEnabled', 'maxSpeedThreshold', 'lastKnownSpeed']);
      if (data) {
        if (data.skelioEnabled === false) enabled = false;
        if (data.maxSpeedThreshold !== undefined) threshold = data.maxSpeedThreshold;
        if (typeof data.lastKnownSpeed === 'number') cachedSpeedMbps = data.lastKnownSpeed;
      }
    } catch (e) {}

    currentSpeedThreshold = threshold;
    const currentSpeed = getEffectiveSpeedMbps();

    setupSpeedWatcher();

    if (enabled && shouldActivateForSpeed(threshold)) {
      activateSkelIO();
    } else {
      console.log(`[SkelIO] Standby: Speed ${currentSpeed} Mbps > threshold ${threshold} Mbps`);
    }

    console.log('[SkelIO] Content script initialized, active:', isActive);
  }

  // Run immediately
  init();

})();
