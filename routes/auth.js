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


const verifyEmail = async (req, res) => {
  try {
    const { token } = req.params;
    const user = await User.findOne({ verificationToken: token });
    if (!user) return res.status(400).json({ message: 'Invalid or expired token' });

    user.isVerified = true;
    user.verificationToken = undefined;
    await user.save();

    res.status(200).send('<h1>Email Verified Successfully!</h1><p>You can now log in.</p>');
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const login = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });

    if (!user) return res.status(404).json({ message: 'User not found' });
    if (!user.isVerified) return res.status(401).json({ message: 'Please verify your email.' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: 'Invalid credentials' });

    const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
    res.status(200).json({ token, user: { ...user , password : "*******" } });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const protect = async (req, res, next) => {
  let token = req.headers.authorization?.startsWith('Bearer') ? req.headers.authorization.split(' ')[1] : null;

  if (!token) return res.status(401).json({ message: 'Not authorized' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = await User.findById(decoded.id).select('-password');
    next();
  } catch (error) {
    res.status(401).json({ message: 'Token is not valid' });
  }
};

const Auth = (router) => {
  router.post('/api/auth/login', login);
  router.get('/api/auth/verify/:token', verifyEmail);

  router.post('/api/auth/signup', upload.single('image'), async (req, res) => {
    let data;
    try {
      data = JSON.parse(req.body.data);
    } catch (err) {
      return res.status(400).json({ res: 'Invalid JSON in data' });
    }

    const file = req.file;
    let imagePath = file ? file.filename : "persona.png";

    try {
      const existingUser = await User.findOne({ 
        $or: [{ email: data.email }, { userName: data.userName }] 
      });

      if (existingUser) {
        if (file) {
          const fullPath = path.join(__dirname, '../public/avatars', imagePath);
          if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
        }
        return res.status(400).json({ message: 'User already exists' });
      }

      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(data.password, salt);
      const verificationToken = crypto.randomBytes(32).toString('hex');

      const newUser = new User({
        ...data,
        photo: imagePath,
        password: hashedPassword,
        verificationToken,
        isVerified: false
      });

      await newUser.save();

      const verificationUrl = `${ClientDomainName}/auth/verify/${verificationToken}`;

      await transporter.sendMail({
        from: `"App Support" <${process.env.emailAdress}>`,
        to: data.email, 
        subject: "Verify your email address",
        html: `<h1>Welcome!</h1><p>Verify here:</p><a href="${verificationUrl}">${verificationUrl}</a>`
      });

      res.status(201).json({ message: 'Check your email to verify account.' });
    } catch (error) {
      if (file && imagePath) {
        const fullPath = path.join(__dirname, '../public/avatars', imagePath);
        if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
      }
      return res.status(500).json({ error: error.message });
    }
  });
};

module.exports = { Auth, protect };