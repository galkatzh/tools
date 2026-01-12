# Place Recommendation Mapper

A vanilla JavaScript app that extracts place recommendations from web content (Reddit posts, blogs, etc.) and maps them using Google Maps.

## Features

- Extract place recommendations from any web URL
- Special support for Reddit posts (includes all comments)
- AI-powered place extraction using OpenRouter
- Automatic geocoding with Google Places API
- Interactive map visualization
- Load existing map data and add new places to it
- Duplicate detection when adding places
- Download extracted places as JSON
- Local storage for API keys

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

1. **Configure API Keys**:
   - Enter your OpenRouter API key and click "Save"
   - Enter your Google Places API key and click "Save"

2. **Load Existing Map (Optional)**:
   - Click "Choose File" to select a previously saved map JSON file
   - Click "Load Map" to import the places
   - The loaded map info will show how many places are currently loaded
   - Click "Clear Map" to start fresh

3. **Extract Places**:
   - Paste a URL into the "Website URL" field
   - Supported URLs:
     - Reddit posts (includes all comments)
     - Blog posts
     - Articles
     - Any web page with place recommendations
   - Click "Extract & Add Places"
   - New places will be automatically added to your current map
   - Duplicates are automatically detected and skipped

4. **View Results**:
   - The app will display a list of all places (loaded + newly extracted)
   - Places are marked as "(from loaded map)" or "(newly extracted)"
   - An interactive map will show all successfully geocoded places
   - Click markers on the map for more information

5. **Download Data**:
   - Click "Download Map Data" to save all places as JSON
   - The file includes all places, coordinates, and metadata
   - You can later reload this file to continue adding more places

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
   - Sends content to OpenRouter (GPT-3.5-turbo)
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
- All API keys are stored locally in your browser
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
