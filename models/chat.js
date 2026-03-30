const mongoose = require('mongoose');

const chatSchema = new mongoose.Schema({
  participants: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });

const randomChatSchema = new mongoose.Schema({
  hostId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  guestId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });

const messageSchema = new mongoose.Schema({
  // refPath allows this message to belong to either a Chat or a RandomChat
  chatId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: 'chatModel' },
  chatModel: { type: String, required: true, enum: ['Chat', 'RandomChat'] },
  sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  text: String,
  replyTo: { type: mongoose.Schema.Types.ObjectId, ref: 'Message' }, // Self-reference for replies
  react: String,
  imagesFiles: [String], // image path ( using multer )
  otherFiles: [String],
}, { timestamps: true });

// Indexing for fast retrieval of a conversation's history
messageSchema.index({ chatId: 1, createdAt: -1 });

const Chat = mongoose.model('Chat', chatSchema);
const RandomChat = mongoose.model('RandomChat', randomChatSchema);
const Message = mongoose.model('Message', messageSchema);

module.exports = {
  Chat,
  RandomChat,
  Message
};