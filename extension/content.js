/**
 * SkelIO Content Script
 * Pure DOM-based interception with CSS background-image skeletons
 * Sub-5ms geometry locking to eliminate CLS
 * 
 * Intercepts: img, video, audio, object, embed,
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

  // Media element tags that get skeleton placeholders (iframes excluded so embeds & auth frames are never blocked)
  const MEDIA_TARGETS = ['IMG', 'VIDEO', 'AUDIO', 'OBJECT', 'EMBED'];

  // Lightweight modern system font stack used when web fonts are swapped
  const SYSTEM_FONT_STACK = '"Segoe UI Variable Display", "Segoe UI Variable Text", "Segoe UI", -apple-system, BlinkMacSystemFont, Roboto, "Helvetica Neue", Arial, sans-serif';

  // ============================================================================
  // WEBSITE ARCHETYPE DETECTION ENGINE
  // Classifies websites into rendering profiles to prevent layout breaking & overlapping
  // ============================================================================

  const ARCHETYPES = {
    EDITORIAL: 'EDITORIAL',         // Blogs, Wikipedia, Substack, Medium, news, documentation
    INFINITE_FEED: 'INFINITE_FEED', // YouTube, Twitter/X, Reddit, Instagram, Pinterest, TikTok, LinkedIn
    SCROLL_SHOWCASE: 'SCROLL_SHOWCASE', // Apple, Nike, Webflow showcases, Stripe, GSAP/Lenis parallax
    RICH_APP: 'RICH_APP',           // Figma, Canva, Google Docs/Sheets/Maps, Notion, Miro, CAD/WebGL
    STANDARD: 'STANDARD'            // General websites, e-commerce storefronts
  };

  let currentArchetype = ARCHETYPES.STANDARD;

  function detectSiteArchetype() {
    const host = (window.location.hostname || '').toLowerCase();

    // Tier 1: Hostname signatures (instant 0ms fingerprinting for top platforms)
    if (host.includes('figma.com') || host.includes('canva.com') || host.includes('docs.google.com') ||
        host.includes('sheets.google.com') || host.includes('maps.google.com') || host.includes('notion.so') ||
        host.includes('miro.com') || host.includes('slack.com') || host.includes('linear.app')) {
      return ARCHETYPES.RICH_APP;
    }

    if (host.includes('youtube.com') || host.includes('twitter.com') || host.includes('x.com') ||
        host.includes('reddit.com') || host.includes('instagram.com') || host.includes('pinterest.com') ||
        host.includes('tiktok.com') || host.includes('linkedin.com')) {
      return ARCHETYPES.INFINITE_FEED;
    }

    if (host.includes('c2c.sh') || host.includes('c2c.acmvit.in') || host.includes('apple.com') ||
        host.includes('nike.com') || host.includes('stripe.com') || host.includes('webflow.io') ||
        host.includes('awwwards.com') || host.includes('framer.website')) {
      return ARCHETYPES.SCROLL_SHOWCASE;
    }

    if (host.includes('wikipedia.org') || host.includes('medium.com') || host.includes('substack.com') ||
        host.includes('nytimes.com') || host.includes('theguardian.com') || host.includes('bbc.com') ||
        host.includes('reuters.com') || host.includes('bloomberg.com') || host.includes('dev.to')) {
      return ARCHETYPES.EDITORIAL;
    }

    // Tier 2: Structural DOM & rendering engine heuristics
    try {
      // Check for Rich Web Application (large full-screen canvas or role=application)
      const hasAppRole = document.querySelector('[role="application"]');
      const largeCanvas = document.querySelector('canvas#canvas, canvas[data-engine], .fullscreen-canvas');
      if (hasAppRole || (largeCanvas && (largeCanvas.clientWidth > window.innerWidth * 0.7))) {
        return ARCHETYPES.RICH_APP;
      }

      // Check for Scene Portals / Visual Showcases / Scrollytelling (c2c.sh, GSAP, Lenis, Locomotive)
      const hasScenePortal = document.querySelector(
        '[data-portal-scene], [data-scene], [class*="scene-"], [class*="-scene"], [id*="scene"], [class*="min-h-dvh"], [class*="min-h-screen"], [class*="overflow-clip"] [class*="pointer-events-none absolute"]'
      );
      const hasSceneStyles = document.querySelector('[style*="--scene"], [class*="--scene"], [class*="bg-[image:var"]');
      const hasScrolly = document.querySelector('[data-scroll-container], [data-scroll-section], .lenis, [data-scroll], .sticky-wrapper, [class*="scrolltrigger"]');
      if (hasScenePortal || hasSceneStyles || hasScrolly) {
        return ARCHETYPES.SCROLL_SHOWCASE;
      }

      // Check for Virtualized Infinite Feeds
      const hasFeed = document.querySelector('[data-virtualized], virtual-scroller, [data-testid*="tweet"], ytd-app, shreddit-app, [class*="infinite-scroll"]');
      if (hasFeed) {
        return ARCHETYPES.INFINITE_FEED;
      }

      // Check for Editorial / Article Content
      const articleEl = document.querySelector('article, [itemprop="articleBody"], .post-content, .entry-content, .article-body');
      if (articleEl && articleEl.querySelectorAll('p').length >= 3) {
        return ARCHETYPES.EDITORIAL;
      }
    } catch (e) {}

    return ARCHETYPES.STANDARD;
  }

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
    if (!element || element.tagName === 'IFRAME') return;
    if (!isActive || element.hasAttribute(SKELIO_ATTR) || element.hasAttribute(SKELIO_HYDRATED_ATTR)) {
      return;
    }
    // Anti-Overlap Protection: Check if element or any ancestor is already locked or hydrated
    if (element.closest && element.closest(`[${SKELIO_ATTR}], [${SKELIO_HYDRATED_ATTR}], [${SKELIO_BG_ATTR}]`)) {
      return;
    }
    // Anti-Overlap Protection: Check if element contains an already locked child (prevent nested double-skeletons)
    if (element.querySelector && element.querySelector(`[${SKELIO_ATTR}], [${SKELIO_BG_ATTR}]`)) {
      return;
    }

    // Archetype Guardrail: Rich Web Applications (Figma, Canva, Google Docs/Maps, Notion, CAD)
    if (currentArchetype === ARCHETYPES.RICH_APP) {
      if (element.closest('canvas, svg, [role="toolbar"], [role="menu"], [role="navigation"], [class*="toolbar"], [class*="toolbox"], [class*="palette"], [class*="layer"], [class*="panel"], aside, nav')) {
        return;
      }
    }

    const tag = element.tagName;

    // Filter out UI icons, logos, wordmarks, and small badges so website navigation and branding are never broken
    if (tag === 'IMG') {
      const isIconOrLogo = (element.className + ' ' + (element.id || '') + ' ' + (element.parentElement?.className || '')).toLowerCase().match(/icon|logo|brand|avatar|badge|emoji|flag|arrow|caret|btn|nav|status|spinner|symbol|wordmark/);
      const rect = element.getBoundingClientRect();
      const w = rect.width || parseInt(element.width, 10) || parseInt(element.style.width, 10) || 0;
      const h = rect.height || parseInt(element.height, 10) || parseInt(element.style.height, 10) || 0;

      // Small icons (42px or less)
      if (w > 0 && w <= 42 && h > 0 && h <= 42) {
        return;
      }
      // Header, navigation, and toolbar logos/buttons
      const inNavOrHeader = element.closest && element.closest('header, nav, [role="navigation"], [class*="nav"], [class*="header"], [class*="toolbar"]');
      if (inNavOrHeader && w <= 240 && h <= 85) {
        return;
      }
      // General logo/brand/wordmark classes
      if (isIconOrLogo && w <= 220 && h <= 80) {
        return;
      }
      // Action button textures and frames (e.g. hero-cta btn-box)
      if (element.closest && element.closest('a[class*="cta"], a[class*="btn"], button[class*="btn"], [class*="cta"] img, [class*="btn"] img')) {
        return;
      }
      // SVGs (almost always vector icons or logos)
      const src = (element.getAttribute('src') || element.src || '').toLowerCase();
      if (src.endsWith('.svg') || src.includes('.svg?') || src.startsWith('data:image/svg')) {
        return;
      }
    }

    // Get original source (prefer cached originalSrc if re-locking after deactivation)
    let originalSrc = element.dataset.skelioOriginalSrc;
    if (!originalSrc || originalSrc.startsWith('data:')) {
      originalSrc = element.getAttribute('src') || element.src || element.currentSrc ||
                    element.getAttribute('data-src') || element.getAttribute('data-lazy-src') ||
                    element.getAttribute('data-original') || element.getAttribute('data-orig') ||
                    element.getAttribute('data-hi-res-src') || element.getAttribute('data-url') ||
                    element.getAttribute('data-fallback-src') ||
                    element.dataset.src || element.dataset.thumb || element.dataset.lazySrc ||
                    element.dataset.original || element.data || element.poster;
    }
    if (tag === 'IMG' && (!originalSrc || originalSrc.startsWith('data:'))) {
      const srcset = element.getAttribute('data-srcset') || element.srcset;
      if (srcset) {
        const first = srcset.split(',')[0].trim().split(' ')[0];
        if (first && !first.startsWith('data:')) originalSrc = first;
      }
    }
    if (tag === 'VIDEO' || tag === 'AUDIO') {
      if (!originalSrc || originalSrc.startsWith('blob:') || originalSrc.startsWith('data:')) {
        const sourceEl = element.querySelector('source');
        if (sourceEl && sourceEl.src) {
          originalSrc = sourceEl.src;
        }
      }
    }

    // Save lazy attributes before clearing so they can be restored upon hydration
    if (element.getAttribute('data-src')) element.dataset.skelioDataSrc = element.getAttribute('data-src');
    if (element.getAttribute('data-lazy-src')) element.dataset.skelioDataLazySrc = element.getAttribute('data-lazy-src');
    if (element.getAttribute('data-original')) element.dataset.skelioDataOriginal = element.getAttribute('data-original');

    if (!originalSrc || (originalSrc.startsWith('data:') && !element.dataset.skelioOriginalSrc) || originalSrc.startsWith('blob:') || originalSrc.startsWith('about:')) {
      return;
    }

    // Normalize to fully qualified absolute URL so Declarative Net Request and background worker can match it accurately
    if (!originalSrc.startsWith('data:') && !originalSrc.startsWith('blob:')) {
      try {
        originalSrc = new URL(originalSrc, window.location.href).href;
      } catch (e) {}
    }

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
    else if (tag === 'OBJECT' || tag === 'EMBED') label = 'EMBED BLOCKED';

    const skeletonSVG = createSkeletonSVG(width, height, label);

    const compStyle = window.getComputedStyle(element);
    const isNaturallyPointerEventsNone = compStyle.pointerEvents === 'none';
    const isInitiallyHidden = compStyle.visibility === 'hidden' || compStyle.opacity === '0';

    // Lock geometry with !important without breaking flex/grid layouts or stacking order
    element.style.setProperty('width', width + 'px', 'important');
    element.style.setProperty('height', height + 'px', 'important');

    const parentWidth = element.parentElement ? element.parentElement.clientWidth : window.innerWidth;
    const isScenicLayer = (
      element.getAttribute('aria-hidden') === 'true' ||
      isNaturallyPointerEventsNone ||
      (element.className && typeof element.className === 'string' && (element.className.includes('max-w-none') || element.className.includes('w-[')))
    );

    if (!(currentArchetype === ARCHETYPES.SCROLL_SHOWCASE && isScenicLayer)) {
      if (width <= parentWidth) {
        element.style.setProperty('max-width', '100%', 'important');
      }
    }
    if (compStyle.aspectRatio && compStyle.aspectRatio !== 'auto') {
      element.style.setProperty('aspect-ratio', compStyle.aspectRatio, 'important');
    }

    // Archetype Strategy: Scroll showcases preserve pin context, infinite feeds isolate layout
    try {
      if (compStyle.display === 'inline') {
        element.style.setProperty('display', 'inline-block', 'important');
      }
      if (currentArchetype === ARCHETYPES.SCROLL_SHOWCASE) {
        // Preserve sticky/fixed/absolute positioning for GSAP & scroll-driven pins
        if (compStyle.position === 'static') {
          element.style.setProperty('position', 'relative', 'important');
        }
      } else {
        if (compStyle.position === 'static') {
          element.style.setProperty('position', 'relative', 'important');
        }
      }
    } catch (e) {
      element.style.setProperty('display', 'inline-block', 'important');
    }

    if (currentArchetype === ARCHETYPES.INFINITE_FEED) {
      // Isolate layout & paint so virtualized node recycling does not cause adjacent grid overlap
      element.style.setProperty('contain', 'layout paint', 'important');
    }

    // Only set visibility/opacity if the element wasn't deliberately hidden by page timeline / scroll trigger
    if (!isInitiallyHidden) {
      element.style.setProperty('visibility', 'visible', 'important');
      element.style.setProperty('opacity', '1', 'important');
    }

    if (currentArchetype !== ARCHETYPES.SCROLL_SHOWCASE) {
      element.style.setProperty('filter', 'none', 'important');
      element.style.setProperty('mix-blend-mode', 'normal', 'important');
    }
    element.style.setProperty('overflow', 'hidden', 'important');
    element.style.setProperty('box-sizing', 'border-box', 'important');

    // Always make locked elements interactive so clicks are received, saving previous state
    if (isNaturallyPointerEventsNone) {
      element.dataset.skelioHadPointerEventsNone = 'true';
    }
    if (isScenicLayer && isNaturallyPointerEventsNone) {
      // Preserve pointer-events: none so decorative background scenery does not intercept clicks to forms & controls
      element.style.setProperty('pointer-events', 'none', 'important');
    } else {
      element.style.setProperty('pointer-events', 'auto', 'important');
      element.style.setProperty('cursor', 'pointer', 'important');
    }
    element.style.setProperty('border-radius', '10px', 'important');

    // Skeleton via CSS background-image (page JS can't overwrite this)
    element.style.setProperty('background-image', `url("${skeletonSVG}")`, 'important');
    element.style.setProperty('background-size', '100% 100%', 'important');
    element.style.setProperty('background-position', 'center center', 'important');
    element.style.setProperty('background-repeat', 'no-repeat', 'important');

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

      if (element.srcset) {
        element.dataset.skelioOriginalSrcset = element.srcset;
        element.removeAttribute('srcset');
      }
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
      e.stopImmediatePropagation();
      hydrateElement(element);
    }, { capture: true });

    // Stats
    layoutShiftsPrevented++;
    blockedResourcesCount++;
    syncStats();

    console.log('[SkelIO] Locked:', tag, width + 'x' + height, originalSrc.substring(0, 60));
  }

  async function hydrateElement(element) {
    const originalSrc = element.dataset.skelioOriginalSrc;
    if (!originalSrc) return;

    const tag = element.tagName;

    // 1. Mark both the element AND its container as hydrated so dynamic re-renders never re-lock
    element.setAttribute(SKELIO_HYDRATED_ATTR, 'true');
    element.removeAttribute(SKELIO_ATTR);

    const container = (element.closest && element.closest('ytd-thumbnail, yt-image, [id*="thumb"], [class*="thumb"], figure, picture, .card, a')) || element.parentElement;
    if (container) {
      container.setAttribute(SKELIO_HYDRATED_ATTR, 'true');
    }

    element.style.cursor = 'default';
    element.title = '';
    element.style.setProperty('opacity', '1', 'important');
    element.style.setProperty('visibility', 'visible', 'important');

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
    element.style.removeProperty('filter');
    element.style.removeProperty('mix-blend-mode');
    element.style.removeProperty('position');
    element.style.removeProperty('z-index');
    if (element.dataset.skelioHadPointerEventsNone) {
      element.style.setProperty('pointer-events', 'none', 'important');
    } else {
      element.style.removeProperty('pointer-events');
    }
    element.style.removeProperty('overflow');
    if (!element.dataset.skelioHadInlineBorderRadius) {
      element.style.removeProperty('border-radius');
    }

    // Collect all URLs to unblock: originalSrc, element.srcset, and picture sources
    const urlsToHydrate = new Set();
    if (originalSrc) urlsToHydrate.add(originalSrc);

    const ss = element.srcset || element.dataset.skelioOriginalSrcset || '';
    if (ss) {
      ss.split(',').forEach(part => {
        const u = part.trim().split(' ')[0];
        if (u && !u.startsWith('data:') && !u.startsWith('blob:')) {
          try { urlsToHydrate.add(new URL(u, window.location.href).href); } catch (e) { urlsToHydrate.add(u); }
        }
      });
    }

    const picture = element.closest('picture');
    if (picture) {
      const sources = picture.querySelectorAll('source');
      sources.forEach(source => {
        const s = source.srcset || source.getAttribute('srcset') || '';
        s.split(',').forEach(part => {
          const u = part.trim().split(' ')[0];
          if (u && !u.startsWith('data:') && !u.startsWith('blob:')) {
            try { urlsToHydrate.add(new URL(u, window.location.href).href); } catch (e) { urlsToHydrate.add(u); }
          }
        });
      });
    }

    // Await DNR allow rules for all associated URLs before setting src
    try {
      await sendToBackground({ action: 'HYDRATE_URLS', urls: Array.from(urlsToHydrate) });
    } catch (e) {
      try {
        await sendToBackground({ action: 'HYDRATE_URL', url: originalSrc });
      } catch (e2) {}
    }

    // Support YouTube and custom web component image containers
    const ytShadow = element.closest && element.closest('yt-img-shadow, yt-image, [id="thumbnail"]');
    if (ytShadow) {
      ytShadow.setAttribute('loaded', '');
      const innerShadow = ytShadow.querySelector('yt-img-shadow');
      if (innerShadow) innerShadow.setAttribute('loaded', '');
    }

    if (tag === 'IMG') {
      // Restore <picture> <source> srcsets
      if (picture && element.dataset.skelioPictureSrcsets) {
        try {
          const srcsets = JSON.parse(element.dataset.skelioPictureSrcsets);
          const sources = picture.querySelectorAll('source');
          sources.forEach((source, i) => {
            if (srcsets[i]) source.srcset = srcsets[i];
          });
        } catch (e) {}
      }

      // Restore img's own srcset if it had one
      if (element.dataset.skelioOriginalSrcset) {
        element.srcset = element.dataset.skelioOriginalSrcset;
      }

      // Restore lazy loading attributes so lazy-load scripts recognize the element
      if (element.dataset.skelioDataSrc) {
        element.setAttribute('data-src', element.dataset.skelioDataSrc);
      }
      if (element.dataset.skelioDataLazySrc) {
        element.setAttribute('data-lazy-src', element.dataset.skelioDataLazySrc);
      }
      if (element.dataset.skelioDataOriginal) {
        element.setAttribute('data-original', element.dataset.skelioDataOriginal);
      }

      element.onload = () => {
        element.style.setProperty('opacity', '1', 'important');
        element.title = '';
      };
      element.onerror = () => {
        element.style.setProperty('opacity', '1', 'important');
        // If image failed to load with originalSrc (e.g. browser negative cache), try cache-busting URL
        const sep = originalSrc.includes('?') ? '&' : '?';
        const cacheBustSrc = originalSrc + sep + 'skelio_cb=' + Date.now();
        if (element.src !== cacheBustSrc) {
          element.src = cacheBustSrc;
        }
      };

      element.src = originalSrc;
      element.classList.remove('lazyload');
      element.classList.add('lazyloaded');
      element.dispatchEvent(new Event('load', { bubbles: true }));

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

    // Apply clean system font stack gracefully without breaking icon fonts, symbols, or font weights
    fontStyleEl.textContent = `
      /* 1. Override all common CSS custom property font stacks */
      :root, html, body {
        --font-sans: ${SYSTEM_FONT_STACK} !important;
        --font-body: ${SYSTEM_FONT_STACK} !important;
        --font-display: ${SYSTEM_FONT_STACK} !important;
        --font-heading: ${SYSTEM_FONT_STACK} !important;
        --font-primary: ${SYSTEM_FONT_STACK} !important;
        --font-secondary: ${SYSTEM_FONT_STACK} !important;
        --font-family: ${SYSTEM_FONT_STACK} !important;
        --font-ui: ${SYSTEM_FONT_STACK} !important;
        --font-serif: ${SYSTEM_FONT_STACK} !important;
        --font-numeral: ${SYSTEM_FONT_STACK} !important;
        --font-geist-sans: ${SYSTEM_FONT_STACK} !important;
        --font-inter: ${SYSTEM_FONT_STACK} !important;
      }

      /* 2. Target text and content elements across all components with !important */
      body,
      p,
      h1, h2, h3, h4, h5, h6,
      li, td, th, label, input, textarea, select, button,
      blockquote, figcaption, article, section,
      div:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]),
      a:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]),
      span:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]):not([data-icon]) {
        font-family: ${SYSTEM_FONT_STACK} !important;
      }

      /* 3. Sleek lightweight styling signature for Light (300) */
      body, p, li, td, th, label,
      div:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]),
      span:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]):not([data-icon]),
      a:not([class*="icon"]):not([class*="material"]):not([class*="symbol"]):not([class*="fa"]):not([aria-hidden="true"]) {
        font-weight: 350;
      }

      /* Keep headings and emphasized text clear and readable */
      h1, h2, h3, h4, h5, h6,
      b, strong, [class*="bold"], [class*="title"], [class*="heading"] {
        font-weight: 600;
      }

      /* 4. Preserve monospace for code blocks */
      code, pre, kbd, samp, .font-mono, [class*="mono"] {
        font-family: Consolas, "Liberation Mono", Menlo, Monaco, monospace !important;
      }

      /* 5. Bulletproof shield for icon fonts, glyphs, and SVGs */
      i, svg,
      [class*="material"],
      [class*="icon"],
      [class*="fa-"],
      [class*="fa"],
      [class*="symbol"],
      [class*="glyph"],
      [class*="c2c"],
      [data-icon],
      [aria-hidden="true"],
      .material-icons,
      .material-symbols-outlined,
      .material-symbols-rounded,
      .material-symbols-sharp {
        font-family: revert !important;
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

    // Safe 3D & animation reduction — NEVER touch visibility, opacity, or layout of UI components
    threeDStyleEl.textContent = `
      /* 1. Stop continuous SVG and marquee animations */
      svg animate, svg animateTransform, svg animateMotion {
        display: none !important;
      }
      marquee {
        -webkit-marquee-repetition: 0 !important;
      }

      /* 2. Pause continuous spinning, flickering, or floating decorative animations */
      [class*="spin"], [class*="rotate"], [class*="pulse"], [class*="bounce"],
      .lantern__body, .lantern__glow, .lantern__beam, .lantern__bob {
        animation-play-state: paused !important;
      }

      /* 3. Hide continuous decorative particle overlays that consume heavy CPU/GPU */
      .drift__petal, .drift__lantern, .drift,
      .petals, .fireworks,
      .embers img, .wind__line {
        display: none !important;
      }

      /* 4. Disable mouse-interaction loops and set flat background ONLY for dedicated 3D model viewers */
      model-viewer, spline-viewer, babylon {
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
  // TRANSLUCENT UI SIMPLIFIER
  // Strips GPU-heavy backdrop blur, frosted glass, and translucent overlays
  // replacing them with clean, crisp, solid-contrast surfaces
  // ============================================================================

  let translucentStyleEl = null;

  function removeTranslucentUI() {
    if (!document.head && !document.documentElement) {
      requestAnimationFrame(removeTranslucentUI);
      return;
    }

    if (!translucentStyleEl) {
      translucentStyleEl = document.createElement('style');
      translucentStyleEl.id = 'skelio-translucent-simplifier';
      (document.body || document.documentElement || document.head).appendChild(translucentStyleEl);
    }

    // Detect dark theme
    const isDark = (
      document.documentElement.getAttribute('data-theme') === 'dark' ||
      document.documentElement.classList.contains('dark') ||
      document.body?.classList?.contains('dark') ||
      (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)
    );

    const solidCardBg = isDark ? '#1E1B2E' : '#FFFFFF';
    const solidCardActiveBg = isDark ? '#2D2744' : '#F8FAFC';
    const solidBorder = isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(0, 0, 0, 0.12)';

    translucentStyleEl.textContent = `
      /* Universal Translucent UI Removal (Zero GPU Compositing Blur) */
      html, html body, html body * {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        --tw-backdrop-blur: none !important;
        --tw-backdrop-brightness: none !important;
        --tw-backdrop-contrast: none !important;
        --tw-backdrop-grayscale: none !important;
        --tw-backdrop-hue-rotate: none !important;
        --tw-backdrop-invert: none !important;
        --tw-backdrop-opacity: none !important;
        --tw-backdrop-saturate: none !important;
        --tw-backdrop-sepia: none !important;
      }

      /* Solidify glassmorphic UI elements (cards, tiles, navigation, modals, dropdowns) */
      button.glass-tile, button[class*="glass"],
      .glass, .glass-tile, .glass-menu, .glass-active,
      [class*="glass-"], [class*="glass_"], [class*="-glass"],
      [class*="glassmorphism"], [class*="glass-card"], [class*="glass-panel"],
      [class*="backdrop-blur"], [class*="backdrop-filter"],
      nav[class*="backdrop"], header[class*="backdrop"],
      nav[class*="glass"], header[class*="glass"] {
        backdrop-filter: none !important;
        -webkit-backdrop-filter: none !important;
        background-image: none !important;
        background-color: ${solidCardBg} !important;
        border-color: ${solidBorder} !important;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12) !important;
      }

      /* Portal scene and design system CSS variable overrides (e.g. c2c.sh, Tailwind) */
      :root, [data-theme] {
        --petal-card-bg: ${solidCardBg} !important;
        --tile-bg: ${solidCardBg} !important;
        --tile-bg-active: ${solidCardActiveBg} !important;
        --sheet-bg: ${solidCardBg} !important;
        --roster-bg: ${solidCardBg} !important;
        --confirm-bg: ${solidCardBg} !important;
      }
    `;

    console.log('[SkelIO] Translucent UI removed -> solid high-contrast surfaces enabled');
  }

  function restoreTranslucentUI() {
    if (translucentStyleEl) {
      translucentStyleEl.remove();
      translucentStyleEl = null;
      console.log('[SkelIO] Translucent UI restored');
    }
  }

  // ============================================================================
  // CSS BACKGROUND IMAGE INTERCEPTION
  // ============================================================================

  function scanBackgroundImages() {
    // Exclude layout wrappers, navigation, forms, and interactive containers
    const EXCLUDED_TAGS = ['HEADER', 'NAV', 'MAIN', 'FORM', 'FOOTER', 'BODY', 'HTML', 'INPUT', 'BUTTON', 'A', 'SELECT', 'TEXTAREA'];
    const candidates = document.querySelectorAll('[style*="background"], [style*="background-image"]');

    let count = 0;
    for (let i = 0; i < candidates.length && count < 20; i++) {
      const el = candidates[i];
      if (!el || el.hasAttribute(SKELIO_BG_ATTR)) continue;
      if (EXCLUDED_TAGS.includes(el.tagName)) continue;
      // Skip interactive elements, accordions, buttons, cards, or non-interactive parallax layers
      if (el.hasAttribute('role') || el.hasAttribute('aria-expanded') || el.hasAttribute('aria-controls')) continue;
      const classStr = (el.className || '').toLowerCase();
      if (classStr.match(/plank|accordion|collapse|btn|button|card|tab|nav|item|ridge|hero|bar/)) continue;

      const comp = window.getComputedStyle(el);
      if (comp.pointerEvents === 'none') continue;

      // Skip if container has interactive children (forms, inputs, buttons, navigation links)
      if (el.querySelector && el.querySelector('input, button, select, textarea, form, nav, h1, h2, h3, a[href]')) {
        continue;
      }

      const bgImage = el.style.backgroundImage || (el.style.background && el.style.background.includes('url(') ? el.style.background : '');

      if (bgImage && bgImage.includes('url(') && !bgImage.startsWith('url("data:')) {
        const rect = el.getBoundingClientRect();
        if (rect.width >= 80 && rect.height >= 80) {
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
    element.style.backgroundImage = originalBg;

    // Send DNR allow rule in case background image was an external URL
    const urlMatch = originalBg.match(/url\(['"]?(.*?)['"]?\)/);
    if (urlMatch && urlMatch[1] && !urlMatch[1].startsWith('data:')) {
      sendToBackground({ action: 'HYDRATE_URL', url: urlMatch[1] }).catch(() => {});
    }

    console.log('[SkelIO] BG image hydrated');
    syncStats();
  }

  // ============================================================================
  // GLOBAL CLICK-TO-LOAD CAPTURE
  // Catches clicks anywhere on locked elements or locked background images
  // ============================================================================

  window.addEventListener('click', function globalHydrateCapture(e) {
    if (!isActive) return;

    const target = e.target;
    if (!target) return;

    // 1. Direct match: target is locked
    let lockedEl = (target.hasAttribute && target.hasAttribute(SKELIO_ATTR)) ? target : null;

    // 2. Target is inside a locked element
    if (!lockedEl && target.closest) {
      lockedEl = target.closest(`[${SKELIO_ATTR}]`);
    }

    // 3. Target is an overlay, badge, or container over a locked element
    if (!lockedEl && target.querySelector) {
      lockedEl = target.querySelector(`[${SKELIO_ATTR}]`);
    }

    // 4. Target is a sibling of a locked element inside a shared thumbnail/card wrapper
    if (!lockedEl && target.parentElement) {
      lockedEl = target.parentElement.querySelector(`[${SKELIO_ATTR}]`);
    }

    // 5. Target is inside a picture wrapper
    if (!lockedEl && target.closest && target.closest('picture')) {
      lockedEl = target.closest('picture').querySelector(`[${SKELIO_ATTR}]`);
    }

    // Background image lock check
    let bgLockedEl = (target.hasAttribute && target.hasAttribute(SKELIO_BG_ATTR)) ? target : null;
    if (!bgLockedEl && target.closest) {
      bgLockedEl = target.closest(`[${SKELIO_BG_ATTR}]`);
    }
    if (!bgLockedEl && target.querySelector) {
      bgLockedEl = target.querySelector(`[${SKELIO_BG_ATTR}]`);
    }
    if (!bgLockedEl && target.parentElement) {
      bgLockedEl = target.parentElement.querySelector(`[${SKELIO_BG_ATTR}]`);
    }

    // If an actual locked element or background was clicked:
    if (lockedEl && lockedEl.hasAttribute(SKELIO_ATTR)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('[SkelIO] Global capture click -> hydrating element:', lockedEl);
      hydrateElement(lockedEl);
      return;
    }

    if (bgLockedEl && bgLockedEl.hasAttribute(SKELIO_BG_ATTR)) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      console.log('[SkelIO] Global capture click -> hydrating bg:', bgLockedEl);
      hydrateBackgroundImage(bgLockedEl);
      return;
    }
  }, true);

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
      // Dynamic SPA Archetype Re-evaluation:
      // Single Page Applications (React, Next.js, Vite, Vue) start as empty shells (<div id="root"></div>)
      // Once components mount into the DOM, re-evaluate archetype from STANDARD to actual profile
      if (currentArchetype === ARCHETYPES.STANDARD) {
        const updatedArchetype = detectSiteArchetype();
        if (updatedArchetype !== ARCHETYPES.STANDARD) {
          currentArchetype = updatedArchetype;
          try {
            document.documentElement.setAttribute('data-skelio-archetype', currentArchetype);
          } catch (e) {}
          console.log(`[SkelIO] SPA mounted -> Upgraded archetype to: ${currentArchetype}`);

          if (currentArchetype === ARCHETYPES.SCROLL_SHOWCASE) {
            // Unsquish any scenic backdrop layers that were locked under standard mode
            const lockedElements = document.querySelectorAll(`[${SKELIO_ATTR}]`);
            lockedElements.forEach(el => {
              const isScenic = (
                el.getAttribute('aria-hidden') === 'true' ||
                el.dataset.skelioHadPointerEventsNone === 'true' ||
                (el.className && typeof el.className === 'string' && (el.className.includes('max-w-none') || el.className.includes('w-[')))
              );
              if (isScenic) {
                el.style.removeProperty('max-width');
                if (el.dataset.skelioHadPointerEventsNone === 'true') {
                  el.style.setProperty('pointer-events', 'none', 'important');
                }
              }
            });
          }
        }
      }

      for (const mutation of mutations) {
        if (mutation.type === 'childList') {
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue;

            // Lock media elements (ignore if element or parent container is hydrated)
            if (MEDIA_TARGETS.includes(node.tagName)) {
              if (!node.hasAttribute(SKELIO_HYDRATED_ATTR) && !(node.closest && node.closest(`[${SKELIO_HYDRATED_ATTR}]`))) {
                lockElement(node);
              }
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
                if (!targets[i].hasAttribute(SKELIO_HYDRATED_ATTR) && !(targets[i].closest && targets[i].closest(`[${SKELIO_HYDRATED_ATTR}]`))) {
                  lockElement(targets[i]);
                }
              }
            }
          }
        } else if (mutation.type === 'attributes') {
          const target = mutation.target;
          if (target.nodeType === 1 && MEDIA_TARGETS.includes(target.tagName)) {
            // NEVER re-lock an element that was hydrated by user or is inside a hydrated container
            if (target.hasAttribute(SKELIO_HYDRATED_ATTR) || (target.closest && target.closest(`[${SKELIO_HYDRATED_ATTR}]`))) {
              return;
            }
            if (target.hasAttribute(SKELIO_ATTR)) {
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

    currentArchetype = detectSiteArchetype();
    try {
      document.documentElement.setAttribute('data-skelio-archetype', currentArchetype);
    } catch (e) {}

    console.log(`[SkelIO] Activating with archetype: ${currentArchetype} (${window.location.hostname})...`);
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

    // Remove translucent UI: strip GPU-heavy backdrop-filter blur and frosted glass overlays
    removeTranslucentUI();

    // Lock existing elements
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', lockExistingElements, { once: true });
    } else {
      lockExistingElements();
    }

    // Setup observer for dynamically added elements
    setupObserver();

    console.log(`[SkelIO] Activated successfully [Profile: ${currentArchetype}]`);
  }

  async function deactivateSkelIO() {
    if (!isActive) return;

    console.log('[SkelIO] Deactivating...');
    isActive = false;
    try {
      document.documentElement.removeAttribute('data-skelio-archetype');
    } catch (e) {}

    // Disconnect MutationObserver
    if (observer) {
      observer.disconnect();
      observer = null;
    }

    // Restore web fonts
    restoreWebFonts();

    // Restore 3D backgrounds
    restore3DWebsites();

    // Restore translucent UI
    restoreTranslucentUI();

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
        restoreTranslucentUI();
        sendResponse({ simplified: false });
      } else {
        simplify3DWebsites();
        removeTranslucentUI();
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
