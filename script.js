// File: script.js

// --- DOM Elements ---
const connectScreen = document.getElementById('connectScreen');
const callScreen = document.getElementById('callScreen');
const roomIdInput = document.getElementById('roomIdInput');
const audioCallButton = document.getElementById('audioCallButton');
const videoCallButton = document.getElementById('videoCallButton');
const connectionStatus = document.getElementById('connectionStatus');
const wsUrlDisplay = document.getElementById('wsUrlDisplay');

// Call Screen Elements
const localVideo = document.getElementById('localVideo');
const remoteVideo = document.getElementById('remoteVideo');
const remoteConnectingOverlay = document.getElementById('remoteConnectingOverlay');
const audioCallUI = document.getElementById('audioCallUI');
const audioAvatarInitials = document.getElementById('audioAvatarInitials');
const audioRoomId = document.getElementById('audioRoomId');
const audioCallStatus = document.getElementById('audioCallStatus');
const currentRoomIdDisplay = document.getElementById('currentRoomIdDisplay'); // In video info bar
const callStatus = document.getElementById('callStatus'); // In video info bar
const endButton = document.getElementById('endButton');

// --- App State ---
let localStream;
let remoteStream;
let peerConnection;
let socket;
let isInitiator = false;
let currentRoom = null;
let currentCallType = null; // 'audio' or 'video'

// --- Configuration ---
// !! IMPORTANT !! Set this for localhost or your deployed server
const WS_URL = 'wss://webrtc-test-zh1v.onrender.com'; // FOR LOCALHOST
// const WS_URL = 'wss://your-app-name.onrender.com'; // FOR PRODUCTION
const configuration = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ]
};

// --- Event Listeners ---
audioCallButton.onclick = () => initiateCall('audio');
videoCallButton.onclick = () => initiateCall('video');
endButton.onclick = hangup;

// --- UI State Management ---
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
    });
    const activeScreen = document.getElementById(screenId);
    if (activeScreen) {
        activeScreen.classList.add('active');
    }
}

function showOverlay(overlayId, show = true) {
    const overlay = document.getElementById(overlayId);
    if (overlay) {
        overlay.classList.toggle('visible', show);
    }
}

function setupCallUI(callType, status = 'Initializing...') {
    currentCallType = callType;
    callScreen.dataset.callType = callType; // Set data attribute for CSS styling

    // Update Room ID display
    currentRoomIdDisplay.textContent = currentRoom || 'N/A';

    // Reset overlays before showing the correct one
    showOverlay('remoteConnectingOverlay', false);
    showOverlay('audioCallUI', false);

    if (callType === 'video') {
        callStatus.textContent = status; // Update status in video info bar
    } else {
        // Setup Audio UI
        audioRoomId.textContent = `Room: ${currentRoom || 'N/A'}`;
        audioCallStatus.textContent = status;
        // Generate simple initials from Room ID
        const initials = currentRoom ? currentRoom.substring(0, 2).toUpperCase() : '??';
        audioAvatarInitials.textContent = initials;
        showOverlay('audioCallUI', true); // Show audio UI immediately
    }

    // Show the call screen itself
    showScreen('callScreen');
}


