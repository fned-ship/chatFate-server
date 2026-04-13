const express = require("express");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());

app.use('/imagesProfile', express.static(path.join(__dirname, 'public/avatars')));
app.use('/images', express.static(path.join(__dirname, 'public/images')));
app.use('/files', express.static(path.join(__dirname, 'public/files')));
app.use('/reports', express.static(path.join(__dirname, 'public/reports')));

module.exports = app;