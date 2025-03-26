// File: script.js

// --- Get references to DOM Elements ---
const joinButton = document.getElementById('joinButton');
const roomIdInput = document.getElementById('roomId');
const connectionStatus = document.getElementById('connectionStatus');
const connectControls = document.getElementById('connectControls');
const callControls = document.getElementById('callControls');
const currentRoomIdSpan = document.getElementById('currentRoomId');
const endButton = document.getElementById('endButton');
const localAudio = document.getElementById('localAudio');
const remoteAudio = document.getElementById('remoteAudio');

// --- WebRTC and Signaling Variables ---
let localStream;      // Holds the user's local audio stream
let remoteStream;     // Holds the peer's remote audio stream
let peerConnection;   // The RTCPeerConnection object
let socket;           // The WebSocket connection to the signaling server
let isInitiator = false; // Tracks if this client is the one initiating the call
let currentRoom = null; // Tracks the ID of the room the client is currently in

// --- Configuration ---
// URL of the WebSocket signaling server (must match the server's address and port)
const WS_URL = 'wss://webrtc-test-zh1v.onrender.com';
// Configuration for the RTCPeerConnection, including STUN servers
// STUN servers are used to discover the client's public IP address and port
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }, // Google's public STUN server
        { urls: 'stun:stun1.l.google.com:19302' }
        // In production, you might need TURN servers for clients behind restrictive firewalls
        // {
        //   urls: 'turn:your-turn-server.com:3478',
        //   username: 'user',
        //   credential: 'password'
        // }
    ]
};

// --- Event Listeners ---
joinButton.onclick = joinRoom;   // Call joinRoom when the join button is clicked
endButton.onclick = hangup;     // Call hangup when the end button is clicked

// --- WebSocket Communication Functions ---

/**
 * Establishes a WebSocket connection to the signaling server.
 * Sets up event handlers for open, message, error, and close events.
 */
