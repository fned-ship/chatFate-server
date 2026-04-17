const multer = require('multer');
const path = require('path');
const { User , Interest  } = require('../models/user');
const mongoose = require('mongoose');
// Import your R2 helper functions
const { putObject, deleteObject } = require("../s3Client.js");
const { protect } = require("./auth");
const { Chat, RandomChat, Message } = require('../models/chat');

// ── Multer setup (Memory Storage) ─────────────────────────────────────────────
// We use memoryStorage because Vercel has a read-only file system.
const storage = multer.memoryStorage();

const fileFilter = (_req, file, cb) => {
  const allowed = /jpeg|jpg|png|webp/;
  const isValid = allowed.test(file.mimetype) && allowed.test(path.extname(file.originalname).toLowerCase());
  isValid ? cb(null, true) : cb(new Error('Only image files are allowed (jpeg, jpg, png, webp).'));
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 2 * 1024 * 1024 } // Reduced to 2MB to stay under your 500MB limit longer
});

const BUCKET_NAME = process.env.R2_BUCKET_NAME; // Ensure this is in your .env

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * PUT /api/profile
 */
const editProfile = async (req, res) => {
  try {
    const userId = req.user.id;
    const user = await User.findById(userId);
    if (!user) return res.status(404).json({ message: 'User not found.' });

    const { firstName, lastName, userName, birthDate, country, sex } = req.body;

    // 1. Update basic fields
    if (firstName) user.firstName = firstName;
    if (lastName) user.lastName = lastName;
    if (sex) user.sex = sex;
    if (country) user.country = country;
    if (birthDate) user.birthDate = new Date(birthDate);

    // 2. Username uniqueness check
    if (userName && userName !== user.userName) {
      const taken = await User.findOne({ userName, _id: { $ne: userId } });
      if (taken) {
        return res.status(409).json({ message: 'Username is already taken.' });
      }
      user.userName = userName;
    }

    // 3. Image Upload to R2
    if (req.file) {
      const ext = path.extname(req.file.originalname);
      const filename = `avatars/profile_${userId}_${Date.now()}${ext}`;

      // Delete old photo from R2 if it exists
      if (user.photo && user.photo.startsWith('avatars/')) {
        await deleteObject(BUCKET_NAME, user.photo).catch(err => 
          console.error("Old file deletion failed:", err)
        );
      }

      // Upload new photo to R2
      // putObject now internally checks your 500MB limit!
      await putObject(BUCKET_NAME, filename, req.file.buffer);
      
      // Store the key/filename in the database
      user.photo = filename;
    }

    await user.save();

    const { password, verificationToken, ...safeUser } = user.toObject();
    res.status(200).json({ 
        message: 'Profile updated successfully.', 
        user: safeUser,
        // Note: In frontend, you'll access the image via your R2 Public URL + user.photo
    });

  } catch (error) {
    if (error.message.includes("limit reached")) {
        return res.status(507).json({ message: error.message });
    }
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
        const senderId = req.user.id;
        const { targetId } = req.params;

        if (senderId === targetId) {
            return res.status(400).json({ message: 'You cannot send a friend request to yourself.' });
        }

        const sId = new mongoose.Types.ObjectId(senderId);
        const tId = new mongoose.Types.ObjectId(targetId);

        const [sender, target] = await Promise.all([
            User.findById(sId),
            User.findById(tId)
        ]);

        if (!target) return res.status(404).json({ message: 'User not found.' });

        // Check arrays using .some() and .equals() for ObjectId compatibility
        if (sender.friends.some(id => id.equals(tId))) {
            return res.status(409).json({ message: 'You are already friends.' });
        }

        if (target.requests.some(id => id.equals(sId))) {
            return res.status(409).json({ message: 'Friend request already sent.' });
        }

        // Auto-accept if target already requested us
        if (sender.requests.some(id => id.equals(tId))) {
            await Promise.all([
                User.findByIdAndUpdate(sId, {
                    $addToSet: { friends: tId },
                    $pull: { requests: tId }
                }),
                User.findByIdAndUpdate(tId, {
                    $addToSet: { friends: sId },
                    $pull: { requests: sId } // Clean up both sides
                })
            ]);

            let chat = await Chat.findOne({
                participants: { $all: [sId, tId], $size: 2 }
            });

            if (!chat) {
                chat = await Chat.create({ participants: [sId, tId] });
            }

            return res.status(200).json({ message: 'Auto-accepted: You are now friends!' });
        }

        // Standard request
        await User.findByIdAndUpdate(tId, { $addToSet: { requests: sId } });
        res.status(200).json({ message: 'Friend request sent.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * POST /api/friends/accept/:requesterId
 */
const acceptFriendRequest = async (req, res) => {
    try {
        const userId = req.user.id;
        const { requesterId } = req.params;

        const uId = new mongoose.Types.ObjectId(userId);
        const rId = new mongoose.Types.ObjectId(requesterId);

        // Atomic Update: Only proceed if rId is actually in the user's requests
        const updatedUser = await User.findOneAndUpdate(
            { _id: uId, requests: rId }, 
            {
                $addToSet: { friends: rId },
                $pull: { requests: rId }
            },
            { returnDocument: 'after' } // Updated line
        );

        if (!updatedUser) {
            return res.status(404).json({ message: 'Friend request not found or already processed.' });
        }

        // Update the requester's friend list
        await User.findByIdAndUpdate(rId, {
            $addToSet: { friends: uId }
        });

        // Chat logic
        let chat = await Chat.findOne({
            participants: { $all: [uId, rId], $size: 2 }
        });

        if (!chat) {
            chat = await Chat.create({ participants: [uId, rId] });
        }

        await chat.populate('participants', 'firstName lastName userName photo online');

        res.status(200).json({ message: 'Friend request accepted.', chat });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * DELETE /api/friends/request/:requesterId
 */
const declineFriendRequest = async (req, res) => {
    try {
        const uId = new mongoose.Types.ObjectId(req.user.id);
        const rId = new mongoose.Types.ObjectId(req.params.requesterId);

        const result = await User.updateOne(
            { _id: uId },
            { $pull: { requests: rId } }
        );

        if (result.modifiedCount === 0) {
            return res.status(404).json({ message: 'Request not found.' });
        }

        res.status(200).json({ message: 'Friend request declined.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * DELETE /api/friends/:friendId
 */
const removeFriend = async (req, res) => {
    try {
        const uId = new mongoose.Types.ObjectId(req.user.id);
        const fId = new mongoose.Types.ObjectId(req.params.friendId);

        await Promise.all([
            User.findByIdAndUpdate(uId, { $pull: { friends: fId } }),
            User.findByIdAndUpdate(fId, { $pull: { friends: uId } })
        ]);

        res.status(200).json({ message: 'Friend removed.' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

/**
 * GET /api/friends/requests
 */
const getFriendRequests = async (req, res) => {
    try {
        const user = await User.findById(req.user.id)
            .populate('requests', 'firstName lastName userName photo online');

        if (!user) return res.status(404).json({ message: 'User not found.' });

        res.status(200).json(user.requests || []);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getRandomChatHistory = async (req, res) => {
  try {
    const userId = req.user.id;

    // Find all random chats where the user was a participant
    const history = await RandomChat.find({
      $or: [{ hostId: userId }, { guestId: userId }]
    })
    .sort({ createdAt: -1 }) // Get most recent chats first
    .populate('hostId', 'userName photo country') // Populate host details
    .populate('guestId', 'userName photo country'); // Populate guest details

    // Transform the data so it's easier for the frontend to consume
    const formattedHistory = history.map(chat => {
      // Determine which participant is the "other" person
      const isHost = chat.hostId._id.toString() === userId;
      const otherUser = isHost ? chat.guestId : chat.hostId;

      return {
        randomChatId: chat._id,
        dateTalked: chat.createdAt,
        partner: {
          _id: otherUser._id,
          userName: otherUser.userName,
          photo: otherUser.photo,
          country: otherUser.country
        },
      };
    });

    res.status(200).json(formattedHistory);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getAllInterestsGrouped = async (req, res) => {
  try {
    // 1. Fetch all interests from the database
    const allInterests = await Interest.find({});

    // 2. Group them by category
    const grouped = allInterests.reduce((acc, item) => {
      const cat = item.category;
      
      // If the category doesn't exist in our accumulator, create it
      if (!acc[cat]) {
        acc[cat] = [];
      }
      
      // Push the formatted interest object
      acc[cat].push({
        id: item._id,
        name: item.name
      });
      
      return acc;
    }, {});

    // 3. Return the grouped object
    res.status(200).json(grouped);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────
const UserRoutes = (router) => {
  // Profile
  router.put('/api/profile', protect , upload.single('photo'), editProfile);
  router.put('/api/profile/interests', protect ,  editInterests);
  router.get('/api/interests', getAllInterestsGrouped);

  // Friends
  router.get ('/api/friends/requests', protect, getFriendRequests);
  router.post  ('/api/friends/request/:targetId', protect ,  sendFriendRequest);
  router.post  ('/api/friends/accept/:requesterId', protect , acceptFriendRequest);
  router.delete('/api/friends/request/:requesterId', protect , declineFriendRequest);
  router.delete('/api/friends/:friendId', protect , removeFriend);

  router.get('/api/random-chats/history', protect, getRandomChatHistory);
};

module.exports = UserRoutes;