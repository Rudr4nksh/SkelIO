# SkelIO

> Zero-auth, high-performance browser extension eliminating Cumulative Layout Shift (CLS) via geometry-locked SVG skeleton placeholders and smart network throttling.

---

## 📁 Project Structure

```text
SkelIO/
├── extension/          # Browser Extension (Manifest V3 for Chrome & Opera GX)
│   ├── manifest.json   # Extension metadata and permissions
│   ├── background.js   # Service worker & network interception (DNR)
│   ├── content.js      # On-page DOM geometry locking & font management
│   ├── freeze.js       # Main-world script pausing WebGL/3D loops
│   ├── popup.html      # Sleek offwhite-grey control popup
│   ├── popup.js        # Real-time speed measurement & popup logic
│   └── icons/          # Extension icons (16, 32, 48, 128px)
│
├── website/            # Landing page matching Figma design
│   ├── index.html      # Landing page HTML with semantic sections & SVGs
│   ├── style.css       # Styling, layout, animations & typography
│   └── script.js       # Interactive skeleton demo, modals, & handlers
```

---

## 🚀 How to Run

### 1. Launch the Website
Simply double-click or open [index.html](file:///c:/Users/RUDRANKSH%20PARIAL/Documents/Project/SkelIO/website/index.html) in any browser (Chrome, Opera GX, Edge, Firefox), or use VS Code's **Live Server** extension.

### 2. Loading the Extension into Your Browser
1. Open your browser's extensions page:
   - **Opera GX:** `opera://extensions`
   - **Chrome / Brave / Edge:** `chrome://extensions`
2. Enable **Developer Mode** (toggle in the top-right corner).
3. Click **Load unpacked**.
4. Select the **`extension`** folder (`c:\Users\RUDRANKSH PARIAL\Documents\Project\SkelIO\extension`).
5. The extension is now active and ready to test!