function connectWebSocket() {
    // Create a new WebSocket connection
    socket = new WebSocket(WS_URL);

    // Called when the WebSocket connection is successfully opened
    socket.onopen = () => {
        console.log('WebSocket connected');
        connectionStatus.textContent = 'Status: Connected to signaling server. Enter Room ID.';
        joinButton.disabled = false; // Enable the join button
    };

    // Called when a message is received from the signaling server
    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('Received message:', message);

        // Handle different types of messages from the server
        switch (message.type) {
            case 'joined': // Confirmation that joining the room was successful
                currentRoom = message.roomId;
                isInitiator = message.isInitiator; // Server tells us if we are the first (initiator)
                console.log(`Joined room ${currentRoom}. I am ${isInitiator ? 'initiator' : 'joiner'}.`);
                connectionStatus.textContent = `Status: Joined room ${currentRoom}. ${isInitiator ? 'Waiting for peer...' : 'Ready.'}`;
                currentRoomIdSpan.textContent = currentRoom; // Display room ID in UI
                connectControls.style.display = 'none'; // Hide initial connection form
                callControls.style.display = 'block';  // Show in-call controls
                // Now that we're in a room, get microphone access
                startMedia();
                break;

            case 'peer_joined': // Notification for the initiator that the second peer has joined
                console.log('Peer joined the room.');
                connectionStatus.textContent = `Status: Peer joined room ${currentRoom}. Starting P2P connection...`;
                // Initiator: Now that the peer is present, create the PeerConnection and the offer
                createPeerConnectionAndOffer();
                break;

            case 'offer': // Received a WebRTC offer from the peer (for the joiner)
                if (!isInitiator) {
                    console.log('Received offer.');
                    connectionStatus.textContent = `Status: Received offer from peer. Creating answer...`;
                    // Joiner: Handle the received offer and create an answer
                    handleOffer(message.offer);
                }
                break;

            case 'answer': // Received a WebRTC answer from the peer (for the initiator)
                if (isInitiator) {
                    console.log('Received answer.');
                    connectionStatus.textContent = `Status: Received answer from peer. Connection should establish.`;
                    // Initiator: Handle the received answer
                    handleAnswer(message.answer);
                }
                break;

            case 'candidate': // Received an ICE candidate from the peer
                if (peerConnection) {
                    console.log('Received ICE candidate.');
                    // Add the received ICE candidate to the PeerConnection
                    peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate))
                        .catch(e => console.error('Error adding received ICE candidate', e));
                } else {
                    console.warn("Received ICE candidate, but PeerConnection is not initialized yet.");
                    // Ideally, queue candidates if PC isn't ready, but this simple example might lose early ones.
                }
                break;

            case 'peer_hangup': // Notification that the peer explicitly ended the call
                 console.log('Peer hung up.');
                 connectionStatus.textContent = `Status: Peer left the call.`;
                 alert('The other user has left the call.');
                 resetCall(); // Clean up the call state
                 break;

            case 'peer_left': // Notification that the peer disconnected unexpectedly
                 console.log('Peer left the room (disconnected).');
                 connectionStatus.textContent = `Status: Peer disconnected. Waiting...`;
                 alert('The other user disconnected.');
                 // Reset the call state, potentially allowing a new peer to join later
                 resetCall(false); // Reset WebRTC but keep WebSocket open for now
                 break;

            case 'room_full': // Server indication that the room is already full
                console.error(`Room ${message.roomId} is full.`);
                connectionStatus.textContent = `Status: Error - Room ${message.roomId} is full.`;
                alert(`Error: Could not join room ${message.roomId} because it is full.`);
                socket.close(); // Close the connection as joining failed
                break;

            case 'error': // Generic error message from the server
                 console.error('Server error:', message.message);
                 connectionStatus.textContent = `Status: Error - ${message.message}`;
                 alert(`Server error: ${message.message}`);
                 break;

            default:
                console.warn('Unknown message type received:', message.type);
        }
    };

    // Called when a WebSocket error occurs
    socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        connectionStatus.textContent = 'Status: WebSocket error. Check console. Is the server running?';
        alert('WebSocket connection error. Please ensure the signaling server is running and accessible.');
        resetState(); // Reset the application state
    };

    // Called when the WebSocket connection is closed
    socket.onclose = () => {
        console.log('WebSocket disconnected');
        // Avoid overwriting specific error messages
        if (!connectionStatus.textContent.includes('Error')) {
             connectionStatus.textContent = 'Status: Disconnected from signaling server.';
        }
        // Reset the state if the disconnection wasn't part of a normal hangup
        // resetState(); // Decide if a full reset is always needed on close
        joinButton.disabled = true; // Disable join until reconnected (if implementing reconnect logic)
    };
}

/**
 * Sends a JSON message through the WebSocket connection.
 * @param {object} message - The message object to send.
 */
function sendMessage(message) {
     if (socket && socket.readyState === WebSocket.OPEN) {
        console.log('Sending message:', message);
        socket.send(JSON.stringify(message));
     } else {
         console.error("Cannot send message: WebSocket is not open.");
         connectionStatus.textContent = 'Status: Error - Not connected to signaling server.';
         // Consider attempting to reconnect or informing the user more clearly.
     }
}

// --- Room Joining Logic ---

/**
 * Called when the 'Join / Start Call' button is clicked.
 * Validates the Room ID and sends a 'create_or_join' message to the server.
 */
function joinRoom() {
    const roomId = roomIdInput.value.trim();
    if (!roomId) {
        alert('Please enter a Room ID.');
        return;
    }
    // Ensure WebSocket is connected before attempting to join
    if (!socket || socket.readyState !== WebSocket.OPEN) {
         alert('Not connected to signaling server. Please wait or refresh.');
         return;
    }

    console.log(`Attempting to join/create room: ${roomId}`);
    connectionStatus.textContent = `Status: Joining room ${roomId}...`;
    joinButton.disabled = true; // Disable button while attempting

    // Send the request to the signaling server
    sendMessage({
        type: 'create_or_join',
        roomId: roomId
    });
}

