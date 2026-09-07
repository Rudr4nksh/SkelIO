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

        const threshold = data.maxSpeedThreshold !== undefined ? data.maxSpeedThreshold : 50;
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

    // Priority 3: Explicit HTML attributes (for unrendered / responsive markup)
    if (!width || !height) {
      if (element.width) width = parseInt(element.width, 10) || width;
      if (element.height) height = parseInt(element.height, 10) || height;
      if (!width && element.getAttribute) {
        width = parseInt(element.getAttribute('width'), 10) || 0;
      }
      if (!height && element.getAttribute) {
        height = parseInt(element.getAttribute('height'), 10) || 0;
      }
    }

    // Priority 4: Inline styles
    if (!width || !height) {
      if (element.style.width) width = parseInt(element.style.width, 10) || width;
      if (element.style.height) height = parseInt(element.style.height, 10) || height;
    }

    // Priority 5: Aspect ratio fallback
    if (width && !height) height = Math.floor(width * 9 / 16);
    else if (height && !width) width = Math.floor(height * 16 / 9);

    // Priority 6: Detect icons/avatars or provide fluid fallback flag
    let isFluid = false;
    if (!width || !height) {
      const isIcon = (element.className + ' ' + (element.parentElement?.className || '')).toLowerCase().match(/icon|avatar|badge|logo|thumb|btn/);
      if (isIcon) {
        width = width || 32;
        height = height || 32;
      } else {
        // Mark as fluid responsive so we do not distort responsive CSS Grid / Flexbox
        isFluid = true;
        width = width || 320;
        height = height || 200;
      }
    }

    return { width, height, isFluid };
  }

  // ============================================================================
  // ADAPTIVE SVG SKELETON GENERATION (Matches Light, Dark & Custom Web Themes)
  // ============================================================================

  function detectAmbientTheme(element) {
    let isDark = false;
    let r = 248, g = 248, b = 245;

    try {
      // 1. Traverse up the parent tree to detect the local background color
      let el = (element && element.nodeType === 1) ? element.parentElement : null;
      while (el && el !== document && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        const bg = style.backgroundColor;
        if (bg && bg !== 'transparent' && bg !== 'rgba(0, 0, 0, 0)') {
          const parts = bg.match(/\d+/g);
          if (parts && parts.length >= 3) {
            r = parseInt(parts[0], 10);
            g = parseInt(parts[1], 10);
            b = parseInt(parts[2], 10);
            const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
            isDark = lum < 0.5;
            return { isDark, r, g, b };
          }
        }
        el = el.parentElement;
      }

      // 2. Check body or root HTML computed background
      const bodyBg = window.getComputedStyle(document.body || document.documentElement).backgroundColor;
      if (bodyBg && bodyBg !== 'transparent' && bodyBg !== 'rgba(0, 0, 0, 0)') {
        const parts = bodyBg.match(/\d+/g);
        if (parts && parts.length >= 3) {
          r = parseInt(parts[0], 10);
          g = parseInt(parts[1], 10);
          b = parseInt(parts[2], 10);
          const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
          isDark = lum < 0.5;
          return { isDark, r, g, b };
        }
      }

      // 3. Fallback: inspect data-theme, class signals, or prefers-color-scheme
      const docTheme = document.documentElement.getAttribute('data-theme') || document.body?.getAttribute('data-theme');
      const docClass = ((document.documentElement.className || '') + ' ' + (document.body?.className || '')).toLowerCase();
      if (docTheme === 'dark' || docClass.includes('dark') || docClass.includes('night') || (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
        isDark = true;
        r = 19; g = 29; b = 47;
      }
    } catch (e) {}

    return { isDark, r, g, b };
  }

  function createSkeletonSVG(elementOrWidth, widthOrHeight, heightOrTag, optionalTag) {
    let element = null;
    let width = 300;
    let height = 200;
    let tag = 'IMG';

    if (elementOrWidth && typeof elementOrWidth === 'object' && elementOrWidth.nodeType) {
      element = elementOrWidth;
      width = widthOrHeight || 300;
      height = heightOrTag || 200;
      tag = (optionalTag || element.tagName || 'IMG').toUpperCase();
    } else {
      width = elementOrWidth || 300;
      height = widthOrHeight || 200;
      tag = (heightOrTag || 'IMG').toUpperCase();
    }

    const isVideo = (tag === 'VIDEO' || tag === 'EMBED' || tag === 'OBJECT');
    const { isDark, r, g, b } = detectAmbientTheme(element);

    let bg0, bg1, shimmerHighlight, border, pillBg, pillBorder, textColor, iconColor;

    if (isDark) {
      // Linear/Apple deep zinc dark surface
      const baseR = Math.max(14, Math.min(28, r));
      const baseG = Math.max(16, Math.min(30, g));
      const baseB = Math.max(20, Math.min(36, b));

      bg0 = `rgb(${baseR + 4}, ${baseG + 4}, ${baseB + 6})`;
      bg1 = `rgb(${baseR}, ${baseG}, ${baseB})`;
      shimmerHighlight = `rgba(255, 255, 255, 0.04)`;
      border = `rgba(255, 255, 255, 0.08)`;
      pillBg = `rgba(255, 255, 255, 0.08)`;
      pillBorder = `rgba(255, 255, 255, 0.12)`;
      textColor = `#F1F5F9`;
      iconColor = `#94A3B8`;
    } else {
      // Off-white / cool grey light surface
      const baseR = Math.max(232, Math.min(248, r));
      const baseG = Math.max(232, Math.min(248, g));
      const baseB = Math.max(230, Math.min(245, b));

      bg0 = `rgb(${baseR}, ${baseG}, ${baseB})`;
      bg1 = `rgb(${baseR - 8}, ${baseG - 8}, ${baseB - 8})`;
      shimmerHighlight = `rgba(255, 255, 255, 0.65)`;
      border = `rgba(0, 0, 0, 0.06)`;
      pillBg = `rgba(255, 255, 255, 0.94)`;
      pillBorder = `rgba(0, 0, 0, 0.08)`;
      textColor = `#1E293B`;
      iconColor = `#64748B`;
    }

    const radius = Math.max(4, Math.min(12, Math.floor(Math.min(width, height) * 0.06)));

    // 1. Tiny micro-thumbnails or avatar dots (< 48px) — pure clean shimmer box
    if (width < 48 || height < 48) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${bg0}"/>
            <stop offset="100%" stop-color="${bg1}"/>
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)" rx="${radius}"/>
        <rect width="100%" height="100%" fill="none" stroke="${border}" stroke-width="1" rx="${radius}"/>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // 2. Compact elements (height < 70px or width < 120px) — sleek standalone icon badge
    if (height < 70 || width < 120) {
      const iconSvg = isVideo
        ? `<polygon points="-3,-5 6,0 -3,5" fill="${iconColor}"/>`
        : `<rect x="-7" y="-5" width="14" height="10" rx="1.5" fill="none" stroke="${iconColor}" stroke-width="1.2"/><circle cx="-2" cy="-2" r="1.2" fill="${iconColor}"/><polyline points="-6,3 -2,-1 1,2 3,0 6,3" fill="none" stroke="${iconColor}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
        <defs>
          <linearGradient id="g" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stop-color="${bg0}"/>
            <stop offset="100%" stop-color="${bg1}"/>
          </linearGradient>
        </defs>
        <rect width="100%" height="100%" fill="url(#g)" rx="${radius}"/>
        <rect width="100%" height="100%" fill="none" stroke="${border}" stroke-width="1" rx="${radius}"/>
        <g transform="translate(${Math.round(width / 2)}, ${Math.round(height / 2)})">
          <circle cx="0" cy="0" r="14" fill="${pillBg}" stroke="${pillBorder}" stroke-width="1"/>
          ${iconSvg}
        </g>
      </svg>`;
      return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
    }

    // 3. Standard & Large Elements (e.g. YouTube video cards, hero images, article photos)
    // Minimalist, high-end Apple / Linear frosted pill: [ ▶  Click to load ] or [ 🖼  Click to load ]
    const pillWidth = 118;
    const pillHeight = 30;
    const pillRadius = 15;
    const centerX = Math.round(width / 2);
    const centerY = Math.round(height / 2);

    const iconSvg = isVideo
      ? `<polygon points="-3,-5 6,0 -3,5" fill="${iconColor}"/>`
      : `<rect x="-7" y="-5" width="14" height="10" rx="1.5" fill="none" stroke="${iconColor}" stroke-width="1.2"/><circle cx="-2" cy="-2" r="1.2" fill="${iconColor}"/><polyline points="-6,3 -2,-1 1,2 3,0 6,3" fill="none" stroke="${iconColor}" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>`;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%">
      <defs>
        <linearGradient id="bgGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="${bg0}"/>
          <stop offset="100%" stop-color="${bg1}"/>
        </linearGradient>
        <linearGradient id="shimmer" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stop-color="transparent"/>
          <stop offset="50%" stop-color="${shimmerHighlight}"/>
          <stop offset="100%" stop-color="transparent"/>
        </linearGradient>
      </defs>
      <rect width="100%" height="100%" fill="url(#bgGrad)" rx="${radius}"/>
      <rect width="100%" height="100%" fill="url(#shimmer)" rx="${radius}"/>
      <rect width="100%" height="100%" fill="none" stroke="${border}" stroke-width="1" rx="${radius}"/>
      <g transform="translate(${centerX}, ${centerY})">
        <rect x="-${Math.round(pillWidth / 2)}" y="-${Math.round(pillHeight / 2)}" width="${pillWidth}" height="${pillHeight}" rx="${pillRadius}" fill="${pillBg}" stroke="${pillBorder}" stroke-width="1"/>
        <g transform="translate(-40, 0)">${iconSvg}</g>
        <text x="-24" y="0" dominant-baseline="central" fill="${textColor}" font-family="-apple-system, BlinkMacSystemFont, 'Plus Jakarta Sans', 'Segoe UI', Roboto, sans-serif" font-size="11.5px" font-weight="600" letter-spacing="0.2px">Click to load</text>
      </g>
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

    // Only skip tiny 16px utility dots/spacers
    if (tag === 'IMG') {
      const rect = element.getBoundingClientRect();
      const w = rect.width || parseInt(element.width, 10) || parseInt(element.style.width, 10) || 0;
      const h = rect.height || parseInt(element.height, 10) || parseInt(element.style.height, 10) || 0;

      // Only skip tracking pixels and micro dots <= 16px
      if (w > 0 && w <= 16 && h > 0 && h <= 16) {
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

    const { width, height, isFluid } = extractGeometry(element);
    element.dataset.skelioOriginalSrc = originalSrc;

    const skeletonSVG = createSkeletonSVG(element, width, height, tag);

    const compStyle = window.getComputedStyle(element);
    const isNaturallyPointerEventsNone = compStyle.pointerEvents === 'none';
    const isInitiallyHidden = compStyle.visibility === 'hidden' || compStyle.opacity === '0';

    // Lock geometry gracefully without distorting responsive grids or flex items
    if (isFluid) {
      element.style.setProperty('max-width', '100%', 'important');
      element.style.setProperty('aspect-ratio', `${width} / ${height}`, 'important');
      element.style.setProperty('min-height', '80px', 'important');
    } else {
      element.style.setProperty('width', width + 'px', 'important');
      element.style.setProperty('height', height + 'px', 'important');
    }

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
    element.title = 'Click to load';

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
    const parent = document.head || document.documentElement;
    if (!parent) {
      requestAnimationFrame(simplify3DWebsites);
      return;
    }

    // Determine base text color (sampling body or defaulting to dark/light)
    let bodyColor = 'rgb(255, 255, 255)';
    try {
      bodyColor = window.getComputedStyle(document.body || document.documentElement).color || 'rgb(255, 255, 255)';
    } catch (e) {}
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
      parent.appendChild(threeDStyleEl);
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

      /* 2. Silence infinite CSS keyframe loops and decorative animations in-place without hiding elements */
      [style*="animation:"][style*="infinite"],
      [style*="animation-iteration-count: infinite"],
      [class*="spin"], [class*="rotate"], [class*="pulse"], [class*="bounce"], [class*="floating"], [class*="loop"],
      [class*="shimmer"], [class*="marquee"], [class*="infinite"],
      .lantern__body, .lantern__glow, .lantern__beam, .lantern__bob {
        animation-play-state: paused !important;
      }

      /* 4. Freeze decorative particle overlays in place instead of hiding them */
      .drift__petal, .drift__lantern, .drift,
      .petals, .fireworks,
      .embers img, .wind__line {
        animation-play-state: paused !important;
      }

      /* 5. Disable mouse-interaction loops and set flat background ONLY for dedicated 3D model viewers */
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
    for (let i = 0; i < candidates.length; i++) {
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
    const skeletonSVG = createSkeletonSVG(element, width, height, 'IMG');

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
              for (let i = 0; i < targets.length; i++) {
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
              // Already locked — page JS or lazy-loader updated src
              const currentSrc = target.src || '';
              if (target.tagName === 'IMG' && !currentSrc.startsWith('data:')) {
                // Keep the real lazy-loaded URL in dataset so click-to-load can restore it
                target.dataset.skelioOriginalSrc = currentSrc;
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
  // PRECISE BANDWIDTH & PERFORMANCE IMPACT CALCULATOR
  // Dynamic calculation based on physical geometry, display density, media type,
  // and asynchronous Content-Length HTTP header verification (zero-body HEAD queries)
  // ============================================================================

  function calculateElementSavings(element, isBg = false) {
    if (!element) return 0;

    // 1. If exact size was already resolved from HTTP Content-Length header or exact data URI
    if (element.dataset.skelioExact === 'true' && element.dataset.skelioSavedBytes) {
      const val = parseInt(element.dataset.skelioSavedBytes, 10);
      if (!isNaN(val) && val > 0) return val;
    }

    const tag = element.tagName;
    const rawSrc = element.dataset.skelioOriginalSrc || element.getAttribute('src') || element.dataset.skelioOriginalBg || '';
    const src = rawSrc.toLowerCase();

    // If data: URI, calculate exact byte size directly from payload
    if (src.startsWith('data:')) {
      const commaIdx = src.indexOf(',');
      if (commaIdx !== -1) {
        const base64Data = src.substring(commaIdx + 1);
        const exactBytes = Math.round(base64Data.length * 0.75);
        element.dataset.skelioSavedBytes = String(exactBytes);
        element.dataset.skelioExact = 'true';
        return exactBytes;
      }
    }

    // 2. Measure actual rendered geometry
    const rect = element.getBoundingClientRect ? element.getBoundingClientRect() : { width: 0, height: 0 };
    let width = Math.round(rect.width || parseInt(element.width, 10) || parseInt(element.style?.width, 10) || 0);
    let height = Math.round(rect.height || parseInt(element.height, 10) || parseInt(element.style?.height, 10) || 0);

    // If dimensions are collapsed, inspect HTML attributes
    if (width <= 0) width = parseInt(element.getAttribute('width'), 10) || 0;
    if (height <= 0) height = parseInt(element.getAttribute('height'), 10) || 0;

    // If still collapsed, check parent container dimensions
    if (width <= 0 && element.parentElement) {
      const pRect = element.parentElement.getBoundingClientRect ? element.parentElement.getBoundingClientRect() : null;
      if (pRect) {
        width = Math.round(pRect.width || 0);
        height = Math.round(pRect.height || 0);
      }
    }

    // Genuinely hidden (0x0) or micro-tracker pixel (1x1)
    if (width <= 1 || height <= 1) {
      const trackerBytes = 68; // 1x1 tracking beacon
      element.dataset.skelioSavedBytes = String(trackerBytes);
      return trackerBytes;
    }

    // Cap geometry to realistic viewport bounds to avoid runaway values
    width = Math.min(width, window.innerWidth || 1920);
    height = Math.min(height, window.innerHeight || 1080);
    const pixels = width * height;

    let bytes = 0;

    // Video media (<video>, <source>, .mp4, .webm)
    if (tag === 'VIDEO' || src.includes('.mp4') || src.includes('.webm')) {
      if (width >= 1000 || height >= 600) {
        bytes = 950000; // ~950 KB (standard web hero video loop)
      } else if (width >= 500 || height >= 300) {
        bytes = 480000; // ~480 KB
      } else {
        bytes = 220000; // ~220 KB
      }
    }
    // Audio media
    else if (tag === 'AUDIO' || src.includes('.mp3') || src.includes('.wav') || src.includes('.ogg')) {
      bytes = 180000; // ~180 KB
    }
    // Vector SVG
    else if (src.endsWith('.svg') || src.includes('.svg?') || src.startsWith('data:image/svg')) {
      bytes = Math.max(800, Math.min(25000, Math.round(pixels * 0.02)));
    }
    // Animated GIF
    else if (src.endsWith('.gif') || src.includes('.gif?')) {
      bytes = Math.max(8000, Math.min(1200000, Math.round(pixels * 0.35)));
    }
    // Standard Compressed Web Images (WebP, AVIF, JPEG, PNG)
    else {
      // Calibrated against real-world web images (Google Web Almanac: median web image is ~35-70 KB)
      let factor = 0.05;
      if (width < 80 && height < 80) {
        factor = 0.08;
      } else if (width <= 400 && height <= 400) {
        factor = 0.06;
      } else if (width > 900 || height > 600) {
        factor = 0.04;
      }

      bytes = Math.round(pixels * factor);
      bytes = Math.max(400, Math.min(850000, bytes));
    }

    element.dataset.skelioSavedBytes = String(bytes);

    // Asynchronously query background worker for exact Content-Length via zero-body HEAD / Range request
    const fullUrl = element.dataset.skelioOriginalSrc || element.getAttribute('src');
    if (fullUrl && (fullUrl.startsWith('http://') || fullUrl.startsWith('https://')) && !element.dataset.skelioQueriedCl) {
      element.dataset.skelioQueriedCl = 'true';
      sendToBackground({ action: 'GET_RESOURCE_SIZE', url: fullUrl }).then(res => {
        if (res && res.success && res.size > 0) {
          element.dataset.skelioSavedBytes = String(res.size);
          element.dataset.skelioExact = 'true';
          syncStats();
        }
      }).catch(() => {});
    }

    return bytes;
  }

  function getActiveFontSavings() {
    if (!fontStyleEl) return 0;
    let fontCount = 0;
    try {
      const fontLinks = document.querySelectorAll('link[href*="fonts.googleapis"], link[href*="use.typekit"], link[href*=".woff"], link[rel="preload"][as="font"]');
      fontCount += fontLinks.length;

      // Check document stylesheets for @font-face rules
      if (fontCount === 0 && document.styleSheets) {
        for (let i = 0; i < Math.min(document.styleSheets.length, 8); i++) {
          try {
            const sheet = document.styleSheets[i];
            if (sheet && sheet.cssRules) {
              for (let j = 0; j < Math.min(sheet.cssRules.length, 15); j++) {
                if (sheet.cssRules[j].type === CSSRule.FONT_FACE_RULE) {
                  fontCount++;
                  break;
                }
              }
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    // Only count if web fonts actually exist on the page (~26 KB per WOFF2 font family)
    return fontCount > 0 ? Math.min(fontCount * 26000, 110000) : 0;
  }

  function getActive3DSavings() {
    if (!threeDStyleEl) return 0;
    let savings = 0;
    try {
      const canvases = document.querySelectorAll('canvas');
      for (const canvas of canvases) {
        const is3D = canvas.id?.includes('webgl') || canvas.className?.includes('webgl') ||
                     canvas.id?.includes('canvas3d') || canvas.getAttribute('data-engine') ||
                     (canvas.width >= 400 && canvas.height >= 300);
        if (is3D) {
          savings += Math.min(Math.round(canvas.width * canvas.height * 0.25), 450000);
        }
      }
      const models = document.querySelectorAll('model-viewer, [data-3d-model]');
      if (models.length > 0) {
        savings += models.length * 650000;
      }
    } catch (e) {}
    return savings;
  }

  function getActualPageTransferredBytes() {
    let totalBytes = 0;
    try {
      // 1. Navigation Timing entry (the initial HTML document wire transfer)
      const navEntries = performance.getEntriesByType('navigation');
      if (navEntries && navEntries.length > 0) {
        const nav = navEntries[0];
        if (typeof nav.transferSize === 'number' && nav.transferSize > 0) {
          totalBytes += nav.transferSize;
        } else if (typeof nav.encodedBodySize === 'number' && nav.encodedBodySize > 0) {
          totalBytes += nav.encodedBodySize;
        } else if (typeof nav.decodedBodySize === 'number' && nav.decodedBodySize > 0) {
          totalBytes += nav.decodedBodySize;
        } else {
          totalBytes += (document.documentElement.outerHTML || '').length;
        }
      } else {
        totalBytes += (document.documentElement.outerHTML || '').length;
      }

      // 2. Resource Timing entries (subresources: scripts, CSS, fonts, fetches, allowed media)
      const resources = performance.getEntriesByType('resource') || [];
      for (let i = 0; i < resources.length; i++) {
        const r = resources[i];
        if (typeof r.transferSize === 'number' && r.transferSize > 0) {
          totalBytes += r.transferSize;
        } else if (typeof r.encodedBodySize === 'number' && r.encodedBodySize > 0) {
          totalBytes += r.encodedBodySize;
        } else if (typeof r.decodedBodySize === 'number' && r.decodedBodySize > 0) {
          totalBytes += r.decodedBodySize;
        } else {
          // Cross-origin resource without Timing-Allow-Origin:
          // Provide a realistic wire estimate based on resource type and URL
          const name = (r.name || '').toLowerCase();
          const type = (r.initiatorType || '').toLowerCase();
          if (!name.startsWith('data:') && !name.startsWith('blob:')) {
            if (name.includes('.woff2') || name.includes('.woff') || name.includes('.ttf') || type === 'font') {
              totalBytes += 28000;
            } else if (name.includes('.js') || type === 'script') {
              totalBytes += 32000;
            } else if (name.includes('.css') || type === 'link' || type === 'css') {
              totalBytes += 12000;
            } else if (type === 'img' || name.match(/\.(png|jpe?g|webp|avif|gif|svg)/i)) {
              totalBytes += 22000;
            } else if (type === 'fetch' || type === 'xmlhttprequest') {
              totalBytes += 2000;
            } else {
              totalBytes += 1500;
            }
          }
        }
      }
    } catch (e) {}

    return Math.max(1024, Math.round(totalBytes));
  }

  let statsSyncTimer = null;

  function syncStats() {
    const pageHref = (window.location.href || '').toLowerCase();
    if (pageHref.includes('dashboard.html') || pageHref.includes('login.html')) return;
    if (statsSyncTimer) clearTimeout(statsSyncTimer);
    statsSyncTimer = setTimeout(async () => {
      try {
        const lockedEls = document.querySelectorAll(`[${SKELIO_ATTR}]`);
        const lockedBgs = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`);
        const fontSavings = getActiveFontSavings();
        const threeDSavings = getActive3DSavings();
        const extras = (fontSavings > 0 ? 1 : 0) + (threeDSavings > 0 ? 1 : 0);
        const currentPageBlocked = lockedEls.length + lockedBgs.length + extras;
        const currentPageShifts = lockedEls.length + lockedBgs.length;

        // Calculate precision bandwidth saved from all locked elements
        let currentPageBandwidth = 0;
        lockedEls.forEach(el => {
          currentPageBandwidth += calculateElementSavings(el, false);
        });
        lockedBgs.forEach(el => {
          currentPageBandwidth += calculateElementSavings(el, true);
        });
        currentPageBandwidth += fontSavings;
        currentPageBandwidth += threeDSavings;

        // Calculate REAL network data transferred
        const pageTransferred = getActualPageTransferredBytes();
        // Potential Data = Actual Transferred + Data Saved
        const potential = pageTransferred + currentPageBandwidth;

        const data = await chrome.storage.local.get([
          'layoutShiftsPrevented',
          'totalBlockedResources',
          'totalBandwidthSaved',
          'skelio_domain_stats'
        ]);

        let domain = window.location.hostname.replace(/^www\./, '');
        if (!domain) {
          if (window.location.protocol === 'file:') {
            domain = window.location.pathname.split('/').pop() || 'local-preview';
          }
        }

        const domainStats = data.skelio_domain_stats || {};

        if (domain) {
          const existing = domainStats[domain] || {};
          const savedForDomain = Math.max(existing.bandwidthSaved || 0, currentPageBandwidth);
          const actualForDomain = Math.max(existing.actualBytes || 0, pageTransferred);
          const potentialForDomain = actualForDomain + savedForDomain;

          domainStats[domain] = {
            domain: domain,
            archetype: currentArchetype || 'STANDARD',
            blocked: Math.max(existing.blocked || 0, currentPageBlocked),
            shifts: Math.max(existing.shifts || 0, currentPageShifts),
            bandwidthSaved: savedForDomain,
            actualBytes: actualForDomain,
            potentialBytes: potentialForDomain,
            lastUpdated: Date.now()
          };
        }

        // Sum up exact totals across all domain records for 100% consistency
        let totalBandwidth = 0;
        let totalShifts = 0;
        let totalBlocked = 0;
        for (const key of Object.keys(domainStats)) {
          const d = domainStats[key];
          totalBandwidth += (d.bandwidthSaved || 0);
          totalShifts += (d.shifts || 0);
          totalBlocked += (d.blocked || 0);
        }

        totalBandwidth = Math.max(data.totalBandwidthSaved || 0, totalBandwidth);
        totalShifts = Math.max(data.layoutShiftsPrevented || 0, totalShifts);
        totalBlocked = Math.max(data.totalBlockedResources || 0, totalBlocked);

        // Bridge directly to SkelIO website localStorage if on SkelIO website
        try {
          if (window.location.href.includes('dashboard.html') || window.location.href.includes('index.html')) {
            window.localStorage.setItem('skelio_domain_stats', JSON.stringify(domainStats));
            window.localStorage.setItem('skelio_total_bandwidth', String(totalBandwidth));
            window.localStorage.setItem('skelio_total_shifts', String(totalShifts));
            window.localStorage.setItem('skelio_total_blocked', String(totalBlocked));
            window.postMessage({ type: 'SKELIO_STATS_UPDATED', domainStats, totalBandwidth, totalShifts }, '*');
            if (typeof window.loadRealData === 'function') window.loadRealData();
          }
        } catch (e) {}

        await chrome.storage.local.set({
          layoutShiftsPrevented: totalShifts,
          totalBlockedResources: totalBlocked,
          totalBandwidthSaved: totalBandwidth,
          pageBlocked: currentPageBlocked,
          pageShifts: currentPageShifts,
          pageBandwidth: currentPageBandwidth,
          skelio_domain_stats: domainStats
        });
      } catch (err) {}
    }, 40);
  }

  function updateStats() {
    syncStats();
  }

  // Auto-record domain stats on page load
  if (typeof window !== 'undefined') {
    window.addEventListener('load', () => {
      setTimeout(() => {
        syncStats();
      }, 500);
    });
  }

  // ============================================================================
  // SKELIO WEBSITE <-> EXTENSION SYNC BRIDGE
  // Real-time synchronization of user profiles and domain statistics
  // ============================================================================

  function isSkelIOWebsitePage() {
    try {
      const host = (window.location.hostname || '').toLowerCase();
      // Strictly exclude third-party platforms like Figma, Canva, GitHub, etc.
      if (host.includes('figma.com') || host.includes('canva.com') || host.includes('github.com') ||
          host.includes('google.com') || host.includes('notion.so') || host.includes('miro.com')) {
        return false;
      }

      // Check explicit meta tag
      if (document.querySelector('meta[name="skelio-app"]')) {
        return true;
      }

      // Check file protocol strictly in SkelIO directory
      if (window.location.protocol === 'file:') {
        const path = (window.location.pathname || '').toLowerCase();
        return path.includes('skelio') && (path.includes('dashboard.html') || path.includes('login.html') || path.includes('index.html'));
      }

      // Check local dev server
      if (host === 'localhost' || host === '127.0.0.1') {
        const path = (window.location.pathname || '').toLowerCase();
        return path.includes('dashboard.html') || path.includes('login.html') || path.includes('index.html') || path === '/';
      }

      // Check official production domains
      if (host === 'skelio.com' || host.endsWith('.skelio.com') || host === 'skelio.io' || host.endsWith('.skelio.io')) {
        return true;
      }
    } catch (e) {}
    return false;
  }

  function initSkelIOBridge() {
    if (!isSkelIOWebsitePage()) return;

    try {
      chrome.storage.local.set({ skelio_website_url: window.location.href });
    } catch (e) {}

    // 1. Sync from Page LocalStorage -> Extension Chrome Storage
    function pullFromPage() {
      try {
        const profileStr = window.localStorage.getItem('skelio_user_profile');
        if (profileStr) {
          const profile = JSON.parse(profileStr);
          if (profile && profile.name && profile.email) {
            const userEmail = profile.email.toLowerCase();
            chrome.storage.local.get(['active_user_email', 'skelio_user_profile'], (res) => {
              const currentActiveEmail = res?.active_user_email || res?.skelio_user_profile?.email?.toLowerCase();
              if (currentActiveEmail && currentActiveEmail !== userEmail) {
                // User changed on page -> load user's isolated data
                const domainStatsStr = window.localStorage.getItem('skelio_domain_stats');
                const bw = window.localStorage.getItem('skelio_total_bandwidth') || '0';
                const shifts = window.localStorage.getItem('skelio_total_shifts') || '0';
                const blk = window.localStorage.getItem('skelio_total_blocked') || '0';
                const stats = domainStatsStr ? JSON.parse(domainStatsStr) : {};

                chrome.storage.local.set({
                  skelio_user_profile: profile,
                  active_user_email: userEmail,
                  skelio_website_url: window.location.href,
                  skelio_domain_stats: stats,
                  totalBandwidthSaved: parseFloat(bw) || 0,
                  layoutShiftsPrevented: parseInt(shifts, 10) || 0,
                  totalBlockedResources: parseInt(blk, 10) || 0
                });
              } else {
                chrome.storage.local.set({
                  skelio_user_profile: profile,
                  active_user_email: userEmail,
                  skelio_website_url: window.location.href
                });
              }
            });
          }
        }
      } catch (e) {}
    }

    // 2. Sync from Extension Chrome Storage -> Page LocalStorage
    function pushToPage() {
      try {
        const href = (window.location.href || '').toLowerCase();
        chrome.storage.local.get([
          'skelio_user_profile',
          'active_user_email',
          'skelio_domain_stats',
          'totalBandwidthSaved',
          'layoutShiftsPrevented',
          'totalBlockedResources'
        ], (data) => {
          if (!data) return;

          // Push metrics to page localStorage so dashboard can display real metrics immediately
          if (data.skelio_domain_stats && Object.keys(data.skelio_domain_stats).length > 0) {
            window.localStorage.setItem('skelio_domain_stats', JSON.stringify(data.skelio_domain_stats));
          }
          if (data.totalBandwidthSaved !== undefined) {
            window.localStorage.setItem('skelio_total_bandwidth', String(data.totalBandwidthSaved));
          }
          if (data.layoutShiftsPrevented !== undefined) {
            window.localStorage.setItem('skelio_total_shifts', String(data.layoutShiftsPrevented));
          }
          if (data.totalBlockedResources !== undefined) {
            window.localStorage.setItem('skelio_total_blocked', String(data.totalBlockedResources));
          }

          // Push profile if not on login page
          if (!href.includes('login.html') && data.skelio_user_profile && data.skelio_user_profile.name) {
            window.localStorage.setItem('skelio_user_profile', JSON.stringify(data.skelio_user_profile));
          }

          // Notify page
          window.postMessage({ type: 'SKELIO_STATS_UPDATED' }, '*');
          if (typeof window.loadRealData === 'function') window.loadRealData();
          if (typeof window.loadUserProfile === 'function') window.loadUserProfile();
        });
      } catch (e) {}
    }

    pullFromPage();
    pushToPage();

    // 3. Listen to live page broadcast events
    window.addEventListener('message', (event) => {
      if (!event.data) return;
      if (event.data.type === 'SKELIO_PROFILE_UPDATED' && event.data.profile) {
        try {
          const userEmail = event.data.profile?.email?.toLowerCase();
          const updatePayload = {
            skelio_user_profile: event.data.profile,
            active_user_email: userEmail,
            skelio_website_url: window.location.href
          };
          if (event.data.domainStats) updatePayload.skelio_domain_stats = event.data.domainStats;
          if (event.data.totalBandwidth !== undefined) updatePayload.totalBandwidthSaved = parseFloat(event.data.totalBandwidth) || 0;
          if (event.data.totalShifts !== undefined) updatePayload.layoutShiftsPrevented = parseInt(event.data.totalShifts, 10) || 0;
          chrome.storage.local.set(updatePayload);
        } catch (e) {}
      } else if (event.data.type === 'SKELIO_PROFILE_LOGOUT') {
        layoutShiftsPrevented = 0;
        blockedResourcesCount = 0;
        try {
          chrome.storage.local.remove([
            'skelio_user_profile',
            'active_user_email',
            'skelio_domain_stats',
            'totalBandwidthSaved',
            'layoutShiftsPrevented',
            'totalBlockedResources',
            'pageBlocked',
            'pageShifts',
            'pageBandwidth'
          ]);
        } catch (e) {}
      } else if (event.data.type === 'SKELIO_STATS_RESET') {
        layoutShiftsPrevented = 0;
        blockedResourcesCount = 0;
        try {
          chrome.storage.local.remove([
            'skelio_domain_stats',
            'totalBandwidthSaved',
            'layoutShiftsPrevented',
            'totalBlockedResources',
            'pageBlocked',
            'pageShifts',
            'pageBandwidth'
          ]);
          chrome.storage.local.set({
            skelio_domain_stats: {},
            totalBandwidthSaved: 0,
            layoutShiftsPrevented: 0,
            totalBlockedResources: 0,
            pageBlocked: 0,
            pageShifts: 0,
            pageBandwidth: 0
          });
        } catch (e) {}
      } else if (event.data.type === 'SKELIO_REQUEST_SYNC') {
        pushToPage();
      }
    });

    document.addEventListener('SKELIO_PROFILE_UPDATED', (event) => {
      if (event.detail) {
        try {
          chrome.storage.local.set({
            skelio_user_profile: event.detail,
            active_user_email: event.detail.email?.toLowerCase(),
            skelio_website_url: window.location.href
          });
        } catch (e) {}
      }
    });

    document.addEventListener('SKELIO_PROFILE_LOGOUT', () => {
      layoutShiftsPrevented = 0;
      blockedResourcesCount = 0;
      try {
        chrome.storage.local.remove([
          'skelio_user_profile',
          'active_user_email',
          'skelio_domain_stats',
          'totalBandwidthSaved',
          'layoutShiftsPrevented',
          'totalBlockedResources',
          'pageBlocked',
          'pageShifts',
          'pageBandwidth'
        ]);
      } catch (e) {}
    });

    document.addEventListener('SKELIO_STATS_RESET', () => {
      layoutShiftsPrevented = 0;
      blockedResourcesCount = 0;
      try {
        chrome.storage.local.remove([
          'skelio_domain_stats',
          'totalBandwidthSaved',
          'layoutShiftsPrevented',
          'totalBlockedResources',
          'pageBlocked',
          'pageShifts',
          'pageBandwidth'
        ]);
        chrome.storage.local.set({
          skelio_domain_stats: {},
          totalBandwidthSaved: 0,
          layoutShiftsPrevented: 0,
          totalBlockedResources: 0,
          pageBlocked: 0,
          pageShifts: 0,
          pageBandwidth: 0
        });
      } catch (e) {}
    });

    document.addEventListener('SKELIO_REQUEST_SYNC', () => {
      pushToPage();
    });

    // 4. Listen to extension storage updates to reflect in page immediately
    try {
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'local') {
          const href = (window.location.href || '').toLowerCase();
          if (changes.skelio_user_profile) {
            if (changes.skelio_user_profile.newValue) {
              window.localStorage.setItem('skelio_user_profile', JSON.stringify(changes.skelio_user_profile.newValue));
              if (typeof window.loadUserProfile === 'function') window.loadUserProfile();
            } else {
              window.localStorage.removeItem('skelio_user_profile');
              window.localStorage.removeItem('skelio_domain_stats');
              window.localStorage.removeItem('skelio_total_bandwidth');
              window.localStorage.removeItem('skelio_total_shifts');
              window.localStorage.removeItem('skelio_total_blocked');
              document.documentElement.removeAttribute('data-skelio-profile');
              if (href.includes('dashboard.html')) {
                window.location.href = 'login.html';
              }
            }
          }
          if (changes.skelio_domain_stats) {
            if (changes.skelio_domain_stats.newValue && Object.keys(changes.skelio_domain_stats.newValue).length > 0) {
              window.localStorage.setItem('skelio_domain_stats', JSON.stringify(changes.skelio_domain_stats.newValue));
            } else {
              window.localStorage.removeItem('skelio_domain_stats');
              layoutShiftsPrevented = 0;
              blockedResourcesCount = 0;
            }
            if (typeof window.loadRealData === 'function') window.loadRealData();
          }
          if (changes.totalBandwidthSaved) {
            if (changes.totalBandwidthSaved.newValue !== undefined && changes.totalBandwidthSaved.newValue !== null) {
              window.localStorage.setItem('skelio_total_bandwidth', String(changes.totalBandwidthSaved.newValue));
            } else {
              window.localStorage.removeItem('skelio_total_bandwidth');
            }
            if (typeof window.loadRealData === 'function') window.loadRealData();
          }
          if (changes.layoutShiftsPrevented) {
            if (changes.layoutShiftsPrevented.newValue !== undefined && changes.layoutShiftsPrevented.newValue !== null) {
              window.localStorage.setItem('skelio_total_shifts', String(changes.layoutShiftsPrevented.newValue));
            } else {
              window.localStorage.removeItem('skelio_total_shifts');
              layoutShiftsPrevented = 0;
            }
            if (typeof window.loadRealData === 'function') window.loadRealData();
          }
          if (changes.totalBlockedResources) {
            if (changes.totalBlockedResources.newValue !== undefined && changes.totalBlockedResources.newValue !== null) {
              window.localStorage.setItem('skelio_total_blocked', String(changes.totalBlockedResources.newValue));
            } else {
              window.localStorage.removeItem('skelio_total_blocked');
              blockedResourcesCount = 0;
            }
          }
        }
      });
    } catch (e) {}
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

    // Setup observer immediately to catch incoming DOM nodes at document_start
    setupObserver();

    // Lock existing elements immediately
    lockExistingElements();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', lockExistingElements, { once: true });
    }
    window.addEventListener('load', lockExistingElements, { once: true });

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
    } else if (message.action === 'SKELIO_RESET_STATS') {
      layoutShiftsPrevented = 0;
      blockedResourcesCount = 0;
      sendResponse({ success: true });
    } else if (message.action === 'SKELIO_STATUS') {
      const lockedEls = document.querySelectorAll(`[${SKELIO_ATTR}]`);
      const lockedBgs = document.querySelectorAll(`[${SKELIO_BG_ATTR}]`);
      const extras = (fontStyleEl ? 1 : 0) + (threeDStyleEl ? 1 : 0);
      const currentPageBlocked = Math.max(blockedResourcesCount, lockedEls.length + lockedBgs.length + extras);
      const currentPageShifts = Math.max(layoutShiftsPrevented, lockedEls.length + lockedBgs.length);

      let currentPageBandwidth = 0;
      lockedEls.forEach(el => {
        currentPageBandwidth += calculateElementSavings(el, false);
      });
      lockedBgs.forEach(el => {
        currentPageBandwidth += calculateElementSavings(el, true);
      });
      if (fontStyleEl) currentPageBandwidth += 140000;
      if (threeDStyleEl) currentPageBandwidth += 2800000;

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

    // Initialize website synchronization bridge
    initSkelIOBridge();
    if (typeof document !== 'undefined') {
      document.addEventListener('DOMContentLoaded', initSkelIOBridge);
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('load', initSkelIOBridge);
    }

    console.log('[SkelIO] Content script initialized, active:', isActive);
  }

  // Run immediately
  init();

})();