// --- WebSocket Communication (Minor changes for status updates) ---
function connectWebSocket() {
    wsUrlDisplay.textContent = WS_URL.replace(/^wss?:\/\//, ''); // Show URL without protocol
    socket = new WebSocket(WS_URL);

    socket.onopen = () => {
        console.log('WebSocket connected');
        connectionStatus.textContent = 'Status: Connected. Enter Room ID.';
        audioCallButton.disabled = false;
        videoCallButton.disabled = false;
    };

    socket.onmessage = (event) => {
        const message = JSON.parse(event.data);
        console.log('Received message:', message);

        switch (message.type) {
            case 'joined':
                currentRoom = message.roomId;
                isInitiator = message.isInitiator;
                currentCallType = message.callType; // Server dictates
                console.log(`Joined room ${currentRoom} (${currentCallType}). Initiator: ${isInitiator}.`);

                const initialStatus = isInitiator ? 'Waiting for peer...' : 'Joining call...';
                setupCallUI(currentCallType, initialStatus); // Setup UI based on received type
                startMedia(); // Get media based on currentCallType
                break;

            case 'peer_joined':
                console.log('Peer joined the room.');
                currentCallType = message.callType; // Ensure type consistency
                const peerJoinedStatus = 'Peer joined. Initializing connection...';
                if (currentCallType === 'video') callStatus.textContent = peerJoinedStatus;
                else audioCallStatus.textContent = peerJoinedStatus;
                showOverlay('remoteConnectingOverlay', true); // Show connecting overlay
                createPeerConnectionAndOffer();
                break;

            case 'offer':
                if (!isInitiator) {
                    console.log('Received offer.');
                    const incomingStatus = 'Incoming call... Preparing...';
                     if (currentCallType === 'video') callStatus.textContent = incomingStatus;
                     else audioCallStatus.textContent = incomingStatus;
                    // Ensure media is ready *before* handling offer
                    startMedia().then(() => {
                        handleOffer(message.offer);
                    }).catch(err => {
                         console.error("Media required before handling offer:", err);
                         const errorStatus = `Error: Media needed.`;
                         if (currentCallType === 'video') callStatus.textContent = errorStatus;
                         else audioCallStatus.textContent = errorStatus;
                    });
                }
                break;

            case 'answer':
                if (isInitiator) {
                    console.log('Received answer.');
                    const connectingStatus = `Connecting...`;
                     if (currentCallType === 'video') callStatus.textContent = connectingStatus;
                     else audioCallStatus.textContent = connectingStatus; // Also show on audio UI
                    handleAnswer(message.answer);
                }
                break;

            case 'candidate':
                 if (peerConnection) {
                    peerConnection.addIceCandidate(new RTCIceCandidate(message.candidate))
                        .catch(e => console.error('Error adding received ICE candidate', e));
                }
                break;

            case 'peer_hangup':
                 console.log('Peer hung up.');
                 alert('The other user has ended the call.');
                 resetCall();
                 break;

            case 'peer_left':
                 console.log('Peer left the room.');
                 alert('The other user disconnected.');
                 resetCall(false); // Keep socket open
                 // Update status appropriately
                 if (currentCallType === 'video') callStatus.textContent = `Peer disconnected. Waiting...`;
                 else audioCallStatus.textContent = `Peer disconnected.`;
                 // Reset remote media display but keep UI appropriate for call type
                 remoteVideo.srcObject = null;
                 if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); }
                 remoteStream = null;
                 showOverlay('remoteConnectingOverlay', false); // Hide spinner
                 // Re-show placeholder if it was an audio call
                 if(currentCallType === 'audio') {
                     showOverlay('audioCallUI', true);
                     audioCallStatus.textContent = `Peer disconnected.`;
                 } else {
                     // Optionally show spinner again for video? Or a different message?
                     showOverlay('remoteConnectingOverlay', true);
                     remoteConnectingOverlay.querySelector('p').textContent = "Peer Disconnected. Waiting...";
                 }
                 break;

            // Other cases (room_full, error) - Adjust status messages if needed
             case 'room_full':
                console.error(`Room ${message.roomId} is full.`);
                connectionStatus.textContent = `Status: Error - Room ${message.roomId} is full.`;
                alert(`Error: Could not join room ${message.roomId} because it is full.`);
                audioCallButton.disabled = false;
                videoCallButton.disabled = false;
                roomIdInput.disabled = false;
                if (socket && socket.readyState === WebSocket.OPEN) socket.close();
                break;

            case 'error':
                 console.error('Server error:', message.message);
                 connectionStatus.textContent = `Status: Error - ${message.message}`;
                 alert(`Server error: ${message.message}`);
                 // Maybe reset UI?
                 resetState();
                 break;

            default:
                console.warn('Unknown message type received:', message.type);
        }
    };

     socket.onerror = (error) => {
        console.error('WebSocket error:', error);
        connectionStatus.textContent = 'Status: Connection Error. Check Server/URL.';
        alert('WebSocket connection error. Check server URL and ensure it is running.');
        resetState(); // Reset fully on connection error
    };

    socket.onclose = () => {
        console.log('WebSocket disconnected');
        if (!connectionStatus.textContent.includes('Error') && !document.getElementById('callScreen').classList.contains('active')) {
            // Only update if not in call or error state
            connectionStatus.textContent = 'Status: Disconnected from server.';
        }
        audioCallButton.disabled = true;
        videoCallButton.disabled = true;
    };
}