// --- WebRTC Core Functions ---

/**
 * Requests access to the user's microphone using getUserMedia.
 * On success, sets the local audio stream and adds tracks to the PeerConnection if ready.
 */
async function startMedia() {
    console.log('Requesting local media (microphone)...');
     try {
        // Request audio-only stream
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        localAudio.srcObject = localStream; // Display local audio (muted)
        console.log('Got local stream:', localStream);

        // If the PeerConnection exists (e.g., joiner handling offer), add tracks now.
        if (peerConnection) {
            addLocalTracksToPeerConnection();
        }
     } catch (e) {
        console.error('Error getting user media:', e);
        alert('Could not access microphone. Please check browser permissions.');
        // Handle the error, maybe reset the call state or inform the user
        resetCall();
     }
}

/**
 * Adds all audio tracks from the localStream to the PeerConnection.
 */
function addLocalTracksToPeerConnection() {
     if (localStream && peerConnection) {
         console.log('Adding local tracks to PeerConnection...');
         localStream.getTracks().forEach(track => {
            // Check if the track is already added before adding
            const senders = peerConnection.getSenders();
            if (!senders.find(sender => sender.track === track)) {
                console.log('Adding local track:', track);
                peerConnection.addTrack(track, localStream);
            } else {
                console.log('Track already added:', track);
            }
        });
     } else if (!localStream) {
         console.warn("Cannot add local tracks: localStream is not available yet.");
     } else if (!peerConnection) {
         console.warn("Cannot add local tracks: peerConnection is not available yet.");
     }
}

/**
 * Creates and configures the RTCPeerConnection object.
 * Sets up event listeners for ICE candidates, track additions, and connection state changes.
 */
function setupPeerConnection() {
     // Close existing connection if any
     if (peerConnection) {
        console.warn("PeerConnection already exists. Closing previous one.");
        peerConnection.close();
     }

    console.log('Creating PeerConnection...');
    peerConnection = new RTCPeerConnection(configuration);
    console.log('PeerConnection created with configuration:', configuration);

    // Event Listener: Called when the browser generates an ICE candidate.
    // Sends the candidate to the peer via the signaling server.
    peerConnection.onicecandidate = event => {
        if (event.candidate) {
            console.log('Generated ICE candidate:', event.candidate);
            // Send the candidate to the signaling server
            sendMessage({
                type: 'candidate',
                candidate: event.candidate
            });
        } else {
            console.log('All ICE candidates have been gathered.');
        }
    };

    // Event Listener: Called when a remote track (audio in this case) is received.
    peerConnection.ontrack = event => {
        console.log('Remote track received:', event.track, 'Stream:', event.streams[0]);
        // Ensure we have a MediaStream object for the remote audio element
         if (!remoteStream || remoteAudio.srcObject !== remoteStream) {
            remoteStream = new MediaStream();
            remoteAudio.srcObject = remoteStream; // Assign the stream to the audio element
            console.log("Created and set remoteStream for remoteAudio element");
        }
        // Add the received track to the remote stream, which plays through the audio element
        remoteStream.addTrack(event.track);
    };

     // Event Listener: Monitors the overall connection state.
    peerConnection.onconnectionstatechange = event => {
        console.log('PeerConnection state changed:', peerConnection.connectionState);
        const state = peerConnection.connectionState;
         connectionStatus.textContent = `Status: Peer connection state: ${state}`; // Update UI
        if (state === 'connected') {
            console.log('Peers connected!');
        } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
             console.log(`PeerConnection ${state}.`);
             // Handle potential disconnections or failures
             // A 'disconnected' state might recover, but 'failed'/'closed' usually means reset.
             // Consider resetting the call on 'failed' or 'closed'
             if (state === 'failed' || state === 'closed') {
                 // resetCall(); // Decide if automatic reset is desired
             }
        }
    };

     // Event Listener: Monitors the ICE connection state (more granular network connection status).
    peerConnection.oniceconnectionstatechange = event => {
        console.log('ICE connection state change:', peerConnection.iceConnectionState);
         // Can provide more detailed status like 'checking', 'completed', 'failed'
         // connectionStatus.textContent = `Status: ICE state: ${peerConnection.iceConnectionState}`;
    }

    // Add local tracks *if* the local stream is already available when PC is created.
    // If not, tracks will be added later by startMedia() or handleOffer().
    if (localStream) {
        addLocalTracksToPeerConnection();
    } else {
        console.log("Local stream not ready when PeerConnection was set up. Tracks will be added later.");
    }
}

