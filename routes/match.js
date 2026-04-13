const { User , Connection } = require('../models/user');
const {protect} = require("./auth");
const { Chat, RandomChat, Message } = require('../models/chat');

// Key helpers
const WAITING_KEY = 'waiting_room';          // Redis Hash  { userId -> JSON }
const userKey = (id) => `user:${id}`;        // Redis Hash  (cached profile)

// ── Helpers ───────────────────────────────────────────────────────────────────
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Age in full years from a Date value.
 */
const ageFromDate = (birthDate) => {
  if (!birthDate) return null;
  const now = new Date();
  const bd  = new Date(birthDate);
  let age   = now.getFullYear() - bd.getFullYear();
  const m   = now.getMonth() - bd.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < bd.getDate())) age--;
  return age;
};


// ── Router ────────────────────────────────────────────────────────────────────
const Match = (router,client) => {
    const addToWaitingRoom = async (user,typeOfChat) => {
        const entry = {
            userId:    user._id.toString(),
            birthDate: user.birthDate,
            typeOfChat : typeOfChat ,
            interests: user.interests.map((i) => ({
            _id:      i._id.toString(),
            name:     i.name.toLowerCase(),
            category: i.category.toLowerCase() ,
            }))
        };
        await client.hSet(WAITING_KEY, user._id.toString(), JSON.stringify(entry));
    };

    const removeFromWaitingRoom = async (userId) => {
        await client.hDel(WAITING_KEY, userId.toString());
    };

    const sameCategory = (birth1 , birth2)=>{
        const age1=ageFromDate(birth1);
        const age2=ageFromDate(birth2);
        if( (age1<18 && age2>18 ) || (age2<18 && age1>18 )  ) return false ;
        return true ;
    }


    const getCandidates = async (currentUser,typeOfChat) => {
        const currentUserId = currentUser._id.toString();

        // 1. Fetch all userIds this user has already talked to
        // We look for any connection where this user's ID exists in the 'users' array


        // const connections = await Connection.find({ users: currentUser._id }).lean();
        const talkedToIds = new Set();
        // const talkedToIds = new Set();
        // connections.forEach(conn => {
        //     conn.users.forEach(id => {
        //         if (id.toString() !== currentUserId) {
        //             talkedToIds.add(id.toString());
        //         }
        //     });
        // });

        const all = await client.hGetAll(WAITING_KEY);
        const entries = [];

        for (const [uid, raw] of Object.entries(all)) {
            // Skip self
            if (uid === currentUserId) continue;

            // 3. Check if they have talked before using our Set
            if (talkedToIds.has(uid)) continue;

            let cand = JSON.parse(raw);
            
            if (cand.typeOfChat!=typeOfChat) continue ;

            // 4. Category logic
            if (sameCategory(currentUser.birthDate, cand.birthDate)) {
                entries.push(cand);
            }
        }

        return entries;
    };

    router.post('/api/find-partner', protect ,async (req, res) => {
        try {
            const currentUserId = req.user.id;
            const io            = req.io;
            let {typeOfChat} = req.body ;

            // ── 0. Fetch current user (Mongo) ────────────────────────────────────────
            const currentUser = await User.findById(currentUserId).populate('interests').select('-password -email -verificationToken');
            if (!currentUser) return res.status(404).json({ message: 'User not found' });

            // ── 1. Ban check ─────────────────────────────────────────────────────────
            if (currentUser.banDate && currentUser.banPeriod > 0) {
            const banEnd = new Date(currentUser.banDate);
            banEnd.setDate(banEnd.getDate() + currentUser.banPeriod);
            if (new Date() < banEnd) {
                return res.status(403).json({
                message: `You are banned until ${banEnd.toISOString()}. Contact support if you believe this is a mistake.`
                });
            }
            }

            const myAge       = ageFromDate(currentUser.birthDate);
            const myInterests = currentUser.interests;

            // ── 2. Add current user to waiting room (if not already there) ───────────
            await addToWaitingRoom(currentUser,typeOfChat);

            // ── 3. Core matching function ─────────────────────────────────────────────
            const performMatch = async () => {
            const candidates = await getCandidates(currentUser,typeOfChat);
            // console.log('conds : ',candidates) ;
            if (candidates.length === 0) return null;

            let bestMatch        = null;
            let maxScore         = -1;
            let hasExactMatch    = false;

            console.log("my interests : ",myInterests);

            for (const cand of candidates) {
                // console.log("cand interests : ",cand.interests);
                // ── Age-gap filter (±4 years) ──
                if (myAge !== null && cand.birthDate) {
                const candAge = ageFromDate(cand.birthDate);
                if (candAge !== null && Math.abs(myAge - candAge) > 4) continue;
                }

                let score                = 0;
                let currentMatchHasExact = false;

                myInterests.forEach((myInt) => {
                cand.interests.forEach((theirInt) => {
                    if (myInt.name.toLowerCase() === theirInt.name) {
                    score += 30;
                    currentMatchHasExact = true;
                    } else if (myInt.category.toLowerCase() === theirInt.category) {
                    score += 10;
                    }
                });
                });

                if (score > maxScore) {
                maxScore         = score;
                bestMatch        = cand;
                hasExactMatch    = currentMatchHasExact;
                }
            }

            return { bestMatch, maxScore, hasExactMatch, candidates };
            };

            // ── Phase 1: First attempt ───────────────────────────────────────────────
            let result = await performMatch();

            // ── Phase 2: Category-only match → wait 0.7 s, retry ────────────────────
            if (result && result.maxScore > 0 && !result.hasExactMatch) {
            await delay(700);
            result = await performMatch();
            }

            // ── Phase 3: No scored match → wait 1 s, fall back to random ────────────
            if (!result || result.maxScore === 0) {
            await delay(1000);
            result = await performMatch();

            if (result && result.maxScore === 0 && result.candidates.length > 0) {
                const randomIdx    = Math.floor(Math.random() * result.candidates.length);
                result.bestMatch   = result.candidates[randomIdx];
                result.maxScore    = 0;
            }
            }

            // ── Phase 4: Finalize ────────────────────────────────────────────────────
            if (result && result.bestMatch) {
            // We need partner's full interest list for common-interest computation.
            // The cached Redis entry already has interests, so we can derive common directly.
            const partnerEntry = result.bestMatch;
            const partnerInterestNames = new Set(partnerEntry.interests.map((i) => i.name));

            const common = myInterests
                .filter((myInt) => partnerInterestNames.has(myInt.name.toLowerCase()))
                .map((i) => i.name);

            const matchPayload = {
                scoreMatch:      result.maxScore,
                commonInterests: common
            };

            //
            const randomChat = await RandomChat.create({ hostId : currentUserId , guestId : partnerEntry.userId });
                await randomChat.populate([
                  { path: 'hostId',  select: 'firstName lastName userName photo' },
                  { path: 'guestId', select: 'firstName lastName userName photo' }
                ]);
            const partner = await User.findById(partnerEntry.userId).select('-password -email -verificationToken');

            // Notify both users via Socket.io
            io.to(currentUserId.toString()).emit('partner_found', {
                matchPayload,
                partnerId: partnerEntry.userId ,
                partner ,
                randomChat
            });
            io.to(partnerEntry.userId).emit('partner_found', {
                matchPayload,
                partnerId: currentUserId.toString() , 
                partner : currentUser ,
                randomChat
            });

            // Remove both from Redis waiting room
            await removeFromWaitingRoom(currentUserId);
            await removeFromWaitingRoom(partnerEntry.userId);

            //add to history 
            // await Connection.create({ users: [currentUserId, partnerEntry.userId] });
            //

            return res.status(200).json(matchPayload);
            }

            res.status(200).json({ message: 'Still searching...' });
        } catch (error) {
            console.log("-------")
            res.status(500).json({ error: error.message });
        }
    });

  // Optional: manually leave waiting room
  router.delete('/api/waiting-room', protect , async (req, res) => {
    try {
      await removeFromWaitingRoom(req.user.id);
      res.status(200).json({ message: 'Removed from waiting room' });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
};

module.exports = Match;