function sendMessage(message) {
     if (socket && socket.readyState === WebSocket.OPEN) {
        console.log('Sending message:', message);
        socket.send(JSON.stringify(message));
     } else {
         console.error("Cannot send message: WebSocket is not open.");
         // Update status on appropriate screen
         const errorMsg = 'Error: Connection Lost';
         if (callScreen.classList.contains('active')) {
             if (currentCallType === 'video') callStatus.textContent = errorMsg;
             else audioCallStatus.textContent = errorMsg;
         } else {
             connectionStatus.textContent = `Status: ${errorMsg}`;
         }
         // Consider attempting reconnect or providing clearer user feedback
     }
}

// --- Call Initiation ---
function initiateCall(callType) {
    const roomId = roomIdInput.value.trim();
    if (!roomId) { alert('Please enter a Room ID.'); return; }
    if (!socket || socket.readyState !== WebSocket.OPEN) { alert('Not connected to signaling server.'); return; }

    console.log(`Initiating ${callType} call in room: ${roomId}`);
    connectionStatus.textContent = `Status: Joining ${roomId}...`;
    audioCallButton.disabled = true;
    videoCallButton.disabled = true;
    roomIdInput.disabled = true;

    sendMessage({ type: 'create_or_join', roomId: roomId, callType: callType });
}

// --- WebRTC Core ---

async function startMedia() {
    if (localStream) {
        console.log("Local stream already active.");
        return Promise.resolve();
    }
    console.log(`Requesting media for ${currentCallType} call...`);
    const statusMsg = 'Requesting permissions...';
    if (currentCallType === 'video') callStatus.textContent = statusMsg;
    else audioCallStatus.textContent = statusMsg;

    const constraints = (currentCallType === 'video')
        ? { audio: true, video: true }
        : { audio: true, video: false };

    try {
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log('Got local stream:', localStream);
        const readyMsg = 'Local media ready.';
        if (currentCallType === 'video') {
            callStatus.textContent = readyMsg;
            if (localStream.getVideoTracks().length > 0) {
                localVideo.srcObject = localStream; // Assign to video element
            } else {
                 console.warn("Requested video, but stream has no video track.");
                 localVideo.srcObject = null; // Ensure it's cleared
            }
        } else {
            audioCallStatus.textContent = readyMsg;
            localVideo.srcObject = null; // Ensure local video is hidden for audio calls
        }

        if (peerConnection) { addLocalTracksToPeerConnection(); }
        return Promise.resolve();

    } catch (e) {
        console.error('Error getting user media:', e);
        alert(`Media access error: ${e.message}. Check permissions.`);
        const errorMsg = `Error: Media access failed.`;
        if (currentCallType === 'video') callStatus.textContent = errorMsg;
        else audioCallStatus.textContent = errorMsg;
        resetCall();
        return Promise.reject(e);
    }
}

function addLocalTracksToPeerConnection() {
    if (!localStream || !peerConnection) return;
    console.log('Adding local tracks...');
    localStream.getTracks().forEach(track => {
        if (!peerConnection.getSenders().find(s => s.track === track)) {
            console.log(`Adding local ${track.kind} track`);
            peerConnection.addTrack(track, localStream);
        }
    });
}

