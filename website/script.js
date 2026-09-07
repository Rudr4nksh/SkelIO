// SkelIO Website Interactive Script

document.addEventListener('DOMContentLoaded', () => {
  // 1. Interactive Skeleton Box Demo
  const heroPlaceholder1 = document.getElementById('heroPlaceholder1');
  const heroPlaceholder2 = document.getElementById('heroPlaceholder2');
  const phoneMediaCard = document.getElementById('phoneMediaCard');

  // Helper to toggle loaded state
  function setupInteractivePlaceholder(element, loadedHtml, originalHtml) {
    if (!element) return;
    let isLoaded = false;

    element.addEventListener('click', () => {
      isLoaded = !isLoaded;
      if (isLoaded) {
        element.style.opacity = '0.4';
        setTimeout(() => {
          element.innerHTML = loadedHtml;
          element.style.borderStyle = 'solid';
          element.style.borderColor = '#10B981';
          element.style.background = '#ECFDF5';
          element.style.opacity = '1';
        }, 180);
      } else {
        element.style.opacity = '0.4';
        setTimeout(() => {
          element.innerHTML = originalHtml;
          element.style.border = '';
          element.style.background = '';
          element.style.opacity = '1';
        }, 180);
      }
    });
  }

  // Hero Placeholder 1 (Mountain Image)
  if (heroPlaceholder1) {
    const orig1 = heroPlaceholder1.innerHTML;
    const loaded1 = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;padding:10px;text-align:center;">
        <svg viewBox="0 0 24 24" width="32" height="32" fill="#059669">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z"/>
        </svg>
        <span style="font-size:11px;font-weight:700;color:#065F46;">Loaded on demand!</span>
        <span style="font-size:9px;color:#047857;">(Click to reset)</span>
      </div>
    `;
    setupInteractivePlaceholder(heroPlaceholder1, loaded1, orig1);
  }

  // Hero Placeholder 2 (Video Player)
  if (heroPlaceholder2) {
    const orig2 = heroPlaceholder2.innerHTML;
    const loaded2 = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;width:100%;height:100%;text-align:center;">
        <svg viewBox="0 0 24 24" width="26" height="26" fill="#059669">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span style="font-size:10px;font-weight:700;color:#065F46;">Media Stream Active</span>
      </div>
    `;
    setupInteractivePlaceholder(heroPlaceholder2, loaded2, orig2);
  }

  // Phone Media Card & Button
  if (phoneMediaCard) {
    const origPhone = phoneMediaCard.innerHTML;
    const loadedPhone = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;width:100%;height:100%;text-align:center;">
        <svg viewBox="0 0 24 24" width="28" height="28" fill="#059669">
          <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
        </svg>
        <span style="font-size:10px;font-weight:800;color:#065F46;">MEDIA LOADED</span>
      </div>
    `;
    setupInteractivePlaceholder(phoneMediaCard, loadedPhone, origPhone);

    const phoneLoadBtn = document.getElementById('phoneLoadBtn');
    if (phoneLoadBtn) {
      phoneLoadBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        phoneMediaCard.click();
      });
    }
  }

  // Tablet Comparison Card (Card 2) - Click to load simulation for tablet skeleton
  const visualTablet = document.querySelector('.card-visual.visual-tablet');
  if (visualTablet) {
    const origTabletHtml = visualTablet.innerHTML;
    let tabletLoaded = false;
    visualTablet.style.cursor = 'pointer';
    visualTablet.setAttribute('title', 'Click to simulate loading tablet wireframes');

    visualTablet.addEventListener('click', () => {
      tabletLoaded = !tabletLoaded;
      visualTablet.style.opacity = '0.5';
      setTimeout(() => {
        if (tabletLoaded) {
          // Replace skeleton wireframes with vibrant loaded media cards in the tablet
          visualTablet.innerHTML = `
            <svg class="card-illustration" viewBox="0 0 180 120" fill="none">
              <rect x="18" y="14" width="144" height="92" rx="10" fill="#1E293B" stroke="#0F172A" stroke-width="2"/>
              <rect x="24" y="20" width="132" height="80" rx="6" fill="#FFFFFF"/>
              <line x1="24" y1="30" x2="156" y2="30" stroke="#E2E8F0" stroke-width="1"/>
              <circle cx="30" cy="25" r="1.5" fill="#EF4444"/>
              <circle cx="35" cy="25" r="1.5" fill="#F59E0B"/>
              <circle cx="40" cy="25" r="1.5" fill="#10B981"/>
              <rect x="52" y="23" width="70" height="4" rx="2" fill="#E2E8F0"/>
              <!-- Sidebar -->
              <rect x="30" y="36" width="22" height="58" rx="3" fill="#F1F5F9"/>
              <circle cx="41" cy="44" r="4" fill="#6366F1"/>
              <line x1="34" y1="54" x2="48" y2="54" stroke="#818CF8" stroke-width="2"/>
              <line x1="34" y1="62" x2="46" y2="62" stroke="#CBD5E1" stroke-width="2"/>
              <!-- 4 Loaded Content Cards with vibrant colors & icons -->
              <rect x="58" y="36" width="34" height="22" rx="4" fill="#D1FAE5"/>
              <circle cx="75" cy="47" r="4.5" fill="#10B981"/>
              <rect x="98" y="36" width="34" height="22" rx="4" fill="#EDE9FE"/>
              <circle cx="115" cy="47" r="4.5" fill="#8B5CF6"/>
              <!-- Lower 2 Wireframe Cards loaded -->
              <rect x="58" y="62" width="34" height="22" rx="4" fill="#E0F2FE"/>
              <circle cx="75" cy="73" r="4.5" fill="#0284C7"/>
              <rect x="98" y="62" width="34" height="22" rx="4" fill="#FEF3C7"/>
              <circle cx="115" cy="73" r="4.5" fill="#F59E0B"/>
              <!-- Content text lines -->
              <line x1="136" y1="40" x2="150" y2="40" stroke="#94A3B8" stroke-width="2"/>
              <line x1="136" y1="46" x2="148" y2="46" stroke="#94A3B8" stroke-width="2"/>
              <line x1="136" y1="66" x2="150" y2="66" stroke="#94A3B8" stroke-width="2"/>
              <line x1="136" y1="72" x2="146" y2="72" stroke="#94A3B8" stroke-width="2"/>
            </svg>
          `;
        } else {
          visualTablet.innerHTML = origTabletHtml;
        }
        visualTablet.style.opacity = '1';
      }, 160);
    });
  }

  // Interactive Card 1 & Card 3 feedback
  const visualFrustrated = document.querySelector('.card-visual.visual-frustrated');
  if (visualFrustrated) {
    visualFrustrated.style.cursor = 'pointer';
    visualFrustrated.setAttribute('title', 'Click to simulate SkelIO stabilizing layout');
    let fixed = false;
    visualFrustrated.addEventListener('click', () => {
      fixed = !fixed;
      visualFrustrated.style.transform = 'scale(0.97)';
      setTimeout(() => {
        visualFrustrated.style.transform = '';
        visualFrustrated.style.boxShadow = fixed ? 'inset 0 0 0 3px #10B981' : '';
      }, 150);
    });
  }

  const visualCalm = document.querySelector('.card-visual.visual-calm');
  if (visualCalm) {
    visualCalm.style.cursor = 'pointer';
    visualCalm.setAttribute('title', 'Click to simulate instant text reload');
    visualCalm.addEventListener('click', () => {
      visualCalm.style.transform = 'scale(0.97)';
      setTimeout(() => {
        visualCalm.style.transform = '';
      }, 150);
    });
  }

  // 2. Download Button Behavior
  const downloadBtn = document.getElementById('downloadBtn');
  if (downloadBtn) {
    downloadBtn.addEventListener('click', (e) => {
      e.preventDefault();
      showModal(
        'Get SkelIO Extension',
        `<p style="margin-bottom: 14px; font-size: 14px; color: #475569; line-height: 1.5;">
          SkelIO is open-source and ready to load directly in Chrome, Opera GX, Brave, or Edge:
         </p>
         <ol style="margin-left: 20px; margin-bottom: 20px; font-size: 13px; color: #334155; line-height: 1.7;">
           <li>Go to <code>chrome://extensions</code> (or <code>opera://extensions</code>) in your browser.</li>
           <li>Enable <strong>Developer mode</strong> in the top-right corner.</li>
           <li>Click <strong>Load unpacked</strong> and select the <code>extension</code> folder in this project.</li>
           <li>Pin SkelIO and browse with lightning speed!</li>
         </ol>
         <div style="display: flex; gap: 10px; justify-content: flex-end;">
           <button id="modalCloseBtn" style="padding: 9px 20px; border-radius: 9999px; background: #0F172A; color: #FFFFFF; font-size: 12px; font-weight: 700; border: none; cursor: pointer;">Got it!</button>
         </div>`
      );
    });
  }

  // 3. Interactive Plane & Pill Micro-Interactions in How It Works
  const planeInteractiveCard = document.getElementById('planeCard');
  if (planeInteractiveCard) {
    planeInteractiveCard.addEventListener('click', () => {
      planeInteractiveCard.style.transition = 'transform 0.8s cubic-bezier(0.34, 1.56, 0.64, 1)';
      planeInteractiveCard.style.transform = 'rotate(350deg) scale(1.22) translateY(-14px)';
      setTimeout(() => {
        planeInteractiveCard.style.transition = '';
        planeInteractiveCard.style.transform = '';
      }, 850);
    });
  }


  // 4. Contact Form Submission
  const contactSubmitBtn = document.getElementById('contactSubmitBtn');
  const contactEmail = document.getElementById('contactEmail');

  if (contactSubmitBtn && contactEmail) {
    contactSubmitBtn.addEventListener('click', () => {
      const email = contactEmail.value.trim();
      if (!email || !email.includes('@')) {
        alert('Please enter a valid email address.');
        contactEmail.focus();
        return;
      }

      contactSubmitBtn.textContent = 'Message Sent ✓';
      contactSubmitBtn.style.background = '#10B981';
      contactEmail.value = '';
      setTimeout(() => {
        contactSubmitBtn.textContent = 'Get in Touch';
        contactSubmitBtn.style.background = '#000000';
      }, 3500);
    });
  }

  // 5. Multi-Layered LERP Parallax Engine
  let targetScrollY = window.pageYOffset || 0;
  let currentScrollY = targetScrollY;
  let isTicking = false;

  const heroBlob = document.getElementById('heroBlob');
  const heroWifi = document.getElementById('heroWifi');
  const heroOndemand = document.getElementById('heroOndemand');
  const heroBrowser = document.getElementById('heroBrowser');
  const heroPills = document.getElementById('heroPills');
  const heroTerms = document.getElementById('heroTerms');
  const mainContainer = document.querySelector('.main-container');

  const howItWorksSection = document.getElementById('how-it-works');
  const parallaxBanner = document.getElementById('parallaxBanner');
  const parallaxCircles = document.querySelectorAll('.parallax-ambient-circle');
  const planeCard = document.getElementById('planeCard');

  const comparisonCardsSection = document.getElementById('comparisonCardsSection');
  const parallaxCards = document.querySelectorAll('.parallax-card');

  const networkPathCard = document.getElementById('networkPathCard');
  const userExpCard = document.getElementById('userExpCard');

  let isMouseOverCards = false;

  function updateParallax() {
    // Smooth LERP (Linear Interpolation) for buttery 60fps/120fps motion
    currentScrollY += (targetScrollY - currentScrollY) * 0.12;
    const scrollDiff = Math.abs(targetScrollY - currentScrollY);
    const vh = window.innerHeight;

    // A. Background Grid Vertical Drift
    if (mainContainer) {
      mainContainer.style.backgroundPositionY = `${(currentScrollY * 0.14) % 60}px`;
    }

    // B. Hero Multi-Layer Parallax (active when hero is in or near view)
    if (currentScrollY < vh * 1.5) {
      if (heroBlob) heroBlob.style.translate = `0px ${currentScrollY * 0.16}px`;
      if (heroBrowser) heroBrowser.style.translate = `0px ${currentScrollY * 0.07}px`;
      if (heroWifi) heroWifi.style.translate = `0px ${currentScrollY * -0.18}px`;
      if (heroOndemand) heroOndemand.style.translate = `0px ${currentScrollY * -0.22}px`;
      if (heroPills) heroPills.style.translate = `0px ${currentScrollY * 0.12}px`;
      if (heroTerms) heroTerms.style.translate = `0px ${currentScrollY * -0.15}px`;
    }

    // C. Standalone "How It Works" Section (100vh)
    if (howItWorksSection) {
      const bannerRect = howItWorksSection.getBoundingClientRect();
      if (bannerRect.top < vh && bannerRect.bottom > 0) {
        const bannerProgress = ((vh / 2) - (bannerRect.top + bannerRect.height / 2)) / (vh / 2);

        if (parallaxBanner) {
          parallaxBanner.style.translate = `0px ${bannerProgress * -28}px`;
        }
        if (planeCard) {
          planeCard.style.translate = `0px ${bannerProgress * -38}px`;
        }
        parallaxCircles.forEach((circle, idx) => {
          const factor = idx === 0 ? -45 : 45;
          circle.style.translate = `0px ${bannerProgress * factor}px`;
        });
      }
    }

    // D. Comparison Cards Parallax (when mouse is not actively tilting)
    if (comparisonCardsSection && !isMouseOverCards) {
      const cardsRect = comparisonCardsSection.getBoundingClientRect();
      if (cardsRect.top < vh && cardsRect.bottom > 0) {
        const cardProgress = ((vh / 2) - (cardsRect.top + cardsRect.height / 2)) / (vh / 2);

        parallaxCards.forEach((card) => {
          const depth = parseFloat(card.getAttribute('data-depth')) || 0.15;
          const shiftY = cardProgress * -32 * depth;
          card.style.translate = `0px ${shiftY}px`;
        });
      }
    }

    // E. Experience Section Parallax
    if (networkPathCard || userExpCard) {
      const expSection = document.querySelector('.experience-section');
      if (expSection) {
        const expRect = expSection.getBoundingClientRect();
        if (expRect.top < vh && expRect.bottom > 0) {
          const expProgress = ((vh / 2) - (expRect.top + expRect.height / 2)) / (vh / 2);
          if (networkPathCard) {
            networkPathCard.style.translate = `0px ${expProgress * -16}px`;
          }
          if (userExpCard) {
            userExpCard.style.translate = `0px ${expProgress * -28}px`;
          }
        }
      }
    }

    // Keep ticking if still catching up to scroll target
    if (scrollDiff > 0.4) {
      requestAnimationFrame(updateParallax);
    } else {
      isTicking = false;
    }
  }

  window.addEventListener('scroll', () => {
    targetScrollY = window.pageYOffset || document.documentElement.scrollTop;
    if (!isTicking) {
      requestAnimationFrame(updateParallax);
      isTicking = true;
    }
  }, { passive: true });

  // Initial trigger
  requestAnimationFrame(updateParallax);

  // Interactive Mouse Move Parallax for Cards Section
  if (comparisonCardsSection) {
    comparisonCardsSection.addEventListener('mouseenter', () => {
      if (window.innerWidth >= 960) {
        isMouseOverCards = true;
      }
    });

    comparisonCardsSection.addEventListener('mousemove', (e) => {
      if (window.innerWidth < 960) return;
      isMouseOverCards = true;
      const rect = comparisonCardsSection.getBoundingClientRect();
      const mouseX = (e.clientX - rect.left) / rect.width - 0.5;
      const mouseY = (e.clientY - rect.top) / rect.height - 0.5;

      parallaxCards.forEach((card) => {
        const depth = parseFloat(card.getAttribute('data-depth')) || 0.15;
        const tiltX = mouseY * -10 * depth;
        const tiltY = mouseX * 10 * depth;
        const moveX = mouseX * 22 * depth;
        const moveY = mouseY * 18 * depth;
        card.style.transform = `perspective(1000px) rotateX(${tiltX}deg) rotateY(${tiltY}deg) translate3d(${moveX}px, ${moveY}px, 0)`;
      });
    });

    comparisonCardsSection.addEventListener('mouseleave', () => {
      isMouseOverCards = false;
      parallaxCards.forEach((card) => {
        card.style.transform = '';
      });
      if (!isTicking) {
        requestAnimationFrame(updateParallax);
      }
    });
  }

  // 6. Scroll Reveal Observer for Cards and Sections
  const revealElements = document.querySelectorAll('.reveal-on-scroll');
  if ('IntersectionObserver' in window) {
    const revealObserver = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-revealed');
        }
      });
    }, {
      rootMargin: '0px 0px -50px 0px',
      threshold: 0.08
    });

    revealElements.forEach((el) => revealObserver.observe(el));
  } else {
    revealElements.forEach((el) => el.classList.add('is-revealed'));
  }

  // 7. Dark Mode Theme Controller
  const themeToggleBtn = document.getElementById('themeToggleBtn');
  const storedTheme = localStorage.getItem('skelio-theme');
  const systemPrefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  const initialTheme = storedTheme || (systemPrefersDark ? 'dark' : 'light');

  function applyTheme(theme) {
    if (theme === 'dark') {
      document.documentElement.setAttribute('data-theme', 'dark');
      if (themeToggleBtn) {
        themeToggleBtn.setAttribute('title', 'Switch to Light Mode');
      }
      localStorage.setItem('skelio-theme', 'dark');
    } else {
      document.documentElement.removeAttribute('data-theme');
      if (themeToggleBtn) {
        themeToggleBtn.setAttribute('title', 'Switch to Dark Mode');
      }
      localStorage.setItem('skelio-theme', 'light');
    }
  }

  // Apply initially
  applyTheme(initialTheme);

  if (themeToggleBtn) {
    themeToggleBtn.addEventListener('click', () => {
      const isCurrentlyDark = document.documentElement.getAttribute('data-theme') === 'dark';
      applyTheme(isCurrentlyDark ? 'light' : 'dark');
    });
  }

  // Listen for system color-scheme changes if no manual preference is saved
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
      if (!localStorage.getItem('skelio-theme')) {
        applyTheme(e.matches ? 'dark' : 'light');
      }
    });
  }

  // Helper Modal System
  function showModal(title, htmlContent) {
    let overlay = document.getElementById('skelio-modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'skelio-modal-overlay';
      overlay.style.cssText = `
        position: fixed;
        top: 0; left: 0; right: 0; bottom: 0;
        background: rgba(15, 23, 42, 0.72);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 99999;
        opacity: 0;
        transition: opacity 0.2s ease;
      `;
      document.body.appendChild(overlay);
    }

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const modalBg = isDark ? '#141D2E' : '#FFFFFF';
    const modalBorder = isDark ? '1px solid #26354D' : '1px solid #E2E8F0';
    const titleColor = isDark ? '#FFFFFF' : '#0F172A';

    overlay.innerHTML = `
      <div style="background: ${modalBg}; border: ${modalBorder}; border-radius: 16px; padding: 28px; max-width: 480px; width: 90%; box-shadow: 0 25px 50px -12px rgba(0,0,0,0.4); transform: scale(0.95); transition: transform 0.2s ease;">
        <h3 style="font-family: 'Plus Jakarta Sans', sans-serif; font-size: 20px; font-weight: 800; color: ${titleColor}; margin-bottom: 12px;">${title}</h3>
        ${htmlContent}
      </div>
    `;

    requestAnimationFrame(() => {
      overlay.style.opacity = '1';
      overlay.querySelector('div').style.transform = 'scale(1)';
    });

    const closeBtn = overlay.querySelector('#modalCloseBtn');
    const closeModal = () => {
      overlay.style.opacity = '0';
      overlay.querySelector('div').style.transform = 'scale(0.95)';
      setTimeout(() => {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      }, 200);
    };

    if (closeBtn) closeBtn.addEventListener('click', closeModal);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
  }
});
