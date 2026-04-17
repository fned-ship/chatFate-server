const multer = require('multer');
const path = require('path');
const { Chat, RandomChat, Message } = require('../models/chat');
const { User } = require('../models/user');
const { protect } = require("./auth");
const { putObject, deleteObject } = require("../s3Client.js");

const BUCKET_NAME = process.env.R2_BUCKET_NAME;

// ── Multer setup (Memory Storage for Vercel) ──────────────────────────────────
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 } // 10 MB per file (Adjusted for R2 testing)
});

// ── Helpers ───────────────────────────────────────────────────────────────────
const PAGE_SIZE = 30;

// Helper to upload multiple files to R2 and return keys
const uploadToR2 = async (files, folder) => {
  if (!files || files.length === 0) return [];
  
  return Promise.all(files.map(async (file) => {
    const ext = path.extname(file.originalname);
    const key = `${folder}/${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`;
    await putObject(BUCKET_NAME, key, file.buffer);
    return key;
  }));
};

const paginateMessages = async (chatId, chatModel, page = 1) => {
  const skip = (page - 1) * PAGE_SIZE;
  return Message.find({ chatId, chatModel })
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(PAGE_SIZE)
    .populate('sender', 'firstName lastName userName photo')
    .populate('replyTo', 'text sender imagesFiles otherFiles');
};

// ── FRIENDS CHAT ──────────────────────────────────────────────────────────────

