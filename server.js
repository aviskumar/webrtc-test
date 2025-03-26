// File: server.js

const WebSocket = require('ws');

// Create a WebSocket server instance listening on port 8080
const wss = new WebSocket.Server({ port: 8080 });

// Store active rooms and the clients within them.
// Format: { "roomId": [clientWebSocket1, clientWebSocket2], ... }
const rooms = {};

console.log('Signaling server started on ws://localhost:8080');

// Event listener for new client connections
wss.on('connection', (ws) => {
    console.log('Client connected');
    let currentRoom = null; // Variable to track which room this specific client (ws) is in

    // Event listener for messages received from this client
    ws.on('message', (message) => {
        let data;
        try {
            // Attempt to parse the incoming message as JSON
            data = JSON.parse(message);
            console.log('Received:', data);
        } catch (e) {
            console.error('Failed to parse message or invalid message format:', message);
            return; // Ignore non-JSON messages or handle appropriately
        }

        // Handle different message types from the client
        switch (data.type) {
            // Client wants to create or join a room
            case 'create_or_join':
                const roomId = data.roomId;
                if (!roomId) {
                    console.error('Room ID is required for create_or_join');
                    ws.send(JSON.stringify({ type: 'error', message: 'Room ID required' }));
                    return;
                }

                currentRoom = roomId; // Assign this client to the requested room

                // Initialize the room if it doesn't exist
                if (!rooms[roomId]) {
                    rooms[roomId] = [];
                }

                // Basic check: Limit rooms to 2 participants for simplicity
                if (rooms[roomId].length >= 2) {
                    console.log(`Room ${roomId} is full. Rejecting client.`);
                    ws.send(JSON.stringify({ type: 'room_full', roomId: roomId }));
                    currentRoom = null; // Client failed to join, clear their room association
                    // Optionally close the connection: ws.close();
                    return;
                }

                // Add the client's WebSocket connection to the room
                rooms[roomId].push(ws);
                console.log(`Client joined room ${roomId}. Room size: ${rooms[roomId].length}`);

                // Determine if this client is the first one (initiator) or the second one
                const isInitiator = rooms[roomId].length === 1;

                // Send confirmation back to the client
                ws.send(JSON.stringify({
                    type: 'joined',
                    roomId: roomId,
                    isInitiator: isInitiator // Let the client know if they should initiate the call
                }));

                // If the room now has 2 clients, notify the *first* client (initiator)
                // that the second client (peer) has joined.
                if (rooms[roomId].length === 2) {
                    const initiator = rooms[roomId][0];
                    // Check if initiator is still connected before sending
                    if (initiator && initiator.readyState === WebSocket.OPEN) {
                       initiator.send(JSON.stringify({ type: 'peer_joined', roomId: roomId }));
                       console.log(`Notified initiator in room ${roomId} that peer joined.`);
                    } else {
                        console.warn(`Initiator in room ${roomId} is not connected or ready.`);
                        // Potential cleanup: Remove the stale initiator connection?
                    }
                }
                break;

            // Relay WebRTC signaling messages (offer, answer, candidate)
            case 'offer':
            case 'answer':
            case 'candidate':
                if (!currentRoom || !rooms[currentRoom]) {
                     console.error(`Cannot relay message: Client not in a valid room (${currentRoom}).`);
                     ws.send(JSON.stringify({ type: 'error', message: 'Not connected to a room.' }));
                     return;
                }

                // Find the *other* client in the same room
                const otherClient = rooms[currentRoom].find(client => client !== ws);

                // If the other client exists and is connected, forward the message
                if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                    console.log(`Relaying ${data.type} from a client to the other client in room ${currentRoom}`);
                    // Forward the original message string directly
                    otherClient.send(message.toString());
                } else {
                     console.log(`Cannot relay ${data.type}: Other client not found or not connected in room ${currentRoom}.`);
                     // Optionally notify the sender if the peer isn't available (except for candidates maybe)
                     if (data.type !== 'candidate') {
                        ws.send(JSON.stringify({ type: 'peer_unavailable', message: 'The other peer is not connected.' }));
                     }
                }
                break;

            // Client explicitly hangs up
            case 'hangup':
                 if (!currentRoom || !rooms[currentRoom]) {
                     console.warn(`Cannot process hangup: Client not in a valid room (${currentRoom}).`);
                     return;
                 }
                 // Notify the other peer in the room, if they exist and are connected
                 const peerToNotify = rooms[currentRoom].find(client => client !== ws);
                 if (peerToNotify && peerToNotify.readyState === WebSocket.OPEN) {
                      console.log(`Relaying hangup in room ${currentRoom}`);
                      peerToNotify.send(JSON.stringify({ type: 'peer_hangup' }));
                 }
                 // Clean up this client's association with the room
                 rooms[currentRoom] = rooms[currentRoom].filter(client => client !== ws);
                 // If room becomes empty, delete it
                 if (rooms[currentRoom].length === 0) {
                      console.log(`Room ${currentRoom} is now empty. Deleting room.`);
                      delete rooms[currentRoom];
                 }
                 currentRoom = null; // Client is no longer in a room
                 break;

            default:
                console.warn('Unknown message type received:', data.type);
                // Optionally send an error back to the client
                // ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${data.type}` }));
        }
    });

    // Event listener for when a client disconnects
    ws.on('close', () => {
        console.log('Client disconnected');
        // If the client was in a room, perform cleanup
        if (currentRoom && rooms[currentRoom]) {
            console.log(`Removing client from room ${currentRoom}`);

            // Find if there's another client remaining in the room
            const remainingClient = rooms[currentRoom].find(client => client !== ws);

            // Notify the remaining client, if they exist and are connected
            if (remainingClient && remainingClient.readyState === WebSocket.OPEN) {
                 remainingClient.send(JSON.stringify({ type: 'peer_left' }));
                 console.log(`Notified peer in room ${currentRoom} that the other client left.`);
            }

            // Remove the disconnected client from the room array
            rooms[currentRoom] = rooms[currentRoom].filter(client => client !== ws);

            // If the room is now empty after removal, delete the room entirely
            if (rooms[currentRoom].length === 0) {
                console.log(`Room ${currentRoom} is now empty. Deleting room.`);
                delete rooms[currentRoom];
            }
        }
        currentRoom = null; // Ensure room tracking is cleared for the closed connection
    });

    // Event listener for WebSocket errors
    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        // Error handling might involve cleanup similar to the 'close' event,
        // as 'close' usually follows 'error'.
    });
});