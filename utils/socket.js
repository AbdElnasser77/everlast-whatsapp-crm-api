const cookie = require("cookie");
const jwt = require("jsonwebtoken");
const prisma = require("../config/prisma");

let io;

const initSocket = (httpServer) => {
  io = require("socket.io")(httpServer, {
    cors: {
      origin: process.env.FRONTEND_URL || "http://localhost:3000",
      credentials: true,
    },
  });

  // Authenticate every socket connection. The browser sends the httpOnly JWT
  // cookie on the handshake (client must use withCredentials); non-browser
  // clients may pass the token via handshake auth instead. Reject anything
  // without a valid token so message events are never broadcast to strangers.
  io.use(async (socket, next) => {
    try {
      const cookies = cookie.parse(socket.handshake.headers.cookie || "");
      const token = cookies.token || socket.handshake.auth?.token;
      if (!token) return next(new Error("Unauthorized"));

      const decoded = jwt.verify(token, process.env.JWT_SECRET);

      // Same authoritative check as middleware/auth.js. Trusting the handshake
      // claims alone would let a deactivated or deleted user keep receiving
      // every message.created event in the system for up to 8 hours.
      //
      // findUnique, not update: a socket lives for hours, so bumping
      // lastActiveAt here would make "last active" meaningless.
      const user = await prisma.user.findUnique({
        where: { id: decoded.id },
        select: { id: true, username: true, role: true, isActive: true },
      });
      if (!user || !user.isActive) return next(new Error("Unauthorized"));

      socket.user = { id: user.id, username: user.username, role: user.role };
      next();
    } catch {
      next(new Error("Unauthorized"));
    }
  });

  io.on("connection", (socket) => {
    // Per-user room so user.controller can force-disconnect one specific
    // account the instant it's deactivated, deleted, or demoted. Every other
    // emit in this codebase stays global — this room is only ever a kick target.
    socket.join(`user:${socket.user.id}`);

    console.log("Socket client connected:", socket.id, "user:", socket.user?.username);

    socket.on("typing.start", ({ conversationId, username }) => {
      socket.broadcast.emit("typing.start", { conversationId, username });
    });

    socket.on("typing.stop", ({ conversationId, username }) => {
      socket.broadcast.emit("typing.stop", { conversationId, username });
    });

    socket.on("disconnect", () => {
      console.log("Socket client disconnected:", socket.id);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) throw new Error("Socket.IO not initialized");
  return io;
};

// Drop every live socket belonging to one user. Called after deactivate,
// delete, and role change so the socket layer can't outlive the HTTP layer's
// authoritative check.
//
// Checks `io` directly rather than calling getIO(), which throws when the
// socket layer was never initialised — e.g. under `npm run seed`.
const disconnectUser = (userId) => {
  if (!io) return;
  io.in(`user:${userId}`).disconnectSockets(true);
};

module.exports = { initSocket, getIO, disconnectUser };
