const nodemailer = require("nodemailer");
const dotenv =require('dotenv');
dotenv.config();


const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com", // Replace with your email provider's SMTP server
  port: 465, // Replace with your email provider's port (usually 587 for TLS)
  secure: true, // true for 465, false for other ports
  auth: {
    user: process.env.emailAdress, // Replace with your email address
    pass: process.env.emailPass, // Replace with your email password or app-specific password
  },
});

module.exports=transporter ;