function setupPeerConnection() {
    if (peerConnection) peerConnection.close();
    console.log('Creating PeerConnection...');
    peerConnection = new RTCPeerConnection(configuration);

    // Show initial connecting state
    showOverlay('remoteConnectingOverlay', true);
    if (currentCallType === 'audio') {
        // Also ensure audio UI is visible and shows connecting status initially
        showOverlay('audioCallUI', true);
        audioCallStatus.textContent = 'Establishing connection...';
    } else {
        showOverlay('audioCallUI', false); // Hide audio UI for video
    }

    peerConnection.onicecandidate = event => {
        if (event.candidate) sendMessage({ type: 'candidate', candidate: event.candidate });
    };

    peerConnection.ontrack = event => {
        console.log(`Remote ${event.track.kind} track received`, event.streams[0]);
        const receivingMsg = `Receiving remote ${event.track.kind}...`;
        if (currentCallType === 'video') callStatus.textContent = receivingMsg;
        // No status update needed on audio UI for track itself

        if (!remoteStream) {
            remoteStream = new MediaStream();
            // Always assign to remoteVideo, it handles audio too
            remoteVideo.srcObject = remoteStream;
            console.log("Created remoteStream, assigned to remoteVideo");
        }
        remoteStream.addTrack(event.track);

        // Refined logic to hide connecting overlay
        if (currentCallType === 'video' && event.track.kind === 'video') {
            remoteVideo.onplaying = () => {
                 console.log("Remote video playing");
                 showOverlay('remoteConnectingOverlay', false); // Hide connecting spinner
            }
        } else if (currentCallType === 'audio' && event.track.kind === 'audio') {
             // Remote audio track is added to the stream assigned to remoteVideo
             // We don't need visual feedback here, but update status text
             console.log("Remote audio track added");
             showOverlay('remoteConnectingOverlay', false); // Hide spinner
             audioCallStatus.textContent = 'Audio connected'; // Update status on audio UI
        }
    };

    peerConnection.onconnectionstatechange = () => {
        const state = peerConnection.connectionState;
        console.log('PeerConnection state:', state);
        const stateMsg = `P2P: ${state}`;
        if (currentCallType === 'video') callStatus.textContent = stateMsg;
        else audioCallStatus.textContent = stateMsg; // Update audio UI status

        if (state === 'connected') {
            showOverlay('remoteConnectingOverlay', false); // Ensure hidden
             if(currentCallType === 'audio') audioCallStatus.textContent = 'Connected';
        } else if (state === 'failed' || state === 'closed' || state === 'disconnected') {
             console.log(`PeerConnection ${state}.`);
             showOverlay('remoteConnectingOverlay', true); // Show overlay on failure/disconnect
             remoteConnectingOverlay.querySelector('p').textContent = `Connection ${state}`;
             if(currentCallType === 'audio') {
                 showOverlay('audioCallUI', true); // Keep audio UI visible
                 audioCallStatus.textContent = `Connection ${state}`;
             }
        }
    };

    if (localStream) addLocalTracksToPeerConnection();
}

// --- Offer/Answer Handling (Mostly status updates) ---

async function createPeerConnectionAndOffer() {
    try {
        if (!localStream) await startMedia();
        if (!localStream) throw new Error("Cannot create offer without local media.");
        if (!peerConnection) setupPeerConnection();

        console.log('Creating offer...');
        const statusMsg = "Creating offer...";
        if (currentCallType === 'video') callStatus.textContent = statusMsg;
        else audioCallStatus.textContent = statusMsg;

        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);
        console.log('Offer created and set.');
        sendMessage({ type: 'offer', offer: offer });
        const sentMsg = "Offer sent.";
        if (currentCallType === 'video') callStatus.textContent = sentMsg;
        else audioCallStatus.textContent = sentMsg;

    } catch (e) {
        console.error('Error creating offer:', e);
        const errorMsg = "Error creating offer.";
        if (currentCallType === 'video') callStatus.textContent = errorMsg;
        else audioCallStatus.textContent = errorMsg;
    }
}

