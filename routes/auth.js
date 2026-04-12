const path = require('path');
const fs = require('fs');
const multer = require('multer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { User } = require('../models/user');
const transporter = require('../mailer');

const JWT_SECRET = process.env.JWT_SECRET;
const ClientDomainName = process.env.ClientDomainName;

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '../public/avatars');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + path.extname(file.originalname));
  },
});

const upload = multer({ storage });

// ── Helpers ───────────────────────────────────────────────────────────────────

const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;
    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    // Redirect to frontend verified page
    res.redirect(`${ClientDomainName}/auth/verified`);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email }).populate('interests');

    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.isVerified) return res.status(401).json({ message: 'Please verify your email.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });

    const userObj = user.toObject();
    delete userObj.password;
    res.status(200).json({ token, user: userObj });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const protect = async (req, res, next) => {
  const token = req.headers.authorization?.startsWith('Bearer')
    ? req.headers.authorization.split(' ')[1]
    : null;

  if (!token) return res.status(401).json({ message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

// ── Forgot / Reset password ───────────────────────────────────────────────────

const forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: 'Email is required' });

    const user = await User.findOne({ email });
    // Always respond 200 so we don't leak whether an account exists
    if (!user) return res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });

    // Generate a secure token valid for 1 hour
    const resetToken  = crypto.randomBytes(32).toString('hex');
    const resetExpiry = Date.now() + 60 * 60 * 1000; // 1 h

    user.passwordResetToken  = resetToken;
    user.passwordResetExpiry = resetExpiry;
    await user.save();

    const resetUrl = `${ClientDomainName}/auth/reset-password/${resetToken}`;

    await transporter.sendMail({
      from: `"App Support" <${process.env.emailAdress}>`,
      to:   email,
      subject: 'Reset your password',
      html: `
        <h2>Password Reset</h2>
        <p>You requested a password reset. Click the link below — it expires in 1 hour.</p>
        <a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#6c63ff;color:#fff;border-radius:6px;text-decoration:none;">Reset Password</a>
        <p>If you didn't request this, you can safely ignore this email.</p>
      `,
    });

    res.status(200).json({ message: 'If that email exists, a reset link has been sent.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const resetPassword = async (req, res) => {
  try {
    const { token }    = req.params;
    const { password } = req.body;

    if (!password || password.length < 6)
      return res.status(400).json({ message: 'Password must be at least 6 characters' });

    const user = await User.findOne({
      passwordResetToken:  token,
      passwordResetExpiry: { $gt: Date.now() },
    });

    if (!user) return res.status(400).json({ message: 'Reset link is invalid or has expired' });

    const salt = await bcrypt.genSalt(10);
    user.password            = await bcrypt.hash(password, salt);
    user.passwordResetToken  = undefined;
    user.passwordResetExpiry = undefined;
    await user.save();

    res.status(200).json({ message: 'Password updated successfully. You can now log in.' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

// ── Router ────────────────────────────────────────────────────────────────────

const Auth = (router) => {
  router.post('/api/auth/login',    login);
  router.get( '/api/auth/verify/:token', verifyEmail);

  router.post('/api/auth/signup', upload.single('image'), async (req, res) => {
    let data;
    try { data = JSON.parse(req.body.data); }
    catch { return res.status(400).json({ res: 'Invalid JSON in data' }); }

    const file      = req.file;
    const imagePath = file ? file.filename : 'persona.png';

    try {
      const existingUser = await User.findOne({
        $or: [{ email: data.email }, { userName: data.userName }],
      });

      if (existingUser) {
        if (file) {
          const fp = path.join(__dirname, '../public/avatars', imagePath);
          if (fs.existsSync(fp)) fs.unlinkSync(fp);
        }
        return res.status(400).json({ message: 'User already exists' });
      }

      const salt             = await bcrypt.genSalt(10);
      const hashedPassword   = await bcrypt.hash(data.password, salt);
      const verificationToken = crypto.randomBytes(32).toString('hex');

      const newUser = new User({
        ...data,
        photo: imagePath,
        password: hashedPassword,
        verificationToken,
        isVerified: false,
      });

      await newUser.save();

      const verificationUrl = `${process.env.SERVER_URL}/api/auth/verify/${verificationToken}`;

      await transporter.sendMail({
        from: process.env.emailAdress,
        to:   data.email,
        subject: 'Verify your email address',
        html: `
          <h2>Welcome to ChatFate!</h2>
          <p>Click below to verify your email address:</p>
          <a href="${verificationUrl}" style="display:inline-block;padding:12px 24px;background:#6c63ff;color:#fff;border-radius:6px;text-decoration:none;">Verify Email</a>
        `,
      });

      res.status(201).json({ message: 'Check your email to verify your account.' });
    } catch (error) {
      if (file && imagePath !== 'persona.png') {
        const fp = path.join(__dirname, '../public/avatars', imagePath);
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      return res.status(500).json({ error: error.message });
    }
  });

  // Forgot / reset password
  router.post('/api/auth/forgot-password',        forgotPassword);
  router.post('/api/auth/reset-password/:token',  resetPassword);
};

module.exports = { Auth, protect };