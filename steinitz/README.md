# 🍽️ Restaurant Finder

A vanilla JavaScript web application that helps you find restaurants and cafes near any location on a map.

## Features

- 📍 **Interactive Map** - Click anywhere to select a search location
- 🎯 **Current Location** - Automatically shows your location if you share it
- 📏 **Adjustable Radius** - Search from 500m to 5km
- ⭐ **Filter by Rating** - Show only highly-rated establishments
- 🔢 **Sort Options** - Sort by rating, review count, or name
- 💾 **API Key Storage** - Securely stores your API key in browser local storage

## Getting Started

### 1. Get a Google Places API Key

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project or select an existing one
3. Enable the **Places API**
4. Go to **Credentials** and create an **API Key**
5. (Optional but recommended) Restrict the key to only the Places API

### 2. Run the Application

Simply open `index.html` in your web browser:

```bash
open index.html
# or
python3 -m http.server 8000  # Then visit http://localhost:8000
```

### 3. Enter Your API Key

When you first open the app, you'll be prompted to enter your Google Places API key. The key will be saved in your browser's local storage for future use.

## Usage

1. **Select a Location**:
   - The map will try to show your current location automatically
   - Click anywhere on the map to choose a different search location

2. **Adjust Search Radius**:
   - Use the dropdown to select a radius (500m - 5km)
   - The blue circle on the map shows your search area

3. **Search**:
   - Click the "Search" button to find restaurants

4. **Filter & Sort**:
   - **Sort by**: Rating, number of reviews, or name
   - **Min Rating**: Filter to show only restaurants above a certain rating

5. **View Results**:
   - Click on any result to center the map on that restaurant
   - Markers on the map show restaurant locations

## Important Notes

### CORS Issue

Due to browser security restrictions (CORS), the app needs a way to make requests to the Google Places API. You have a few options:

#### Option 1: Browser Extension (Easiest for testing)
Install a CORS browser extension:
- Chrome: "CORS Unblock" or "Allow CORS"
- Firefox: "CORS Everywhere"

#### Option 2: Use a CORS Proxy
The code currently uses `cors-anywhere.herokuapp.com`, but this public proxy may have rate limits. For production use, consider:
- Setting up your own CORS proxy
- Using a backend server to make API requests

#### Option 3: Create a Backend
For a production app, create a simple backend that makes the API requests:

```javascript
// Example Node.js endpoint
app.get('/api/places', async (req, res) => {
  const { lat, lng, radius } = req.query;
  const response = await fetch(
    `https://maps.googleapis.com/maps/api/place/nearbysearch/json?location=${lat},${lng}&radius=${radius}&type=restaurant&key=${API_KEY}`
  );
  const data = await response.json();
  res.json(data);
});
```

## Technologies Used

- **Leaflet.js** - Interactive maps
- **OpenStreetMap** - Map tiles (no API key required)
- **Google Places API** - Restaurant data
- **Vanilla JavaScript** - No frameworks required

## File Structure

```
steinitz/
├── index.html    # Main HTML structure
├── style.css     # Styling and layout
├── app.js        # Application logic
└── README.md     # This file
```

## Customization

### Change Search Type
Edit `app.js` line 173 to search for different types of places:
```javascript
// Current: type=restaurant
// Options: cafe, bar, bakery, meal_takeaway, etc.
type=restaurant|cafe  // Search for both
```

### Adjust Map Style
The app uses OpenStreetMap, but you can switch to other tile providers in `app.js`:
```javascript
L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
  // Change to other providers like Mapbox, Stamen, etc.
})
```

## Troubleshooting

**"API key is invalid"**
- Verify your API key is correct
- Ensure Places API is enabled in Google Cloud Console
- Check if there are any API restrictions

**"No restaurants found"**
- Try increasing the search radius
- Move to a more populated area on the map
- Check your internet connection

**Map not loading**
- Check browser console for errors
- Ensure you have an internet connection
- Try refreshing the page

## License

MIT License - Feel free to use and modify as needed!
