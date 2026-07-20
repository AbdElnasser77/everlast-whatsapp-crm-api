const storage = require("../../utils/storage");
const prisma = require("../../config/prisma");
const AppError = require("../../utils/AppError");
const { getMessageType } = require("../../utils/mediaHelpers");

const VALID_TYPES = ["IMAGE", "VIDEO", "AUDIO", "DOCUMENT"];

// How many active templates currently point their header at each of these
// URLs — lets the library warn "used on N templates" before someone deletes
// a file that's still referenced.
async function usageCountsByUrl(urls) {
  if (urls.length === 0) return new Map();
  const usage = await prisma.template.groupBy({
    by: ["headerMediaUrl"],
    where: { headerMediaUrl: { in: urls }, isActive: true },
    _count: { _all: true },
  });
  return new Map(usage.map((u) => [u.headerMediaUrl, u._count._all]));
}

const getAllMedia = async (req, res, next) => {
  try {
    const where = {};
    if (req.query.type) {
      if (!VALID_TYPES.includes(req.query.type)) {
        return next(new AppError(`Invalid type. Must be one of: ${VALID_TYPES.join(", ")}`, 400));
      }
      where.mediaType = req.query.type;
    }
    const media = await prisma.mediaAsset.findMany({ where, orderBy: { createdAt: "desc" } });
    const usageByUrl = await usageCountsByUrl(media.map((m) => m.url));

    res.status(200).json({
      success: true,
      data: media.map((m) => ({ ...m, usageCount: usageByUrl.get(m.url) ?? 0 })),
    });
  } catch (err) {
    next(err);
  }
};

// Uploads to R2 (same folder structure as the ad-hoc chat uploader) and
// persists a MediaAsset row so it can be reused later — e.g. picked as a
// template header — instead of re-uploading the same file every time.
const uploadMedia = async (req, res, next) => {
  if (!req.file) return next(new AppError("No file provided", 400));

  const mediaType = getMessageType(req.file.mimetype);
  const filename = req.body?.name?.trim() || req.file.originalname || null;

  let result;
  try {
    result = await storage.uploadBuffer({
      buffer: req.file.buffer,
      mimetype: req.file.mimetype,
      folder: "everlast-crm/library",
    });
  } catch (error) {
    console.error("Storage upload error:", error.message);
    return next(new AppError("File upload failed", 502));
  }

  try {
    const asset = await prisma.mediaAsset.create({
      data: {
        url: result.url,
        publicId: result.key,
        mediaType,
        format: result.format,
        bytes: result.bytes,
        width: result.width,
        height: result.height,
        filename,
        createdById: req.user.id,
      },
    });
    res.status(201).json({ success: true, data: { ...asset, usageCount: 0 } });
  } catch (dbErr) {
    next(dbErr);
  }
};

// Rename the library's display label — purely cosmetic, doesn't touch the
// underlying R2 object or its key.
const updateMedia = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const { filename } = req.body;
    if (filename !== undefined && !String(filename).trim()) {
      return next(new AppError("Filename can't be empty", 400));
    }
    const asset = await prisma.mediaAsset.update({
      where: { id },
      data: { filename: filename !== undefined ? String(filename).trim() : undefined },
    });
    const usageByUrl = await usageCountsByUrl([asset.url]);
    res.status(200).json({ success: true, data: { ...asset, usageCount: usageByUrl.get(asset.url) ?? 0 } });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Media not found", 404));
    next(err);
  }
};

const deleteMedia = async (req, res, next) => {
  try {
    const id = parseInt(req.params.id);
    const asset = await prisma.mediaAsset.findUnique({ where: { id } });
    if (!asset) return next(new AppError("Media not found", 404));

    try {
      // publicId holds the active provider's object key / public_id. If a row
      // was created under the other provider, this delete is a harmless miss
      // (wrong key for the current backend) — tolerated by the catch below.
      await storage.deleteObject({ key: asset.publicId, mediaType: asset.mediaType });
    } catch (err) {
      // Don't block removing the library entry on a storage-side hiccup — an
      // orphaned remote file is a smaller problem than a stuck UI record.
      console.error("Storage delete error:", err.message);
    }

    await prisma.mediaAsset.delete({ where: { id } });
    res.status(200).json({ success: true, message: "Media deleted" });
  } catch (err) {
    if (err.code === "P2025") return next(new AppError("Media not found", 404));
    next(err);
  }
};

module.exports = { getAllMedia, uploadMedia, updateMedia, deleteMedia };
