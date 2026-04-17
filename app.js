const express = require("express");
const cors = require("cors");
const path = require("path");

const { getObject } = require('./s3Client');
const stream = require('stream');
const util = require('util');


const app = express();

const dotenv = require('dotenv');
dotenv.config();
const bucketName = process.env.R2_BUCKET_NAME;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());



const streamFile = async (req, res, folder) => {
    // const fileName = req.path.substring(`/${folder}/`.length);
    const fileName = req.params.path;

    try {
        const response = await getObject(bucketName, `${folder}/${fileName}`);

        if (!response) {
            console.log("File not found");
            if (!res.headersSent) {
                return res.status(404).json({ message: 'File not found !' });
            }
            return;
        }

        const fileStream = response.Body;

        // Listen for errors on the file stream
        fileStream.on('error', (error) => {
            console.log('Stream error:', error);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Error reading file stream' });
            }
        });

        // Handle premature close error
        fileStream.on('end', () => {
            console.log('Stream ended successfully');
        });

        // Use a fallback content type if response.ContentType is undefined
        const contentType = response.ContentType || 'application/octet-stream';
        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Disposition', `inline; filename="${fileName}"`);

        // Use pipeline to pipe the file stream to the response
        const pipeline = util.promisify(stream.pipeline);

        try {
            await pipeline(fileStream, res);
        } catch (pipelineError) {
            console.log('Pipeline error:', pipelineError);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Error streaming file' });
            }
        }
    } catch (error) {
        console.log(`Error fetching file from R2:`, error);
        if (!res.headersSent) {
            res.status(500).json({ message: 'Error fetching file from R2' });
        }
    }
};



// Middleware for different folders
app.get(/^\/avatars\/(.*)/, async (req, res) =>{ 
    req.params.path = req.params[0];
    streamFile(req, res, 'avatars');
});
app.get(/^\/images\/(.*)/, async (req, res) =>{ 
    req.params.path = req.params[0];
    streamFile(req, res, 'images');
});
app.get(/^\/files\/(.*)/, async (req, res) =>{ 
    req.params.path = req.params[0];
    streamFile(req, res, 'files');
});
app.get(/^\/reports\/(.*)/, async (req, res) =>{ 
    req.params.path = req.params[0];
    streamFile(req, res, 'reports');
});

// app.use('/imagesProfile', express.static(path.join(__dirname, 'public/avatars')));
// app.use('/images', express.static(path.join(__dirname, 'public/images')));
// app.use('/files', express.static(path.join(__dirname, 'public/files')));
// app.use('/reports', express.static(path.join(__dirname, 'public/reports')));

module.exports = app;