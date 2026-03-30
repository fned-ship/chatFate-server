const { Chat, RandomChat, Message } = require('./models/chat');

/**
 * Attach all Socket.io event handlers.
 * Call this once after creating your io instance:
 *
 *   const io = require('socket.io')(server);
 *   require('./socketHandler')(io);
 *
 * The client must send a valid userId on connection:
 *   const socket = io('http://localhost:5000', { auth: { userId: '...' } });
 */
module.exports = (io) => {
  //--------------------- webRTC ------------------------------



  //-------------------------------------------------------------


  // ── Auth middleware ─────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId) return next(new Error('Authentication error: userId required.'));
    socket.userId = userId;
    next();
  });

  // ── Connection ──────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {

    const userId = socket.userId;
    console.log(`[Socket] Connected: ${userId} (${socket.id})`);

    //--------------------- webRTC ------------------------------
          console.log("User connected:", socket.id);

          // Send your ID to yourself so you know who you are
          socket.emit("me", socket.id);

          // Forward the call request to a specific user
          socket.on("callUser", ({ userToCall, signalData, from }) => {
              io.to(userToCall).emit("callUser", { signal: signalData, from });
          });

          // Forward the answer back to the caller
          socket.on("answerCall", (data) => {
              io.to(data.to).emit("callAccepted", data.signal);
          });
    //---------------------  ------------------------------

    //
    socket.on('join', (userId) => {
        socket.join(userId);
    });

    // Join a personal room so we can target this user directly
    // (used by matchmaking partner_found event)
    socket.join(userId);

    // ────────────────────────────────────────────────────────────────────────
    // FRIEND CHAT EVENTS
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Join a friend chat room.
     * Client emits: { chatId }
     */
    socket.on('join_chat', async ({ chatId }) => {
      try {
        const chat = await Chat.findById(chatId);
        if (!chat) return socket.emit('error', { message: 'Chat not found.' });

        if (!chat.participants.map(String).includes(userId)) {
          return socket.emit('error', { message: 'Access denied to this chat.' });
        }

        socket.join(`chat:${chatId}`);
        socket.emit('joined_chat', { chatId });
        console.log(`[Socket] ${userId} joined chat:${chatId}`);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    /**
     * Leave a friend chat room.
     * Client emits: { chatId }
     */
    socket.on('leave_chat', ({ chatId }) => {
      socket.leave(`chat:${chatId}`);
      socket.emit('left_chat', { chatId });
    });

    /**
     * Send a text message in a friend chat (socket path — no file support here, use REST for files).
     * Client emits: { chatId, text, replyTo? }
     * Broadcasts: 'new_message' to room chat:${chatId}
     */
    socket.on('send_message', async ({ chatId, text, replyTo }) => {
      try {
        if (!text?.trim()) {
          return socket.emit('error', { message: 'Message text is required.' });
        }

        const chat = await Chat.findById(chatId);
        if (!chat) return socket.emit('error', { message: 'Chat not found.' });

        if (!chat.participants.map(String).includes(userId)) {
          return socket.emit('error', { message: 'Access denied.' });
        }

        const message = await Message.create({
          chatId,
          chatModel: 'Chat',
          sender:    userId,
          text:      text.trim(),
          replyTo:   replyTo || null
        });

        await Chat.findByIdAndUpdate(chatId, { updatedAt: new Date() });

        await message.populate([
          { path: 'sender',  select: 'firstName lastName userName photo' },
          { path: 'replyTo', select: 'text sender' }
        ]);

        io.to(`chat:${chatId}`).emit('new_message', message);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    /**
     * Typing indicator for friend chat.
     * Client emits: { chatId }
     * Broadcasts: 'typing' to others in the room
     */
    socket.on('typing', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('typing', { userId, chatId });
    });

    socket.on('stop_typing', ({ chatId }) => {
      socket.to(`chat:${chatId}`).emit('stop_typing', { userId, chatId });
    });

    // ────────────────────────────────────────────────────────────────────────
    // RANDOM CHAT EVENTS
    // ────────────────────────────────────────────────────────────────────────

    /**
     * Join a random chat room.
     * Client emits: { randomChatId }
     */
    socket.on('join_random_chat', async ({ randomChatId }) => {
      try {
        const rc = await RandomChat.findById(randomChatId);
        if (!rc) return socket.emit('error', { message: 'Random chat not found.' });

        const participants = [rc.hostId.toString(), rc.guestId.toString()];
        if (!participants.includes(userId)) {
          return socket.emit('error', { message: 'Access denied to this random chat.' });
        }

        socket.join(`random:${randomChatId}`);
        socket.emit('joined_random_chat', { randomChatId });

        // Notify the other participant that their partner has joined
        socket.to(`random:${randomChatId}`).emit('partner_joined', { userId, randomChatId });

        console.log(`[Socket] ${userId} joined random:${randomChatId}`);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    /**
     * Leave a random chat room.
     * Client emits: { randomChatId }
     * Notifies the other participant.
     */
    socket.on('leave_random_chat', ({ randomChatId }) => {
      socket.to(`random:${randomChatId}`).emit('partner_left', {
        userId,
        randomChatId,
        message: 'Your chat partner has left the session.'
      });
      socket.leave(`random:${randomChatId}`);
      socket.emit('left_random_chat', { randomChatId });
    });

    /**
     * Send a text message in a random chat (socket path — no files, use REST for files).
     * Client emits: { randomChatId, text, replyTo? }
     * Broadcasts: 'new_message' to room random:${randomChatId}
     */
    socket.on('send_random_message', async ({ randomChatId, text, replyTo }) => {
      try {
        if (!text?.trim()) {
          return socket.emit('error', { message: 'Message text is required.' });
        }

        const rc = await RandomChat.findById(randomChatId);
        if (!rc) return socket.emit('error', { message: 'Random chat not found.' });

        const participants = [rc.hostId.toString(), rc.guestId.toString()];
        if (!participants.includes(userId)) {
          return socket.emit('error', { message: 'Access denied.' });
        }

        const message = await Message.create({
          chatId:    randomChatId,
          chatModel: 'RandomChat',
          sender:    userId,
          text:      text.trim(),
          replyTo:   replyTo || null
        });

        await message.populate([
          { path: 'sender',  select: 'firstName lastName userName photo' },
          { path: 'replyTo', select: 'text sender' }
        ]);

        io.to(`random:${randomChatId}`).emit('new_message', message);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    /**
     * Typing indicator for random chat.
     */
    socket.on('random_typing', ({ randomChatId }) => {
      socket.to(`random:${randomChatId}`).emit('typing', { userId, randomChatId });
    });

    socket.on('random_stop_typing', ({ randomChatId }) => {
      socket.to(`random:${randomChatId}`).emit('stop_typing', { userId, randomChatId });
    });

    /**
     * React to a message (works for both chat types).
     * Client emits: { messageId, react }
     * Broadcasts: 'message_reacted' to the correct room
     */
    socket.on('react_message', async ({ messageId, react }) => {
      try {
        if (!react) return socket.emit('error', { message: 'react is required.' });

        const message = await Message.findByIdAndUpdate(
          messageId,
          { $set: { react } },
          { new: true }
        ).populate('sender', 'firstName lastName userName photo');

        if (!message) return socket.emit('error', { message: 'Message not found.' });

        const room = message.chatModel === 'Chat'
          ? `chat:${message.chatId}`
          : `random:${message.chatId}`;

        io.to(room).emit('message_reacted', message);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    /**
     * Delete a message (only sender can delete).
     * Client emits: { messageId }
     * Broadcasts: 'message_deleted' to the correct room
     */
    socket.on('delete_message', async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return socket.emit('error', { message: 'Message not found.' });

        if (message.sender.toString() !== userId) {
          return socket.emit('error', { message: 'You can only delete your own messages.' });
        }

        const room = message.chatModel === 'Chat'
          ? `chat:${message.chatId}`
          : `random:${message.chatId}`;

        await Message.findByIdAndDelete(messageId);
        io.to(room).emit('message_deleted', { messageId });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ────────────────────────────────────────────────────────────────────────
    // DISCONNECT
    // ────────────────────────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${userId} (${socket.id})`);
    });
  });
};