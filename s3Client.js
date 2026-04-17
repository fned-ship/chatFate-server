const { 
  S3Client, 
  PutObjectCommand, 
  GetObjectCommand, 
  DeleteObjectCommand, 
  ListObjectsV2Command 
} = require('@aws-sdk/client-s3');
const dotenv = require('dotenv');

dotenv.config();

// Define your hard limit here (in MB)
const STORAGE_LIMIT_MB = 500;

const s3Client = new S3Client({
    region: process.env.R2_REGION || 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
});

/**
 * Checks the total size of the bucket to ensure it's under the limit.
 */
const checkBucketLimit = async (bucket) => {
    try {
        const command = new ListObjectsV2Command({ Bucket: bucket });
        const data = await s3Client.send(command);

        // Sum up the size of all objects currently in the bucket
        const totalSizeBytes = data.Contents?.reduce((acc, obj) => acc + obj.Size, 0) || 0;
        const totalSizeMB = totalSizeBytes / (1024 * 1024);

        console.log(`Current Bucket Storage: ${totalSizeMB.toFixed(2)} MB / ${STORAGE_LIMIT_MB} MB`);
        
        return totalSizeMB < STORAGE_LIMIT_MB;
    } catch (error) {
        console.error('Error checking bucket size:', error);
        // If the check fails, we default to false as a safety measure
        return false;
    }
};

const putObject = async (bucket, key, body) => {
    try {
        // 1. Check if we have space before uploading
        const hasSpace = await checkBucketLimit(bucket);
        if (!hasSpace) {
            throw new Error(`Upload blocked: Storage limit of ${STORAGE_LIMIT_MB}MB reached.`);
        }

        // 2. Perform the upload
        const command = new PutObjectCommand({ 
            Bucket: bucket, 
            Key: key, 
            Body: body,
            ContentType: 'image/jpeg' // Optional: improves browser rendering
        });
        await s3Client.send(command);
        console.log(`Successfully uploaded: ${key}`);
    } catch (error) {
        console.error('Error in putObject:', error.message);
        throw error; // Re-throw so the controller can handle it
    }
};

const getObject = async (bucket, key) => {
    try {
        const command = new GetObjectCommand({ Bucket: bucket, Key: key });
        const response = await s3Client.send(command);
        return response;
    } catch (error) {
        console.error('Error retrieving object:', error);
    }
};

const deleteObject = async (bucket, key) => {
    try {
        const command = new DeleteObjectCommand({ Bucket: bucket, Key: key });
        await s3Client.send(command);
    } catch (error) {
        console.error('Error deleting object:', error);
    }
};

module.exports = { s3Client, putObject, getObject, deleteObject, checkBucketLimit };