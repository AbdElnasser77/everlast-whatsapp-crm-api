const storage = require("../../utils/storage");
const AppError = require("../../utils/AppError");
const { getMessageType } = require("../../utils/mediaHelpers");

const uploadMedia = async (req, res, next) => {
  if (!req.file) return next(new AppError("No file provided", 400));

  const messageType = getMessageType(req.file.mimetype);

  try {
    const result = await storage.uploadBuffer({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      folder: "everlast-crm",
    });

    res.status(200).json({
      success: true,
      url: result.url,
      publicId: result.key,
      messageType,
      format: result.format,
      bytes: result.bytes,
    });
  } catch (error) {
    console.error("R2 upload error:", error.message);
    return next(new AppError("File upload failed", 502));
  }
};

module.exports = { uploadMedia };
