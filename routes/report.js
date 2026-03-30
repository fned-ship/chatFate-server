const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { User }  = require('../models/user');
const Report     = require('../models/report');
const transporter = require('../mailer');
const {protect} = require("./auth");

// ── Helpers ───────────────────────────────────────────────────────────────────
const AUTO_BAN_THRESHOLD = 3;   // ban after this many new reports
const AUTO_BAN_DAYS      = 3;   // days for automatic ban

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../public/reports');
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

const sendMail = (to, subject, html) =>
  transporter.sendMail({
    from: `"Platform Support" <${process.env.emailAdress}>`,
    to,
    subject,
    html
  });

const restrictTo = (...roles) => {
  return (req, res, next) => {
    // protect must run before this to populate req.user
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'You do not have permission to perform this action' });
    }
    next();
  };
};

// ── Controllers ───────────────────────────────────────────────────────────────

/**
 * GET /api/reports
 * Returns all reports sorted by importance (desc). Moderators only.
 */
const getAllReports = async (req, res) => {
  try {
    const reports = await Report.find()
      .sort({ importance: -1, createdAt: -1 })
      .populate('victimId', 'firstName lastName email userName')
      .populate('reportedId', 'firstName lastName email userName');

    res.status(200).json(reports);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/reports
 * Body: { reportedId, report, images, importance }
 * Authenticated user submits a report against another user.
 * If the reported user accumulates > AUTO_BAN_THRESHOLD new reports → auto-ban 3 days.
 */
const addReport = async (req, res) => {
  try {
    const victimId   = req.user.id;
    const { reportedId, report, importance } = req.body;

    if (!reportedId) {
      return res.status(400).json({ message: 'reportedId is required.' });
    }
    if (victimId === reportedId) {
      return res.status(400).json({ message: 'You cannot report yourself.' });
    }

    const reportedUser = await User.findById(reportedId);
    if (!reportedUser) return res.status(404).json({ message: 'Reported user not found.' });

    //

    let images = [];

    req.files && req.files.forEach(file => {
        images.push(file.filename);
    });

    // Create report
    const newReport = await Report.create({
      victimId,
      reportedId,
      report,
      images:     images     || [],
      importance: importance || 1
    });

    // Increment counters
    reportedUser.numOfReports  += 1;
    reportedUser.totalReports  += 1;

    // Auto-ban if threshold exceeded
    if (reportedUser.numOfReports > AUTO_BAN_THRESHOLD) {
      reportedUser.banDate   = new Date();
      reportedUser.banPeriod = AUTO_BAN_DAYS;

      // Notify the reported user
      await sendMail(
        reportedUser.email,
        'Your account has been temporarily suspended',
        `<p>Hi ${reportedUser.firstName},</p>
         <p>Your account has been <strong>temporarily suspended for ${AUTO_BAN_DAYS} days</strong>
            due to multiple reports. A moderator will review your case shortly.</p>
         <p>If you believe this is a mistake, please contact our support team.</p>`
      ).catch(console.error);
    }

    await reportedUser.save();

    res.status(201).json({ message: 'Report submitted successfully.', report: newReport });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

/**
 * POST /api/reports/:reportId/action
 * Moderator takes action on a report.
 * Body: { action: 'ban' | 'delete' | 'none', banDays?: number }
 */
const takeAction = async (req, res) => {
  try {
    if (req.user.role !== 'moderator') {
      return res.status(403).json({ message: 'Access denied. Moderators only.' });
    }

    const { reportId } = req.params;
    const { action, banDays } = req.body;

    if (!['ban', 'delete', 'none'].includes(action)) {
      return res.status(400).json({ message: "action must be 'ban', 'delete', or 'none'." });
    }

    const report = await Report.findById(reportId)
      .populate('victimId',   'firstName lastName email')
      .populate('reportedId', 'firstName lastName email numOfReports');

    if (!report) return res.status(404).json({ message: 'Report not found.' });

    const victim   = report.victimId;
    const reported = report.reportedId;

    // ── Action: none ─────────────────────────────────────────────────────────
    if (action === 'none') {
      // Reset the per-cycle report counter so user isn't stuck
      await User.findByIdAndUpdate(reported._id, { $set: { numOfReports: numOfReports - 1 } });

      await Promise.allSettled([
        sendMail(
          victim.email,
          'Update on your report',
          `<p>Hi ${victim.firstName},</p>
           <p>Our moderation team has reviewed your report. After careful review, 
              no action was taken at this time. We appreciate you keeping the 
              platform safe.</p>`
        ),
        sendMail(
          reported.email,
          'Report resolved — no action taken',
          `<p>Hi ${reported.firstName},</p>
           <p>A report submitted against your account has been reviewed by our 
              moderation team. No action has been taken and your account remains 
              in good standing.</p>`
        )
      ]);

      return res.status(200).json({ message: 'No action taken. Notified both parties.' });
    }

    // ── Action: delete ────────────────────────────────────────────────────────
    if (action === 'delete') {
      await User.findByIdAndDelete(reported._id);

      await sendMail(
        victim.email,
        'Update on your report',
        `<p>Hi ${victim.firstName},</p>
         <p>Following your report, our moderation team has reviewed the account 
            and <strong>removed it</strong> from the platform. Thank you for 
            helping keep the community safe.</p>`
      ).catch(console.error);

      // No email to the deleted user — account is gone.
      return res.status(200).json({ message: 'User account deleted.' });
    }

    // ── Action: ban ───────────────────────────────────────────────────────────
    if (action === 'ban') {
      const days = parseInt(banDays, 10);
      if (!days || days < 1) {
        return res.status(400).json({ message: 'Provide a valid banDays (≥1) for a ban action.' });
      }

      const banEnd = new Date();
      banEnd.setDate(banEnd.getDate() + days);

      await User.findByIdAndUpdate(reported._id, {
        $set: {
          banDate:      new Date(),
          banPeriod:    days,
          numOfReports: 0     // reset cycle counter
        }
      });

      await Promise.allSettled([
        sendMail(
          victim.email,
          'Update on your report',
          `<p>Hi ${victim.firstName},</p>
           <p>Our moderation team has reviewed your report. The reported user's 
              account has been <strong>suspended for ${days} day(s)</strong> 
              (until ${banEnd.toDateString()}). Thank you for your report.</p>`
        ),
        sendMail(
          reported.email,
          'Your account has been suspended',
          `<p>Hi ${reported.firstName},</p>
           <p>Following a moderation review, your account has been 
              <strong>suspended for ${days} day(s)</strong> 
              (until ${banEnd.toDateString()}).</p>
           <p>Reason: violation of community guidelines based on reports received.</p>
           <p>If you believe this is a mistake, please contact our support team.</p>`
        )
      ]);

      return res.status(200).json({
        message: `User banned for ${days} day(s) until ${banEnd.toDateString()}.`
      });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────
const ReportRoutes = (router) => {
  // Get all reports (sorted by importance) — moderators only
  router.get('/api/reports',protect, restrictTo('moderator'), getAllReports);

  // Submit a report
  router.post('/api/reports',protect , upload.array('files') , addReport);

  // Moderator action on a specific report
  router.post('/api/reports/:reportId/action', protect ,takeAction);
};

module.exports = ReportRoutes;