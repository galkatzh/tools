// YouTube Video Crossfader App
const app = {
    player1: null,
    player2: null,
    ready: {
        player1: false,
        player2: false
    },

    init() {
        // This will be called when the YouTube IFrame API is ready
        console.log('YouTube IFrame API Ready');
    },

    createPlayers() {
        const video1Id = document.getElementById('video1-id').value || 'dQw4w9WgXcQ';
        const video2Id = document.getElementById('video2-id').value || 'jNQXAC9IVRw';

        this.player1 = new YT.Player('player1', {
            height: '360',
            width: '640',
            videoId: video1Id,
            playerVars: {
                'autoplay': 0,
                'controls': 1,
                'rel': 0
            },
            events: {
                'onReady': (event) => this.onPlayerReady(event, 1),
                'onStateChange': (event) => this.onPlayerStateChange(event, 1)
            }
        });

        this.player2 = new YT.Player('player2', {
            height: '360',
            width: '640',
            videoId: video2Id,
            playerVars: {
                'autoplay': 0,
                'controls': 1,
                'rel': 0
            },
            events: {
                'onReady': (event) => this.onPlayerReady(event, 2),
                'onStateChange': (event) => this.onPlayerStateChange(event, 2)
            }
        });
    },

    onPlayerReady(event, playerNum) {
        console.log(`Player ${playerNum} ready`);
        this.ready[`player${playerNum}`] = true;

        // Set initial volume based on crossfader position
        this.updateVolumes();

        // Add crossfader event listener (only once when first player is ready)
        if (playerNum === 1) {
            const crossfader = document.getElementById('crossfader');
            crossfader.addEventListener('input', () => this.updateVolumes());
        }
    },

    onPlayerStateChange(event, playerNum) {
        console.log(`Player ${playerNum} state changed:`, event.data);
    },

    updateVolumes() {
        const crossfader = document.getElementById('crossfader');
        const position = parseInt(crossfader.value);

        // Calculate volumes based on crossfader position
        // Position 0 = 100% video 1, 0% video 2
        // Position 50 = 50% video 1, 50% video 2
        // Position 100 = 0% video 1, 100% video 2
        const volume1 = 100 - position;
        const volume2 = position;

        // Update players
        if (this.player1 && this.ready.player1) {
            this.player1.setVolume(volume1);
        }
        if (this.player2 && this.ready.player2) {
            this.player2.setVolume(volume2);
        }

        // Update display
        document.getElementById('video1-volume').textContent = `Volume 1: ${volume1}%`;
        document.getElementById('video2-volume').textContent = `Volume 2: ${volume2}%`;

        // Update visual opacity for player wrappers
        document.getElementById('player1-wrapper').style.opacity = 0.3 + (volume1 / 100) * 0.7;
        document.getElementById('player2-wrapper').style.opacity = 0.3 + (volume2 / 100) * 0.7;
    },

    loadVideo(playerNum) {
        const videoId = document.getElementById(`video${playerNum}-id`).value;
        if (!videoId) {
            alert(`Please enter a video ID for Video ${playerNum}`);
            return;
        }

        const player = this[`player${playerNum}`];
        if (player && this.ready[`player${playerNum}`]) {
            player.loadVideoById(videoId);
            console.log(`Loaded video ${videoId} in player ${playerNum}`);
        } else {
            console.error(`Player ${playerNum} not ready`);
        }
    },

    playBoth() {
        if (this.player1 && this.ready.player1) {
            this.player1.playVideo();
        }
        if (this.player2 && this.ready.player2) {
            this.player2.playVideo();
        }
    },

    pauseBoth() {
        if (this.player1 && this.ready.player1) {
            this.player1.pauseVideo();
        }
        if (this.player2 && this.ready.player2) {
            this.player2.pauseVideo();
        }
    }
};

// This function is called by the YouTube IFrame API when it's ready
function onYouTubeIframeAPIReady() {
    app.init();
    app.createPlayers();
}
