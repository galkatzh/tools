#!/usr/bin/env node
// Icon generator script for Expense Report PWA
// Run with: node generate-icons.js

const fs = require('fs');
const path = require('path');

// Simple SVG icon template
function createSVGIcon(size) {
    const radius = size * 0.2;
    const docWidth = size * 0.4;
    const docHeight = size * 0.5;
    const docX = (size - docWidth) / 2;
    const docY = (size - docHeight) / 2 - size * 0.02;
    const foldSize = size * 0.1;
    const strokeWidth = Math.max(2, size * 0.03);
    const fontSize = size * 0.15;
    const dollarY = size / 2 + size * 0.08;

    return `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2563eb"/>
      <stop offset="100%" style="stop-color:#1d4ed8"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${radius}" fill="url(#bg)"/>
  <g fill="none" stroke="white" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
    <path d="M${docX},${docY} L${docX + docWidth - foldSize},${docY} L${docX + docWidth},${docY + foldSize} L${docX + docWidth},${docY + docHeight} L${docX},${docY + docHeight} Z"/>
    <path d="M${docX + docWidth - foldSize},${docY} L${docX + docWidth - foldSize},${docY + foldSize} L${docX + docWidth},${docY + foldSize}"/>
  </g>
  <text x="${size / 2}" y="${dollarY}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">$</text>
</svg>`;
}

const iconsDir = path.join(__dirname, 'icons');
const sizes = [72, 96, 128, 144, 152, 192, 384, 512];

// Ensure icons directory exists
if (!fs.existsSync(iconsDir)) {
    fs.mkdirSync(iconsDir, { recursive: true });
}

// Generate SVG icons
sizes.forEach(size => {
    const svg = createSVGIcon(size);
    const filename = path.join(iconsDir, `icon-${size}.svg`);
    fs.writeFileSync(filename, svg);
    console.log(`Created: icon-${size}.svg`);
});

// Also create a favicon.svg
const faviconSVG = createSVGIcon(32);
fs.writeFileSync(path.join(__dirname, 'favicon.svg'), faviconSVG);
console.log('Created: favicon.svg');

console.log('\\nSVG icons generated successfully!');
console.log('\\nTo convert to PNG, you can use:');
console.log('- Online converters like https://svgtopng.com/');
console.log('- ImageMagick: convert icon-192.svg icon-192.png');
console.log('- Or open icons/generate-icons.html in a browser to download PNGs');