async function handleOffer(offerSdp) {
    try {
        if (!localStream) await startMedia();
        if (!localStream) throw new Error("Cannot handle offer without local media.");
        if (!peerConnection) setupPeerConnection();

        console.log('Handling offer...');
        const statusMsg = "Processing offer...";
        if (currentCallType === 'video') callStatus.textContent = statusMsg;
        else audioCallStatus.textContent = statusMsg;

        await peerConnection.setRemoteDescription(new RTCSessionDescription(offerSdp));
        console.log('Remote description (offer) set.');

        console.log('Creating answer...');
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);
        console.log('Answer created and set.');
        sendMessage({ type: 'answer', answer: answer });
        const sentMsg = "Answer sent.";
        if (currentCallType === 'video') callStatus.textContent = sentMsg;
        else audioCallStatus.textContent = sentMsg;

    } catch (e) {
        console.error('Error handling offer:', e);
        const errorMsg = "Error processing offer.";
         if (currentCallType === 'video') callStatus.textContent = errorMsg;
         else audioCallStatus.textContent = errorMsg;
    }
}

async function handleAnswer(answerSdp) {
    if (!peerConnection || !peerConnection.localDescription) return;
    console.log('Handling answer...');
    const statusMsg = "Processing answer...";
    if (currentCallType === 'video') callStatus.textContent = statusMsg;
    else audioCallStatus.textContent = statusMsg;
    try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(answerSdp));
        console.log('Remote description (answer) set.');
         const finalMsg = "Connecting...";
         if (currentCallType === 'video') callStatus.textContent = finalMsg;
         else audioCallStatus.textContent = finalMsg;
    } catch (e) {
        console.error('Error setting remote answer:', e);
        const errorMsg = "Error processing answer.";
        if (currentCallType === 'video') callStatus.textContent = errorMsg;
        else audioCallStatus.textContent = errorMsg;
    }
}

// --- Call Control & Cleanup ---

function hangup() {
    console.log('Hanging up call...');
    if (socket && socket.readyState === WebSocket.OPEN && currentRoom) {
        sendMessage({ type: 'hangup' });
    }
    resetCall();
}

function resetCall(closeSocket = true) {
     console.log('Resetting call state...');
     if (peerConnection) { peerConnection.close(); peerConnection = null; }
     if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; localVideo.srcObject = null; }
     if (remoteStream) { remoteStream.getTracks().forEach(t => t.stop()); remoteStream = null; remoteVideo.srcObject = null; }

     isInitiator = false;
     currentCallType = null;

     showScreen('connectScreen'); // Go back to connect screen
     roomIdInput.disabled = false;
     roomIdInput.value = '';
     showOverlay('remoteConnectingOverlay', false); // Hide overlays
     showOverlay('audioCallUI', false);

     // Reset status/buttons on connect screen
     const canJoin = (socket && socket.readyState === WebSocket.OPEN && !closeSocket);
     if (!connectionStatus.textContent.includes('Error')) {
         connectionStatus.textContent = `Status: ${closeSocket ? 'Disconnected.' : 'Ready to connect.'}`;
     }
     audioCallButton.disabled = !canJoin;
     videoCallButton.disabled = !canJoin;


     if (closeSocket && socket && socket.readyState === WebSocket.OPEN) {
         socket.close(); socket = null; currentRoom = null;
     } else if (closeSocket) {
         socket = null; currentRoom = null;
     }
     // If socket stays open (peer_left), currentRoom is kept

     console.log('Call state reset complete.');
}

function resetState() { // Full reset including socket
    console.log("Performing full application state reset.");
    resetCall(true);
    if (!connectionStatus.textContent.includes('Error')) {
        connectionStatus.textContent = 'Status: Disconnected. Refresh?';
    }
    audioCallButton.disabled = true;
    videoCallButton.disabled = true;
}

// --- Initialization ---
function initialize() {
    console.log('Initializing application...');
    showScreen('connectScreen');
    connectionStatus.textContent = 'Status: Connecting to server...';
    audioCallButton.disabled = true;
    videoCallButton.disabled = true;
    connectWebSocket();
}

// Go!
initialize();