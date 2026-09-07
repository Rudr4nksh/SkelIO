// ==========================================================================
// SkelIO Smooth Navigation & Page Transitions
// High-performance, app-like seamless page transitions across pages
// ==========================================================================

(function () {
  'use strict';

  // 1. Create or get Top Progress Bar
  let progressBar = document.getElementById('skelioProgressBar');
  if (!progressBar) {
    progressBar = document.createElement('div');
    progressBar.id = 'skelioProgressBar';
    progressBar.className = 'page-progress-bar';
    document.documentElement.appendChild(progressBar);
  }

  function setProgress(percent, opacity = 1) {
    if (!progressBar) return;
    progressBar.style.opacity = String(opacity);
    progressBar.style.width = percent + '%';
  }

  function resetProgress() {
    if (!progressBar) return;
    progressBar.style.opacity = '0';
    setTimeout(() => {
      if (progressBar.style.opacity === '0') {
        progressBar.style.width = '0%';
      }
    }, 220);
  }

  // Force browser to not restore scroll to bottom on fresh reload
  if ('scrollRestoration' in history) {
    history.scrollRestoration = 'manual';
  }

  // 2. Entrance Animation on Page Load
  window.addEventListener('DOMContentLoaded', () => {
    // Quick progress finish flare
    setProgress(100, 1);
    setTimeout(() => {
      resetProgress();
    }, 200);

    // If loaded without hash or with #home, ensure top of page
    if (!window.location.hash || window.location.hash === '#home' || window.location.hash === '#top') {
      window.scrollTo(0, 0);
    } else if (window.location.hash === '#contact') {
      // Clear residual #contact hash so page does not jump to bottom on refresh
      history.replaceState(null, '', window.location.pathname);
      window.scrollTo(0, 0);
    } else {
      setTimeout(() => {
        try {
          const target = document.querySelector(window.location.hash);
          if (target) {
            target.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
        } catch (e) {}
      }, 120);
    }
  });

  // 3. Back-Forward Cache (BFCache) Safety: Ensure page is never invisible when navigating via Back/Forward
  window.addEventListener('pageshow', (event) => {
    document.body.classList.remove('page-transition-exiting');
    resetProgress();
    isTransitioning = false;
  });

  let isTransitioning = false;

  // 4. Programmatic Navigation helper
  window.skelioNavigate = function (targetUrl) {
    if (isTransitioning || !targetUrl) return;
    isTransitioning = true;

    // Advance progress bar
    setProgress(35, 1);
    setTimeout(() => {
      if (isTransitioning) setProgress(75, 1);
    }, 70);

    // Apply exit transition
    document.body.classList.add('page-transition-exiting');

    setTimeout(() => {
      setProgress(98, 1);
      window.location.href = targetUrl;
    }, 190);
  };

  // Helper: check if target URL is the current HTML page
  function isCurrentPage(destUrlObj) {
    const current = new URL(window.location.href);
    const cleanPath = (p) => {
      let s = p.replace(/^\/([A-Za-z]:)/, '$1').toLowerCase();
      // Treat /index.html and / as equal
      s = s.replace(/\/index\.html$/, '/');
      return s;
    };
    return (
      destUrlObj.origin === current.origin &&
      cleanPath(destUrlObj.pathname) === cleanPath(current.pathname) &&
      destUrlObj.search === current.search
    );
  }

  // 5. Intercept Link Clicks for Internal Page Navigation
  document.addEventListener('click', (event) => {
    const link = event.target.closest('a');
    if (!link) return;

    // Ignore clicks with keyboard modifiers (Ctrl, Cmd, Shift, Alt) or middle clicks
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }

    const href = link.getAttribute('href');
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
      return;
    }

    // Ignore links with target="_blank" or download attribute
    if (link.getAttribute('target') === '_blank' || link.hasAttribute('download')) {
      return;
    }

    let urlObj;
    try {
      urlObj = new URL(link.href, window.location.href);
    } catch (e) {
      return;
    }

    // Allow external sites to open normally
    if (window.location.protocol === 'file:') {
      if (urlObj.protocol !== 'file:') return;
    } else {
      if (urlObj.origin !== window.location.origin) return;
    }

    // Check if link points to same page with hash (e.g. #how-it-works or index.html#how-it-works on index.html)
    if (isCurrentPage(urlObj) && urlObj.hash) {
      event.preventDefault();
      const hash = urlObj.hash;

      if (hash === '#home' || hash === '#top') {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        history.pushState(null, '', window.location.pathname);
      } else {
        const targetEl = document.querySelector(hash);
        if (targetEl) {
          targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
          history.pushState(null, '', hash);
        }
      }

      // Subtle tactile progress bar flash
      setProgress(100, 0.75);
      setTimeout(() => resetProgress(), 220);

      // Update active nav link
      document.querySelectorAll('.nav-link').forEach((nl) => {
        const nlHref = nl.getAttribute('href');
        if (nlHref === hash || nlHref === 'index.html' + hash || (hash === '#home' && (nlHref === 'index.html' || nlHref === '#home'))) {
          nl.classList.add('active');
        } else if (nlHref && (nlHref.startsWith('#') || nlHref.startsWith('index.html#'))) {
          nl.classList.remove('active');
        }
      });
      return;
    }

    // Check if link points to same page without hash (e.g. clicking Home while on index.html)
    if (isCurrentPage(urlObj) && !urlObj.hash) {
      event.preventDefault();
      window.scrollTo({ top: 0, behavior: 'smooth' });
      setProgress(100, 0.75);
      setTimeout(() => resetProgress(), 220);

      // Set active on home link
      document.querySelectorAll('.nav-link').forEach((nl) => {
        const nlHref = nl.getAttribute('href');
        if (nlHref === '#home' || nlHref === 'index.html' || nlHref === 'index.html#home') {
          nl.classList.add('active');
        } else if (nlHref && nlHref.startsWith('#')) {
          nl.classList.remove('active');
        }
      });
      return;
    }

    // Navigating to a different internal page (e.g. index.html -> dashboard.html or login.html)
    event.preventDefault();
    window.skelioNavigate(link.href);
  });

  // 6. Authentication UI Synchronization: only show Dashboard if user is logged in
  function syncAuthUI() {
    let profile = null;
    try {
      const stored = localStorage.getItem('skelio_user_profile');
      if (stored) profile = JSON.parse(stored);
    } catch (e) {}

    const isLoggedIn = !!(profile && (profile.loggedIn || profile.name));

    // Toggle all Dashboard navigation links
    document.querySelectorAll('.auth-only-dashboard, #navDashboardLink, #loginDashboardLink').forEach((el) => {
      el.style.display = isLoggedIn ? 'inline-flex' : 'none';
    });

    // Toggle navbar profile chip and login buttons on home page
    const loginBtn = document.getElementById('loginBtn');
    const signupBtn = document.getElementById('signupBtn');
    const userProfileChip = document.getElementById('userProfileChip');
    const homeSignOutBtn = document.getElementById('homeSignOutBtn');

    if (isLoggedIn) {
      if (loginBtn) loginBtn.style.display = 'none';
      if (signupBtn) signupBtn.style.display = 'none';
      if (userProfileChip) {
        userProfileChip.style.display = 'inline-flex';
        const avatar = document.getElementById('homeAvatarDot');
        const nameEl = document.getElementById('homeUserName');
        const planEl = document.getElementById('homeUserPlan');
        if (avatar) avatar.textContent = profile.initials || profile.name.slice(0, 2).toUpperCase();
        if (nameEl) nameEl.textContent = profile.name;
        if (planEl) planEl.textContent = profile.plan || 'PRO';
      }
      if (homeSignOutBtn) homeSignOutBtn.style.display = 'inline-flex';
    } else {
      if (loginBtn) loginBtn.style.display = '';
      if (signupBtn) signupBtn.style.display = '';
      if (userProfileChip) userProfileChip.style.display = 'none';
      if (homeSignOutBtn) homeSignOutBtn.style.display = 'none';
    }
  }

  // Handle Home Sign Out button
  document.addEventListener('click', (e) => {
    if (e.target && (e.target.id === 'homeSignOutBtn' || e.target.closest('#homeSignOutBtn'))) {
      e.preventDefault();
      localStorage.removeItem('skelio_user_profile');
      document.documentElement.removeAttribute('data-skelio-profile');
      try {
        if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.local) {
          chrome.storage.local.remove(['skelio_user_profile']);
        }
      } catch (err) {}
      syncAuthUI();
    }
  });

  // Sync auth on DOM load, pageshow, and whenever storage changes across tabs
  window.addEventListener('DOMContentLoaded', syncAuthUI);
  window.addEventListener('pageshow', syncAuthUI);
  window.addEventListener('storage', (e) => {
    if (e.key === 'skelio_user_profile') {
      syncAuthUI();
    }
  });

  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    syncAuthUI();
  }
})();

