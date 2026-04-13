const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { User } = require('../models/user');
const Report = require('../models/report');
const transporter = require('../mailer');
const { protect } = require("./auth");

// ── Helpers ───────────────────────────────────────────────────────────────────
const AUTO_BAN_THRESHOLD = 10;
const AUTO_DELETE_ACCOUNT_THRESHOLD = 40;
const AUTO_BAN_DAYS = 3;
const PERMANENT_BAN_DAYS = 3650; // 10 years

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

/**
 * Deletes images from the disk for one or many reports
 * @param {Array|Object} reports - A single report object or array of report objects
 */
const deleteReportImages = (reports) => {
    const reportArray = Array.isArray(reports) ? reports : [reports];
    reportArray.forEach(report => {
        if (report.images && report.images.length > 0) {
            report.images.forEach(imgName => {
                const imgPath = path.join(__dirname, '../public/reports', imgName);
                if (fs.existsSync(imgPath)) {
                    fs.unlinkSync(imgPath);
                }
            });
        }
    });
};

const sendMail = (to, subject, html) =>
    transporter.sendMail({
        from: `"Platform Support" <${process.env.emailAdress}>`,
        to,
        subject,
        html
    });

const restrictTo = (...roles) => {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ message: 'You do not have permission to perform this action' });
        }
        next();
    };
};

// ── Controllers ───────────────────────────────────────────────────────────────

