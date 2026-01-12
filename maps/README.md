# Place Recommendation Mapper

A vanilla JavaScript app that extracts place recommendations from web content (Reddit posts, blogs, etc.) and maps them using Google Maps.

## Features

- Extract place recommendations from any web URL
- Special support for Reddit posts (includes all comments)
- AI-powered place extraction using OpenRouter
- Automatic geocoding with Google Places API
- Interactive map visualization
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

2. **Extract Places**:
   - Paste a URL into the "Website URL" field
   - Supported URLs:
     - Reddit posts (includes all comments)
     - Blog posts
     - Articles
     - Any web page with place recommendations
   - Click "Extract & Map Places"

3. **View Results**:
   - The app will display a list of extracted places
   - An interactive map will show all successfully geocoded places
   - Click markers on the map for more information

4. **Download Data**:
   - Click "Download Map Data" to save the results as JSON
   - The file includes all places, coordinates, and metadata

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
- Downloaded JSON files can be imported into other mapping tools

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