const getOrCreateChat = async (req, res) => {
  try {
    const userId = req.user.id;
    const { participantId } = req.body;

    if (!participantId || userId === participantId) 
        return res.status(400).json({ message: 'Invalid participantId.' });

    const me = await User.findById(userId);
    if (!me.friends.map(String).includes(participantId)) {
      return res.status(403).json({ message: 'You can only chat with friends.' });
    }

    let chat = await Chat.findOne({ participants: { $all: [userId, participantId], $size: 2 } });
    if (!chat) chat = await Chat.create({ participants: [userId, participantId] });

    await chat.populate('participants', 'firstName lastName userName photo online');
    res.status(200).json(chat);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const sendChatMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { chatId } = req.params;
    const { text, replyTo } = req.body;

    const chat = await Chat.findById(chatId);
    if (!chat || !chat.participants.map(String).includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const files = req.files || {};
    
    // Upload images and files to separate "folders" in R2
    const imagesFiles = await uploadToR2(files['images'], 'images');
    const otherFiles = await uploadToR2(files['files'], 'files');

    if (!text && imagesFiles.length === 0 && otherFiles.length === 0) {
      return res.status(400).json({ message: 'Message cannot be empty.' });
    }

    const message = await Message.create({
      chatId,
      chatModel: 'Chat',
      sender: userId,
      text,
      replyTo: replyTo || null,
      imagesFiles,
      otherFiles
    });

    await Chat.findByIdAndUpdate(chatId, { updatedAt: new Date() });
    await message.populate([
      { path: 'sender', select: 'firstName lastName userName photo' },
      { path: 'replyTo', select: 'text sender imagesFiles otherFiles' }
    ]);

    if (req.io) req.io.to(`chat:${chatId}`).emit('new_message', message);
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── RANDOM CHAT ───────────────────────────────────────────────────────────────

const sendRandomChatMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { randomChatId } = req.params;
    const { text, replyTo } = req.body;

    const rc = await RandomChat.findById(randomChatId);
    if (!rc || ![rc.hostId.toString(), rc.guestId.toString()].includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }

    const files = req.files || {};
    const imagesFiles = await uploadToR2(files['images'], 'images');
    const otherFiles = await uploadToR2(files['files'], 'files');

    const message = await Message.create({
      chatId: randomChatId,
      chatModel: 'RandomChat',
      sender: userId,
      text,
      replyTo: replyTo || null,
      imagesFiles,
      otherFiles
    });

    await message.populate([
      { path: 'sender', select: 'firstName lastName userName photo' },
      { path: 'replyTo', select: 'text sender imagesFiles otherFiles' }
    ]);

    if (req.io) req.io.to(`random:${randomChatId}`).emit('new_message', message);
    res.status(201).json(message);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── CLEANUP / DELETE ─────────────────────────────────────────────────────────

const deleteMessage = async (req, res) => {
  try {
    const userId = req.user.id;
    const { messageId } = req.params;

    const message = await Message.findById(messageId);
    if (!message) return res.status(404).json({ message: 'Message not found.' });
    if (message.sender.toString() !== userId) return res.status(403).json({ message: 'Denied.' });

    // Delete attached files from R2
    const allFiles = [...message.imagesFiles, ...message.otherFiles];
    await Promise.allSettled(allFiles.map(key => deleteObject(BUCKET_NAME, key)));

    const room = message.chatModel === 'Chat' ? `chat:${message.chatId}` : `random:${message.chatId}`;
    await Message.findByIdAndDelete(messageId);

    if (req.io) req.io.to(room).emit('message_deleted', { messageId });
    res.status(200).json({ message: 'Message deleted.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const endRandomChat = async (req, res) => {
    try {
      const userId = req.user.id;
      const { randomChatId } = req.params;
      const rc = await RandomChat.findById(randomChatId);
      
      if (!rc || ![rc.hostId.toString(), rc.guestId.toString()].includes(userId)) {
        return res.status(403).json({ message: 'Access denied.' });
      }
  
      // Find all messages to delete their R2 assets
      const messages = await Message.find({ chatId: randomChatId, chatModel: 'RandomChat' });
      const allKeys = messages.reduce((acc, m) => acc.concat(m.imagesFiles, m.otherFiles), []);
      
      await Promise.allSettled(allKeys.map(key => deleteObject(BUCKET_NAME, key)));
      await Message.deleteMany({ chatId: randomChatId, chatModel: 'RandomChat' });
      await RandomChat.findByIdAndDelete(randomChatId);
  
      if (req.io) req.io.to(`random:${randomChatId}`).emit('chat_ended', { randomChatId });
      res.status(200).json({ message: 'Random chat ended.' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  };

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


const getAllRandomChatMessages = async (req, res) => {
  try {
    const userId = req.user.id;
    const { randomChatId } = req.params;

    const rc = await RandomChat.findById(randomChatId);
    if (!rc) return res.status(404).json({ message: 'Random chat not found.' });

    const participants = [rc.hostId.toString(), rc.guestId.toString()];
    if (!participants.includes(userId)) {
      return res.status(403).json({ message: 'Access denied.' });
    }


    const messages = await Message.find({ chatId: randomChatId, chatModel: 'RandomChat' })
      .sort({ createdAt: 1 }) // 1 sorts in ascending order (oldest first)
      .populate('sender', 'firstName lastName userName photo')
      .populate('replyTo', 'text sender imagesFiles otherFiles');


    res.status(200).json({ messages });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};


const ChatRoutes = (router) => {
  const uploadFields = upload.fields([
    { name: 'images', maxCount: 5 },
    { name: 'files', maxCount: 5 }
  ]);



  router.post('/api/chats', protect, getOrCreateChat);
  router.get('/api/chats', protect, getMyChats);
  router.get('/api/chats/:chatId/messages', protect, getChatMessages);
  router.post('/api/chats/:chatId/messages', protect, uploadFields, sendChatMessage);

  router.post('/api/random-chats', protect, createRandomChat);
  router.get   ('/api/random-chats/:randomChatId/messages',protect,   getRandomChatMessages);
  router.post('/api/random-chats/:randomChatId/messages', protect, uploadFields, sendRandomChatMessage);
  router.delete('/api/random-chats/:randomChatId', protect, endRandomChat);

  router.get   ('/api/random-chats/get-all-messages/:randomChatId',protect, getAllRandomChatMessages);

  router.put('/api/messages/:messageId/react', protect,reactToMessage);
  router.delete('/api/messages/:messageId', protect, deleteMessage);
};

module.exports = ChatRoutes;