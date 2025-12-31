# YouTube Video Crossfader

A vanilla JavaScript application that allows you to play two YouTube videos simultaneously and control the audio mix between them using a crossfader.

## Features

- **Dual YouTube Players**: Play two YouTube videos side-by-side
- **Crossfader Control**: Smoothly transition audio between the two videos
- **Dynamic Volume**: Real-time volume adjustment based on crossfader position
- **Visual Feedback**: Player opacity changes to reflect the current mix
- **Custom Videos**: Load any YouTube video by entering its video ID
- **Individual Controls**: Play or pause each video separately
- **Synchronized Controls**: Play or pause both videos simultaneously
- **Auto-Sync**: Automatically starts the second video when the first one plays
- **Mute/Unmute**: Control both videos' mute state together
- **Responsive Design**: Works on desktop and mobile devices

## How to Use

1. **Open the App**: Open `index.html` in a web browser
2. **Default Videos**: The app loads with two default YouTube videos
3. **Use the Crossfader**:
   - Slide left to hear more of Video 1
   - Slide right to hear more of Video 2
   - Center position plays both at 50% volume
4. **Load Custom Videos**:
   - Enter a YouTube video ID in the input fields
   - Click "Load" to change the video
   - Example video IDs: `dQw4w9WgXcQ`, `jNQXAC9IVRw`
5. **Individual Playback Controls**:
   - Use "Video 1 Controls" to play or pause video 1 independently
   - Use "Video 2 Controls" to play or pause video 2 independently
6. **Synchronized Controls**:
   - Click "Play Both" to start both videos
   - Click "Pause Both" to pause both videos
   - Click "Mute Both" or "Unmute Both" to control sound
   - Videos will auto-sync: when one starts playing, the other follows

## How It Works

- **YouTube IFrame API**: Uses the official YouTube IFrame API to embed and control videos
- **Volume Control**: Adjusts each player's volume based on the crossfader position (0-100%)
- **Auto-Synchronization**: When one video starts playing, the other automatically follows after a short delay
- **Visual Feedback**: Changes player wrapper opacity to indicate the current mix level
- **Vanilla JavaScript**: No frameworks or libraries required (except YouTube API)

## Files

- `index.html` - Main HTML structure
- `app.js` - JavaScript logic for YouTube API and crossfader control
- `style.css` - Styling and responsive design
- `README.md` - This file

## Browser Compatibility

Works in all modern browsers that support:
- YouTube IFrame API
- HTML5 range input
- CSS Grid and Flexbox

## Tips

- You can control each video individually using the built-in YouTube controls
- The crossfader works in real-time, even while videos are playing
- Try mixing music videos, nature sounds, or any two videos for creative combinations
- If videos don't play simultaneously due to browser restrictions, click the play button on each individual player first, or use the mute/unmute controls

## License

Free to use and modify.
