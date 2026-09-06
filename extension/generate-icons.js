// Simple icon generator using Canvas API (Node.js)
const fs = require('fs');
const { createCanvas } = require('canvas');

function generateIcon(size, outputPath) {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');

  // Dark grey background
  ctx.fillStyle = '#1E1E1E';
  ctx.fillRect(0, 0, size, size);

  // White "S" letter
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `bold ${size * 0.6}px Arial`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('S', size / 2, size / 2);

  // Save to file
  const buffer = canvas.toBuffer('image/png');
  fs.writeFileSync(outputPath, buffer);
  console.log(`Generated ${outputPath}`);
}

const iconsDir = 'C:/Users/RUDRANKSH PARIAL/Documents/Project/SkelIO/icons';

generateIcon(16, `${iconsDir}/icon16.png`);
generateIcon(32, `${iconsDir}/icon32.png`);
generateIcon(48, `${iconsDir}/icon48.png`);
generateIcon(128, `${iconsDir}/icon128.png`);

console.log('All icons generated successfully!');
