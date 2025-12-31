// YouTube Video Crossfader App
const app = {
    player1: null,
    player2: null,
    ready: {
        player1: false,
        player2: false
    },
    isMuted: false,
    syncInProgress: false,

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
                'rel': 0,
                'enablejsapi': 1
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
                'rel': 0,
                'enablejsapi': 1
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

        // YT.PlayerState.PLAYING = 1
        // When one video starts playing, try to start the other
        // But only if we're not already in the middle of a sync operation
        if (event.data === 1 && !this.syncInProgress) {
            const otherPlayerNum = playerNum === 1 ? 2 : 1;
            const otherPlayer = this[`player${otherPlayerNum}`];

            // If the other player is paused or not playing, start it
            if (otherPlayer && this.ready[`player${otherPlayerNum}`]) {
                const otherState = otherPlayer.getPlayerState();
                // YT.PlayerState: -1 (unstarted), 0 (ended), 2 (paused), 3 (buffering), 5 (cued)
                if (otherState !== 1 && otherState !== 3) {
                    console.log(`Auto-starting player ${otherPlayerNum} to sync with player ${playerNum}`);
                    this.syncInProgress = true;
                    setTimeout(() => {
                        otherPlayer.playVideo();
                        // Reset the flag after a delay to allow the sync to complete
                        setTimeout(() => {
                            this.syncInProgress = false;
                        }, 500);
                    }, 100);
                }
            }
        }
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

    play(playerNum) {
        const player = this[`player${playerNum}`];
        if (player && this.ready[`player${playerNum}`]) {
            try {
                player.playVideo();
                console.log(`Playing video ${playerNum}`);
            } catch (error) {
                console.error(`Error playing video ${playerNum}:`, error);
            }
        } else {
            console.error(`Player ${playerNum} not ready`);
        }
    },

    pause(playerNum) {
        const player = this[`player${playerNum}`];
        if (player && this.ready[`player${playerNum}`]) {
            player.pauseVideo();
            console.log(`Paused video ${playerNum}`);
        } else {
            console.error(`Player ${playerNum} not ready`);
        }
    },

    async playBoth() {
        console.log('Attempting to play both videos...');

        // Play first video
        if (this.player1 && this.ready.player1) {
            try {
                this.player1.playVideo();
                console.log('Started player 1');
            } catch (error) {
                console.error('Error playing video 1:', error);
            }
        }

        // Small delay to help with browser autoplay policies
        await new Promise(resolve => setTimeout(resolve, 150));

        // Play second video
        if (this.player2 && this.ready.player2) {
            try {
                this.player2.playVideo();
                console.log('Started player 2');
            } catch (error) {
                console.error('Error playing video 2:', error);
            }
        }

        // Update volumes after both are playing
        setTimeout(() => {
            this.updateVolumes();
        }, 300);
    },

    pauseBoth() {
        if (this.player1 && this.ready.player1) {
            this.player1.pauseVideo();
        }
        if (this.player2 && this.ready.player2) {
            this.player2.pauseVideo();
        }
    },

    muteBoth() {
        if (this.player1 && this.ready.player1) {
            this.player1.mute();
        }
        if (this.player2 && this.ready.player2) {
            this.player2.mute();
        }
        this.isMuted = true;
    },

    unmuteBoth() {
        if (this.player1 && this.ready.player1) {
            this.player1.unMute();
        }
        if (this.player2 && this.ready.player2) {
            this.player2.unMute();
        }
        this.isMuted = false;
        this.updateVolumes();
    }
};

// This function is called by the YouTube IFrame API when it's ready
function onYouTubeIframeAPIReady() {
    app.init();
    app.createPlayers();
}