/**
 * Initiator's Action: Creates the PeerConnection (if needed) and the SDP Offer.
 * Sends the offer to the peer via the signaling server.
 * This is typically called after the initiator receives the 'peer_joined' message.
 */
async function createPeerConnectionAndOffer() {
     // Ensure local media is started before creating offer
     if (!localStream) {
        console.warn("Local stream not ready yet. Waiting before creating offer.");
        // Attempt to start media if not already started/requested
        await startMedia(); // Ensure media is attempted
        if (!localStream) {
            console.error("Failed to get local media. Cannot create offer.");
            return; // Exit if media failed
        }
    }

    // Setup the PeerConnection object
    if (!peerConnection) {
        setupPeerConnection();
    } else {
        // If PC exists but tracks weren't added (e.g., media was slow), try adding now.
        addLocalTracksToPeerConnection();
    }


    console.log('Creating offer...');
    try {
        const offer = await peerConnection.createOffer(); // Create the SDP offer
        await peerConnection.setLocalDescription(offer); // Set the offer as the local description
        console.log('Offer created and set as local description:', offer);

        // Send the offer to the peer via the signaling server
        sendMessage({
            type: 'offer',
            offer: offer // Include the offer SDP
        });
    } catch (e) {
        console.error('Error creating offer or setting local description:', e);
        // Handle error (e.g., notify user, reset state)
    }
}

/**
 * Joiner's Action: Handles an incoming SDP Offer from the initiator.
 * Sets the remote description, creates an SDP Answer, sets the local description,
 * and sends the answer back to the initiator via the signaling server.
 * @param {RTCSessionDescriptionInit} offerSdp - The offer received from the peer.
 */
async function handleOffer(offerSdp) {
     // Ensure local media is started before setting remote description and creating answer
     if (!localStream) {
        console.warn("Local stream not ready yet. Starting media before handling offer.");
        await startMedia();
        if (!localStream) {
            console.error("Failed to get local media. Cannot handle offer.");
            return;
        }
    }

    // Setup PeerConnection if it doesn't exist (should be called after getting media)
    if (!peerConnection) {
         setupPeerConnection();
    }


    console.log('Handling received offer...');
     try {
        // Set the received offer as the remote description
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
        console.log('Remote description (offer) set.');

        // Create the SDP answer
        console.log('Creating answer...');
        const answer = await peerConnection.createAnswer();
        // Set the answer as the local description
        await peerConnection.setLocalDescription(answer);
        console.log('Answer created and set as local description:', answer);

        // Send the answer back to the initiator via the signaling server
        sendMessage({
            type: 'answer',
            answer: answer // Include the answer SDP
        });
    } catch (e) {
        console.error('Error handling offer or creating/setting answer:', e);
        // Handle error
    }
}

/**
 * Initiator's Action: Handles an incoming SDP Answer from the joiner.
 * Sets the remote description based on the received answer.
 * @param {RTCSessionDescriptionInit} answerSdp - The answer received from the peer.
 */
