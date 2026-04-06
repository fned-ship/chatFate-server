const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const { User, Interest } = require('../models/user');
const {protect} = require("./auth");
const { Chat, RandomChat, Message } = require('../models/chat');

// ── Multer setup ──────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'public', 'avatars');

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => {
    const ext      = path.extname(file.originalname);
    const filename = `profile_${req.user.id}_${Date.now()}${ext}`;
    cb(null, filename);
  }
});

const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const isValid  = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase());
  isValid ? cb(null, true) : cb(new Error('Only image files are allowed (jpeg, jpg, png, webp).'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 } // 5 MB
});

// ── Helper: delete file from disk ─────────────────────────────────────────────
const deleteFile = (filePath) => {
  if (!filePath) return;
  const abs = path.join(__dirname, '..', 'public', 'avatars', filePath);
  fs.unlink(abs, (err) => {
    if (err && err.code !== 'ENOENT') console.error('File delete error:', err);
  });
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * PUT /api/profile
 * Edit profile information. Accepts multipart/form-data.
 * Fields: firstName, lastName, userName, birthDate, country, sex
 * File:   photo (optional)
 */
const editProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user   = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const { firstName, lastName, userName, birthDate, country, sex } = req.body;


    // Only update fields that were actually sent
    if (firstName) user.firstName = firstName;
    if (lastName)  user.lastName  = lastName;
    if (sex)       user.sex       = sex;
    if (country)   user.country   = country;
    if (birthDate) user.birthDate = new Date(birthDate);

    // Username uniqueness check
    if (userName && userName !== user.userName) {
      const taken = await User.findOne({ userName, _id: { $ne: userId } });
      if (taken) {
        // Rollback uploaded file if username is taken
        if (req.file) deleteFile(user.photo);
        return res.status(409).json({ message: 'Username is already taken.' });
      }
      user.userName = userName;
    }


    if (req.file) {
      deleteFile(user.photo);
      user.photo = req.file.filename;
    }

    await user.save();

    const { password, verificationToken, ...safeUser } = user.toObject();
    res.status(200).json({ message: 'Profile updated successfully.', user: safeUser });
  } catch (error) {
    // If Mongo throws a duplicate key error (e.g. userName)
    if (error.code === 11000) {
      return res.status(409).json({ message: 'Username or email is already in use.' });
    }
    res.status(500).json({ error: error.message });
  }
};

/**
 * PUT /api/profile/interests
 * Replace the user's interests with a new list.
 * Body: { interests: ["interestId1", "interestId2", ...] }
 *    OR { interests: [{ name, category }, ...] }  ← creates missing interests
 */
