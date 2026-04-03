const express = require("express");
const http = require("http");
const cors = require("cors") ;  //  It allows your server to handle requests from different origins (domains)
const mongoose = require('mongoose');
const { Server } = require("socket.io"); // live updates
const path = require('path');
const util = require('util');
const app = require("./app");
const { createClient } = require('redis');


const {seedInterests} = require("./interestsSeed");
const {Auth}=require("./routes/auth");
const ReportRoutes= require("./routes/report");
const Match= require("./routes/match");
const UserRoutes= require("./routes/user");
const ChatRoutes   = require('./routes/chat');

//create server 

const server = http.createServer(app);

//envirenement variable
const dotenv = require('dotenv');
dotenv.config();

const clientDomainName=process.env.ClientDomainName;

// port
const port = process.env.PORT || 3001;

//connect redis 

// const client = createClient({
//     username: process.env.REDISUSERNAME,
//     password: process.env.REDISPASSWORD,
//     socket: {
//         host: process.env.REDISHOST,
//         port: process.env.REDISPORT
//     }
// });

// client.on('error', (err) => {
//     console.error('Redis Client Error:', err);
// });

// client.connect()
//     .then(() => console.log('Redis connected!'))
//     .catch(err => console.log('Redis Connection Error', err));

//create socket

const io = new Server(server, {
    cors: {
        origin: clientDomainName,
        methods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
});

app.use((req, _res, next) => { req.io = io; next(); });

require('./socketHandler')(io);
//////////////////////
// io.on('connection', (socket) => {
//           console.log("User connected:", socket.id);

//           // Send your ID to yourself so you know who you are
//           socket.emit("me", socket.id);

//           // Forward the call request to a specific user
//           socket.on("callUser", ({ userToCall, signalData, from }) => {
//               io.to(userToCall).emit("callUser", { signal: signalData, from });
//           });

//           // Forward the answer back to the caller
//           socket.on("answerCall", (data) => {
//               io.to(data.to).emit("callAccepted", data.signal);
//           });
//       });
//////////////////////

// seedInterests();
Auth(app);
ReportRoutes(app);
// Match(app,client);
UserRoutes(app);
ChatRoutes(app);

//connect to db
const uri = process.env.ATLAS_URI;
mongoose.connect(uri) // {useNewUrlParser: true,useUnifiedTopology: true,}
.then(() => {
    console.log("MongoDB database connection established successfully");
    // Perform operations on the database
})
.catch((err) => {
    console.error("Error connecting to MongoDB:", err);
});



//listening to the port
server.listen(port,()=>{
    console.log("port connected at "+port);
})