const getAllReports = async (req, res) => {
    try {
        const reports = await Report.find({ ai: false })
            .sort({ importance: -1, createdAt: -1 })
            .populate('victimId', 'firstName lastName email userName')
            .populate('reportedId', 'firstName lastName email userName');
        res.status(200).json(reports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const getAllAiReports = async (req, res) => {
    try {
        const reports = await Report.find({ ai: true })
            .sort({ importance: -1, createdAt: -1 })
            .populate('victimId', 'firstName lastName email userName')
            .populate('reportedId', 'firstName lastName email userName');
        res.status(200).json(reports);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

const addReport = async (req, res) => {
    let images = [];
    try {
        const victimId = req.user.id;
        let { reportedId, report, importance, ai } = req.body;

        if (req.files) {
            images = req.files.map(file => file.filename);
        }

        if (!reportedId) throw new Error('reportedId is required.');
        if (victimId === reportedId) throw new Error('You cannot report yourself.');

        const reportedUser = await User.findById(reportedId);
        if (!reportedUser) throw new Error('Reported user not found.');

        report = ai ? ("AI : " + report) : report;

        const newReport = await Report.create({
            victimId,
            reportedId,
            report,
            ai,
            images,
            importance: importance || 1
        });

        reportedUser.numOfReports += 1;
        reportedUser.totalReports += 1;

        // --- Threshold logic ---
        let cleanupNeeded = false;

        if (reportedUser.totalReports > AUTO_DELETE_ACCOUNT_THRESHOLD) {
            // "Delete Account" action -> Now a 10-year ban
            reportedUser.banDate = new Date();
            reportedUser.banPeriod = PERMANENT_BAN_DAYS;
            cleanupNeeded = true;

            await sendMail(reportedUser.email, 'Account Disabled', `<p>Your account has been disabled for 10 years due to excessive reports.</p>`);
        } else if (reportedUser.numOfReports > AUTO_BAN_THRESHOLD) {
            reportedUser.banDate = new Date();
            reportedUser.banPeriod = AUTO_BAN_DAYS;
            cleanupNeeded = true;

            await sendMail(reportedUser.email, 'Temporary Suspension', `<p>Your account is suspended for ${AUTO_BAN_DAYS} days.</p>`);
        }

        if (cleanupNeeded) {
            const allUserReports = await Report.find({ reportedId });
            deleteReportImages(allUserReports);
            console.log("deleted reports ...") ;
            await Report.deleteMany({ reportedId });
            reportedUser.numOfReports = 0; // Reset cycle
        }

        await reportedUser.save();
        res.status(201).json({ message: 'Report submitted successfully.', report: newReport });

    } catch (error) {
        // Cleanup: If error occurs during report creation, delete uploaded files
        // if (images.length > 0) {
        //     images.forEach(imgName => {
        //         const imgPath = path.join(__dirname, '../public/reports', imgName);
        //         if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
        //     });
        //     console.log("deleted images")
        // }
        res.status(500).json({ error: error.message });
    }
};

const takeAction = async (req, res) => {
    try {
        const { reportId } = req.params;
        const { action, banDays } = req.body;

        const report = await Report.findById(reportId)
            .populate('victimId', 'firstName lastName email')
            .populate('reportedId', 'firstName lastName email numOfReports');

        if (!report) return res.status(404).json({ message: 'Report not found.' });

        const victim = report.victimId;
        const reported = report.reportedId;

        if (action === 'none') {
            await User.findByIdAndUpdate(reported._id, { $inc: { numOfReports: -1 } });
            // Delete only this report and its images
            deleteReportImages(report);
            await Report.findByIdAndDelete(reportId);
            return res.status(200).json({ message: 'No action taken. Report cleared.' });
        }

        if (action === 'delete') {
            // Instead of deleting user, set 10-year ban
            await User.findByIdAndUpdate(reported._id, {
                $set: { banDate: new Date(), banPeriod: PERMANENT_BAN_DAYS, numOfReports: 0 }
            });

            await Promise.allSettled([
                sendMail(
                victim.email,
                'Update on your report',
                `<p>Hi ${victim.firstName},</p>
                <p>Our moderation team has reviewed your report. The reported user's
                    account has been <strong>deleted</strong>. Thank you for your report.</p>`
                ),
                sendMail(
                reported.email,
                'Your account has been suspended',
                `<p>Hi ${reported.firstName},</p>
                <p>Following a moderation review, your account has been
                    <strong>deleted</strong>
                <p>Reason: violation of community guidelines based on reports received.</p>
                <p>If you believe this is a mistake, please contact our support team.</p>`
                )
            ]);

            // Delete ALL reports for this user
            const allUserReports = await Report.find({ reportedId: reported._id });
            deleteReportImages(allUserReports);
            await Report.deleteMany({ reportedId: reported._id });

            return res.status(200).json({ message: 'User banned for 10 years and all reports cleared.' });
        }

        if (action === 'ban') {
            const days = parseInt(banDays, 10) || AUTO_BAN_DAYS;
            await User.findByIdAndUpdate(reported._id, {
                $set: { banDate: new Date(), banPeriod: days, numOfReports: 0 }
            });

            // await Promise.allSettled([
            //     sendMail(
            //     victim.email,
            //     'Update on your report',
            //     `<p>Hi ${victim.firstName},</p>
            //     <p>Our moderation team has reviewed your report. The reported user's
            //         account has been <strong>suspended for ${days} day(s)</strong>
            //         (until ${banEnd.toDateString()}). Thank you for your report.</p>`
            //     ),
            //     sendMail(
            //     reported.email,
            //     'Your account has been suspended',
            //     `<p>Hi ${reported.firstName},</p>
            //     <p>Following a moderation review, your account has been
            //         <strong>suspended for ${days} day(s)</strong>
            //         (until ${banEnd.toDateString()}).</p>
            //     <p>Reason: violation of community guidelines based on reports received.</p>
            //     <p>If you believe this is a mistake, please contact our support team.</p>`
            //     )
            // ]);

            // Delete ONLY the specific report that was processed
            deleteReportImages(report);
            await Report.findByIdAndDelete(reportId);

            return res.status(200).json({ message: `User banned for ${days} days. Report deleted.` });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
};

// ── Router ────────────────────────────────────────────────────────────────────
const ReportRoutes = (router) => {
    router.get('/api/reports', protect, restrictTo('moderator'), getAllReports);
    router.get('/api/ai/reports', protect, restrictTo('moderator'), getAllAiReports);
    router.post('/api/reports', protect, upload.array('files'), addReport);
    router.post('/api/reports/:reportId/action', protect, restrictTo('moderator'), takeAction);
};

module.exports = ReportRoutes;