const editInterests = async (req, res) => {
  try {
    const userId = req.user.id;
    let { interests } = req.body;

    if (!Array.isArray(interests) || interests.length === 0) {
      return res.status(400).json({ message: 'interests must be a non-empty array.' });
    }

    let interestIds = [];

    // Detect if caller sent objects { name, category } or plain IDs (strings)
    if (typeof interests[0] === 'object' && interests[0] !== null) {
      // Upsert each interest by name
      const ops = interests.map(({ name, category }) =>
        Interest.findOneAndUpdate(
          { name: name.toLowerCase() },
          { name: name.toLowerCase(), category },
          { upsert: true, new: true, setDefaultsOnInsert: true }
        )
      );
      const results = await Promise.all(ops);
      interestIds   = results.map((i) => i._id);
    } else {
      // Assume plain ObjectId strings — validate they exist
      const found = await Interest.find({ _id: { $in: interests } });
      if (found.length !== interests.length) {
        return res.status(400).json({ message: 'One or more interest IDs are invalid.' });
      }
      interestIds = found.map((i) => i._id);
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: { interests: interestIds } },
      { new: true }
    ).populate('interests');

    res.status(200).json({ message: 'Interests updated.', interests: user.interests });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/friends/request/:targetId
 * Send a friend request to another user.
 */
const sendFriendRequest = async (req, res) => {
  try {
    const senderId   = req.user.id;
    const { targetId } = req.params;

    if (senderId === targetId) {
      return res.status(400).json({ message: 'You cannot send a friend request to yourself.' });
    }

    const [sender, target] = await Promise.all([
      User.findById(senderId),
      User.findById(targetId)
    ]);

    if (!target) return res.status(404).json({ message: 'User not found.' });

    // Already friends?
    if (sender.friends.map(String).includes(targetId)) {
      return res.status(409).json({ message: 'You are already friends.' });
    }

    // Request already sent?
    if (target.requests.map(String).includes(senderId)) {
      return res.status(409).json({ message: 'Friend request already sent.' });
    }

    // Did the target already send us a request? → auto-accept
    if (sender.requests.map(String).includes(targetId)) {
      await Promise.all([
        User.findByIdAndUpdate(senderId, {
          $push: { friends: targetId },
          $pull: { requests: targetId }
        }),
        User.findByIdAndUpdate(targetId, {
          $push: { friends: senderId },
          $pull: { requests: senderId }
        })
      ]);
      return res.status(200).json({ message: 'You were already requested by this user — now friends!' });
    }

    // Add senderId to target's requests array
    await User.findByIdAndUpdate(targetId, { $addToSet: { requests: senderId } });

    res.status(200).json({ message: 'Friend request sent.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/friends/accept/:requesterId
 * Accept a pending friend request.
 */
const acceptFriendRequest = async (req, res) => {
  try {
    const userId       = req.user.id;
    const { requesterId } = req.params;

    const user = await User.findById(userId);

    // Check the request exists
    if (!user.requests.map(String).includes(requesterId)) {
      return res.status(404).json({ message: 'No friend request from this user.' });
    }

    await Promise.all([
      // Add each other as friends & remove the request
      User.findByIdAndUpdate(userId, {
        $push: { friends: requesterId },
        $pull: { requests: requesterId }
      }),
      User.findByIdAndUpdate(requesterId, {
        $push: { friends: userId }
      })
    ]);

    //if (!participantId) return res.status(400).json({ message: 'participantId is required.' });
        const participantId=requesterId ;
        if (userId === participantId) return res.status(400).json({ message: 'Cannot chat with yourself.' });
    
        // Find existing chat between these two users
        let chat = await Chat.findOne({
          participants: { $all: [userId, participantId], $size: 2 }
        });
    
        if (!chat) {
          chat = await Chat.create({ participants: [userId, participantId] });
        }
    
        await chat.populate('participants', 'firstName lastName userName photo online');

    res.status(200).json({ message: 'Friend request accepted.' , chat });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * DELETE /api/friends/request/:requesterId
 * Decline / delete a pending friend request.
 */
const declineFriendRequest = async (req, res) => {
  try {
    const userId          = req.user.id;
    const { requesterId } = req.params;

    const user = await User.findById(userId);

    if (!user.requests.map(String).includes(requesterId)) {
      return res.status(404).json({ message: 'No friend request from this user.' });
    }

    await User.findByIdAndUpdate(userId, { $pull: { requests: requesterId } });

    res.status(200).json({ message: 'Friend request declined.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * DELETE /api/friends/:friendId
 * Remove an existing friend.
 */
const removeFriend = async (req, res) => {
  try {
    const userId      = req.user.id;
    const { friendId } = req.params;

    await Promise.all([
      User.findByIdAndUpdate(userId,   { $pull: { friends: friendId } }),
      User.findByIdAndUpdate(friendId, { $pull: { friends: userId   } })
    ]);

    res.status(200).json({ message: 'Friend removed.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};
/**
 * GET /api/friends/requests
 * Get all pending friend requests for the logged-in user.
 */
const getFriendRequests = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find the user and populate the 'requests' array with specific fields
    const user = await User.findById(userId)
      .populate('requests', 'firstName lastName userName photo online');

    if (!user) {
      return res.status(404).json({ message: 'User not found.' });
    }

    // Return the populated requests array (or an empty array if none)
    res.status(200).json(user.requests || []);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────
const UserRoutes = (router) => {
  // Profile
  router.put('/api/profile', protect , upload.single('photo'), editProfile);
  router.put('/api/profile/interests', protect ,  editInterests);

  // Friends
  router.get ('/api/friends/requests', protect, getFriendRequests);
  router.post  ('/api/friends/request/:targetId', protect ,  sendFriendRequest);
  router.post  ('/api/friends/accept/:requesterId', protect , acceptFriendRequest);
  router.delete('/api/friends/request/:requesterId', protect , declineFriendRequest);
  router.delete('/api/friends/:friendId', protect , removeFriend);
};

module.exports = UserRoutes;