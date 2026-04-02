const { Chat, RandomChat, Message } = require('./models/chat');

module.exports = (io) => {

  // ── Auth middleware ──────────────────────────────────────────────────────────
  io.use((socket, next) => {
    const userId = socket.handshake.auth?.userId;
    if (!userId) return next(new Error('Authentication error: userId required.'));
    socket.userId = userId;
    next();
  });

  // ── Connection ───────────────────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const userId = socket.userId;
    console.log(`[Socket] Connected: ${userId} (${socket.id})`);

    // Track which randomChat rooms this socket is in so we can
    // notify the partner on abrupt disconnect (tab close, network drop, etc.)
    const activeRandomChats = new Set();

    // ── Personal room (used by matchmaking partner_found) ──────────────────
    socket.join(userId);

    socket.on('join', (uid) => {
      socket.join(uid);
    });

    // ── WebRTC signaling ───────────────────────────────────────────────────
    socket.emit('me', socket.id);

    socket.on('callUser', ({ userToCall, signalData, from }) => {
      console.log(`[RTC] ${userId} is calling user room: ${userToCall}`);
      io.to(userToCall).emit('callUser', {
        signal: signalData,
        from:   userId,        // always DB userId, not socket ID
      });
    });

    socket.on('answerCall', (data) => {
      console.log(`[RTC] ${userId} answered call from: ${data.to}`);
      io.to(data.to).emit('callAccepted', data.signal);
    });

    // 
    socket.on('callee_ready', ({ to }) => {
      console.log(`[Signal] callee_ready: relaying to initiator ${to}`);
      io.to(to).emit('callee_ready');
    });

    // ── Friend chat ────────────────────────────────────────────────────────

    socket.on('join_chat', async ({ chatId }) => {
      try {
        const chat = await Chat.findById(chatId);
        if (!chat) return socket.emit('error', { message: 'Chat not found.' });
        if (!chat.participants.map(String).includes(userId))
          return socket.emit('error', { message: 'Access denied to this chat.' });

        socket.join(`chat:${chatId}`);
        socket.emit('joined_chat', { chatId });
        console.log(`[Socket] ${userId} joined chat:${chatId}`);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('leave_chat', ({ chatId }) => {
      socket.leave(`chat:${chatId}`);
      socket.emit('left_chat', { chatId });
    });

    socket.on('send_message', async ({ chatId, text, replyTo }) => {
      try {
        if (!text?.trim()) return socket.emit('error', { message: 'Message text is required.' });

        const chat = await Chat.findById(chatId);
        if (!chat) return socket.emit('error', { message: 'Chat not found.' });
        if (!chat.participants.map(String).includes(userId))
          return socket.emit('error', { message: 'Access denied.' });

        const message = await Message.create({
          chatId,
          chatModel: 'Chat',
          sender:    userId,
          text:      text.trim(),
          replyTo:   replyTo || null,
        });

        await Chat.findByIdAndUpdate(chatId, { updatedAt: new Date() });
        await message.populate([
          { path: 'sender',  select: 'firstName lastName userName photo' },
          { path: 'replyTo', select: 'text sender' },
        ]);

        io.to(`chat:${chatId}`).emit('new_message', message);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('typing',      ({ chatId }) => socket.to(`chat:${chatId}`).emit('typing',      { userId, chatId }));
    socket.on('stop_typing', ({ chatId }) => socket.to(`chat:${chatId}`).emit('stop_typing', { userId, chatId }));

    // ── Random chat ────────────────────────────────────────────────────────

    socket.on('join_random_chat', async ({ randomChatId }) => {
      try {
        const rc = await RandomChat.findById(randomChatId);
        if (!rc) return socket.emit('error', { message: 'Random chat not found.' });

        const participants = [rc.hostId.toString(), rc.guestId.toString()];
        if (!participants.includes(userId))
          return socket.emit('error', { message: 'Access denied to this random chat.' });

        socket.join(`random:${randomChatId}`);
        activeRandomChats.add(randomChatId);   // ← track for disconnect handling
        socket.emit('joined_random_chat', { randomChatId });
        socket.to(`random:${randomChatId}`).emit('partner_joined', { userId, randomChatId });

        console.log(`[Socket] ${userId} joined random:${randomChatId}`);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('leave_random_chat', ({ randomChatId }) => {
      // Explicit leave: Skip button, page navigation with cleanup
      socket.to(`random:${randomChatId}`).emit('partner_left', {
        userId,
        randomChatId,
        message: 'Your chat partner has left the session.',
      });
      socket.leave(`random:${randomChatId}`);
      activeRandomChats.delete(randomChatId);  // ← stop tracking
      socket.emit('left_random_chat', { randomChatId });
      console.log(`[Socket] ${userId} left random:${randomChatId}`);
    });

    socket.on('send_random_message', async ({ randomChatId, text, replyTo }) => {
      try {
        if (!text?.trim()) return socket.emit('error', { message: 'Message text is required.' });

        const rc = await RandomChat.findById(randomChatId);
        if (!rc) return socket.emit('error', { message: 'Random chat not found.' });

        const participants = [rc.hostId.toString(), rc.guestId.toString()];
        if (!participants.includes(userId))
          return socket.emit('error', { message: 'Access denied.' });

        const message = await Message.create({
          chatId:    randomChatId,
          chatModel: 'RandomChat',
          sender:    userId,
          text:      text.trim(),
          replyTo:   replyTo || null,
        });

        await message.populate([
          { path: 'sender',  select: 'firstName lastName userName photo' },
          { path: 'replyTo', select: 'text sender' },
        ]);

        io.to(`random:${randomChatId}`).emit('new_message', message);
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    socket.on('random_typing',      ({ randomChatId }) => socket.to(`random:${randomChatId}`).emit('typing',      { userId, randomChatId }));
    socket.on('random_stop_typing', ({ randomChatId }) => socket.to(`random:${randomChatId}`).emit('stop_typing', { userId, randomChatId }));

    // ── React / Delete (both chat types) ──────────────────────────────────

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

    socket.on('delete_message', async ({ messageId }) => {
      try {
        const message = await Message.findById(messageId);
        if (!message) return socket.emit('error', { message: 'Message not found.' });
        if (message.sender.toString() !== userId)
          return socket.emit('error', { message: 'You can only delete your own messages.' });

        const room = message.chatModel === 'Chat'
          ? `chat:${message.chatId}`
          : `random:${message.chatId}`;

        await Message.findByIdAndDelete(messageId);
        io.to(room).emit('message_deleted', { messageId });
      } catch (err) {
        socket.emit('error', { message: err.message });
      }
    });

    // ── Disconnect — covers tab close / network drop / page refresh ────────
    socket.on('disconnect', () => {
      console.log(`[Socket] Disconnected: ${userId} (${socket.id})`);

      // Notify the partner in every random chat this socket was part of
      for (const randomChatId of activeRandomChats) {
        socket.to(`random:${randomChatId}`).emit('partner_left', {
          userId,
          randomChatId,
          message: 'Your chat partner has disconnected.',
        });
        console.log(`[Socket] partner_left emitted for random:${randomChatId}`);
      }

      activeRandomChats.clear();
    });
  });
};