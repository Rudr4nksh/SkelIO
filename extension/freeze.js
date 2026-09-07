/**
 * SkelIO Main World Interceptor
 * Runs in the page's execution context (MAIN world) to freeze 3D/WebGL animation loops
 * into crisp still images without breaking React, UI components, text, or buttons.
 */

(function() {
  'use strict';

  let isFrozen = true; // Default to true as SkelIO runs active on load
  let canvasDrawCounts = new WeakMap();

  // Hook WebGL rendering to freeze continuous 3D loops after drawing initial still frame
  function hookWebGL(proto) {
    if (!proto) return;

    const origDrawArrays = proto.drawArrays;
    const origDrawElements = proto.drawElements;

    if (origDrawArrays) {
      proto.drawArrays = function(...args) {
        if (isFrozen) {
          const count = (canvasDrawCounts.get(this.canvas) || 0) + 1;
          canvasDrawCounts.set(this.canvas, count);
          if (count > 25) {
            // Scene has rendered — freeze at current frame as a still image!
            return;
          }
        }
        return origDrawArrays.apply(this, args);
      };
    }

    if (origDrawElements) {
      proto.drawElements = function(...args) {
        if (isFrozen) {
          const count = (canvasDrawCounts.get(this.canvas) || 0) + 1;
          canvasDrawCounts.set(this.canvas, count);
          if (count > 25) {
            // Scene has rendered — freeze at current frame as a still image!
            return;
          }
        }
        return origDrawElements.apply(this, args);
      };
    }
  }

  // Hook both WebGL 1 and WebGL 2
  try {
    if (window.WebGLRenderingContext) hookWebGL(window.WebGLRenderingContext.prototype);
    if (window.WebGL2RenderingContext) hookWebGL(window.WebGL2RenderingContext.prototype);
  } catch (e) {}

  function pauseAllAnimations() {
    if (!isFrozen) return;

    // 1. Pause Web Animations API (CSS animations & WAAPI)
    // ONLY target infinite looping animations, NEVER touch one-shot entrances or regular elements
    if (document.getAnimations) {
      try {
        const anims = document.getAnimations();
        for (let i = 0; i < anims.length; i++) {
          const anim = anims[i];
          try {
            const effect = anim.effect;
            const timing = effect ? effect.getTiming() : null;
            if (timing) {
              const isInfinite = timing.iterations === Infinity || timing.duration === Infinity || timing.iterations > 20;
              if (isInfinite) {
                anim.pause();
              }
            }
          } catch (e) {}
        }
      } catch (e) {}
    }

    // 2. Pause videos so they stay as crisp still frames
    const videos = document.querySelectorAll('video');
    for (let i = 0; i < videos.length; i++) {
      const v = videos[i];
      try {
        if (!v.paused) v.pause();
        v.removeAttribute('autoplay');
        v.removeAttribute('loop');
      } catch (e) {}
    }
  }

  function applyFreeze() {
    pauseAllAnimations();
    console.log('[SkelIO] Infinite animations frozen into still images — UI controls and menus preserved');
  }

  function applyResume() {
    canvasDrawCounts = new WeakMap();

    if (document.getAnimations) {
      try {
        document.getAnimations().forEach(anim => {
          try { anim.play(); } catch (e) {}
        });
      } catch (e) {}
    }
    console.log('[SkelIO] Animations resumed');
  }

  // Listen for freeze/unfreeze signals from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'SKELIO_FREEZE_ANIMATIONS') return;

    isFrozen = !!event.data.freeze;

    if (isFrozen) {
      applyFreeze();
    } else {
      applyResume();
    }
  });

  // Run freeze on load
  applyFreeze();

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      if (isFrozen) applyFreeze();
    }, { once: true });
  }
  window.addEventListener('load', () => {
    if (isFrozen) applyFreeze();
  }, { once: true });

})();

