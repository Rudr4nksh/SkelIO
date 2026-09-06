/**
 * SkelIO Main World Interceptor
 * Runs in the page's execution context (MAIN world) to freeze 3D/WebGL animation loops
 * into crisp still images without breaking React, UI components, text, or buttons.
 */

(function() {
  'use strict';

  let isFrozen = false;
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
          if (count > 5) {
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
          if (count > 5) {
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

  function applyFreeze() {
    // 1. Finish entrance animations so text & buttons are 100% visible immediately,
    //    and pause infinite background loops into still frames.
    if (document.getAnimations) {
      document.getAnimations().forEach(anim => {
        try {
          // Finish one-shot animations (fade-in text, buttons)
          anim.finish();
        } catch (e) {
          // Infinite loop animations (pulsing backgrounds, 3D spinners) -> pause as still frame
          try { anim.pause(); } catch (err) {}
        }
      });
    }

    // 2. Pause videos so they stay as still frames
    document.querySelectorAll('video').forEach(v => {
      try {
        v.pause();
        v.removeAttribute('autoplay');
        v.removeAttribute('loop');
      } catch (e) {}
    });

    console.log('[SkelIO] 3D & animations frozen into still images — text and buttons preserved');
  }

  function applyResume() {
    // Reset draw counts so canvases can update if user wants to unfreeze
    canvasDrawCounts = new WeakMap();

    if (document.getAnimations) {
      document.getAnimations().forEach(anim => {
        try { anim.play(); } catch (e) {}
      });
    }
    console.log('[SkelIO] Animations resumed');
  }

  // Listen for freeze/unfreeze signals from content.js
  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.type !== 'SKELIO_FREEZE_ANIMATIONS') return;

    isFrozen = !!event.data.freeze;

    if (isFrozen) {
      applyFreeze();
      // Also apply once after microtask to catch elements rendered just after message
      setTimeout(applyFreeze, 100);
      setTimeout(applyFreeze, 500);
    } else {
      applyResume();
    }
  });

})();
