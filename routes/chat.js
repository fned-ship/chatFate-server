const path    = require('path');
const fs      = require('fs');
const multer  = require('multer');
const { Chat, RandomChat, Message } = require('../models/chat');
const { User } = require('../models/user');
const {protect} = require("./auth");

// ── Multer setup ──────────────────────────────────────────────────────────────
const IMAGES_DIR = path.join(__dirname, '..', 'public','images');
const FILES_DIR  = path.join(__dirname, '..', 'public','files');

[IMAGES_DIR, FILES_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const isImage = file.mimetype.startsWith('image/');
    cb(null, isImage ? IMAGES_DIR : FILES_DIR);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  }
});

const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB per file
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const PAGE_SIZE = 30;

const paginateMessages = async (chatId, chatModel, page = 1) => {
  const skip = (page - 1) * PAGE_SIZE;
  return Message.find({ chatId, chatModel })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(PAGE_SIZE)
    .populate('sender',  'firstName lastName userName photo')
    .populate('replyTo', 'text sender imagesFiles otherFiles');
};

// ── FRIENDS CHAT ──────────────────────────────────────────────────────────────

/**
 * POST /api/chats
 * Create or retrieve a 1-on-1 friend chat.
 * Body: { participantId }
 */
const getOrCreateChat = async (req, res) => {
  try {
    const userId        = req.user.id;
    const { participantId } = req.body;

    if (!participantId) return res.status(400).json({ message: 'participantId is required.' });
    if (userId === participantId) return res.status(400).json({ message: 'Cannot chat with yourself.' });

    // Check they are friends
    const me = await User.findById(userId);
    if (!me.friends.map(String).includes(participantId)) {
      return res.status(403).json({ message: 'You can only chat with friends.' });
    }

    // Find existing chat between these two users
    let chat = await Chat.findOne({
      participants: { $all: [userId, participantId], $size: 2 }
    });

    if (!chat) {
      chat = await Chat.create({ participants: [userId, participantId] });
    }

    await chat.populate('participants', 'firstName lastName userName photo online');
    res.status(200).json(chat);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/chats
 * Get all friend chats for the current user.
 */
const getMyChats = async (req, res) => {
  try {
    const userId = req.user.id;

    const chats = await Chat.find({ participants: userId })
      .populate('participants', 'firstName lastName userName photo online')
      .sort({ updatedAt: -1 });

    // Attach last message to each chat
    const withLastMsg = await Promise.all(
      chats.map(async (chat) => {
        const lastMsg = await Message.findOne({ chatId: chat._id, chatModel: 'Chat' })
          .sort({ createdAt: -1 })
          .populate('sender', 'firstName lastName userName');
        return { ...chat.toObject(), lastMessage: lastMsg };
      })
    );

    res.status(200).json(withLastMsg);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/chats/:chatId/messages?page=1
 * Get paginated messages for a friend chat.
 */
const getChatMessages = async (req, res) => {
  try {
    const userId  = req.user.id;
    const { chatId } = req.params;
    const page    = parseInt(req.query.page) || 1;

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ message: 'Chat not found.' });

    if (!chat.participants.map(String).includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const messages = await paginateMessages(chatId, 'Chat', page);
    res.status(200).json({ page, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/chats/:chatId/messages
 * Send a message in a friend chat. Supports file uploads.
 * Fields: text, replyTo  |  Files: images[], files[]
 */
const sendChatMessage = async (req, res) => {
  try {
    const userId  = req.user.id;
    const { chatId } = req.params;
    const { text, replyTo } = req.body;

    const chat = await Chat.findById(chatId);
    if (!chat) return res.status(404).json({ message: 'Chat not found.' });

    if (!chat.participants.map(String).includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const files = req.files || {};

    const imagesFiles = (files['images'] || []).map(
      f => f.filename
    );
    const otherFiles  = (files['files'] || []).map(
      f => f.filename
    );

    if (!text && imagesFiles.length === 0 && otherFiles.length === 0) {
      return res.status(400).json({ message: 'Message must have text or at least one file.' });
    }

    const message = await Message.create({
      chatId,
      chatModel: 'Chat',
      sender:    userId,
      text,
      replyTo:   replyTo || null,
      imagesFiles,
      otherFiles
    });

    // Bump chat updatedAt so it sorts to top
    await Chat.findByIdAndUpdate(chatId, { updatedAt: new Date() });

    await message.populate([
      { path: 'sender',  select: 'firstName lastName userName photo' },
      { path: 'replyTo', select: 'text sender imagesFiles otherFiles' }
    ]);

    // Emit via socket (attached to req by middleware)
    if (req.io) {
      req.io.to(`chat:${chatId}`).emit('new_message', message);
    }

    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── RANDOM CHAT ───────────────────────────────────────────────────────────────

/**
 * POST /api/random-chats
 * Create a random chat session between two matched users.
 * Body: { guestId }  (called by the host after match)
 */
const createRandomChat = async (req, res) => {
  try {
    const hostId  = req.user.id;
    const { guestId } = req.body;

    if (!guestId) return res.status(400).json({ message: 'guestId is required.' });

    const randomChat = await RandomChat.create({ hostId, guestId });
    await randomChat.populate([
      { path: 'hostId',  select: 'firstName lastName userName photo' },
      { path: 'guestId', select: 'firstName lastName userName photo' }
    ]);

    res.status(201).json(randomChat);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * GET /api/random-chats/:randomChatId/messages?page=1
 * Get paginated messages for a random chat.
 */
const getRandomChatMessages = async (req, res) => {
  try {
    const userId         = req.user.id;
    const { randomChatId } = req.params;
    const page           = parseInt(req.query.page) || 1;

    const rc = await RandomChat.findById(randomChatId);
    if (!rc) return res.status(404).json({ message: 'Random chat not found.' });

    const participants = [rc.hostId.toString(), rc.guestId.toString()];
    if (!participants.includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const messages = await paginateMessages(randomChatId, 'RandomChat', page);
    res.status(200).json({ page, messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/random-chats/:randomChatId/messages
 * Send a message in a random chat. Supports file uploads.
 */
const sendRandomChatMessage = async (req, res) => {
  try {
    const userId         = req.user.id;
    const { randomChatId } = req.params;
    const { text, replyTo } = req.body;

    const rc = await RandomChat.findById(randomChatId);
    if (!rc) return res.status(404).json({ message: 'Random chat not found.' });

    const participants = [rc.hostId.toString(), rc.guestId.toString()];
    if (!participants.includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const files = req.files || {};

    const imagesFiles = (files['images'] || []).map(
      f => f.filename
    );
    const otherFiles  = (files['files'] || []).map(
      f => f.filename
    );

    if (!text && imagesFiles.length === 0 && otherFiles.length === 0) {
      return res.status(400).json({ message: 'Message must have text or at least one file.' });
    }

    const message = await Message.create({
      chatId:    randomChatId,
      chatModel: 'RandomChat',
      sender:    userId,
      text,
      replyTo:   replyTo || null,
      imagesFiles,
      otherFiles
    });

    await message.populate([
      { path: 'sender',  select: 'firstName lastName userName photo' },
      { path: 'replyTo', select: 'text sender imagesFiles otherFiles' }
    ]);

    if (req.io) {
      req.io.to(`random:${randomChatId}`).emit('new_message', message);
    }

    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * DELETE /api/random-chats/:randomChatId
 * End (delete) a random chat session and all its messages.
 */
const endRandomChat = async (req, res) => {
  try {
    const userId         = req.user.id;
    const { randomChatId } = req.params;

    const rc = await RandomChat.findById(randomChatId);
    if (!rc) return res.status(404).json({ message: 'Random chat not found.' });

    const participants = [rc.hostId.toString(), rc.guestId.toString()];
    if (!participants.includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    // Delete all messages belonging to this random chat
    await Message.deleteMany({ chatId: randomChatId, chatModel: 'RandomChat' });
    await RandomChat.findByIdAndDelete(randomChatId);

    if (req.io) {
      req.io.to(`random:${randomChatId}`).emit('chat_ended', {
        randomChatId,
        message: 'The random chat session has ended.'
      });
    }

    res.status(200).json({ message: 'Random chat ended and deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * PUT /api/messages/:messageId/react
 * Add or update a reaction on a message.
 * Body: { react: "👍" }
 */
const reactToMessage = async (req, res) => {
  try {
    const { messageId } = req.params;
    const { react }     = req.body;

    if (!react) return res.status(400).json({ message: 'react emoji is required.' });

    const message = await Message.findByIdAndUpdate(
      messageId,
      { $set: { react } },
      { returnDocument: 'after' }
    ).populate('sender', 'firstName lastName userName photo');

    if (!message) return res.status(404).json({ message: 'Message not found.' });

    const room = message.chatModel === 'Chat'
      ? `chat:${message.chatId}`
      : `random:${message.chatId}`;

    if (req.io) req.io.to(room).emit('message_reacted', message);

    res.status(200).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * DELETE /api/messages/:messageId
 * Delete a message (only by its sender).
 */
const deleteMessage = async (req, res) => {
  try {
    const userId      = req.user.id;
    const { messageId } = req.params;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: 'Message not found.' });

    if (message.sender.toString() !== userId) {
      return res.status(403).json({ message: 'You can only delete your own messages.' });
    }

    // Delete attached files from disk
    [...message.imagesFiles, ...message.otherFiles].forEach(filePath => {
      const abs = path.join(__dirname, '..', filePath);
      fs.unlink(abs, err => { if (err && err.code !== 'ENOENT') console.error(err); });
    });

    const room = message.chatModel === 'Chat'
      ? `chat:${message.chatId}`
      : `random:${message.chatId}`;

    await Message.findByIdAndDelete(messageId);

    if (req.io) req.io.to(room).emit('message_deleted', { messageId });

    res.status(200).json({ message: 'Message deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────
const ChatRoutes = (router) => {
  const uploadFields = upload.fields([
    { name: 'images', maxCount: 5 },
    { name: 'files',  maxCount: 5 }
  ]);

  // Friend chats
  router.post  ('/api/chats',protect,                      getOrCreateChat);
  router.get   ('/api/chats',protect,                      getMyChats);
  router.get   ('/api/chats/:chatId/messages',protect,     getChatMessages);
  router.post  ('/api/chats/:chatId/messages',protect,     uploadFields, sendChatMessage);

  // Random chats
  router.post  ('/api/random-chats',protect,                          createRandomChat);
  router.get   ('/api/random-chats/:randomChatId/messages',protect,   getRandomChatMessages);
  router.post  ('/api/random-chats/:randomChatId/messages',protect,   uploadFields, sendRandomChatMessage);
  router.delete('/api/random-chats/:randomChatId',protect,            endRandomChat);

  // Messages (shared)
  router.put   ('/api/messages/:messageId/react',protect,  reactToMessage);
  router.delete('/api/messages/:messageId',protect,        deleteMessage);
};

module.exports = ChatRoutes;