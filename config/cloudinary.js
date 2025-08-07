const cloudinary = require('cloudinary').v2;

cloudinary.config({
  cloud_name: 'peoples-power-technology',
  api_key: '741617957557579',
  api_secret: 'SzPorCF6VXl9iRMOvitjLaQFSy4'
});



const upload = async (file, type = "image") => {
  try {
    const options = {
      resource_type: type || "auto",
      timeout: 120000, // 2-minute timeout
      chunk_size: 6000000, // Use chunked uploads for all resources
    };
    
    // For large files, use chunked upload approach
    const image = await cloudinary.uploader.upload(
      file,
      options
    );
    return image.secure_url;
  } catch (error) {
    console.error("Cloudinary upload error:", error);
    throw error; // Re-throw to handle in the calling function
  }
};

const getSignature = async () => {
  const timestamp = Math.floor(new Date().getTime() / 1000);

  const signature = cloudinary.utils.api_sign_request(
    { timestamp },
    'SzPorCF6VXl9iRMOvitjLaQFSy4'
  );
  return {
    apiKey: '741617957557579',
    timestamp: timestamp,
    signature: signature,
    cloudname: 'peoples-power-technology'
  };
};

const cloudinaryVidUpload = async (asset) => {
  try {
    const res = await cloudinary.uploader.upload(asset, {
      resource_type: "video",
      chunk_size: 6000000, // Using 6MB chunks
      timeout: 180000, // 3-minute timeout for videos
      eager_async: true,
      use_filename: true,
      unique_filename: true,
      overwrite: true,
      // Added retry logic for more resilient uploads
      max_retries: 3,
      // Optional transformation settings
      // eager: [
      //   { width: 300, height: 300, crop: "pad", audio_codec: "none" },
      //   { width: 160, height: 100, crop: "crop", gravity: "south", audio_codec: "none" }],
    });
    return res.secure_url;
  } catch (error) {
    console.error("Cloudinary video upload error:", error);
    // More specific error message based on error type
    if (error.http_code === 499 || error.name === "TimeoutError") {
      throw new Error("Video upload timed out. The file may be too large or the connection is too slow.");
    }
    throw new Error(`Video upload failed: ${error.message}`);
  }
};


/**
 * Helper function to retry uploads with exponential backoff
 * @param {Function} uploadFn - The upload function to retry
 * @param {any} resource - The resource (file or URL) to upload
 * @param {Object} options - Upload options
 * @param {number} maxRetries - Maximum number of retries
 * @returns {Promise<string>} - The secure URL of the uploaded resource
 */
const retryUpload = async (uploadFn, resource, options = {}, maxRetries = 3) => {
  let lastError;
  let retryCount = 0;
  
  while (retryCount < maxRetries) {
    try {
      // Attempt to upload
      const result = await uploadFn(resource, options);
      return result.secure_url;
    } catch (error) {
      lastError = error;
      
      // If not a timeout error, don't retry
      if (error.http_code !== 499 && error.name !== "TimeoutError") {
        break;
      }
      
      // Exponential backoff
      const delay = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s, etc.
      console.log(`Upload failed, retrying in ${delay}ms... (Attempt ${retryCount + 1}/${maxRetries})`);
      await new Promise(resolve => setTimeout(resolve, delay));
      retryCount++;
    }
  }
  
  // All retries failed
  throw lastError || new Error('Upload failed after multiple attempts');
};

module.exports = { upload, cloudinaryVidUpload, getSignature, retryUpload };