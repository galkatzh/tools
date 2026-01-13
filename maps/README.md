# Place Recommendation Mapper

A minimalistic vanilla JavaScript app that extracts place recommendations from web content and maps them using Google Maps. Clean, mobile-friendly interface with settings in a collapsible panel.

## Features

- **Modern UI**: Minimalistic design with mobile-first responsive layout
- **Settings Panel**: Collapsible sidebar for configuration (hamburger menu)
- **Extract Places**: From any web URL (Reddit posts, blogs, articles)
- **Reddit Support**: Special handling for Reddit posts (includes all comments)
- **AI-Powered**: Configurable OpenRouter model for place extraction
- **Auto-Geocoding**: Google Places API integration for coordinates
- **Interactive Map**: Visual display with numbered markers
- **Map Management**: Load, append, and save map data as JSON
- **Duplicate Detection**: Prevents duplicate places when appending
- **Debug View**: Inspect extracted content sent to AI
- **Local Storage**: API keys and preferences persist across sessions

## Setup

### Prerequisites

You'll need two API keys:

1. **OpenRouter API Key**: Get one from [OpenRouter](https://openrouter.ai/)
2. **Google Places API Key**: Get one from [Google Cloud Console](https://console.cloud.google.com/)
   - Enable "Places API" and "Maps JavaScript API" for your project

### Installation

1. Open `index.html` in a web browser
2. Enter your API keys in the configuration section
3. Click "Save" for each key (they'll be stored in localStorage)

## Usage

### Quick Start

1. **Open Settings** (click hamburger menu in top-right)
2. **Configure API Keys**:
   - Enter your OpenRouter API key → Save
   - (Optional) Change the model from default `moonshotai/kimi-k2:free` → Save
   - Enter your Google Places API key → Save
3. **Close Settings** (click × or outside the panel)
4. **Paste URL** in the main input field
5. **Click "Extract"** and wait for results

### Detailed Guide

**Settings Panel (hamburger menu)**

- **API Configuration**:
  - OpenRouter API Key (required for AI extraction)
  - Model selection (browse [OpenRouter Models](https://openrouter.ai/models))
  - Google Places API Key (required for geocoding)

- **Map Management**:
  - Load existing map JSON files
  - View current map info (filename, place count)
  - Clear map to start fresh

**Main Interface**

- **Extract Places**:
  - Paste any URL (Reddit, blogs, articles, etc.)
  - Click "Extract" button
  - New places append to current map
  - Duplicates auto-detected and skipped

- **View Results**:
  - Places list shows all locations
  - Color-coded: loaded (blue) vs extracted (grey)
  - Failed geocoding shown in red with error message
  - Place count displayed in header

- **Debug View** (click "View Debug"):
  - Inspect exact text sent to AI
  - Useful for troubleshooting extraction issues
  - Shows full content including Reddit comments

- **Download**:
  - Click "Download" in results header
  - Saves JSON with all places and metadata
  - Can be reloaded in future sessions

- **Interactive Map**:
  - Numbered markers for each place
  - Click markers for place details
  - Auto-zooms to fit all locations

## Workflow Example

Build a comprehensive map over multiple sessions:

1. **Session 1**: Extract places from a Reddit post about Tokyo restaurants
   - Download the map as `tokyo-restaurants.json`

2. **Session 2**: Load `tokyo-restaurants.json`
   - Add places from a blog post about Tokyo cafes
   - Download the updated map

3. **Session 3**: Load the updated map
   - Add places from another Reddit thread
   - Continue building your comprehensive Tokyo places map

Each time you add places, duplicates are automatically detected and skipped.

## How It Works

1. **Content Extraction**:
   - For Reddit: Fetches post and all comments via Reddit's JSON API
   - For other URLs: Extracts text content (with CORS proxy fallback)

2. **AI Processing**:
   - Sends content to your chosen OpenRouter model (default: Kimi K2 free model)
   - AI extracts place names, types, and descriptions

3. **Geocoding**:
   - Uses Google Places API to find each place
   - Gets coordinates, addresses, and place IDs

4. **Mapping**:
   - Displays all places on an interactive Google Map
   - Numbered markers correspond to the list
   - Info windows show place details

## Notes

- Reddit URLs work best with direct post links
- Some websites may block content extraction due to CORS policies
- The app uses a public CORS proxy as fallback
- All API keys and model preferences are stored locally in your browser
- You can use any OpenRouter model by entering its model ID
- Free models recommended: `moonshotai/kimi-k2:free`, `google/gemini-flash-1.5:free`
- Downloaded JSON files can be re-loaded to continue building maps
- Duplicate places are detected by name (case-insensitive)
- Loaded places are preserved when adding new ones
- The current map state is only in memory - remember to download before closing

## Troubleshooting

- **"Failed to fetch Reddit content"**: Make sure the URL is a valid Reddit post
- **"No places found"**: The AI didn't detect any place recommendations in the content
- **"Place not found"**: Google Places API couldn't geocode a place (still shown in list)
- **CORS errors**: Some websites block direct access; the app will try a proxy

## File Structure

```
maps/
├── index.html    # Main HTML structure
├── styles.css    # Styling
├── app.js        # Application logic
└── README.md     # This file
```

## Privacy

- API keys are stored only in your browser's localStorage
- No data is sent to any server except OpenRouter and Google APIs
- All processing happens client-side

## License

MIT
