// server.js
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 }); // WebSocket server runs on port 8080
const rooms = {}; // Store rooms: { roomId: { clients: [ws1, ws2], callType: 'audio'|'video' } }

console.log('Signaling server started on ws://localhost:8080');

wss.on('connection', (ws) => {
    console.log('Client connected');
    let currentRoomId = null; // Track the room ID this client is in

    ws.on('message', (message) => {
        let data;
        try {
            data = JSON.parse(message);
            console.log('Received:', data);
        } catch (e) {
            console.error('Failed to parse message or invalid message format:', message);
            return;
        }

        switch (data.type) {
            case 'create_or_join':
                const roomId = data.roomId;
                const requestedCallType = data.callType; // 'audio' or 'video'

                if (!roomId || !requestedCallType) {
                    console.error('Room ID and Call Type are required');
                    ws.send(JSON.stringify({ type: 'error', message: 'Room ID and Call Type required' }));
                    return;
                }

                currentRoomId = roomId; // Assign room ID to this connection
                let room = rooms[roomId];
                let isInitiator = false;
                let actualCallType;

                // Find or create room
                if (!room) {
                    // First user creates the room and sets the call type
                    isInitiator = true;
                    actualCallType = requestedCallType;
                    rooms[roomId] = {
                        clients: [ws],
                        callType: actualCallType
                    };
                    room = rooms[roomId];
                    console.log(`Client created room ${roomId} as initiator. Type: ${actualCallType}`);
                } else {
                    // Second user joins
                    if (room.clients.length >= 2) {
                        console.log(`Room ${roomId} is full. Rejecting client.`);
                        ws.send(JSON.stringify({ type: 'room_full', roomId: roomId }));
                        currentRoomId = null;
                        return;
                    }
                    // Use the call type established by the initiator
                    actualCallType = room.callType;
                    room.clients.push(ws);
                    console.log(`Client joined room ${roomId}. Type: ${actualCallType}. Room size: ${room.clients.length}`);
                }

                 // Store room reference on the WebSocket object for easier cleanup on close
                ws.roomId = roomId;

                // Notify client they joined and the established call type
                ws.send(JSON.stringify({
                    type: 'joined',
                    roomId: roomId,
                    isInitiator: isInitiator,
                    callType: actualCallType // Send the actual call type
                }));

                // If two clients are now in the room, notify the first one (initiator)
                if (!isInitiator && room.clients.length === 2) {
                    const initiator = room.clients[0];
                    if (initiator && initiator.readyState === WebSocket.OPEN) {
                       initiator.send(JSON.stringify({
                           type: 'peer_joined',
                           roomId: roomId,
                           callType: actualCallType // Also send call type here
                        }));
                       console.log(`Notified initiator in room ${roomId} that peer joined. Type: ${actualCallType}`);
                    } else {
                        console.warn(`Initiator in room ${roomId} is not connected.`);
                    }
                }
                break;

            // Relay messages (offer, answer, candidate) - NO CHANGE NEEDED HERE
            case 'offer':
            case 'answer':
            case 'candidate':
                const targetRoom = rooms[currentRoomId];
                if (!targetRoom) {
                     console.error(`Cannot relay message: Client not in a valid room (${currentRoomId}).`);
                     ws.send(JSON.stringify({ type: 'error', message: 'Not connected to a room.' }));
                     return;
                }
                // Find the other client in the room
                const otherClient = targetRoom.clients.find(client => client !== ws);
                if (otherClient && otherClient.readyState === WebSocket.OPEN) {
                    console.log(`Relaying ${data.type} in room ${currentRoomId}`);
                    otherClient.send(message.toString()); // Forward the raw message
                } else {
                     console.log(`Cannot relay ${data.type}: Other client not found or not connected in room ${currentRoomId}.`);
                     if (data.type !== 'candidate') {
                        ws.send(JSON.stringify({ type: 'peer_unavailable', message: 'The other peer is not connected.' }));
                     }
                }
                break;

            // Hangup - NO CHANGE NEEDED IN CORE LOGIC, cleanup uses ws.roomId
            case 'hangup':
                 const roomToHangup = rooms[currentRoomId];
                 if (!roomToHangup) {
                     console.warn(`Cannot process hangup: Client not in a valid room (${currentRoomId}).`);
                     return;
                 }
                 const peerToNotify = roomToHangup.clients.find(client => client !== ws);
                 if (peerToNotify && peerToNotify.readyState === WebSocket.OPEN) {
                      console.log(`Relaying hangup in room ${currentRoomId}`);
                      peerToNotify.send(JSON.stringify({ type: 'peer_hangup' }));
                 }
                 // Cleanup handled in 'close' event now
                 break;

            default:
                console.warn('Unknown message type:', data.type);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        const closedRoomId = ws.roomId; // Get room ID stored on the WS object
        if (closedRoomId && rooms[closedRoomId]) {
            console.log(`Removing client from room ${closedRoomId}`);
            const room = rooms[closedRoomId];

            // Remove the client from the room array
            room.clients = room.clients.filter(client => client !== ws);

             // Notify the remaining client if they exist and are connected
            if (room.clients.length === 1) {
                 const remainingClient = room.clients[0];
                 if (remainingClient && remainingClient.readyState === WebSocket.OPEN) {
                      remainingClient.send(JSON.stringify({ type: 'peer_left' }));
                      console.log(`Notified peer in room ${closedRoomId} that the other client left.`);
                 }
            }

            // If the room is now empty, delete it
            if (room.clients.length === 0) {
                console.log(`Room ${closedRoomId} is now empty. Deleting room.`);
                delete rooms[closedRoomId];
            }
        }
        // No need to clear currentRoomId here as it's local to the connection handler
    });

    ws.on('error', (error) => {
        console.error('WebSocket error:', error);
        // Cleanup handled in 'close' event, which usually follows 'error'
    });
});