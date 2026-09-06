# SkelIO Testing Guide

## Quick Test (Wikipedia Auto-Activation)

1. **Load Extension**
   ```bash
   # In Chrome, go to: chrome://extensions/
   # Enable "Developer mode"
   # Click "Load unpacked"
   # Select the SkelIO project folder
   ```

2. **Test on Wikipedia**
   - Navigate to: `https://en.wikipedia.org/wiki/Chrome_extension`
   - **Expected behavior:**
     - Images should be replaced with dark grey skeleton boxes
     - Text overlay: "REMOVED BY SKELIO" and "Click to load"
     - Animated shimmer effect on boxes
     - No layout shift when scrolling

3. **Test Hydration**
   - Click any skeleton box
   - **Expected:** Original image loads in place
   - Opacity animates from 0.5 to 1.0

4. **Check Stats**
   - Click SkelIO extension icon (top right)
   - **Expected stats:**
     - Layout Shifts Prevented: > 0
     - Resources Blocked: > 0
     - Bandwidth Saved: > 0 KB

## Debug Console Logs

Open DevTools (F12) and check Console for:
- `[SkelIO] Activated on Wikipedia (testing mode)`
- `[SkelIO] Locking N existing elements`
- `[SkelIO] Locked: IMG 300x200 https://...`
- `[SkelIO] Set IMG src to skeleton, length: ...`

## Common Issues

### Issue: Images still load normally
- **Check:** Extension is enabled in chrome://extensions/
- **Check:** Console shows `[SkelIO] Content script initializing...`
- **Check:** Hard refresh page (Ctrl+Shift+R)

### Issue: Grey boxes appear but no text overlay
- **Check:** SVG data URI length in console
- **Check:** Browser console for CSP violations

### Issue: Click doesn't hydrate
- **Check:** Console shows original src was stored
- **Check:** Click event listener attached

## Manual Activation (Any Site)

Add `?skelio` to any URL:
```
https://example.com?skelio
```

Or check network conditions:
- Open DevTools → Network tab → Throttling dropdown
- Select "Slow 3G"
- Refresh page — SkelIO should auto-activate