async function handleAnswer(answerSdp) {
    if (!peerConnection || !peerConnection.localDescription) {
        console.error('Cannot handle answer: PeerConnection not ready or offer not sent.');
        return;
    }
    console.log('Handling received answer...');
    try {
        // Set the received answer as the remote description
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answerSdp));
        console.log('Remote description (answer) set.');
        // At this point, the connection should start establishing if ICE candidates exchange successfully.
    } catch (e) {
        console.error('Error setting remote description (answer):', e);
        // Handle error
    }
}

// --- Call Control Functions ---

/**
 * Called when the 'End Call' button is clicked or when leaving the call.
 * Sends a 'hangup' message, cleans up local resources, and resets the UI.
 */
function hangup() {
    console.log('Hanging up call...');
    // Notify the peer via the signaling server (if connected)
    if (socket && socket.readyState === WebSocket.OPEN && currentRoom) {
        sendMessage({ type: 'hangup' });
    }
    resetCall(); // Clean up local state and UI
    alert('Call ended.');
}

// --- Utility and Cleanup Functions ---

/**
 * Resets the WebRTC connection and media streams, and updates the UI.
 * @param {boolean} [closeSocket=true] - Whether to also close the WebSocket connection.
 */
function resetCall(closeSocket = true) {
     console.log('Resetting call state...');

     // 1. Close PeerConnection
     if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        console.log('PeerConnection closed.');
    }

    // 2. Stop Media Tracks and Clear Audio Elements
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
        localAudio.srcObject = null; // Clear local audio element
        console.log('Local media stream stopped.');
    }
     if (remoteStream) {
        remoteStream.getTracks().forEach(track => track.stop());
        remoteStream = null;
        remoteAudio.srcObject = null; // Clear remote audio element
        console.log('Remote media stream stopped.');
    }

    // 3. Reset Flags
    isInitiator = false;
    // currentRoom = null; // Keep currentRoom to display status until WS closes?

    // 4. Reset UI
    callControls.style.display = 'none';   // Hide call controls
    connectControls.style.display = 'block'; // Show connection controls
    roomIdInput.value = '';                // Clear room input field
    currentRoomIdSpan.textContent = '';      // Clear displayed room ID
    // Update status message, avoid overwriting errors
     if (!connectionStatus.textContent.includes('Error')) {
         connectionStatus.textContent = `Status: Call ended${closeSocket ? '. Disconnected.' : '. Ready to join a new room.'}`;
     }


     // 5. Close WebSocket (Optional)
     if (closeSocket && socket && socket.readyState === WebSocket.OPEN) {
         console.log("Closing WebSocket connection.");
         socket.close();
     } else if (closeSocket && socket) {
         // Socket might be closing or closed already
         socket = null; // Ensure we get a new one next time if fully resetting
     }
    // Clear room only after potentially closing socket or if resetting fully
    if (closeSocket) {
       currentRoom = null;
    }
    // Re-enable join button only if WebSocket is still open or will reconnect
     joinButton.disabled = !(socket && socket.readyState === WebSocket.OPEN);

     console.log('Call state reset complete.');
}

/**
 * Resets the entire application state, including closing the WebSocket.
 * Useful for handling fatal errors or full cleanup.
 */
function resetState() {
    console.log("Performing full application state reset.");
    resetCall(true); // Ensure WebSocket is closed during a full reset
    // Update status to reflect disconnected state
    if (!connectionStatus.textContent.includes('Error')) {
      connectionStatus.textContent = 'Status: Disconnected. Please refresh or try again.';
    }
    joinButton.disabled = true; // Disable join until re-initialized
}


// --- Initialization ---

/**
 * Initializes the application when the script loads.
 * Disables the join button initially and starts the WebSocket connection.
 */
function initialize() {
    console.log('Initializing application...');
    connectionStatus.textContent = 'Status: Connecting to signaling server...';
    joinButton.disabled = true; // Disable join until WebSocket connects
    callControls.style.display = 'none'; // Ensure call controls are hidden initially
    connectControls.style.display = 'block'; // Ensure connect controls are visible
    connectWebSocket(); // Start WebSocket connection
}

// Start the application initialization process when the script is loaded
initialize();
