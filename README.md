# Webpage-Translation

A Chrome Manifest V3 extension for translating text visible in comics, manga,
manhwa, and webtoons.

The extension captures the currently visible browser viewport, sends the image
to TAMU AI, requests translated text with bounding boxes, and places English
text overlays over the original regions.

## Features

- Translates only the currently visible area
- Text overlays placed over detected comic text
- Horizontal and vertical text support
- Adjustable overlay opacity
- Dynamic font sizing
- Retina and high-DPI coordinate correction
- Overlays remain aligned while scrolling
- Overlays persist on the current page
- Automatic overlay cleanup after URL changes
- Clear Overlays button
- TAMU AI model selector
- User-provided API key
- Warning when visible images have not finished loading

## Project structure

```text
tamu-comic-text-translator/
├── manifest.json
├── popup.html
├── popup.css
├── popup.js
├── background.js
├── content.js
├── overlay.css
├── README.md
└── .gitignore
